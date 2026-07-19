# 0019. dev / staging から ECR / Logs の Interface VPC Endpoint を撤去する

## ステータス

Accepted

## 日付

2026-07-15

## 背景

dev / staging の VPC には、ECR (`ecr.api` / `ecr.dkr`) と CloudWatch Logs (`logs`) 向けの Interface VPC Endpoint（2 AZ × 3 サービス = 6 ENI）が構築時から存在していた（`terraform/modules/network/main.tf`）。`dev-environment.md` には「ECR / S3 / CloudWatch Logs は VPC endpoint 経由にして NAT 転送量を抑える」という設計判断が明文化されていたが、実際のデータ転送量と NAT 課金額を比較した試算はなく、コスト最適化の前提として未検証のままだった（`production-readiness.md` M-6）。

Issue #313 で、この設計判断を損益分岐点分析で検証した。dev / staging は低トラフィック・エフェメラル運用のため確定額（$X/月 vs $Y/月）の比較は誤差の範囲に留まり、構成判断の妥当性を評価する土台にならないと判断し、「稼働時間あたり何 GB を超えたら Interface Endpoint が有利か」という損益分岐点（GB/稼働時間）で評価した。

## 決定

dev / staging の `terraform/modules/network/main.tf` から、ECR / Logs 向けの Interface VPC Endpoint 3 種（`ecr.api` / `ecr.dkr` / `logs`）と専用セキュリティグループ（`aws_security_group.vpc_endpoints`）を削除し、NAT Gateway 経由の通信へ一本化する。

S3 向けの Gateway VPC Endpoint（`aws_vpc_endpoint.s3`）は無料のため維持する。ECR のイメージレイヤー本体は元々この S3 Gateway Endpoint 経由で配信されており、Interface Endpoint（`ecr.api` / `ecr.dkr`）が担っていたのは認証・マニフェスト取得等の制御プレーン通信のみだった。

## 根拠

Issue #313 の試算（Cost Explorer 請求実績、ap-northeast-1、対象 AWS アカウント、2026-07-01〜07-15、dev/staging 合算。実測データが取得できない部分は「未検証の前提」と明記して区別）:

- **損益分岐点**: Interface Endpoint 固定費 $0.084/時間（6 ENI × $0.014/ENI-hour）÷ NAT 転送単価 $0.062/GB ≒ **1.355 GB/稼働時間**（常時稼働換算では 730h × 1.355 ≒ 989 GB/月相当）。稼働時間あたりの転送量がこれを上回れば Endpoint 維持が有利、下回れば NAT 一本化が有利。
- **実測**: 3 Interface Endpoint が 116 ENI-hour 稼働（＝環境稼働 116 ÷ 6 ≒ 19.3 稼働時間相当）した期間に、実際に通過した合計データ量は 0.261 GB。稼働時間あたりに換算すると 0.261 GB ÷ 19.3 稼働時間 ≒ **約 0.0135 GB/稼働時間**で、損益分岐点の約 **1/100**。この比率は期間合計のコスト比（Endpoint 固定費 $1.624 が NAT 換算転送費 $0.0162 の約 100 倍）とも整合する。
- **独立クロスチェック（ECR pull 頻度からの下限試算）**: 同期間の deploy workflow 実行回数はバックエンド 16 回 + フロントエンド 8 回 = 24 回（2026-07-06〜07-12 の集中開発期間の実測値であり、定常運用の頻度ではない点に注意）。環境稼働 19.3 時間に対し 1.24 回/稼働時間。1 pull あたりの転送量は実測不能（destroy 時に `force_delete` で ECR リポジトリごと削除されるため過去イメージのサイズを取得できない）ため、NestJS/Next.js 本番用 Docker イメージの一般的なサイズ帯（**未検証の前提**: 300MB/pull、レイヤーキャッシュを無視した最悪ケース）を仮定すると 1.24 × 0.3GB ≒ 0.373 GB/稼働時間で、これも損益分岐点の約 1/3.6。クロスチェックは意図的に最悪ケースの仮定（毎回フルサイズ再取得）を置いているため実測より高めに出るのは想定どおりであり、実測・クロスチェックの両方が独立に損益分岐点を大きく下回ることを確認した。
- コスト表是正（`dev-environment.md`）と合わせ、月額目安 ~$140 → ~$200 の内訳を正確化した上での判断である。

## 反対材料・トレードオフ

- Interface Endpoint を撤去すると、ECR 認証・マニフェスト取得・CloudWatch Logs 送信のトラフィックが NAT Gateway 経由になる。NAT Gateway が単一障害点であるという既存の設計（`nat_gateway_mode = "single"`、dev ではコスト優先で 1 台のみ）への依存がわずかに増える。ただし NAT 自体は EventBridge / SQS / Secrets Manager 等、他の AWS API 呼び出しでも既に必須のパスであり、新たな単一障害点が増えるわけではない。
- 将来的に PrivateLink 経由の通信を要求するセキュリティ要件（インターネットゲートウェイを経由しないトラフィック制御など）が生じた場合、コストではなくセキュリティ上の理由で Interface Endpoint の再導入が必要になる可能性がある。
- 本 ADR の損益分岐点分析は dev / staging の実測データに基づくものであり、本番規模のトラフィックでの妥当性は未検証（下記トリガー参照）。

## 再検討のトリガー

- `docs/architecture/capacity-planning.md` の baseline RPS が確定し、本番相当の ECR pull 頻度・CloudWatch Logs 送信量が見積もれるようになった時点で、本番環境（prod 化する場合）における損益分岐点（1.355 GB/稼働時間、常時稼働なら月 989 GB 相当）との比較を改めて行う。本番トラフィックがこれを上回ると判明した場合は Interface Endpoint の再導入を検討する。
- ALB 直叩き遮断（ADR-0013）やデータ層 SG egress 制限（production-readiness.md L-6）など、NAT を経由しないネットワーク境界の強化が prod 化の要件として明確になった場合。
- dev / staging のデプロイ頻度・イメージサイズが実測ベースで大きく増加し（例: モノレポ化やマルチサービス化で pull 頻度が増える等）、損益分岐点に近づく兆候が観測された場合。

## 関連

- Issue #313（損益分岐点試算・コスト表是正）
- Issue #315（本 ADR・Terraform 撤去）
- `docs/architecture/production-readiness.md` M-6
- `docs/architecture/dev-environment.md`
