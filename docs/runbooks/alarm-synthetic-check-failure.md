# Runbook: synthetic-check-failure（CloudFront 経由の外形監視失敗）

対象: dev / staging（https-dns モード時）の CloudWatch Synthetics canary（us-east-1）。Issue #256、Issue #272。

対象アラーム:

- `<name>-synthetic-check-failure`（severity: Critical）

severity 分類・エスカレーション条件の全体方針は `docs/architecture/observability.md`「アラームの severity と escalation 方針（Issue #257）」節を正本とする。通知先 SNS トピック（`<name>-edge-alerts`）は us-east-1 に別建てされている点に注意（Tokyo 側の `<name>-alerts` とは別系統。L-16 設計判断）。

## 影響範囲

CloudFront 経由の代表 read-only 経路の外形監視（`terraform/modules/synthetics-canary`）が失敗している。単一の multi-step canary が `app_fqdn` に対して以下 3 step を順に GET しており、いずれか 1 つでも 2xx 以外を返すと canary 全体が失敗として記録される。

| step | path | 内容 |
|---|---|---|
| `healthzCheck` | `/api/healthz` | 軽量到達確認（liveness） |
| `frontendHtmlCheck` | `/` | frontend（Next.js SSR）の HTML 到達確認 |
| `apiReadEndpointCheck` | `/api/events` | API の代表 read endpoint（認証不要） |

内部メトリクス（ALB / ECS / Aurora）が正常でもこのアラームだけ発報する場合、内部監視では検知できない外形障害（DNS / CDN / WAF 誤設定・証明書問題など）の可能性が高い。ユーザー入口そのものの到達性喪失を示すシグナルであり、放置すると全ユーザー影響になる。

## 初動確認

1. CloudWatch Dashboard（`<name>-overview`）で、入口（CloudFront / WAF）→ ALB → ECS → Aurora のどの層に異常が出ているかを横断確認する。
2. CloudWatch Synthetics コンソール（us-east-1）で canary（`<name>-synthetic-check`）の直近 run 結果を開き、**どの step で失敗したか**（healthz / frontend HTML / API read）と失敗理由（ステータスコード・タイムアウト・DNS 解決失敗）を特定する。
3. CloudFront / WAF / ALB 側アラーム（`cloudfront-5xx-rate` / `waf-block` / `alb-5xx` / `unhealthy-hosts` 系）が同時に ALARM 状態か確認する。併発の有無が切り分けの起点になる。

## 主な原因候補

- **CloudFront / DNS / 証明書側**: alias ドメインの DNS 解決失敗、ACM 証明書の期限切れ、CloudFront distribution の設定変更ミス（`cloudfront-5xx-rate` と併発しやすい）。
- **WAF の誤ブロック**: マネージドルールが canary のリクエストを false positive でブロック（`waf-block` と併発しやすい）。
- **ALB / ECS / API 側の障害**: origin 自体が落ちている（`alb-5xx` / `unhealthy-hosts` と併発する。この場合 synthetic は「内部障害の外形への波及」を示しているだけ）。
- **canary script / endpoint path の不整合**: アプリ側のルーティング変更（`/api` プレフィックス写像・`stripApiPrefix` の変更等）に canary の step 定義が追従していない。環境は正常なのに canary だけ失敗するパターン。

## 確認コマンド

```bash
# canary の状態・直近 run 結果（us-east-1 を明示）
aws synthetics get-canary --region us-east-1 --name <name>-synthetic-check

aws synthetics get-canary-runs --region us-east-1 --name <name>-synthetic-check \
  --max-results 10 \
  --query 'CanaryRuns[].{name:Name,status:Status.State,reason:Status.StateReason,started:Timeline.Started}'

# SuccessPercent メトリクスの推移
aws cloudwatch get-metric-statistics --region us-east-1 \
  --namespace CloudWatchSynthetics --metric-name SuccessPercent \
  --dimensions Name=CanaryName,Value=<name>-synthetic-check \
  --start-time "$(date -u -d '-1 hour' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 300 --statistics Average

# 手動での外形再現（canary と同じ 3 step）
curl -sS -o /dev/null -w '%{http_code}\n' https://<app_fqdn>/api/healthz
curl -sS -o /dev/null -w '%{http_code}\n' https://<app_fqdn>/
curl -sS -o /dev/null -w '%{http_code}\n' https://<app_fqdn>/api/events

# 併発アラームの確認
aws cloudwatch describe-alarms --state-value ALARM \
  --query 'MetricAlarms[].{name:AlarmName,updated:StateUpdatedTimestamp}'
aws cloudwatch describe-alarms --region us-east-1 --state-value ALARM \
  --query 'MetricAlarms[].{name:AlarmName,updated:StateUpdatedTimestamp}'
```

失敗 run の詳細（HAR ファイル・スクリーンショット・ログ）は canary のアーティファクト S3 バケット（`<name>-synthetics-artifacts`）にも保存されている。

## 復旧・緩和の判断

1. **CloudFront / WAF 側が原因の場合**（`cloudfront-5xx-rate` / `waf-block` と併発、または DNS・証明書・distribution 設定の問題）: `alarm-cloudfront-waf-edge.md` の runbook に従う。
2. **ALB / ECS / API 側が原因の場合**（`alb-5xx` / `unhealthy-hosts` / ECS 系と併発）: `alarm-alb.md` / `alarm-ecs-cpu-memory.md` など対応する runbook に従う。synthetic 側は origin 復旧後に自然回復する。
3. **canary script / endpoint path の不整合が原因の場合**（環境は正常、手動 curl は成功するのに canary だけ失敗）: canary の step 定義（`terraform/modules/synthetics-canary`）とアプリのルーティングの乖離を特定し、Terraform / script 修正を Issue 化して対応する（インシデントではなく監視側の保守）。

## エスカレーション条件

- **Critical**: 通知受信次第、1 時間以内に状況確認を開始する。
- **`cloudfront-5xx-rate` または `alb-5xx` と併発している場合はユーザー影響ありとして扱う**（外形監視の失敗が実トラフィックの失敗と一致している状態）。直近デプロイ起因なら rollback を第一手段とする。
- ALARM が 1 時間以上 OK 復帰しない場合は、影響範囲を記録し復旧を最優先タスク化する（他作業中断）。

## 関連

- L-19（production-readiness.md）、Issue #256（実装）、Issue #272（runbook 追加）
- `docs/architecture/observability.md`「CloudFront 経由の外形監視（synthetic monitoring。Issue #256）」節
- `docs/runbooks/alarm-cloudfront-waf-edge.md`（edge 側の切り分け先）
- `terraform/modules/synthetics-canary/main.tf` の `aws_cloudwatch_metric_alarm.synthetic_check_failure`
