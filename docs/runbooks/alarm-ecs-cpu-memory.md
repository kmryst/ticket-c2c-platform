# Runbook: ECS CPU / Memory アラーム

対象: dev / staging の API / Worker / Frontend（ECS Fargate）。Issue #218、Issue #254。

対象アラーム:

- `<name>-api-cpu-high` / `<name>-api-memory-high`（severity: Warning）
- `<name>-worker-cpu-high` / `<name>-worker-memory-high`（severity: Warning）
- `<name>-frontend-cpu-high` / `<name>-frontend-memory-high`（severity: Warning）

severity 分類・エスカレーション条件の全体方針は `docs/architecture/observability.md`「アラームの severity と escalation 方針（Issue #257）」節を正本とする。

## 影響範囲

CPU / Memory の逼迫はスケール不足・OOM kill の前兆（Saturation）。放置すると `alb-5xx`（unhealthy hosts 経由）や購入 API のレイテンシ悪化につながりうる。単独では「まだユーザー影響が出ていない予兆」の段階のため severity は Warning。

## 初動確認

1. CloudWatch Dashboard（`<name>-overview`）の「ECS CPUUtilization」「ECS MemoryUtilization」widget でどのサービス（api / worker / frontend）が逼迫しているかを確認する。
2. 同時刻に `alb-5xx` / `unhealthy-hosts` / 購入 API 系アラームが発報していないか確認する（実害が出始めているかの判断材料）。
3. autoscaling が効いている staging full の API / Worker では、Application Auto Scaling の activity と max capacity 到達有無を確認する。

## 主な原因候補

- 実トラフィック増（staging full の API / Worker は想定内のスケールアウトで自然回復する可能性がある）。
- 負荷試験・意図的な高負荷操作の実施中（本番運用ではなく検証中の誤発火でないか確認）。
- 特定エンドポイントの高負荷処理（bcrypt を伴う signup、`GET /events` の DB 直読みなど、過去の実地検証（`docs/architecture/observability.md` dev 実地検証節）で CPU 高負荷の実例あり）。
- メモリリーク（時間経過とともに単調増加している場合は再起動での一時緩和 + 調査が必要）。
- dev と staging normal は autoscaling 対象外。staging full は API / Worker が CPU 60% の target tracking 対象で、Frontend は全 profile で autoscaling 対象外（ADR-0018 / Issue #234）。

## 確認コマンド

```bash
# CPU / Memory の推移
aws cloudwatch get-metric-statistics \
  --namespace AWS/ECS --metric-name CPUUtilization \
  --dimensions Name=ClusterName,Value=<name> Name=ServiceName,Value=<service-name> \
  --start-time "$(date -u -d '-1 hour' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 300 --statistics Average

# 現在の running/desired タスク数（autoscaling が働いているか）
aws ecs describe-services --cluster <name> --services <service-name> \
  --query 'services[].{running:runningCount,desired:desiredCount}'

# autoscaling のアクティビティ履歴
aws application-autoscaling describe-scaling-activities \
  --service-namespace ecs --resource-id service/<name>/<service-name>
```

## 復旧・緩和の判断

以下の `aws ecs update-service` は AWS リソースを変更する。対象環境、変更前の desired count / task definition、復旧値を記録し、実行承認を得てから使用する。手動 desired count は Application Auto Scaling や次回 Terraform apply で再変更され得る。

1. **一時的な負荷（想定内のトラフィック増・負荷試験）**: staging full の API / Worker は target tracking の activity を確認しながら経過観察する。dev / staging normal、または Frontend では desired count の一時引き上げを検討する。

   ```bash
   aws ecs update-service --cluster <name> --service <name>-worker --desired-count <N>
   ```

2. **メモリリーク疑い**: タスクの再起動で一時緩和しつつ、原因調査を別 Issue 化する。

   ```bash
   aws ecs update-service --cluster <name> --service <name>-worker --force-new-deployment
   ```

3. **恒常的なリソース不足**: task definition の cpu/memory 引き上げ、または autoscaling の `autoscaling_max_capacity` 引き上げを検討（コスト増を伴うため設計判断として記録する）。
4. **負荷試験・検証操作が原因と分かっている場合**: 負荷生成プロセスを直ちに停止する（過去の dev 実地検証と同じ運用。ECS CPU / Aurora CPU・ACU near max は ALARM 確認後即負荷停止する方針で合意済み）。

## エスカレーション条件

- 基本 Warning: 24 時間以内に確認。
- `alb-5xx` / `unhealthy-hosts` / 購入 API 系アラームと同時発報している場合は、実害が出ている可能性が高いため当日中の優先対応とする。
- 同一アラームが 1 週間に 3 回以上発報する場合は、リソース割り当て見直しを Issue 化する。

## 関連

- Issue #218（Golden Signals アラーム導入）
- `terraform/modules/ecs-service/main.tf`（アラーム定義、autoscaling 設定）
- `docs/adr/0018-ecs-autoscaling-scoped-to-staging-full.md`（autoscaling の適用範囲）
