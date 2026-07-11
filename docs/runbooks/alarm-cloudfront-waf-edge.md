# Runbook: CloudFront / WAF edge アラーム

対象: staging（https-dns モード時）/ dev の CloudFront + WAFv2（scope=CLOUDFRONT、us-east-1）。L-16、Issue #252、Issue #254。

対象アラーム:

- `<name>-cloudfront-5xx-rate`（severity: Critical）
- `<name>-cloudfront-origin-latency`（severity: Warning）
- `<name>-waf-block`（severity: Warning）

severity 分類・エスカレーション条件の全体方針は `docs/architecture/observability.md`「アラームの severity と escalation 方針（Issue #257）」節を正本とする。通知先 SNS トピック（`<name>-edge-alerts`）は us-east-1 に別建てされている点に注意（Tokyo 側の `<name>-alerts` とは別系統。L-16 設計判断）。

## 影響範囲

CloudFront はユーザー入口そのもの（ALB は CloudFront 経由以外から到達できない。ADR-0013）。

- `cloudfront-5xx-rate` はユーザー入口の広範な障害を示す（origin 全体の障害、CloudFront 設定ミス等）。
- `cloudfront-origin-latency` は購入 API 以外も含む全経路（検索・イベント一覧・SSR ページロード）のバックエンド遅延。
- `waf-block` は「WAF が防御に成功している」シグナル（攻撃を検知しブロックできている）。ブロックそのものはユーザー影響ではないが、攻撃規模の把握のため即座に確認する。

## 初動確認

1. CloudWatch Dashboard（`<name>-overview`）の「CloudFront: Requests / 5xxErrorRate」「CloudFront Origin Latency (p90) / WAF BlockedRequests」widget（us-east-1 リージョンのメトリクス）で状況を確認する。
2. `cloudfront-5xx-rate` の場合、ALB 側（`alb-5xx`）も同時に ALARM か確認する。CloudFront 側のみ 5xx が出ている場合は CloudFront ⇔ ALB 間（origin 接続、証明書、WAF ブロック）を疑う。
3. `waf-block` の場合、ブロックされたリクエストの送信元・ルールを CloudFront / WAF ログ（S3、L-12 / Issue #185）で確認する。

## 主な原因候補

**5xx / latency 系**:
- origin（ALB）自体の障害（`alarm-alb.md` の runbook を参照）。
- CloudFront ⇔ origin 間の TLS/証明書エラー（ACM 証明書の期限切れ・ドメイン不一致）。
- WAF のマネージドルールが正規リクエストを誤ブロックしている（false positive）。

**WAF block 系**:
- 実際の攻撃（bot・脆弱性スキャン・IP reputation 該当）。マネージドルール（CommonRuleSet / KnownBadInputsRuleSet / AmazonIpReputationList）による正常な防御。
- 正規クライアントの誤検知（false positive。特定のリクエストパターンが繰り返しブロックされていないか確認）。

## 確認コマンド

```bash
# CloudFront 5xx 率・origin latency（us-east-1 を明示）
aws cloudwatch get-metric-statistics --region us-east-1 \
  --namespace AWS/CloudFront --metric-name 5xxErrorRate \
  --dimensions Name=DistributionId,Value=<distribution id> Name=Region,Value=Global \
  --start-time "$(date -u -d '-1 hour' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 300 --statistics Average

aws cloudwatch get-metric-statistics --region us-east-1 \
  --namespace AWS/CloudFront --metric-name OriginLatency \
  --dimensions Name=DistributionId,Value=<distribution id> Name=Region,Value=Global \
  --start-time "$(date -u -d '-1 hour' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 300 --extended-statistics p90

# WAF ブロック数（WebACL 全体）
aws cloudwatch get-metric-statistics --region us-east-1 \
  --namespace AWS/WAFV2 --metric-name BlockedRequests \
  --dimensions Name=WebACL,Value=<name>-app-waf Name=Rule,Value=ALL \
  --start-time "$(date -u -d '-1 hour' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 300 --statistics Sum

# WAF ログから直近のブロック内容を確認（S3 直接配信。L-12 / Issue #185）
aws s3 ls s3://aws-waf-logs-<name>/ --recursive | tail -20

# CloudFront distribution の状態・証明書確認
aws cloudfront get-distribution --id <distribution id> \
  --query 'Distribution.{status:Status,domainName:DomainName}'
```

## 復旧・緩和の判断

1. **origin（ALB）障害が原因の場合**: `alarm-alb.md` の runbook に従う。
2. **証明書・TLS エラーが原因の場合**: ACM 証明書の有効期限・DNS 検証状態を確認し、必要であれば再発行（`terraform apply` を伴うため、通常のインシデント対応より慎重な手順が必要。ユーザー確認のうえで実施）。
3. **WAF の false positive が原因の場合**: 該当ルールを一時的に count モードへ切り替える、または特定パターンの許可ルールを追加する（Terraform 変更を伴うため、即応が必要な場合でも変更内容をレビューしてから apply する）。
4. **実際の攻撃（true positive）の場合**: WAF が正常に機能している状態のため、追加対応は不要。攻撃規模・パターンを記録し、必要であれば追加のマネージドルール導入を検討（Issue 化）。

## エスカレーション条件

- **Critical（`cloudfront-5xx-rate`）**: 通知受信次第、1 時間以内に状況確認開始。`alb-5xx` と同時発報している場合は `alarm-alb.md` と合わせて対応する。
- **Warning（`cloudfront-origin-latency` / `waf-block`）**: 24 時間以内に確認。`waf-block` は当日中に攻撃パターンを確認する（WAF は防御に成功しているシグナルのため、初動の緊急性は 5xx より低い）。
- 同一アラームが 1 週間に 3 回以上発報する場合は、WAF ルール構成・origin latency の恒久対策を Issue 化する。

## 関連

- L-16（production-readiness.md）、Issue #252（実装）
- ADR-0013（ALB ingress を CloudFront prefix list に限定）
- `docs/architecture/observability.md`「エッジ監視アラーム」節
- `terraform/environments/{dev,staging}/main.tf` の `aws_cloudwatch_metric_alarm.cloudfront_5xx_rate` 等
