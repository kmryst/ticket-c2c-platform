# Runbook: ALB 5xx / unhealthy hosts アラーム

対象: dev / staging の ALB。Issue #218、Issue #254。

対象アラーム:

- `<name>-alb-5xx`（severity: Critical）
- `<name>-alb-api-unhealthy-hosts`（severity: 基本 Warning。`alb-5xx` と同時 ALARM の場合は Critical）
- `<name>-alb-frontend-unhealthy-hosts`（severity: 基本 Warning。`alb-5xx` と同時 ALARM の場合は Critical）

severity 分類・エスカレーション条件の全体方針は `docs/architecture/observability.md`「アラームの severity と escalation 方針（Issue #257）」節を正本とする。

## 影響範囲

ALB は API / frontend への唯一の入口（CloudFront の origin）。5xx はユーザーへのエラー応答そのもの、unhealthy hosts はタスクのヘルスチェック失敗（`/healthz`）を示す。

- `alb-5xx` は `HTTPCode_Target_5XX_Count`（アプリが 5xx を返した）と `HTTPCode_ELB_5XX_Count`（ALB 自身がターゲット未接続・タイムアウトで 5xx を返した）の合算。
- unhealthy hosts は staging の `capacity_profile=full`（2 タスク構成、AZ 跨ぎ failover 検証用）では **1 台 unhealthy が即ユーザー影響とは限らない**（縮退状態。もう 1 台が捌けている可能性がある）。このため基本 severity は Warning とし、`alb-5xx` の同時発報でユーザー影響が確定した場合のみ Critical へ格上げする運用（Composite Alarm は実装せず、確認手順として本 runbook に記載）。

## 初動確認

1. CloudWatch Dashboard（`<name>-overview`）の「ALB: 5xx / UnHealthyHostCount」widget で現在の傾向を確認する。
2. `alb-5xx` と `unhealthy-hosts` が同時に ALARM かどうかを確認する（併発エスカレーション判定）。
3. target group（api / frontend）ごとのヘルスチェック状態を確認する。

## 主な原因候補

- API / frontend タスクのクラッシュ・OOM kill（`ecs-{api,worker,frontend}-{cpu,memory}-high` の同時発報を確認）。
- 直近デプロイでのリグレッション（`/healthz` が 200 を返さなくなった等）。
- Aurora / Valkey / OpenSearch など依存サービス障害によるアプリケーションエラー（`/healthz` は DB を触らない liveness のみのため、依存障害単体では unhealthy にならないことに注意。5xx のみ発生している場合はこちら側を疑う）。
- security group / ネットワーク変更（ALB → ECS タスクの経路が塞がれている）。
- デプロイ中の一時的なタスク入れ替わり（2 期間・5 分 x 2 = 10 分継続の条件のため、通常のローリングデプロイでは誤発火しない設計だが、デプロイが長引いている場合は要確認）。

## 確認コマンド

```bash
# target group のヘルスチェック状態
aws elbv2 describe-target-health --target-group-arn <api または frontend の target group ARN>

# ECS サービスの直近イベント（タスク起動失敗・デプロイ状況）
aws ecs describe-services --cluster <name> --services <name>-api <name>-frontend \
  --query 'services[].{name:serviceName,running:runningCount,desired:desiredCount,events:events[:5]}'

# ALB 5xx の内訳（target 起因 / ALB 起因）
aws cloudwatch get-metric-statistics \
  --namespace AWS/ApplicationELB --metric-name HTTPCode_Target_5XX_Count \
  --dimensions Name=LoadBalancer,Value=<alb arn_suffix> \
  --start-time "$(date -u -d '-30 min' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 300 --statistics Sum

# アプリログでエラー内容を確認
aws logs start-query \
  --log-group-name "/ecs/<name>-api" \
  --start-time "$(date -u -d '-30 min' +%s)" --end-time "$(date -u +%s)" \
  --query-string 'fields @timestamp, @message | filter @message like /ERROR/ | sort @timestamp desc | limit 50'

# 併発エスカレーション判定
aws cloudwatch describe-alarms --alarm-names "<name>-alb-5xx" --state-value ALARM
```

## 復旧・緩和の判断

以下の `aws ecs update-service` は AWS リソースを変更する。対象環境、対象サービス、変更前の task definition / desired count、復旧値を記録し、実行承認を得てから使用する。

1. **直近デプロイが原因の場合**: rollback（`deployment_circuit_breaker` により壊れたデプロイは自動 rollback される設計だが、`/healthz` 自体は 200 を返しつつ機能不全のケースは自動検知されないため手動 rollback を検討）。

   ```bash
   aws ecs update-service --cluster <name> --service <service-name> \
     --task-definition <ロールバック先の task definition ARN>
   ```

2. **タスク数不足（縮退）の場合**: `desired_count` を一時的に増やす、または `force-new-deployment` でタスクを再起動する。

   ```bash
   aws ecs update-service --cluster <name> --service <service-name> --force-new-deployment
   ```

3. **依存サービス障害が原因の場合**: 該当サービス（Aurora / Valkey / OpenSearch）の runbook へ切り替える。

## エスカレーション条件

- **Critical（`alb-5xx`、または `unhealthy-hosts` が `alb-5xx` と併発）**: 通知受信次第、1 時間以内に状況確認開始。
- **Warning（`unhealthy-hosts` 単独）**: 24 時間以内に確認。縮退状態が続く場合はタスク再起動やスケール調整を検討。24 時間経過しても OK 復帰しない場合は Critical 相当として扱う。
- 同一アラームが 1 週間に 3 回以上発報する場合は恒久対策を Issue 化する。

## 関連

- Issue #218（Golden Signals アラーム導入）
- `terraform/modules/alb/main.tf`（アラーム定義）
- `docs/architecture/observability.md`「CloudWatch アラーム」節
