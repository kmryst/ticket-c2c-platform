# Runbook: 購入 API SLO / burn-rate / technical_failure アラーム

対象: dev / staging の API（ECS Fargate）。ADR-0016 / ADR-0017、Issue #227、Issue #254。

対象アラーム:

- `<name>-purchase-error-burn-rate-fast`（severity: Critical）
- `<name>-purchase-error-burn-rate-slow`（severity: Warning）
- `<name>-purchase-technical-failure-weak`（severity: Info）
- `<name>-purchase-technical-failure-normal`（severity: Warning）
- `<name>-purchase-latency-burn-rate-fast`（severity: Warning）
- `<name>-purchase-latency-burn-rate-slow`（severity: Warning）

severity 分類・初動目標・エスカレーション条件の全体方針は `docs/architecture/observability.md`「アラームの severity と escalation 方針（Issue #257）」節を正本とする。本 runbook はこのアラーム群固有の初動確認・原因切り分け手順を記録する。

## 影響範囲

`POST /events/:eventId/purchases`（購入確定 API）のユーザー体験。C2C チケット販売の中核フローであり、失敗はそのまま「購入できない」というユーザー影響に直結する。error 系（burn-rate / technical_failure）は成功率 SLO（99.5%）の逸脱、latency 系はレイテンシ SLO（p95 < 800ms、`Outcome=success` のみ）の逸脱を示す。

- `-weak` は低頻度時の早期シグナル（単発では対応不要。ADR-0017）。
- `-normal` / `-fast` / `-slow` は持続的な逸脱で、実際にユーザーが購入に失敗している状態。

## 初動確認

1. CloudWatch Dashboard（`<name>-overview`、Issue #253）の「購入 API: 成功率 / technical_failure」「購入 API: レイテンシ p95」widget で現在の傾向を確認する。
2. どのアラームが発報しているか（error 系か latency 系か、fast か slow か）で疑うべき層が変わる。
   - error 系（`-error-burn-rate-*` / `-technical_failure-*`）→ アプリ / DB / 依存サービスで例外が発生している。
   - latency 系（`-latency-burn-rate-*`）→ 成功はしているが遅い。DB 接続プール逼迫・Aurora 負荷・外部依存の遅延を疑う。
3. 同時刻に `alb-5xx` / `aurora-cpu-high` / `aurora-connections-high` / `aurora-acu-near-max` が ALARM か確認する（併発エスカレーション。下記参照）。

## 主な原因候補

- Aurora 接続プール枯渇・Aurora 側の高負荷（`aurora-connections-high` / `aurora-cpu-high` / `aurora-acu-near-max` の同時発報を確認）。
- 直近デプロイでのリグレッション（バリデーション・DB クエリ・外部呼び出しの変更）。
- Valkey 障害による fail-open（`ValkeyFailOpen` の同時発報を確認。前段フィルタが無効化され Aurora へ直接負荷がかかる）。
- レート制限（`invalid_request` / `rate_limited` は分母から除外されるため本アラームの直接原因にはならないが、同時に大量の 429 が出ていないか `PurchaseRequestOutcome`（Outcome=rate_limited）も確認する）。
- 依存サービス（EventBridge / SQS）の障害によるタイムアウト。

## 確認コマンド

```bash
# 直近の成功率・technical_failure 件数を確認（named profile / region は環境に合わせる）
aws cloudwatch get-metric-statistics \
  --namespace TicketC2C/<env> --metric-name PurchaseRequestOutcome \
  --dimensions Name=Service,Value=api Name=Outcome,Value=technical_failure \
  --start-time "$(date -u -d '-30 min' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 300 --statistics Sum

# レイテンシ p95（Outcome=success）
aws cloudwatch get-metric-statistics \
  --namespace TicketC2C/<env> --metric-name PurchaseRequestLatencyMs \
  --dimensions Name=Service,Value=api Name=Outcome,Value=success \
  --start-time "$(date -u -d '-30 min' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 300 --extended-statistics p95

# API タスクの直近ログから technical_failure の例外内容を確認（CloudWatch Logs Insights）
aws logs start-query \
  --log-group-name "/ecs/<name>-api" \
  --start-time "$(date -u -d '-30 min' +%s)" --end-time "$(date -u +%s)" \
  --query-string 'fields @timestamp, @message | filter @message like /technical_failure/ | sort @timestamp desc | limit 50'

# 同時刻の Aurora / Valkey 系アラーム状態を確認（併発エスカレーション判断）
aws cloudwatch describe-alarms --alarm-name-prefix "<name>-aurora" --state-value ALARM
aws cloudwatch describe-alarms --alarm-names "<name>-valkey-fail-open" --state-value ALARM
```

## 復旧・緩和の判断

1. **直近デプロイが原因と判断できる場合**: rollback を第一手段とする（severity Critical の初動目標どおり 1 時間以内）。

   ```bash
   aws ecs update-service --cluster <name> --service <name>-api \
     --task-definition <ロールバック先の task definition ARN>
   aws ecs wait services-stable --cluster <name> --services <name>-api
   ```

2. **Aurora 側の高負荷が原因の場合**: `aurora-connections-high` / `aurora-acu-near-max` の runbook（`alarm-aurora.md`）へ切り替える。API 側の緊急対応としては、desired_count を一時的に下げて Aurora への負荷を減らすことも選択肢（トレードオフ: スループット低下）。
3. **Valkey fail-open が原因の場合**: `alarm-valkey-fail-open.md` の runbook へ切り替える。
4. 原因が特定できない場合は、まず影響範囲（どの operation・どのユーザー層か）を記録し、OK 復帰を待ちながら調査を継続する。

## エスカレーション条件

- **Critical（`-error-burn-rate-fast`）**: 通知受信次第、1 時間以内に状況確認開始。1 時間以上 OK 復帰しない場合は復旧を最優先タスク化。
- **Warning（`-error-burn-rate-slow` / `-technical_failure-normal` / `-latency-burn-rate-*`）**: 24 時間以内に原因確認。同一アラームが 1 週間に 3 回以上発報したら恒久対策を Issue 化。
- **Info（`-technical_failure-weak`）**: 対応不要。24 時間に 3 回以上発報する場合のみ、`-normal` 相当として調査する。
- 併発エスカレーション: `alb-5xx` と同時 ALARM の場合はユーザー影響が確定しているため即座に Critical 扱いとする。

## 関連

- ADR-0016（SLI 定義）、ADR-0017（SLO / burn-rate 設計）
- `docs/architecture/observability.md`「購入 API の SLO 目標値と burn-rate アラート」節
- `src/observability/request-outcome.interceptor.ts`（`PurchaseRequestOutcome` / `PurchaseRequestLatencyMs` の計測実装）
