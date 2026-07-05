# ADR（Architecture Decision Record）運用ルール

このディレクトリは、トレードオフを伴う設計判断を記録する ADR の正本です。

## いつ ADR を書くか

次のいずれかに該当する判断は ADR として記録する。

- 複数の実現方式があり、採用しなかった案にも合理性がある。
- 後から「なぜこうしたのか」を問われる可能性が高い。
- 変更コストが高い（インフラ構成、state 設計、DB 正本の配置など）。
- 既存の設計文書（`docs/architecture/` / `docs/poc/`）の方針を変更・確定する。

軽微な実装判断や、正本ドキュメントの記述で十分なものは ADR にしない。

## ファイル命名

```
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

- ADR は「判断の記録」、`docs/architecture/` は「現在の構成の正本」。
- ADR で判断が変わったら、対応する正本ドキュメントも同じ PR で更新する。
- 内容が衝突する場合は、ステータスが Accepted の最新 ADR を優先し、正本ドキュメントを追従させる。

## 一覧

| ADR | タイトル | ステータス |
|---|---|---|
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
