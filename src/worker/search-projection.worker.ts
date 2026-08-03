// ファイル概要:
// このファイルは検索プロジェクション Worker の本体です。
// EventBridge → SQS に届いたドメインイベントをロングポーリングで消費し、
// OpenSearch の events index を更新します（読み取り経路の結果整合な複製。ADR-0006）。

import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Client } from '@opensearch-project/opensearch';
// SpanKind / SpanStatusCode / trace は Worker 側の consumer span を張るための OTel API です。
// SDK 未起動時（ローカル PoC）は no-op になります（ADR-0014）。
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
// context.with 相当の親 context 指定には extractTraceContext の戻り値を使います。
import {
  extractTraceContext,
  TRACE_CONTEXT_FIELD,
  // traceLogFields は構造化ログへ trace id / span id を付与し、
  // CloudWatch Logs から X-Ray trace へ辿れるようにします（Issue #255）。
  traceLogFields,
} from '../observability/trace-context';
// emitMetric は Worker の処理遅延メトリクス（EMF）を出します（ADR-0014）。
import { emitMetric } from '../observability/emf';
// createOpenSearchClient は AWS 上では SigV4 署名付きクライアントを返します（production-readiness M-3）。
import { createOpenSearchClient } from '../opensearch';
import { EVENTS_INDEX } from '../search/search.service';
// projection store は versioned / legacy / metadata の atomic scripted update を提供します（Issue #377）。
import {
  applyEventMetadata,
  applyParsedInventoryChanged,
  ensureEventsIndex,
} from '../search/events-projection.store';
// InventoryChanged の runtime parser（Issue #377）。壊れた versioned payload は throw します。
import { parseInventoryChangedDetail } from '../messaging/inventory-event.contract';

// EventBridgeEnvelope は SQS body に入る EventBridge イベントの外形です。
interface EventBridgeEnvelope {
  'detail-type': string;
  detail: Record<string, unknown>;
}

export class SearchProjectionWorker {
  private readonly sqs = new SQSClient({});
  private readonly opensearch: Client;
  private running = true;

  constructor(
    private readonly queueUrl: string,
    opensearchEndpoint: string,
  ) {
    this.opensearch = createOpenSearchClient(opensearchEndpoint);
  }

  // start は index の存在を保証してから消費ループへ入ります。
  async start(): Promise<void> {
    await this.ensureIndex();
    console.log('search-projection worker started', {
      queueUrl: this.queueUrl,
    });

    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        // 一時障害でプロセスを落とさず、次のポーリングで回復を試みます。
        console.error('poll failed:', error);
        await sleep(5000);
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  // ensureIndex は index の存在を保証し、mapping を additive に適用します（Issue #377）。
  // 既存 index にも putMapping で versioned field（ticket_types / event_inventory_version 等）を
  // 追加します。早期 return せず additive 適用するため、既存 index で新 field が欠落しません。
  // mapping 適用に失敗した場合は throw し、message consumption を開始しません。
  private async ensureIndex(): Promise<void> {
    await ensureEventsIndex(this.opensearch, EVENTS_INDEX);
    console.log(`ensured index mapping: ${EVENTS_INDEX}`);
  }

  private async pollOnce(): Promise<void> {
    const received = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        // SQS モジュール側の receive_wait_time_seconds と合わせたロングポーリングです。
        WaitTimeSeconds: 20,
        // SentTimestamp は処理遅延メトリクス（送信からの経過時間）の計算に使います（ADR-0014）。
        MessageSystemAttributeNames: ['SentTimestamp'],
      }),
    );

    for (const message of received.Messages ?? []) {
      await this.handleMessage(message);
      await this.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
      // 削除まで完了した時点の「SQS 送信からの経過時間」を処理遅延として記録します。
      // キュー全体の滞留は SQS 標準メトリクス ApproximateAgeOfOldestMessage が別途拾うため、
      // こちらは「正常系での消費までの遅延」を見る用途です。
      this.emitProcessingLag(message);
    }
  }

  // emitProcessingLag は SentTimestamp から処理完了までの経過 ms を EMF で出します。
  // 属性が欠けている場合（ローカルの偽 SQS など）は何もしません。
  private emitProcessingLag(message: Message): void {
    const sentTimestamp = Number(message.Attributes?.SentTimestamp);
    if (!Number.isFinite(sentTimestamp) || sentTimestamp <= 0) {
      return;
    }
    const lagMs = Date.now() - sentTimestamp;
    if (lagMs >= 0) {
      emitMetric('WorkerProcessingLagMs', lagMs, 'Milliseconds');
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (!message.Body) {
      return;
    }
    const envelope = JSON.parse(message.Body) as EventBridgeEnvelope;

    // detail に同梱された trace context（ADR-0014）を復元し、API 側で始まった trace の
    // 続きとして consumer span を張ります。context が無ければ独立した trace になります。
    const parentContext = extractTraceContext(
      envelope.detail?.[TRACE_CONTEXT_FIELD],
    );
    const tracer = trace.getTracer('search-projection-worker');

    await tracer.startActiveSpan(
      `search-projection ${envelope['detail-type']}`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'aws_sqs',
          'messaging.operation': 'process',
        },
      },
      parentContext,
      async (span) => {
        try {
          await this.processEnvelope(envelope);
        } catch (error) {
          // 失敗した span はエラーとして記録し、X-Ray 側で fault として見えるようにします。
          if (error instanceof Error) {
            span.recordException(error);
          }
          span.setStatus({ code: SpanStatusCode.ERROR });
          // review 4: 処理 Operation は error class から逆算せず、envelope の detail-type から
          // 決定する。InventoryChanged 処理中の OpenSearch write error / Painless contract
          // corruption / conflict retry 枯渇は InventoryChanged/error として記録する。
          // EventListed / EventUpdated の write error は EventMetadata/error。
          // TicketPurchased / unknown は無理に EventMetadata へ分類しない（metric を出さない）。
          // message は ack されず、visibility timeout 後に再配信 / DLQ へ進みます。
          const operation = operationForDetailType(envelope['detail-type']);
          if (operation) {
            this.emitOutcome(operation, 'error');
          }
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  // processEnvelope は EventBridge イベント 1 件を OpenSearch プロジェクションへ反映します
  // （旧 handleMessage の本体。trace 用の span 管理と分離しました）。
  private async processEnvelope(envelope: EventBridgeEnvelope): Promise<void> {
    const detailType = envelope['detail-type'];
    const detail = envelope.detail;
    const eventId = detail.eventId as string | undefined;

    if (!eventId) {
      console.warn('message without eventId skipped', {
        detailType,
        ...traceLogFields(),
      });
      return;
    }

    switch (detailType) {
      case 'EventListed':
      case 'EventUpdated': {
        // metadata だけを merge します。Ticket Type 在庫と version は削除・上書きしません
        // （EVENT_METADATA_SCRIPT。InventoryChanged 先着時も upsert で耐えます）。
        await applyEventMetadata(this.opensearch, EVENTS_INDEX, {
          eventId,
          title: detail.title,
          eventType: detail.eventType,
          startsAt: detail.startsAt,
          latitude: detail.latitude as number | null | undefined,
          longitude: detail.longitude as number | null | undefined,
          totalQuantity: detail.totalQuantity as number | null | undefined,
          remainingQuantity: detail.remainingQuantity as
            | number
            | null
            | undefined,
        });
        this.emitOutcome('EventMetadata', 'applied');
        console.log('indexed event', {
          eventId,
          detailType,
          ...traceLogFields(),
        });
        break;
      }
      case 'InventoryChanged': {
        // 壊れた versioned payload は parser が throw し、SQS message を削除させません。
        // version guard は OpenSearch 側の atomic scripted update が担います。
        const parsed = parseInventoryChangedDetail(detail);
        // review 3: OpenSearch の実 response を基に applied / stale / legacy_ignore を区別する。
        const outcome = await applyParsedInventoryChanged(
          this.opensearch,
          EVENTS_INDEX,
          parsed,
        );
        this.emitOutcome('InventoryChanged', outcome);
        console.log('updated inventory', {
          eventId,
          kind: parsed.kind,
          ...traceLogFields(),
        });
        break;
      }
      case 'TicketPurchased':
        // 在庫 projection の更新源は InventoryChanged に固定します。ここでは記録のみ行います。
        console.log('ticket purchased', { eventId, ...traceLogFields() });
        break;
      default:
        console.warn('unknown detail-type skipped', {
          detailType,
          ...traceLogFields(),
        });
    }
  }

  // emitOutcome は Worker の projection 処理結果を低カーディナリティ dimension で記録します
  // （Issue #377）。Operation / Outcome は有限集合のみで、ID や trace は dimension に含めません。
  private emitOutcome(
    operation: 'InventoryChanged' | 'EventMetadata',
    outcome: 'applied' | 'stale' | 'legacy_ignore' | 'error',
  ): void {
    emitMetric('ProjectionOutcome', 1, 'Count', {
      Operation: operation,
      Outcome: outcome,
    });
  }
}

// operationForDetailType は envelope の detail-type から ProjectionOutcome の Operation を
// 決定します（review 4）。error class からの逆算をやめ、catch へ入る前に決まる detail-type で
// 有限 Operation を選ぶ。TicketPurchased / unknown は無理に EventMetadata へ分類せず null を返す。
function operationForDetailType(
  detailType: string,
): 'InventoryChanged' | 'EventMetadata' | null {
  if (detailType === 'InventoryChanged') {
    return 'InventoryChanged';
  }
  if (detailType === 'EventListed' || detailType === 'EventUpdated') {
    return 'EventMetadata';
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
