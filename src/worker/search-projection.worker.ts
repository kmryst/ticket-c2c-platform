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
} from '../observability/trace-context';
// emitMetric は Worker の処理遅延メトリクス（EMF）を出します（ADR-0014）。
import { emitMetric } from '../observability/emf';
// createOpenSearchClient は AWS 上では SigV4 署名付きクライアントを返します（production-readiness M-3）。
import { createOpenSearchClient } from '../opensearch';
import { EVENTS_INDEX } from '../search/search.service';

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

  // ensureIndex は初回起動時に geo_point を含む mapping で index を作成します。
  private async ensureIndex(): Promise<void> {
    const exists = await this.opensearch.indices.exists({
      index: EVENTS_INDEX,
    });
    if (exists.body) {
      return;
    }
    await this.opensearch.indices.create({
      index: EVENTS_INDEX,
      body: {
        mappings: {
          properties: {
            event_id: { type: 'keyword' },
            title: { type: 'text' },
            event_type: { type: 'keyword' },
            starts_at: { type: 'date' },
            location: { type: 'geo_point' },
            total_quantity: { type: 'integer' },
            remaining_quantity: { type: 'integer' },
          },
        },
      },
    });
    console.log(`created index: ${EVENTS_INDEX}`);
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
      console.warn('message without eventId skipped', { detailType });
      return;
    }

    switch (detailType) {
      case 'EventListed':
      case 'EventUpdated': {
        // イベント全体を upsert します。lat/lon がない場合 location は持ちません。
        const doc: Record<string, unknown> = {
          event_id: eventId,
          title: detail.title,
          event_type: detail.eventType,
          starts_at: detail.startsAt,
          total_quantity: detail.totalQuantity,
          remaining_quantity: detail.remainingQuantity,
        };
        if (detail.latitude != null && detail.longitude != null) {
          doc.location = { lat: detail.latitude, lon: detail.longitude };
        }
        await this.opensearch.index({
          index: EVENTS_INDEX,
          id: eventId,
          body: doc,
          refresh: true,
        });
        console.log('indexed event', { eventId, detailType });
        break;
      }
      case 'InventoryChanged': {
        // 残在庫のみの部分更新です。イベント本体が未投入でも upsert で耐えます。
        await this.opensearch.update({
          index: EVENTS_INDEX,
          id: eventId,
          body: {
            doc: {
              event_id: eventId,
              remaining_quantity: detail.remainingQuantity,
            },
            doc_as_upsert: true,
          },
          refresh: true,
        });
        console.log('updated inventory', {
          eventId,
          remainingQuantity: detail.remainingQuantity,
        });
        break;
      }
      case 'TicketPurchased':
        // 検索プロジェクションの在庫更新は InventoryChanged が担うため、ここでは記録のみ行います。
        console.log('ticket purchased', { eventId });
        break;
      default:
        console.warn('unknown detail-type skipped', { detailType });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
