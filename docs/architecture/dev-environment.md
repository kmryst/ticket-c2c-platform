# dev 環境設計

## ステータス

設計確定・構築中。

このドキュメントは、AWS 上の dev 環境構成の正本です。dev 環境は PoC ではなく、staging / prod へ育てる本番系トラックの最初の環境です（[ADR-0002](../adr/0002-dev-environment-as-first-prod-track-environment.md)）。

## 運用方針

- 使わない期間は destroy workflow で環境ごと削除し、必要なときに Terraform で再構築する。
- deploy / destroy は GitHub Actions（AWS OIDC、長期アクセスキー不使用）で行う。
- リージョンは `ap-northeast-1`。AWS アカウントは当面単一で、staging 追加時にアカウント分離を判断する（[ADR-0003](../adr/0003-terraform-state-and-environment-isolation.md)）。

## 構成

```
                       ┌─────────────────────────────────────────────┐
 Internet ──► ALB ──►  │ ECS Fargate (API / NestJS)                  │
              (public) │  - events / search / purchases / health     │
                       └──┬───────────┬───────────┬──────────────────┘
                          │           │           │
              ┌───────────▼──┐ ┌──────▼──────┐ ┌──▼──────────────┐
              │ Aurora        │ │ ElastiCache │ │ OpenSearch      │
              │ PostgreSQL    │ │ Valkey      │ │ (検索プロジェク  │
              │ Serverless v2 │ │ (前段フィルタ)│ │  ション・読取専用)│
              │ (正本)        │ └─────────────┘ └──▲──────────────┘
              └───────┬───────┘                    │ index 更新
                      │ 購入確定後                  │
                      ▼                            │
              EventBridge (domain bus) ──► SQS Standard + DLQ ──► ECS Fargate Worker
               EventListed / EventUpdated /                        (API と同一イメージ)
               InventoryChanged / TicketPurchased
```

- VPC: 2 AZ。public subnet に ALB、private subnet に ECS / Aurora / Valkey / OpenSearch。
- API 入口は HTTPS（[ADR-0007](../adr/0007-alb-https-with-acm-and-ingress-variable.md)）。`ticket-api-dev.ticket-c2c.click`（プロジェクト専用ドメイン。[ADR-0009](../adr/0009-migrate-to-project-domain.md)）の ACM 証明書（DNS 検証）を ALB:443 で終端し、HTTP:80 は 443 への 301 リダイレクト専用。ingress は `alb_allowed_ingress_cidrs` 変数（既定 `0.0.0.0/0`）で絞り込み可能。
- NAT Gateway は dev では 1 つ（コスト優先。prod では AZ ごとに配置）。ECR / S3 / CloudWatch Logs は VPC endpoint 経由にして NAT 転送量を抑える。
- 書き込み経路（購入）: API → Valkey 前段フィルタ → Aurora 条件付き更新 → EventBridge 発行。
- 読み取り経路（検索・一覧）: API → OpenSearch。正本確認が必要な場合のみ Aurora。
- 人気イベントの影響隔離は、(1) Valkey による売り切れ後の即時拒否、(2) Worker 分離による非同期処理の隔離、(3) API の DB コネクションプール上限、の 3 層で行う。SQS FIFO によるイベント単位直列化は測定データが出るまで導入しない（[ADR-0004](../adr/0004-defer-sqs-fifo.md)）。
- フロントエンド（[ADR-0011](../adr/0011-nextjs-ssr-on-ecs-with-cloudfront-unified-origin.md)）: `ticket-app-dev.ticket-c2c.click` → CloudFront（us-east-1 ACM 証明書）→ 同一 ALB を 2 origin（api / frontend、custom header で識別）とする統合オリジン。`/api/*` は API target group、その他は frontend target group（ECS Fargate 上の Next.js SSR、専用 ECR イメージ）へ。ALB の default action は API のまま。`/_next/static/*` のみ edge で長期キャッシュ、SSR / API はキャッシュ無効 + Cookie 全転送。

## 採用 / 不採用 / 後回し

| サービス | 判定 | 備考 |
|---|---|---|
| ALB | 採用 | [ADR-0005](../adr/0005-alb-as-api-entry.md) |
| ECS Fargate（API / Worker） | 採用 | Worker は [ADR-0006](../adr/0006-ecs-fargate-worker.md)。同一イメージ・command 差し替え |
| Aurora PostgreSQL Serverless v2 | 採用 | 正本 DB。min 0 ACU の auto-pause でアイドルコストを抑える |
| ElastiCache Valkey | 採用 | cache.t4g.micro ×1。購入前段フィルタ |
| OpenSearch | 採用 | t3.small.search ×1（シングルノード）。検索プロジェクション |
| EventBridge | 採用 | ドメインイベントバス |
| SQS Standard + DLQ | 採用 | EventBridge → Worker のバッファ・リトライ |
| SQS FIFO | 後回し | [ADR-0004](../adr/0004-defer-sqs-fifo.md)。モジュールは `fifo` フラグで対応済みにする |
| CloudWatch Logs / Metrics | 採用 | ログ保持 30 日 |
| ECR | 採用 | 1 リポジトリ（API / Worker 共用イメージ） |
| Secrets Manager | 採用 | DB 認証情報（Aurora マネージドローテーション統合） |
| SSM Parameter Store | 採用 | 非秘密の設定値 |
| CloudFront / WAF / API Gateway | 後回し | prod で CloudFront + WAF を ALB の前段に追加 |
| X-Ray / ADOT | 後回し | まず CloudWatch のみ |
| Cognito 等の認証 | 後回し | 未決事項のまま。ADR 候補 |

## Terraform 構成

[ADR-0003](../adr/0003-terraform-state-and-environment-isolation.md) に従う。

```
terraform/
  modules/
    network/           VPC, subnet, NAT, VPC endpoints
    alb/
    ecs-service/       API / Worker 共用（ALB 接続はオプション）
    aurora/
    valkey/
    opensearch/
    eventbridge/
    sqs/               fifo フラグで FIFO 化に対応
    ecr/
    observability/
    iam-github-oidc/
  environments/
    bootstrap/         tfstate S3 バケット + OIDC + CI 用 IAM ロール
    dev/
```

| state | backend key | 内容 |
|---|---|---|
| bootstrap | `bootstrap/terraform.tfstate` | state バケット、OIDC provider、CI ロール |
| dev app | `dev/app/terraform.tfstate` | dev の全リソース |

## CI/CD（GitHub Actions）

すべて AWS OIDC。長期アクセスキーは使わない。

| workflow | トリガー | 内容 |
|---|---|---|
| `terraform-plan.yml` | PR（`terraform/**`） | fmt / validate / plan。plan 専用ロール |
| `terraform-apply-dev.yml` | workflow_dispatch | plan → Environment `dev` の承認 → apply |
| `terraform-destroy-dev.yml` | workflow_dispatch | `confirm` 入力（`destroy-dev` 完全一致）+ Environment `dev-destroy` の承認 |
| `deploy-app-dev.yml` | workflow_dispatch | Docker build → ECR push → ECS 2 サービス更新 |

GitHub Environments / Variables:

| 種別 | 名前 | 用途 |
|---|---|---|
| Environment | `dev` | apply / deploy。required reviewer 必須 |
| Environment | `dev-destroy` | destroy 専用。required reviewer 必須 |
| Variable | `AWS_REGION` | `ap-northeast-1` |
| Variable | `AWS_PLAN_ROLE_ARN` | plan 用読み取りロール |
| Variable | `AWS_APPLY_ROLE_ARN` | apply / destroy / deploy 用ロール |

## destroy の安全策

- workflow_dispatch のみ + `confirm` 入力の完全一致 + protected Environment の三重ゲート。
- CloudFront distribution の削除は無効化 + 削除で 15〜20 分以上かかるため、destroy workflow の所要時間はフロントエンド導入後に伸びている（正常挙動）。
- Aurora は dev では `deletion_protection = false` / `skip_final_snapshot = true`（変数化し、staging / prod では必ず有効化する）。
- state バケットは bootstrap state 管理 + `prevent_destroy` で destroy 対象外。

## コスト目安（常時稼働時・月額概算）

| リソース | 月額目安 |
|---|---|
| OpenSearch t3.small ×1 + EBS 10GB | ~$30 |
| NAT Gateway ×1 | ~$35 + 転送量 |
| ALB | ~$20 |
| Valkey cache.t4g.micro | ~$12 |
| Fargate（API + Worker + Frontend 各 0.25vCPU/0.5GB） | ~$30 |
| Aurora Serverless v2（auto-pause） | アイドル時ほぼ $0 |
| CloudFront | 従量課金（検証トラフィックのみ、ほぼ $0） |
| 合計 | **~$130/月** |

常駐コストの主因は OpenSearch / NAT / ALB。検証しない期間は destroy workflow で環境ごと削除する。

## 関連ドキュメント

- [システム要件](../requirements/system-requirements.md)
- [技術スタックドラフト](./technology-stack.md)
- [技術検証計画](../poc/technical-validation-plan.md)
- [ADR 一覧](../adr/README.md)
