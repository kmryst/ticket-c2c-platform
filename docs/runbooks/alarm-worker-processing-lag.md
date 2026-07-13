# Runbook: WorkerProcessingLagMs アラーム

対象: dev / staging の Worker（ECS Fargate）。Issue #218、Issue #254。

対象アラーム: `<name>-worker-processing-lag`（severity: Warning）

severity 分類・エスカレーション条件の全体方針は `docs/architecture/observability.md`「アラームの severity と escalation 方針（Issue #257）」節を正本とする。

## 影響範囲

`WorkerProcessingLagMs` は SQS 送信から Worker の処理完了（削除）までの経過時間（p90）。検索プロジェクション（OpenSearch）の鮮度劣化を示す。DLQ アラーム（処理失敗）とは別軸の「遅いが失敗していない」検知。ユーザー影響としては、イベント登録・購入確定直後の検索結果への反映が遅れる（購入フロー自体は同期処理のため影響しない）。

## 初動確認

1. CloudWatch Dashboard（`<name>-overview`）の「ValkeyFailOpen / WorkerProcessingLagMs (EMF)」widget で傾向を確認する。
2. SQS キューの `ApproximateNumberOfMessagesVisible`（DLQ ではなく本体キュー）が積み上がっていないか確認する（Worker のスループット不足の兆候）。
3. Worker タスクの CPU / Memory / running count を確認する（`alarm-ecs-cpu-memory.md` の worker 該当箇所）。

## 主な原因候補

- Worker タスクの詰まり・スループット不足（CPU 逼迫、OpenSearch への書き込み遅延）。
- Worker タスク数の不足（desired_count が低いまま流入量が増えた）。
- OpenSearch 側の負荷・レイテンシ増（インデックス書き込みが遅い）。
- EventBridge → SQS の配信遅延（通常は稀だが、大量イベント発火時に発生しうる）。
- Worker のデプロイ中断・再起動が頻発している（`deployment_circuit_breaker` のロールバックが繰り返されている等）。

## 確認コマンド

```bash
# WorkerProcessingLagMs の推移
aws cloudwatch get-metric-statistics \
  --namespace TicketC2C/<env> --metric-name WorkerProcessingLagMs \
  --dimensions Name=Service,Value=worker \
  --start-time "$(date -u -d '-1 hour' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 300 --extended-statistics p90

# SQS 本体キューの滞留状況
aws cloudwatch get-metric-statistics \
  --namespace AWS/SQS --metric-name ApproximateNumberOfMessagesVisible \
  --dimensions Name=QueueName,Value=<name>-search-projection \
  --start-time "$(date -u -d '-1 hour' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 300 --statistics Maximum

# Worker タスクの稼働状況
aws ecs describe-services --cluster <name> --services <name>-worker \
  --query 'services[].{running:runningCount,desired:desiredCount,events:events[:5]}'

# Worker ログでエラー・処理時間の内訳を確認
aws logs start-query \
  --log-group-name "/ecs/<name>-worker" \
  --start-time "$(date -u -d '-30 min' +%s)" --end-time "$(date -u +%s)" \
  --query-string 'fields @timestamp, @message | filter @message like /ERROR/ | sort @timestamp desc | limit 50'
```

## 復旧・緩和の判断

1. **Worker のスループット不足が原因の場合**: `desired_count` を一時的に増やす。

   ```bash
   aws ecs update-service --cluster <name> --service <name>-worker --desired-count <N>
   ```

2. **OpenSearch 側の負荷が原因の場合**: OpenSearch のメトリクス（CPUUtilization / JVMMemoryPressure 等、本アラーム群の対象外だが AWS/ES namespace で確認可能）を確認し、必要であればインスタンスタイプ・台数の見直しを検討。
3. **一時的なイベント急増が原因の場合**: 経過観察で自然回復するか確認する（Worker は SQS ベースのため、詰まりが解消すれば自動的に追いつく）。
4. lag が解消しない場合、検索結果の鮮度が劣化した状態が続くことをユーザー影響として記録する（データ損失ではなく遅延のため、緊急停止等は不要）。

## エスカレーション条件

- **Warning**: 24 時間以内に確認。24 時間 OK 復帰しない場合は Critical 相当として扱う。
- 同一アラームが 1 週間に 3 回以上発報する場合は、Worker のキャパシティ設計（desired_count・autoscaling 導入要否）を Issue 化する。

## 関連

- Issue #218（EMF ビジネスメトリクスのアラーム導入）
- `docs/architecture/observability.md`「ビジネスメトリクス（CloudWatch EMF）」節
- `src/worker/search-projection.worker.ts`（実装）
