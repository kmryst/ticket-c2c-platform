# staging 環境設計

## ステータス

ドラフト。

このドキュメントは、AWS 上の staging 環境構成と運用方針の正本候補です。staging は dev と異なり、本番化前に本番相当の冗長構成・デプロイ経路・運用手順を検証する環境とします。

ただし、staging は prod と同じサイズで常時稼働させる環境ではありません。本番と同じ壊れ方を検証できるトポロジーを保ちつつ、未使用時の destroy、scheduled scaling、最小サイズ、再作成可能な seed data によりコストを抑えます。

## 位置づけ

| 環境 | 目的 | コスト方針 | データ方針 |
|---|---|---|---|
| dev | 本番系トラックの最初の環境。構築・配線・機能検証 | 最小構成。未使用時 destroy | 破棄可能 |
| staging (`capacity_profile=normal`) | prod 移行前の本番相当トポロジー検証 | 本番相当構成を最小サイズで運用。未使用時 destroy / scale down | seed で再作成可能 |
| staging (`capacity_profile=full`) | リリース前・負荷検証・failover 検証用の一時的な強化プロファイル | 短時間のみ本番に近い冗長構成 | seed + 検証データ |
| prod | 本番サービス提供 | 常時稼働。可用性・保護優先 | 永続・保護対象 |

Terraform では `terraform/environments/<name>/` の root module と state を環境単位とし、`capacity_profile` は同じ環境内のサイズ・冗長化モードとして扱う。`staging-full` は独立した環境名ではなく、staging root に `capacity_profile=full` を指定した状態を指す。

## 基本方針

- staging は prod と同じ主要コンポーネント構成を持つ。
- staging のリソースサイズは、性能ではなく配線・冗長化・failover・運用手順を検証できる最小値にする。
- 未使用時は destroy できる前提で、schema apply、seed、smoke test を自動化する。
- 夜間や週末など予測可能な未使用時間は、ECS service scheduled scaling で API / Worker を 0 まで落とす。
- Aurora Serverless v2 は idle 時に auto-pause できる構成を維持し、ECS 停止中に不要な接続を残さない。
- Valkey、OpenSearch、NAT Gateway、VPC endpoint など scale-to-zero しにくい固定費リソースは、長期未使用時に destroy で止める。
- staging の destroy は prod と異なり許可するが、GitHub Environment protection と明示的な confirm 入力を必須にする。

## 推奨構成

```
Internet
  |
  v
ALB
  |
  +--> ECS Fargate API task x2+ across private subnets
          |
          +--> Aurora PostgreSQL Serverless v2
          |      - writer
          |      - failover reader
          |
          +--> ElastiCache Valkey
          |      - primary
          |      - replica
          |      - automatic failover
          |
          +--> OpenSearch
          |      - capacity_profile=normal: single-node profile
          |      - capacity_profile=full: Multi-AZ profile
          |
          +--> EventBridge
                    |
                    v
                  SQS Standard + DLQ
                    |
                    v
                  ECS Fargate Worker task x2+
                    |
                    v
                  OpenSearch
```

## 冗長化方針

### API / Worker

- API は最小 2 タスクにし、異なる private subnet / AZ に配置する。
- Worker も最小 2 タスクにし、SQS backlog や oldest message age を見て scale out できるようにする。
- API の最低稼働分は Fargate on-demand を使う。
- Worker、バッチ、負荷検証ジョブなど中断に耐えやすい処理では Fargate Spot を検討する。
- ECS service deployment circuit breaker を有効化し、壊れたイメージの起動ループを早く止める。

### Aurora PostgreSQL

- staging は writer 1 + failover reader 1 を基本にする。
- Serverless v2 の min ACU は、通常 staging では 0 または低い値を使う。
- failover、schema apply、secret rotation、connection pool の挙動を staging で検証する。
- staging data は seed から再作成できる前提にし、prod のような長期保護対象にはしない。

### Valkey

- staging では primary + replica + automatic failover を基本にする。
- Valkey 障害時に API が fail-open して Aurora へ負荷を逃がす挙動を検証する。
- 人気イベント売り切れ後のリクエストが Aurora に到達しないことを負荷検証で確認する。

### OpenSearch

- staging 通常時（`capacity_profile=normal`）は小さい profile でよい。
- `capacity_profile=full` では Multi-AZ profile を使い、index replication、AZ 障害、Worker 再投入、検索プロジェクション遅延を検証する。
- OpenSearch は正本ではないが、検索が主要導線なので prod では冗長化を必須にする。
- staging では OpenSearch を常時本番相当サイズで動かさず、リリース前や障害訓練時だけ強化 profile に切り替える。

### Network

- VPC は 2 AZ 以上を維持する。
- staging 通常時（`capacity_profile=normal`）は dev と同じく NAT Gateway 1 台も許容するが、`capacity_profile=full` / prod では AZ ごとの NAT Gateway を検証する。
- SQS、EventBridge、Secrets Manager など、NAT 依存を減らせる VPC endpoint は段階的に追加する。

## コスト削減策

| 施策 | 対象 | 方針 |
|---|---|---|
| destroy 運用 | staging 全体 | 長期未使用時は環境ごと削除する |
| scheduled scaling | ECS API / Worker | 夜間・週末に desired count を 0 にする |
| Aurora auto-pause | Aurora Serverless v2 | ECS 停止中に DB compute を止める |
| 最小サイズ profile | ECS / Aurora / Valkey / OpenSearch | staging 通常時は本番相当構成を小さいサイズで動かす |
| `capacity_profile=full` | OpenSearch / NAT / 負荷検証 | リリース前・障害訓練時だけ本番寄せ構成へ切り替える |
| seed 再投入 | DB / Search projection | destroy 後も再現できるデータだけを保持する |
| Fargate Spot | Worker / 検証ジョブ | 中断しても SQS 再処理や再実行で回復できる処理に限定して使う |

## 再構築フロー

staging は destroy 可能にするため、再構築手順を GitHub Actions で自動化する。

```
terraform apply
  -> deploy app
  -> apply schema
  -> seed staging data
  -> run smoke test
  -> publish endpoint / summary
```

smoke test では最低限、次を確認する。

- `GET /healthz`
- `GET /readyz`
- `POST /events`
- `GET /events/search`
- `POST /events/:eventId/purchases`
- EventBridge -> SQS -> Worker -> OpenSearch projection
- 売り切れ後の Valkey 前段拒否

## Readiness checklist

staging 環境を作る前に、少なくとも次を満たす。

- [x] GitHub Environment `staging` / `staging-destroy` に required reviewer と branch restriction を設定する。**Environment は先に手動作成して保護設定を入れてから workflow で参照する**（未保護のまま `environment:` で参照すると保護なしで自動作成されてしまうため）。設定済み（2026-07-03、reviewer: kmryst、branch restriction: 全 4 環境とも custom branch policy で `main` 固定）。
- [ ] bootstrap の `apply_environments`（`terraform/environments/bootstrap/main.tf`、IAM OIDC trust）に `staging` / `staging-destroy` を追加し、bootstrap を再 apply する。現状は `["dev", "dev-destroy"]` のみで、staging 用ロールの trust policy が存在しない。
- [ ] apply IAM ロールを `AdministratorAccess` から縮小する（dev で先に検証し、staging 追加時に trust policy と合わせて見直す）。
- [x] staging 用 Terraform backend key を dev / prod と分離する。対応済み（Issue #78。`terraform/environments/staging/` を `staging/app/terraform.tfstate` で追加）。
- [x] Terraform root / state は `dev` / `staging` の環境単位にし、staging の通常構成 / 本番寄せ構成は `capacity_profile=normal|full` で切り替えられる。対応済み（Issue #78、Issue #80。prod は対象外）。
- [x] API / Worker の desired count、min / max capacity、scheduled scaling を変数化する。対応済み（Issue #78）。
- [x] Aurora の failover reader 有無、min / max ACU、deletion protection、final snapshot を変数化する。対応済み（Issue #78）。
- [x] Valkey の replica count、automatic failover、encryption 設定を変数化する。対応済み（Issue #78）。
- [x] OpenSearch の single-node / Multi-AZ profile を切り替えられる。対応済み（Issue #78）。
- [x] NAT Gateway の single / per-AZ 構成を切り替えられる。対応済み（Issue #78）。
- [ ] seed data と smoke test を自動実行できる。
- [ ] destroy workflow に `confirm=destroy-staging` と Environment protection を設定する。
- [ ] API / Worker の desired count を 2 以上にする前に、`schema-on-boot` をマイグレーションツールへ移行する（複数タスク同時起動時の DDL 競合を避けるため。[production-readiness.md](./production-readiness.md) L-4）。
- [x] OpenSearch のアクセスポリシーを IAM 認証（SigV4 署名）に切り替える前に、アプリ側の署名クライアント実装を dev で先行検証しておく（[production-readiness.md](./production-readiness.md) M-3）。対応済み（2026-07-03、PR #75。API / Worker とも SigV4 署名クライアントで dev の接続・インデックス・検索を確認。アクセスポリシー切り替えは staging 構築時に実施）。
- [ ] 本番化ギャップは `production-readiness.md` に移す。

## production-readiness.md との関係

このドキュメントは staging 自体の設計正本です。

`production-readiness.md` は、dev / staging から prod に上げる前に解消すべき未対応ギャップのバックログとして扱います。staging で意図的に許容するコスト削減策が prod では許容できない場合、その差分を `production-readiness.md` に残します。

## ADR 候補

次の判断が固まった時点で ADR として記録する。

- staging を destroy 可能な prod-like 環境として扱うか。
- staging data を seed 再作成前提にするか。
- OpenSearch Multi-AZ を staging 常時構成にするか、`capacity_profile=full` の一時構成にするか。
- Fargate Spot を Worker / 検証ジョブで使うか。

## 関連ドキュメント

- [dev 環境設計](./dev-environment.md)
- [dev 環境 本番化ギャップ一覧](./production-readiness.md)
- [技術スタックドラフト](./technology-stack.md)
- [技術検証計画](../poc/technical-validation-plan.md)
- [ADR 一覧](../adr/README.md)
