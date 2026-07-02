// ファイル概要:
// このファイルは EventBridge へドメインイベントを発行する service です。
// EVENT_BUS_NAME 未設定時（ローカル PoC）は no-op になります。
// イベント発行の失敗は購入・登録処理を失敗させず、ログのみ残します（プロジェクションは結果整合）。

import { Injectable } from '@nestjs/common';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import { getOptionalEnv } from '../config';

// DomainEventType は technology-stack.md で定義したドメインイベントです。
export type DomainEventType =
  | 'EventListed'
  | 'EventUpdated'
  | 'InventoryChanged'
  | 'TicketPurchased';

@Injectable()
export class DomainEventsService {
  private readonly client: EventBridgeClient | null;
  private readonly busName: string | undefined;
  private readonly source = getOptionalEnv('EVENT_SOURCE') ?? 'ticket-c2c.api';

  constructor() {
    this.busName = getOptionalEnv('EVENT_BUS_NAME');
    this.client = this.busName ? new EventBridgeClient({}) : null;
  }

  // publish はドメインイベントを 1 件発行します。失敗しても throw しません。
  async publish(
    detailType: DomainEventType,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!this.client || !this.busName) {
      return;
    }
    try {
      await this.client.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: this.busName,
              Source: this.source,
              DetailType: detailType,
              Detail: JSON.stringify(detail),
            },
          ],
        }),
      );
    } catch (error) {
      // イベント発行失敗で API 応答を失敗させない。検索プロジェクションは次のイベントで追いつきます。
      console.error(`EventBridge publish failed (${detailType}):`, error);
    }
  }
}
