# ADR（Architecture Decision Record）運用ルール

このディレクトリは、トレードオフを伴う設計判断を ADR（Architecture Decision Record）として残す場所です。

現在の仕様・構成・運用手順は、領域ごとに定められた正本に従います。
ADR はその正本を置き換えるものではなく、重要な設計判断の背景・採択理由・トレードオフ・再検討条件を記録するものです。

## いつ ADR を書くか

次のいずれかに該当する判断は ADR として記録する。

- 複数の実現方式があり、採用しなかった案にも合理性がある。
- 後から「なぜこうしたのか」を問われる可能性が高い。
- 変更コストが高い（インフラ構成、state 設計、DB 正本の配置など）。
- 領域ごとの正本ドキュメントの方針を変更・確定する。

軽微な実装判断や、正本ドキュメントの記述で十分なものは ADR にしない。

## ファイル命名

```text
docs/adr/NNNN-kebab-case-title.md
```

- `NNNN` は 0001 からの連番。欠番は詰めない。
- 1 ファイル 1 判断。

## フォーマット

```markdown
# NNNN. タイトル

## ステータス

Accepted | Superseded by [NNNN](./NNNN-xxx.md) | Deprecated

## 日付

YYYY-MM-DD

## 背景

判断が必要になった文脈。要件・制約・きっかけ。

## 決定

採用した方式を断定形で書く。

## 根拠

採用理由。可能なら数値・比較を含める。

## 反対材料・トレードオフ

採用案の弱点、不採用案が優位になる条件を正直に書く。

## 再検討のトリガー

この判断を見直すべき具体的な条件。
```

## 既存ドキュメントとの関係

- 現在の仕様・構成・運用手順は、領域ごとに定められた正本に従う。
- ADR はその正本を置き換えるものではなく、判断の背景・採択理由・トレードオフ・再検討条件を記録する。
- ADR で判断が変わったら、対応する正本ドキュメントも同じ PR で更新する。
- 内容が衝突する場合は、現在状態の確認では領域ごとの正本を優先し、判断履歴の確認ではステータスが Accepted の最新 ADR を参照する。
  必要に応じて ADR のステータス更新または正本ドキュメントの追従を同じ PR で行う。

## 一覧

| ADR | タイトル | ステータス |
| --- | --- | --- |
| [0001](./0001-record-architecture-decisions.md) | ADR で設計判断を記録する | Accepted |
| [0002](./0002-dev-environment-as-first-prod-track-environment.md) | dev 環境を本番系トラックの最初の環境として位置づける | Accepted |
| [0003](./0003-terraform-state-and-environment-isolation.md) | Terraform の state / 環境分離設計 | Accepted |
| [0004](./0004-defer-sqs-fifo.md) | SQS FIFO を初期 dev 環境に含めない | Accepted |
| [0005](./0005-alb-as-api-entry.md) | API 入口に ALB を採用する | Accepted |
| [0006](./0006-ecs-fargate-worker.md) | Worker を ECS Fargate にする | Accepted |
| [0007](./0007-alb-https-with-acm-and-ingress-variable.md) | dev の ALB を HTTPS 化し、HTTP は明示的リダイレクトに限定する | Accepted |
| [0008](./0008-staging-ephemeral-prod-like-environment.md) | staging をエフェメラルな prod-like 環境とし、初回 endpoint を alb-http-only にする | Accepted |
| [0009](./0009-migrate-to-project-domain.md) | プロジェクト専用ドメイン ticket-c2c.click へ移行する | Accepted |
| [0010](./0010-email-password-jwt-auth.md) | メール+パスワード認証を自前実装（bcrypt + JWT + 自作 Guard）で行う | Accepted |
| [0011](./0011-nextjs-ssr-on-ecs-with-cloudfront-unified-origin.md) | フロントエンドを Next.js SSR コンテナとして ECS でホスティングし、CloudFront 統合オリジン + httpOnly Cookie 認証を採用する | Accepted |
| [0012](./0012-refresh-token-rotation-and-auth-hardening.md) | リフレッシュトークンのローテーションと認証の堅牢化（reuse detection・レート制限・シークレットローテーション） | Accepted |
| [0013](./0013-restrict-alb-ingress-to-cloudfront-prefix-list.md) | ALB の ingress を CloudFront managed prefix list に限定し、直叩きを遮断する | Accepted |
| [0014](./0014-xray-distributed-tracing-with-adot-sidecar.md) | X-Ray 分散トレーシングを ADOT collector sidecar で導入し、EMF でビジネスメトリクスを出す | Accepted |
| [0015](./0015-purchase-rate-limit-dual-key.md) | 購入エンドポイントのレート制限を user_id 主体の dual-key 方式で導入する | Accepted |
| [0016](./0016-purchase-api-sli-definition.md) | 購入 API の SLI（成功率・レイテンシ）を定義する | Accepted |
| [0017](./0017-purchase-api-slo-burn-rate.md) | 購入 API の SLO 目標値と burn-rate アラートを実装する | Accepted |
| [0018](./0018-ecs-autoscaling-scoped-to-staging-full.md) | ECS Auto Scaling policy は staging-full にのみ実装し、frontend は desired_count のみで冗長化する | Accepted |
| [0019](./0019-remove-ecr-logs-interface-endpoints.md) | dev / staging から ECR / Logs の Interface VPC Endpoint を撤去する | Accepted |
| [0020](./0020-reframe-as-b2c-primary-ticketing.md) | 既存リポジトリを B2C 一次販売プラットフォームへ転換する | Accepted |
| [0021](./0021-protected-zone-purchase-flow.md) | Protected Zone 内の購入フローと疑似決済境界を定義する | Accepted |
| [0022](./0022-b2c-purchase-journey-success-sli.md) | B2C 購入ジャーニーの技術的成功率 SLI を定義する | Accepted |
| [0023](./0023-split-b2c-purchase-journey-latency-sli.md) | B2C 購入ジャーニーのレイテンシ SLI を 2 つに分ける | Accepted |
| [0024](./0024-b2c-synchronous-api-latency-boundary.md) | B2C 同期 API のサーバー側レイテンシ計測境界を定義する | Accepted |
