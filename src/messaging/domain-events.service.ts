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
// injectTraceContext は現在の trace を EventBridge detail へ同梱するための helper です（ADR-0014）。
// traceLogFields は発行失敗ログに trace id / span id を付与します（Issue #255）。
import {
  injectTraceContext,
  TRACE_CONTEXT_FIELD,
  traceLogFields,
} from '../observability/trace-context';
// emitMetric は publish 結果を低カーディナリティ metric（EMF）で記録します（Issue #377）。
import { emitMetric } from '../observability/emf';

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

    // 現在の trace context を detail に同梱します（ADR-0014）。EventBridge → SQS には
    // trace header を運ぶ仕組みがないため、detail 内の予約フィールドで Worker まで届けます。
    // トレーシング無効時（ローカル PoC）は undefined になり、detail は従来のままです。
    const traceContext = injectTraceContext();
    const detailWithTrace = traceContext
      ? { ...detail, [TRACE_CONTEXT_FIELD]: traceContext }
      : detail;

    try {
      const response = await this.client.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: this.busName,
              Source: this.source,
              DetailType: detailType,
              Detail: JSON.stringify(detailWithTrace),
            },
          ],
        }),
      );

      // HTTP 成功でも FailedEntryCount > 0 / entry error を見逃さない（Issue #377）。
      // Purchase transaction や成功済み API response は rollback しない（結果整合の projection）。
      const failedEntry = (response.Entries ?? []).find(
        (entry) => entry.ErrorCode || entry.ErrorMessage,
      );
      if ((response.FailedEntryCount ?? 0) > 0 || failedEntry) {
        // entry error の ErrorCode（AWS 側の有限集合）だけを log 属性として残す。
        // ErrorMessage は payload 断片を含み得るため log にも metric dimension にも出さない。
        console.error('EventBridge publish returned entry failure', {
          detailType,
          errorCode: failedEntry?.ErrorCode,
          ...traceLogFields(),
        });
        this.emitPublishOutcome(detailType, 'partial_failure');
        return;
      }
      this.emitPublishOutcome(detailType, 'success');
    } catch (error) {
      // イベント発行失敗で API 応答を失敗させない。次のイベントで追いつく場合はあるが、
      // 最終イベントが欠損すると projection は古いまま残る。
      // detailType / trace id を構造化フィールドで残し、発行元リクエストの trace へ辿れるようにします（Issue #255）。
      console.error(
        'EventBridge publish failed',
        { detailType, ...traceLogFields() },
        error,
      );
      this.emitPublishOutcome(detailType, 'sdk_error');
    }
  }

  // emitPublishOutcome は publish 結果を低カーディナリティ metric で記録します（Issue #377）。
  // dimension は DetailType（有限集合）と Outcome（success / partial_failure / sdk_error）だけ。
  // eventId / ticketTypeId / trace id / error message は dimension に含めません。
  private emitPublishOutcome(
    detailType: DomainEventType,
    outcome: 'success' | 'partial_failure' | 'sdk_error',
  ): void {
    emitMetric('DomainEventPublish', 1, 'Count', {
      DetailType: detailType,
      Outcome: outcome,
    });
  }
}
