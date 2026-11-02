# inventory: ticket-c2c-platform の AWS 構成（README 用）

- 作成日: 2026-11-01
- 入力:
  - 調査担当の報告（原文）: `raw/infra.md`（インフラ）、`raw/cicd.md`（CI/CD）、`raw/data-ops.md`（データ運用）。リポジトリには入れていない
  - 用語・矢印の向き: 作図の手順（リポジトリの外）の AWS 用の reference
  - 突き合わせのために読んだリポジトリのファイル（下の各行の根拠に記載）。実環境（AWS CLI / AWS MCP の run_script / gh / terraform）には問い合わせていない
- 対象環境: **staging の変数既定値**（`capacity_profile=normal`、`public_endpoint_mode=https-dns`、Region `ap-northeast-1`。CloudFront 用の ACM 証明書・AWS WAF の web ACL・edge の CloudWatch alarm と SNS topic・CloudWatch Synthetics canary・WAF ログの S3 bucket は `us-east-1`）
  - 根拠: `terraform/environments/staging/variables.tf:19-51`（既定値）、`docs/architecture/staging-environment.md:9`。`terraform.tfvars` はリポジトリに無いので既定値で判断した
  - dev / staging とも「未使用時は destroy が定常」（`staging-environment.md:5`、`dev-environment.md:5`、ADR-0008）。これは README 本文で説明し、図には描かない
  - canary は変数 `enable_synthetic_check` の既定値が `false` だが、標準手順では 2 回目の apply で `true` にして作る（`staging/variables.tf:133-146`、`staging-environment.md:270-277`、ADR-0043）。標準手順の完了状態として図に含める
- 「作図」列の凡例:
  - **描く**: 図に箱または矢印として描く
  - **ラベル**: 独立した箱・矢印にせず、他の要素のラベル（注記）で示す
  - **描かない（理由）**: 図に出さない。理由を括弧内に書く
- 「観点」列: `request-flow` / `operations`（下の「観点の案」）
- 略記: パスの `S/` は `terraform/environments/staging/`、`M/` は `terraform/modules/`、`B/` は `terraform/environments/bootstrap/`（ファイルパスの省略で、用語ではない）

---

## 1. リソース一覧

### 1.1 ユーザーからのアクセス（エッジ）

| サービス名 | リソース名（IaC） | 役割 | 管理方法 | 作図 | 観点 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| （利用者） | — | ブラウザで画面表示と購入を行う | — | 描く（`mxgraph.aws4.users` / `client`） | request-flow | `frontend/components/purchase-form.tsx:3,7,44` |
| Amazon Route 53 | `data.aws_route53_zone.public`（既存 hosted zone を参照） | 公開 DNS の hosted zone | 管理外（参照のみ。ADR-0009） | 描かない（README では名前解決を省略。必要なら本文） | — | `S/main.tf:262-267` |
| Amazon Route 53 | `aws_route53_record.app_alias`（A alias → CloudFront）、`.api_alias`（A alias → ALB） | 名前解決。CloudFront の origin の domain は API の FQDN（alias で ALB） | IaC | 描かない（細部） | — | `S/main.tf:343-355, 1202-1214`、`M/cloudfront/main.tf:69-79` |
| Amazon Route 53 | `*_cert_validation` | ACM の DNS 検証レコード | IaC | 描かない（細部） | — | `S/main.tf:284-299, 744-759` |
| Amazon CloudFront | `module.cloudfront` の `aws_cloudfront_distribution.this` | 公開入口。origin は ALB 1 つに 2 つの origin 定義（`/api/*` → api origin、default と `/_next/static/*` → frontend origin。frontend origin は識別用の custom header を付ける） | IaC（us-east-1 ではなく global。設定は ap-northeast-1 の root から） | 描く | request-flow, operations | `M/cloudfront/main.tf:57-155`、`S/main.tf:908-919` |
| Amazon CloudFront | `aws_cloudfront_response_headers_policy.security_headers` | HSTS などの security headers | IaC | 描かない（設定の細部） | — | `M/cloudfront/main.tf:24-55` |
| Amazon CloudFront | `aws_cloudfront_monitoring_subscription.app` | additional metrics（OriginLatency など） | IaC | 描かない（設定の細部） | — | `S/main.tf:1245-1255` |
| AWS WAF | `aws_wafv2_web_acl.app`（`scope="CLOUDFRONT"`、managed rule group 3 つ） | CloudFront に関連付ける web ACL | IaC（us-east-1） | 描く（CloudFront に添えて置く。矢印の経路に入れない） | request-flow | `S/main.tf:820-905, 918` |
| AWS Certificate Manager | `aws_acm_certificate.app`（us-east-1） | CloudFront の viewer certificate | IaC | 描かない（細部。README 本文で TLS を説明すれば足りる） | — | `S/main.tf:732-767` |
| AWS Certificate Manager | `aws_acm_certificate.api`（ap-northeast-1） | ALB の HTTPS listener の証明書 | IaC | 描かない（同上） | — | `S/main.tf:273-306` |
| Amazon VPC | `aws_vpc.this` | VPC | IaC | 描く（枠） | request-flow | `M/network/main.tf:10-16` |
| Amazon VPC | `aws_subnet.public` ×2（2 AZs） | public subnet（ALB、NAT gateway） | IaC | 描く（枠。`(2 AZs)` はラベル） | request-flow | `M/network/main.tf:24-33`、`M/network/variables.tf:17-21` |
| Amazon VPC | `aws_subnet.private` ×2（2 AZs） | private subnet（ECS task、Aurora、ElastiCache、OpenSearch） | IaC | 描く（枠。`(2 AZs)` はラベル） | request-flow | `M/network/main.tf:35-43` |
| Amazon VPC | `aws_internet_gateway.this` | internet gateway | IaC | 描く | request-flow | `M/network/main.tf:18-22` |
| Amazon VPC | `aws_nat_gateway.this`（normal は 1 台、public subnet[0]） | private subnet から外（AWS の public endpoint・CloudFront）への出口 | IaC | 描く | request-flow | `M/network/main.tf:47-79` |
| Amazon VPC | `aws_vpc_endpoint.s3`（Gateway） | S3 の gateway endpoint（ECR のイメージレイヤー取得） | IaC | 描かない（細部。ECR pull の経路の補足は README 本文で） | — | `M/network/main.tf:130-143`、ADR-0019 |
| Amazon VPC | route table、security group（`app` / `alb` / 各データストア）、CloudFront の managed prefix list 参照 | 経路と通信制御 | IaC | 描かない（細部。「ALB は CloudFront からのみ受ける」は ALB のラベルで示す） | — | `M/network/main.tf:81-128`、`S/main.tf:121-137, 311-313, 331-332, 357-365` |
| Application Load Balancer | `module.alb` の `aws_lb.this`（internet-facing、public subnet 2 つ）、listener 80（301）/ 443、target group `api` / `frontend`、listener rule（header 条件で frontend へ） | API / Frontend への振り分け | IaC | 描く（listener rule の振り分けはラベル） | request-flow | `M/alb/main.tf:48-166` |

### 1.2 アプリ（ECS）

| サービス名 | リソース名（IaC） | 役割 | 管理方法 | 作図 | 観点 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| Amazon ECS | `aws_ecs_cluster.this` | cluster（Fargate） | IaC | 描く（枠） | request-flow, operations | `S/main.tf:367-374` |
| Amazon ECS（AWS Fargate） | `module.api_service`（service + task definition、private subnet、container port 3000） | API（NestJS）。購入・検索・認証 | IaC（task definition のイメージ差し替えは CI） | 描く | request-flow, operations | `S/main.tf:583-646`、`M/ecs-service/main.tf:11-131` |
| Amazon ECS（AWS Fargate） | `module.worker_service`（command `node dist/src/worker.js`、ALB 登録なし） | Worker。SQS を消費して OpenSearch へ projection を書く | IaC | 描く | request-flow, operations | `S/main.tf:648-688`、`src/worker.ts:12-29` |
| Amazon ECS（AWS Fargate） | `module.frontend_service[0]`（https-dns の時だけ作る） | Frontend（Next.js SSR） | IaC | 描く | request-flow, operations | `S/main.tf:775-811` |
| AWS Distro for OpenTelemetry | API / Worker の task definition 内 sidecar `otel-collector`（Frontend には無い） | trace を X-Ray へ転送 | IaC | 描く（API / Worker の task 内の小さい要素） | operations | `M/ecs-service/main.tf:57-81`、`S/main.tf:574-576, 608, 672` |
| Application Auto Scaling | `aws_appautoscaling_*` | full の時だけ API / Worker をスケール | IaC（normal では作られない） | 描かない（既定の normal に存在しない。差分表に記載） | — | `M/ecs-service/main.tf:133-178`、`S/main.tf:27-34, 63-70` |
| Amazon ECR | `module.ecr`（backend：API と Worker で共用）、`module.ecr_frontend` | private repository | IaC（staging root） | 描く | operations | `S/main.tf:111-117, 719-725`、`M/ecr/main.tf` |
| Amazon ECR Public | `public.ecr.aws/aws-observability/aws-otel-collector`（参照のみ） | ADOT のイメージの取得元 | 管理外 | 描かない（細部。外部のイメージ取得元） | — | `S/main.tf:576` |
| IAM | task execution role、task role（api / worker / frontend）と inline policy | ECS の権限 | IaC | 描かない（role 個別は細部。矢印の主体はラベルで示す） | — | `S/main.tf:377-573, 769-773` |

### 1.3 データ

| サービス名 | リソース名（IaC） | 役割 | 管理方法 | 作図 | 観点 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| Amazon Aurora PostgreSQL-Compatible Edition（Aurora Serverless v2） | `module.aurora` の `aws_rds_cluster.this`（16.14）、writer 1 + reader 1（`db.serverless`、ACU 0〜4） | 在庫・購入の正本（authoritative） | IaC | 描く（cluster の箱に writer / reader。reader は「failover 先、アプリは未使用」とラベル） | request-flow, operations | `M/aurora/main.tf:1-90`、`S/main.tf:37-41, 149-160` |
| （Aurora の機能） | automated backups（`backup_retention_period=1`）、final snapshot は skip、deletion protection 無効 | バックアップ | IaC | ラベル（Aurora の箱に「automated backups 1 日」。AWS Backup ・S3 への矢印は描かない） | operations | `M/aurora/main.tf:51-58`、`S/main.tf:40-41, 157-160` |
| Amazon ElastiCache（Valkey） | `module.valkey` の `aws_elasticache_replication_group.this`（Valkey 8.0、2 ノード、automatic failover、TLS） | 購入の前段判定（在庫カウンタ）とレート制限 | IaC | 描く（backup 無効は README 本文か「backup 無効（Aurora から再構築）」のラベル） | request-flow | `M/valkey/main.tf:31-55`、`S/main.tf:43-46, 618` |
| Amazon OpenSearch Service | `module.opensearch` の `aws_opensearch_domain.this`（OpenSearch_2.19、1 ノード、VPC 内） | 検索 projection（Aurora から rebuild 可能） | IaC | 描く | request-flow | `M/opensearch/main.tf:28-93` |
| AWS Secrets Manager | RDS 管理の master user secret（`manage_master_user_password`）、`aws_secretsmanager_secret.jwt` | DB password と JWT 署名鍵 | IaC（master user secret は RDS が作成） | 描く（1 つのアイコン） | request-flow, operations | `M/aurora/main.tf:39-40`、`S/main.tf:225-256` |

### 1.4 非同期処理（イベント）

| サービス名 | リソース名（IaC） | 役割 | 管理方法 | 作図 | 観点 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| Amazon EventBridge | `module.eventbridge` の `aws_cloudwatch_event_bus.this`（custom event bus）、`_event_rule.domain_events`、`_event_target.to_sqs` | ドメインイベント（`TicketPurchased` / `InventoryChanged`）を SQS へ配信 | IaC | 描く（event bus + rule をまとめて 1 つ） | request-flow | `M/eventbridge/main.tf:1-20` |
| Amazon SQS | `module.search_projection_queue` の `aws_sqs_queue.this`（Standard、long polling 20 秒）と `.dlq` | search projection の queue と dead-letter queue | IaC | 描く（queue。DLQ はラベル） | request-flow | `M/sqs/main.tf:7-27` |
| Amazon EventBridge Scheduler | — | refresh token cleanup は廃止済み（API プロセス内の `@Cron` に移行） | 存在しない | 描かない（現行に存在しない。ADR-0041） | — | `src/database/refresh-token-cleanup.service.ts:5,23`、ADR-0041 |

### 1.5 監視・通知

| サービス名 | リソース名（IaC） | 役割 | 管理方法 | 作図 | 観点 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| Amazon CloudWatch（CloudWatch Logs） | `/ecs/<name>-{api,worker,frontend}`（保持 30 日）、ADOT の `/aws/ecs/application/metrics` | アプリのログと EMF のビジネスメトリクス | IaC | 描く（log group をまとめて 1 つ） | operations | `M/observability/main.tf:1-6`、`S/main.tf:525-529, 692-713` |
| Amazon CloudWatch（metrics・alarm） | `aws_cloudwatch_metric_alarm`：ALB、ECS、Aurora 4 本、DLQ、EMF（SLO burn rate など）／ us-east-1 に CloudFront 5xx・OriginLatency・WAF block・canary 失敗 | 監視 | IaC | 描く（ap-northeast-1 と us-east-1 に 1 つずつ alarm のアイコン） | operations | `M/aurora/main.tf:92-202`、`M/observability/main.tf:41-390`、`S/main.tf:1259-1361` |
| Amazon CloudWatch（dashboard） | `module.dashboard` の `aws_cloudwatch_dashboard.main` | dashboard | IaC | ラベル（CloudWatch の箱に添える） | operations | `M/dashboard/main.tf:68`、`S/main.tf:1369-1397` |
| Amazon SNS | `aws_sns_topic.alerts`（ap-northeast-1）、`.edge_alerts`（us-east-1）、email subscription | alarm の通知先 | IaC | 描く（Region ごとに 1 つ。宛先は書かない） | operations | `M/observability/main.tf:11-26`、`S/main.tf:1224-1240` |
| AWS X-Ray | `aws_xray_group.this` | trace | IaC | 描く | operations | `M/observability/main.tf:32-39` |
| Amazon CloudWatch Synthetics | `module.synthetic_check[0]`（us-east-1、`rate(5 minutes)`、VPC 外） | CloudFront 経由の外形監視 | IaC（2 回目の apply で作成） | 描く（「2 回目の apply で作成」は README 本文） | operations | `M/synthetics-canary/main.tf:90-199`、`S/main.tf:1408-1418` |
| Amazon S3 | `aws_s3_bucket.cf_logs`（ap-northeast-1）、`.waf_logs`（us-east-1）、canary の artifacts bucket（us-east-1） | CloudFront access logs / WAF ログ / canary の結果（30 日で失効） | IaC | 描かない（ログ保存先の細部。README 本文で「CloudFront・WAF のログは S3」と書けば足りる） | — | `S/main.tf:931-1199`、`M/synthetics-canary/main.tf:43-83` |
| Amazon CloudWatch Logs（vended logs） | `aws_cloudwatch_log_delivery_*`（us-east-1） | CloudFront access logs の配信設定 | IaC | 描かない（同上） | — | `S/main.tf:1043-1073` |

### 1.6 開発・運用（CI/CD）

| サービス名 | リソース名 | 役割 | 管理方法 | 作図 | 観点 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| GitHub Actions | `terraform-plan.yml`、`terraform-apply-staging.yml`、`terraform-destroy-staging.yml`、`deploy-backend-staging.yml` / `deploy-frontend-staging.yml`（→ `deploy-service.yml`）、`db-migrate-staging.yml`、`staging-smoke-test.yml` | IaC の plan / apply / destroy、イメージの build・push とデプロイ、DB migration、smoke test（AWS を操作するものは全部 `workflow_dispatch`。plan だけ PR） | リポジトリ（`.github/workflows/`） | 描く（GitHub Actions 1 つ。workflow 名はラベルか README 本文） | operations | `raw/cicd.md` 表1(a)、各ファイル |
| GitHub Actions | `ticket-type-expand-readiness-staging.yml`、`ticket-type-cutover-staging.yml` | Gate A / Gate B の移行期間専用 | リポジトリ | 描かない（移行期間専用で退役予定。ADR-0033 決定 3） | — | `.github/workflows/ticket-type-cutover-staging.yml:26-27`、`docs/runbooks/gate-b-ticket-type-cutover.md:19` |
| GitHub Actions | `pr-check.yml`、`codeql.yml`、Trivy、gitleaks、lint 系、Dependabot | AWS に触れない CI | リポジトリ | 描かない（AWS の構成に関与しない） | — | `raw/cicd.md` 表1(b) |
| IAM（OIDC） | 既存の IAM OIDC identity provider（参照のみ）、`module.github_oidc` の plan / apply role、staging / dev の state readonly role | GitHub Actions からの federation | IaC（bootstrap root）。OIDC provider は管理外 | 描かない（role 個別は細部。GitHub Actions → AWS STS の矢印で示す） | — | `B/main.tf:36-199`、`M/iam-github-oidc/main.tf:25-90` |
| AWS STS | — | `AssumeRoleWithWebIdentity` | AWS のサービス | 描く（AWS Cloud の中、Region 枠の外） | operations | `M/iam-github-oidc/main.tf:25-90` |
| Amazon S3 | `aws_s3_bucket.tfstate`（bootstrap root、versioning） | Terraform の state（deploy 時に `terraform output` で読む） | IaC（bootstrap） | 描く | operations | `B/main.tf:1-34`、`.github/workflows/deploy-service.yml:145-183` |
| （ECS run-task） | API の task definition を command override した単発 task | DB migration、OpenSearch の search index migration | CI からの実行（常設リソースではない） | 描く（API の task definition を使う単発 task として、矢印のラベルで示す） | operations | `scripts/deployment/run-db-migration.sh:99-143`、`.github/workflows/deploy-service.yml:257-277` |
| AWS Backup | — | 未構成 | 存在しない | 描かない（IaC に `aws_backup_*` が無い） | — | `raw/data-ops.md` 表1 |

---

## 2. 包含関係

```text
AWS Cloud
├─ Region: ap-northeast-1
│   ├─ VPC
│   │   ├─ Availability Zone ×2（図では AZ ごとに描き分けず `(2 AZs)` とラベル）
│   │   ├─ Public subnet (2 AZs)
│   │   │   ├─ Application Load Balancer（2 つの public subnet に関連付け）
│   │   │   └─ NAT gateway（normal は 1 台。public subnet[0]）
│   │   ├─ Private subnet (2 AZs)
│   │   │   ├─ ECS cluster（Fargate）
│   │   │   │   ├─ service: API      ─ task: app container + ADOT sidecar（otel-collector）
│   │   │   │   ├─ service: Worker   ─ task: app container + ADOT sidecar（otel-collector）
│   │   │   │   └─ service: Frontend ─ task: app container（sidecar なし）
│   │   │   └─ Data store（図の枠）
│   │   │       ├─ Aurora PostgreSQL DB cluster（writer + reader、Aurora Serverless v2）
│   │   │       ├─ ElastiCache（Valkey）replication group（primary + replica）
│   │   │       └─ OpenSearch Service domain（1 ノード、subnet[0]）
│   │   └─ internet gateway（VPC に付く）
│   │   （gateway endpoint for S3 は描かない）
│   ├─ VPC の外（regional service）: EventBridge（custom event bus）、SQS（queue + DLQ）、
│   │   Secrets Manager、ECR（private repository ×2）、CloudWatch（Logs / alarm / dashboard）、
│   │   SNS（alerts）、X-Ray、S3（tfstate。bootstrap root の管理）
├─ Region: us-east-1
│   ├─ AWS WAF（web ACL、scope=CLOUDFRONT）
│   ├─ CloudWatch Synthetics canary（VPC 外）
│   ├─ CloudWatch alarm（edge 用）+ SNS（edge_alerts）
│   └─ （描かない: ACM の app 証明書、WAF ログ / canary artifacts の S3 bucket）
├─ global: CloudFront distribution（AWS WAF を関連付け）、AWS STS
└─ AWS の外: 利用者のブラウザ、GitHub Actions
```

根拠: `M/network/main.tf:1-143`、`M/ecs-service/main.tf:57-96`、`S/main.tf:583-811`、`M/aurora/main.tf`、`M/valkey/main.tf`、`M/opensearch/main.tf:28-93`、`S/main.tf:820-905, 1224-1418`。各ノードの具体的な AZ は不明（不明点を参照）なので、AZ 単位の配置は描かない。

---

## 3. 接続関係

矢印は「通信を開始する側 → 受ける側」。番号は購入リクエスト 1 回分の処理順（下の「4. 番号を振る流れ」）。

| # | 通信元 | 通信先 | プロトコル・方式 | 目的 | 作図 | 観点 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 利用者のブラウザ（client component） | CloudFront（`/api/*`、AWS WAF で評価） | HTTPS `POST /api/events/{eventId}/purchases`、httpOnly Cookie | 購入リクエスト | 描く（①） | request-flow | `frontend/components/purchase-form.tsx:3,7,44-45`、`frontend/lib/api.ts:57-62`、`M/cloudfront/main.tf:131-141` |
| 2 | CloudFront | ALB | HTTPS 443（`https-only`）。api origin（識別ヘッダーなし） | origin へのリクエスト | 描く（②） | request-flow | `M/cloudfront/main.tf:69-79, 131-141` |
| 3 | ALB | API task | HTTP 3000（443 listener の default action → api target group） | API への転送。API は `/api` を外して既存ルートへ写像 | 描く（③） | request-flow | `M/alb/main.tf:59-118`、`src/main.ts:22-40` |
| 4 | API task | ElastiCache（Valkey）primary endpoint | `rediss://`（TLS）6379、ioredis。Lua script | レート制限 → 在庫カウンタの reserve（前段判定）。在庫なしなら DB へ行かず拒否。DB 確定後のカウンタ補償・request marker も同じ接続 | 描く（④） | request-flow | `src/purchases/purchases.controller.ts:88-91`、`src/purchases/purchases.service.ts:202-222, 393-415, 249-281, 459-468`、`S/main.tf:618` |
| 5 | API task | Aurora の cluster endpoint（writer） | PostgreSQL 5432、TLS。`BEGIN` … `COMMIT` | 購入の確定（authoritative） | 描く（⑤） | request-flow | `src/purchases/purchases.service.ts:624-660, 808`、`S/main.tf:613-617` |
| 6 | API task（task role） | EventBridge の custom event bus | HTTPS `PutEvents`（NAT gateway 経由） | ドメインイベント `TicketPurchased` / `InventoryChanged` の発行（新規 confirmed の時だけ）。この後 API はブラウザへ応答する | 描く（⑥） | request-flow | `src/purchases/purchases.service.ts:283, 324-370, 470`、`src/messaging/domain-events.service.ts:41-69`、`S/main.tf:417-437` |
| 7 | EventBridge（rule） | SQS queue | rule の target への配信（queue policy で `events.amazonaws.com` に `sqs:SendMessage`） | projection 用のイベントを渡す（以降は非同期） | 描く（⑦） | request-flow | `M/eventbridge/main.tf:6-39` |
| 8 | Worker task（task role） | SQS queue | HTTPS `ReceiveMessage`（long polling 20 秒）、処理後 `DeleteMessage`（NAT gateway 経由） | queue の消費 | 描く（⑧） | request-flow | `src/worker/search-projection.worker.ts:88-113`、`S/main.tf:457-481` |
| 9 | Worker task | OpenSearch domain | HTTPS 443、SigV4（task role） | projection の書き込み（`update`） | 描く（⑨） | request-flow | `src/worker/search-projection.worker.ts:180-223`、`src/search/events-projection.store.ts:301-405`、`src/opensearch.ts:81-98` |
| — | API task（resolver の cache miss 時） | Aurora | PostgreSQL | writer mode と Ticket Type の解決（in-process cache。hit 時は DB に行かない） | 描かない（矢印 5 と同じ通信先。番号の順序の注記のみ） | — | `src/purchases/ticket-type-resolver.service.ts:9-12, 86-89`、`purchases.service.ts:156-176` |
| — | SQS queue | SQS DLQ | redrive policy（maxReceiveCount 5） | 失敗メッセージの退避 | ラベル（queue に「DLQ あり」） | request-flow | `M/sqs/main.tf:23-26` |
| — | ブラウザ | CloudFront（default / `/_next/static/*`） | HTTPS | 画面（SSR・静的ファイル） | 描く（番号なし。矢印 1 と同じ線にまとめてよい） | request-flow | `M/cloudfront/main.tf:104-128` |
| — | CloudFront | ALB（frontend origin、識別ヘッダー付き） | HTTPS 443 | frontend への origin リクエスト | 描く（番号なし。矢印 2 と同じ線にまとめてよい） | request-flow | `M/cloudfront/main.tf:82-128` |
| — | ALB | Frontend task | HTTP 3000（listener rule の `http_header` 条件） | SSR への転送 | 描く（番号なし） | request-flow | `M/alb/main.tf:148-166` |
| — | Frontend task（SSR のサーバー側 fetch） | CloudFront（`https://<app FQDN>/api`） | HTTPS。NAT gateway → internet gateway → CloudFront → ALB → API | SSR でのイベント一覧・検索の取得。ALB を直接呼ばない | 描く（番号なし。「NAT gateway 経由」をラベル） | request-flow | `S/main.tf:807-809`、`frontend/lib/events.ts:3-5, 21-31`、`S/main.tf:331-332` |
| — | API task | OpenSearch domain | HTTPS 443、SigV4 | 検索 API（購入の流れには含まれない） | 描く（番号なし） | request-flow | `src/search/search.service.ts:135`、`M/opensearch/main.tf:82-92` |
| — | API task（task role、アプリの AWS SDK） | Secrets Manager | HTTPS `GetSecretValue`（NAT gateway 経由）。DB 接続を張るたび | ローテーション後の DB password を読む | 描く（番号なし） | request-flow | `src/config.ts:183-200, 224-253`、`S/main.tf:441-455, 623` |
| — | ECS（Fargate の agent、task execution role） | Secrets Manager | task 定義の `secrets` 注入（task 起動時 1 回） | `DB_PASSWORD`（migration 用）と `JWT_SECRET` | 描く | operations | `S/main.tf:397-415, 639-645` |
| — | ECS（Fargate の agent、task execution role） | ECR | image pull（認証・manifest は NAT gateway、レイヤーは S3 gateway endpoint 経由） | アプリのイメージ | 描く | operations | `M/network/main.tf:130-143`、`docs/architecture/dev-environment.md:35` |
| — | ECS（Fargate の agent） | Amazon ECR Public | image pull（NAT gateway 経由） | ADOT のイメージ | 描かない（細部） | — | `S/main.tf:576`、`M/network/main.tf:92-101` |
| — | ECS（`awslogs` log driver、task execution role） | CloudWatch Logs | awslogs（NAT gateway 経由） | アプリのログと EMF（CloudWatch Logs がメトリクスを抽出） | 描く | operations | `M/ecs-service/main.tf:47-54`、`src/observability/emf.ts` |
| — | API / Worker のアプリ container | 同じ task の ADOT sidecar | OTLP/HTTP `localhost:4318` | trace の送信 | 描く（task 内の短い矢印） | operations | `src/observability/tracing.ts:7-41`、`M/ecs-service/variables.tf:121` |
| — | ADOT sidecar（task role） | X-Ray | HTTPS `PutTraceSegments`（NAT gateway 経由） | trace の転送 | 描く | operations | `S/main.tf:483-523` |
| — | ADOT sidecar（task role） | CloudWatch Logs（`/aws/ecs/application/metrics`） | `PutLogEvents`（awsemf） | collector 自身のメトリクス | 描かない（細部） | — | `S/main.tf:525-572` |
| — | ALB | API / Frontend task | HTTP `GET /healthz`（30 秒間隔）。CloudFront・WAF を通らない | health check | 描かない（細部。README 本文で必要なら） | — | `M/alb/main.tf:66-73, 134-140` |
| — | CloudWatch alarm（ap-northeast-1） | CloudWatch のメトリクス（ALB、ECS、Aurora、SQS DLQ、EMF） | metric の評価 | 監視 | 描かない（評価対象への矢印は線が多すぎる。alarm の箱のラベルに対象を列挙） | — | 各 module の `aws_cloudwatch_metric_alarm` |
| — | CloudWatch alarm（ap-northeast-1） | SNS `alerts` | alarm action / OK action | 通知 | 描く | operations | `M/observability/main.tf:11-26` |
| — | CloudWatch alarm（us-east-1） | SNS `edge_alerts` | alarm action / OK action | CloudFront 5xx・OriginLatency・WAF block・canary 失敗の通知 | 描く | operations | `S/main.tf:1259-1361, 1417` |
| — | SNS | email subscription | email | 通知 | 描く（宛先は書かない。「email」だけ） | operations | `M/observability/main.tf:11-26`、`S/main.tf:1224-1240` |
| — | CloudWatch Synthetics canary（us-east-1） | CloudFront（app の FQDN） | HTTPS GET `/api/healthz`、`/`、`/api/events`（5 分ごと） | 外形監視（CloudFront・WAF を通る） | 描く | operations | `M/synthetics-canary/files/syntheticCheck.js:24-30, 61-67` |
| — | canary（実行 role） | S3 artifacts / CloudWatch / X-Ray | IAM role | 結果の保存 | 描かない（細部） | — | `M/synthetics-canary/main.tf:106-166` |
| — | CloudFront（vended logs） / AWS WAF（logging） | S3 `cf_logs` / `waf_logs` | `delivery.logs.amazonaws.com` が `s3:PutObject` | access logs / WAF ログ | 描かない（細部。README 本文） | — | `S/main.tf:979-1199` |
| — | GitHub Actions | AWS STS | `AssumeRoleWithWebIdentity`（GitHub の OIDC token） | 一時認証情報の取得 | 描く | operations | `M/iam-github-oidc/main.tf:25-90`、`.github/workflows/deploy-service.yml:89-96` |
| — | GitHub Actions | S3（tfstate） | Terraform backend / `terraform output` | state の読み書き | 描く | operations | `B/main.tf:1-34`、`S/backend.tf`、`.github/workflows/deploy-service.yml:145-183` |
| — | GitHub Actions | ECR | `docker push`（short SHA タグ） | イメージの登録 | 描く | operations | `.github/workflows/deploy-service.yml:192-225` |
| — | GitHub Actions | ECS | `register-task-definition`、`run-task`、`update-service`、rollout の確認 | デプロイ | 描く | operations | `.github/workflows/deploy-service.yml:232-300` |
| — | GitHub Actions | staging の全リソース | `terraform apply` / `destroy`（apply role） | IaC の適用・削除 | ラベル（GitHub Actions の箱に「terraform plan / apply / destroy」。全リソースへの矢印は引かない） | operations | `.github/workflows/terraform-apply-staging.yml:7-96`、`terraform-destroy-staging.yml:9-76` |
| — | ECS run-task（migration 用の単発 task） | Aurora / OpenSearch | PostgreSQL / HTTPS SigV4 | DB migration（`run_migrations=true` か `db-migrate-staging.yml`）、search index migration（deploy ごと） | 描く（ECS → Aurora・OpenSearch の点線にラベル「migration（単発 task）」） | operations | `.github/workflows/deploy-service.yml:257-277`、`db-migrate-staging.yml:10-45`、`scripts/deployment/run-db-migration.sh:99-143` |
| — | GitHub Actions（`staging-smoke-test.yml`） | CloudFront（`api_base_url`）/ canary（`GetCanary`） | HTTPS / AWS API | smoke test | 描かない（canary の外形監視と重なる。README 本文） | — | `.github/workflows/staging-smoke-test.yml:1-100` |
| — | private subnet の task | NAT gateway → internet gateway → AWS の public endpoint | route 0.0.0.0/0 | AWS API（EventBridge、SQS、Secrets Manager、X-Ray、Logs、ECR）と CloudFront への出口 | 描く（task → NAT gateway → internet gateway を 1 本。個々の AWS API の矢印は NAT を経由する旨をラベルで） | request-flow | `M/network/main.tf:92-101`、ADR-0019 |

---

## 4. 番号を振る流れ（購入リクエスト 1 回分）

コードの処理順。依頼時の仮説（ブラウザ → CloudFront(WAF) → ALB → API → Valkey → Aurora → EventBridge → SQS → Worker → OpenSearch）と**順序は一致した**。補足点だけ下に記す。

| # | 区間 | コード上の位置 |
| --- | --- | --- |
| ① | ブラウザ → CloudFront（AWS WAF の web ACL で評価） | `frontend/components/purchase-form.tsx:44-45`（client component が `POST /api/events/{eventId}/purchases`） |
| ② | CloudFront → ALB（`/api/*` → api origin） | `M/cloudfront/main.tf:131-141` |
| ③ | ALB → API task | `M/alb/main.tf:79-118`、`src/purchases/purchases.controller.ts:50-71`（JWT の検証は API 内で完結し AWS へ通信しない: `src/auth/jwt-auth.guard.ts:62`） |
| ④ | API → ElastiCache（Valkey）: レート制限 → 在庫カウンタの reserve（Lua） | `purchases.controller.ts:88-91` → `purchases.service.ts:202`（legacy）/ `:393-399`（ticket_type） |
| ⑤ | API → Aurora: transaction で確定 | `purchases.service.ts:237, 443` → `:624-808`（`BEGIN` / `COMMIT`） |
| ⑥ | API → EventBridge: `PutEvents` | `purchases.service.ts:283, 470` → `:324-370` → `src/messaging/domain-events.service.ts:57-69` |
| ⑦ | EventBridge（rule）→ SQS | `M/eventbridge/main.tf:6-20` |
| ⑧ | Worker → SQS: `ReceiveMessage` | `src/worker/search-projection.worker.ts:88-98` |
| ⑨ | Worker → OpenSearch: projection の更新（その後 `DeleteMessage`） | `search-projection.worker.ts:100-107, 180-223` |

補足（図の注記か README 本文に）:

- ④ で在庫なし（requestId なし）の場合は DB に行かずに拒否して終わる（`purchases.service.ts:209-222, 402-415`）
- ⑤ の後、API は Valkey にもう一度アクセスする（request marker、カウンタの補償・同期。`:249-281, 459-468`）。図では ④ の矢印に含め、番号を増やさない
- ⑥ は新規 confirmed の時だけ。⑥ の後に API がブラウザへ応答し、⑦ 以降は非同期（`:324-334`）
- resolver の cache miss 時だけ ④ の前に Aurora を読む（`ticket-type-resolver.service.ts:86-89`）
- 応答（戻りの通信）は矢印にしない

---

## 5. 観点の案

| 観点名 | タイトル | 含める要素 | 番号を振る流れ | この観点を立てる理由 |
| --- | --- | --- | --- | --- |
| `request-flow` | リクエストの流れ（staging） | 利用者、CloudFront + AWS WAF、Region / VPC / public・private subnet（`(2 AZs)` はラベル）、internet gateway、NAT gateway、ALB、ECS cluster（API / Worker / Frontend service）、ElastiCache（Valkey）、Aurora（writer / reader）、OpenSearch Service、EventBridge、SQS（DLQ はラベル）、Secrets Manager。Frontend SSR → CloudFront の折り返し、API → Secrets Manager（GetSecretValue） | ①〜⑨（購入リクエスト 1 回分） | README の主図。在庫制御の中核（Valkey の前段判定 → Aurora の確定 → イベントで検索 projection）を 1 枚で示す |
| `operations` | デプロイと監視（staging） | GitHub Actions、AWS STS、S3（tfstate）、ECR、ECS cluster（task 内の ADOT sidecar を含む）、ECS run-task（migration）→ Aurora / OpenSearch、Secrets Manager（起動時注入）、CloudWatch Logs、X-Ray、CloudWatch alarm（ap-northeast-1 / us-east-1）・dashboard（ラベル）、SNS ×2 → email、CloudWatch Synthetics canary（us-east-1）→ CloudFront、Aurora の automated backups（ラベル） | なし（必要ならデプロイ手順を番号付け: apply → backend deploy → frontend deploy → 2 回目の apply → smoke test。`staging-environment.md:325-338`） | 実行時の流れとは主体（GitHub Actions・監視系）と矢印の意味が違い、1 枚に入れると購入の流れが読めなくなる |

`network` は立てない。VPC・subnet・NAT gateway・internet gateway は `request-flow` に含めれば足り、AZ ごとの配置は IaC で決まっていない（不明点）ため、AZ 別に描く図を立てても根拠のある内容が増えない。

---

## 6. 突き合わせで解消した点

| 論点 | 担当間の差 | 結論と根拠 |
| --- | --- | --- |
| Frontend SSR が API を呼ぶ経路 | インフラ: CloudFront 経由（ALB 直ではない）。CI/CD: `api_base_url` は https-dns なら CloudFront 経由と記載。docs の Mermaid には SSR の経路が無い | **CloudFront 経由**（Frontend task → NAT gateway → internet gateway → CloudFront → ALB → API）。`S/main.tf:807-809`（`API_BASE_URL = "https://${local.app_fqdn}/api"`）、`frontend/lib/events.ts:3-5, 21-31`。ALB の ingress は CloudFront の origin-facing prefix list だけ（`S/main.tf:331-332`）なので ALB 直は届かない |
| Secrets Manager の取得主体 | インフラ: execution role の起動時注入とアプリの `GetSecretValue` の両方。データ運用: RDS 管理 secret を挙げるのみ | **両方ある**。(a) task execution role が起動時に `DB_PASSWORD`・`JWT_SECRET` を注入（`S/main.tf:397-415, 639-645`）。(b) API のアプリが task role で DB 接続のたびに `GetSecretValue`（`src/config.ts:183-200, 224-253`、ARN は `S/main.tf:623`）。`DB_PASSWORD_SECRET_ARN` があれば (b) が優先され、(a) の `DB_PASSWORD` は migration runner 用（`S/main.tf:640` のコメント）。Worker・Frontend は secret を使わない |
| ECR Public（ADOT のイメージ）の取得経路 | インフラ: NAT gateway 経由と「推定」（不明点に計上） | **NAT gateway 経由**。private route table の外向き経路は 0.0.0.0/0 → NAT gateway と S3 の gateway endpoint だけで、interface endpoint は無い（`M/network/main.tf:92-101, 130-143`、ADR-0019）。レイヤーの配信元が S3 gateway endpoint を通るかは不明（不明点へ）。図には描かない |
| docs の Mermaid の `sqs --> worker` | インフラ: IaC と食い違い（Worker が取りに行く） | **Worker → SQS**。`ReceiveMessage`（long polling）を Worker が呼ぶ（`src/worker/search-projection.worker.ts:88-98`、task role の権限 `S/main.tf:457-481`）。`staging-environment.md:104-105` はデータの流れの向きで描かれている |
| docs の Mermaid の `api_c --> aurora_reader` | インフラ: アプリは reader を使わない | **API → cluster endpoint（writer）のみ**。`DB_HOST = module.aurora.cluster_endpoint`（`S/main.tf:613`）。`cluster_reader_endpoint` は output にあるだけで、`src`・`terraform` で使う箇所が無い（`M/aurora/outputs.tf:5-6` 以外に grep で 0 件）。reader instance は normal でも 1 台ある（`S/main.tf:39, 155`）ので、failover 先として箱だけ描く |
| docs の Mermaid の `api_c --> valkey_replica` | 報告では未指摘（突き合わせ担当が追加で確認） | **API → primary endpoint のみ**（`S/main.tf:618`）。replica への矢印は描かない |
| ticket-type cutover 系 workflow を描くか | CI/CD: 外すのが妥当。データ運用: メンテナンスとして列挙 | **描かない**。Gate A / Gate B の移行期間専用で、ADR-0033 決定 3 により退役予定（`.github/workflows/ticket-type-cutover-staging.yml:26-27`、`docs/runbooks/gate-b-ticket-type-cutover.md:19`） |
| canary が呼ぶ URL と path | CI/CD: 不明（スクリプト未読）。インフラ: 3 つの path | **CloudFront（app の FQDN）の `/api/healthz`、`/`、`/api/events`**（`M/synthetics-canary/files/syntheticCheck.js:24-30, 61-67`）。CloudFront・WAF を通る |
| EMF のビジネスメトリクスがメトリクスになる経路 | インフラ: 不明（log group にメトリクス抽出の設定が無い）。データ運用: 自動抽出 | **CloudWatch Logs が自動で抽出する**。AWS 公式: PutLogEvents で送る EMF について "you have the option to include the following HTTP header ... but it's not required"（日本語訳: ヘッダー `x-amzn-logs-format: json/emf` は付けてもよいが必須ではない）<https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Generation_PutLogEvents.html>。awslogs → log group → メトリクス → alarm の経路で、log group 側の追加設定は不要 |
| canary を描くか（既定値 `false`） | インフラ: 既定 false と記載。CI/CD・データ運用: 標準手順の 2 回目の apply で作る | **描く**。既定値は初回 apply の順序の都合で、標準手順（`staging-environment.md:270-277`、ADR-0043）の完了状態では存在する。作成の順序は README 本文で説明 |
| refresh token cleanup の実行基盤 | データ運用: API 内の `@Cron`、EventBridge Scheduler 版は廃止。CI/CD: 残存リソース検査の対象に Scheduler が残る | **API プロセス内の cron**（`src/database/refresh-token-cleanup.service.ts:5,23`、ADR-0041）。`check-residual-resources.sh` の Scheduler は destroy 後の残骸確認であり現行の構成要素ではない。EventBridge Scheduler は描かない |
| 購入の処理順 | 依頼時の仮説 | コードの順序と一致（「4. 番号を振る流れ」）。追加点は Valkey へのアクセスが ⑤ の後にもあること、⑥ が新規 confirmed の時だけであること |

---

## 7. 不明点

| 項目 | 不明な理由 | 関連ファイル |
| --- | --- | --- |
| 現在 staging が稼働しているか、どのモードで作られているか | 通常は destroy 済み。tfvars が無く、実環境は問い合わせない | `docs/architecture/staging-environment.md:5`、ADR-0008 |
| Aurora writer / reader、Valkey primary / replica、ECS task、NAT gateway がどの AZ にあるか | IaC で AZ を指定していない（`data.aws_availability_zones` の先頭 2 つ、配置は各サービスが決める） | `M/network/main.tf:1-7`、`M/aurora/main.tf:63-90`、`M/valkey/main.tf:31-55`、`M/ecs-service/main.tf:92-96` |
| Route 53 の hosted zone と IAM OIDC identity provider の作成元 | data source で参照するだけで、このリポジトリでは作らない | `S/main.tf:262-267`、`B/main.tf:59-62`、ADR-0009 |
| ECR Public のイメージレイヤーが S3 gateway endpoint を通るか | 経路を書いた docs が無い。NAT gateway を通ることまでは route table から言える | `S/main.tf:576`、`M/network/main.tf:92-101, 130-143` |
| CloudFront → ALB の TLS で Host ヘッダーと証明書がどう一致するか | origin は API の FQDN、origin request policy は `AllViewerExceptHostHeader`。実際の振る舞いは実環境でしか確認できない | `M/cloudfront/main.tf:14-16, 69-79, 112, 139` |
| GitHub Variables の値（role ARN、`AWS_REGION`）と `AWS_STAGING_READONLY_ROLE_ARN` の設定手順 | GitHub 側にあり、リポジトリに無い | `docs/architecture/dev-environment.md:139-143`、`.github/workflows/staging-smoke-test.yml:35` |
| 外部の reusable workflow（`kmryst/idp-golden-path`）の中身 | 別リポジトリで未読。AWS を使わないのは呼び出し側の permissions からの推定 | `raw/cicd.md` 表1(b) |
| Aurora の preferred backup window / maintenance window、OpenSearch の automated snapshot の時刻 | IaC で未指定（AWS が決める） | `M/aurora/variables.tf:76-80`、`M/opensearch/main.tf` |
| RPO / RTO | 未確定と明記（M-17 / M-18 未着手） | `docs/architecture/production-readiness.md:35-36` |

---

## 8. 参考: 環境・モード差分表（図には描かない）

`raw/infra.md` 表4 を元に、突き合わせ後の値。

| リソース | dev | staging normal（作図対象） | staging full | staging alb-http-only | 根拠 |
| --- | --- | --- | --- | --- | --- |
| NAT gateway | 1 | 1 | AZ ごと（2） | profile に従う | `terraform/environments/dev/main.tf:17-42`、`S/main.tf:25, 61` |
| API task（desired / autoscaling） | 1 / なし | 1 / なし | 2 / min 2・max 4・CPU 60% | profile に従う | `S/main.tf:27-34, 63-70` |
| Worker task | 1 | 1 | 2（autoscaling 2〜4） | profile に従う | 同上 |
| Frontend task | 1 | 1 | 2（autoscaling なし） | 作らない | `S/main.tf:775-798` |
| Aurora ACU / reader | 0〜2 / 0 | 0〜4 / 1 | 0.5〜8 / 1 | profile に従う | `S/main.tf:37-41, 73-77` |
| Valkey ノード / failover / TLS | 1 / 無効 / 無効 | 2 / 有効 / 有効 | 2 / 有効 / 有効 | profile に従う | `S/main.tf:43-46, 618` |
| OpenSearch ノード / zone awareness | 1 / 無効 | 1 / 無効 | 2 / 有効 | profile に従う | `M/opensearch/main.tf:51-53` |
| OpenSearch の access policy | VPC と SG のみ（`Principal "*"`） | api / worker の task role | 同左 | 同左 | `S/main.tf:193-196` |
| ALB listener / ingress | 80（301）+ 443、CloudFront prefix list | 同左 | 同左 | 80 のみ（API へ forward）、許可 CIDR を渡した時だけ | `M/alb/main.tf:79-118`、`S/main.tf:331-332` |
| CloudFront、AWS WAF、ACM、Route 53 alias、ログの S3、edge alarm・SNS | あり | あり | あり | 無し | `S/main.tf:262-355, 732-1361` |
| Synthetics canary | 2 回目の apply で作る | 2 回目の apply で作る | 同左 | 作らない | `S/main.tf:1408-1418`、`S/variables.tf:133-146` |
| trace のサンプリング | 1.0 | 0.1 | 0.1 | 0.1 | `S/main.tf:633` |
| Aurora final snapshot / deletion protection | skip / 無効 | skip / 無効 | skip / 無効 | 同左 | `S/main.tf:40-41, 76-77`、`terraform/environments/dev/main.tf:32` |
