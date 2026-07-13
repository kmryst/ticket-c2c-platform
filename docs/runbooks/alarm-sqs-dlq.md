# Runbook: SQS DLQ 滞留アラーム

対象: dev / staging の search-projection DLQ。Issue #100、Issue #200、Issue #254。

対象アラーム: `<name>-search-projection-dlq-messages-visible`（severity: Warning）

severity 分類・エスカレーション条件の全体方針は `docs/architecture/observability.md`「アラームの severity と escalation 方針（Issue #257）」節を正本とする。

## 影響範囲

Worker が `max_receive_count`（5 回）を超えて処理に失敗したメッセージが DLQ へ移動したことを示す。該当イベント（購入確定・イベント登録等）の検索プロジェクション（OpenSearch）反映が失われている状態。**データはまだ失われていない**（DLQ にメッセージとして残っている。redrive 可能）ため severity は Warning。

## 初動確認

1. CloudWatch Dashboard（`<name>-overview`）の「SQS DLQ: ApproximateNumberOfMessagesVisible」widget で滞留状況を確認する。
2. DLQ 内のメッセージ内容を確認し、どのイベント種別（`TicketPurchased` / `EventListed` 等）が失敗しているか特定する。
3. Worker ログで、対応する `messageId` の失敗理由（例外内容）を確認する。

## 主な原因候補

- OpenSearch への書き込み失敗が持続（インデックス不整合、マッピングエラー、OpenSearch 側の障害）。
- Worker のコードバグ（特定のイベント形式で必ず例外を投げる）。
- Worker タスクが処理前にクラッシュを繰り返している（`worker-cpu-high` / `worker-memory-high` の同時発報を確認）。
- 一時的な依存障害が `max_receive_count`（5 回、visibility timeout 60 秒 x 5 ≈ 5 分)以上継続した（一過性の障害でも DLQ に落ちる設計であることに注意）。

## 確認コマンド

```bash
# DLQ の滞留数
aws cloudwatch get-metric-statistics \
  --namespace AWS/SQS --metric-name ApproximateNumberOfMessagesVisible \
  --dimensions Name=QueueName,Value=<name>-search-projection-dlq \
  --start-time "$(date -u -d '-1 hour' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 300 --statistics Maximum

# DLQ からメッセージを覗く（削除しない。--visibility-timeout を短くして確認のみ）
aws sqs receive-message --queue-url <DLQ の URL> \
  --max-number-of-messages 10 --visibility-timeout 5 \
  --attribute-names All --message-attribute-names All

# Worker ログで該当 messageId の失敗理由を確認
aws logs start-query \
  --log-group-name "/ecs/<name>-worker" \
  --start-time "$(date -u -d '-2 hour' +%s)" --end-time "$(date -u +%s)" \
  --query-string 'fields @timestamp, @message | filter @message like /<messageId>/ | sort @timestamp desc'
```

## 復旧・緩和の判断

1. **原因を特定し、恒久修正をデプロイ済みの場合**: DLQ から本体キューへ redrive する。

   ```bash
   aws sqs start-message-move-task --source-arn <DLQ の ARN>
   ```

   redrive 後、DLQ のメッセージが本体キューに戻り Worker が再処理する。処理内容は eventId を doc ID とする OpenSearch upsert のため冪等（再配信による二重処理も収束する。`search-projection.worker.spec.ts` で担保）。
2. **原因が一時的な依存障害（OpenSearch の瞬断等）だった場合**: 依存サービスの復旧を確認したうえで redrive する。
3. **原因がコードバグの場合**: 修正をデプロイしてから redrive する（修正前に redrive すると同じ理由で再度 DLQ へ落ちる）。
4. redrive せず放置しても即座のデータ損失にはならないが（DLQ の `message_retention_seconds` は 14 日）、検索結果からは該当イベントが欠落し続けるため、原因調査と redrive はエスカレーション条件内で完了させる。

## エスカレーション条件

- **Warning**: 24 時間以内に原因確認・redrive 要否判断。
- 同一アラームが 1 週間に 3 回以上発報する場合は、Worker のエラーハンドリング・リトライ設計の見直しを Issue 化する。
- DLQ のメッセージ数が急増している（単発の失敗ではなく大量発生）場合は、Worker 全体の障害を疑い `alarm-worker-processing-lag.md` / `alarm-ecs-cpu-memory.md` と合わせて確認する。

## 関連

- Issue #100（DLQ アラーム導入）、Issue #200（通知配線）
- `docs/architecture/observability.md`「CloudWatch アラーム」節
- `src/worker/search-projection.worker.ts`（`pollOnce()` の逐次処理・冪等性）
