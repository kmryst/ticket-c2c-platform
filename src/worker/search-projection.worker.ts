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
    this.opensearch = new Client({ node: `https://${opensearchEndpoint}` });
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
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (!message.Body) {
      return;
    }
    const envelope = JSON.parse(message.Body) as EventBridgeEnvelope;
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
