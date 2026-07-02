# dev 環境 初回構築・検証記録

## ステータス

実施済み（2026-07-02）。

AWS dev 環境（[dev 環境設計](../architecture/dev-environment.md)）の初回の 構築 → デプロイ → 動作検証 → destroy の一巡を記録する。

## 実施経路

すべて GitHub Actions（AWS OIDC、長期アクセスキー不使用）で実施した。

| フェーズ | workflow run | 結果 |
|---|---|---|
| terraform apply（初回） | 28580430318 | 失敗（下記「初回 apply の失敗」） |
| terraform apply（再実行） | 28581245219 | 成功 |
| deploy-app | 28582177153 | 成功（build → ECR push → ECS 2 サービス安定化） |
| terraform destroy | 28582659045 | 成功（三重ゲート: 手動実行 + `confirm=destroy-dev` + Environment `dev-destroy`） |

### 初回 apply の失敗と対処

1. **OpenSearch**: `ValidationException: you must enable a service-linked role`。SLR `AWSServiceRoleForAmazonOpenSearchService` が初回 CreateDomain の途中で AWS により自動作成され（09:39:38 UTC）、伝播レースで初回のみ失敗。再実行で解消。コード変更不要。
2. **ElastiCache**: description の日本語が `InvalidParameterValue` で拒否された。ASCII 表記へ修正（PR #25）。

## 動作検証結果（ALB 経由）

環境: Aurora Serverless v2（min 0 ACU）、Valkey cache.t4g.micro ×1、OpenSearch t3.small ×1、ECS Fargate API / Worker 各 1 タスク。

### health

- `GET /healthz` → `{"status":"ok"}`
- `GET /readyz` → `{"status":"ok","database":"ok"}`（Aurora 接続 + schema-on-boot 適用を確認）

### イベント登録・検索（読み書き分離経路）

- `POST /events`（在庫 5、位置=東京駅、music、2026-08-15）→ 201。
- 登録から約 10 秒後、`GET /events/search` が OpenSearch から正しく応答:
  - `eventType=music&date=2026-08-15` → 1 件ヒット
  - 東京駅から半径 50km の geo 検索 → 1 件ヒット
  - 大阪駅から半径 10km の geo 検索 → 0 件（正しく除外）
- プロジェクション経路 EventBridge → SQS → ECS Worker → OpenSearch の全段が機能。

### 並列購入（在庫超過防止 + 前段フィルタ）

| 項目 | 値 |
|---|---:|
| 在庫 | 5 |
| 並列購入リクエスト | 12（同時） |
| confirmed | 5 |
| rejected（`sold_out_precheck`、Valkey 前段拒否） | 7 |
| API エラー | 0 |
| 売り切れ後の追加バースト 10 件 | 10 件全て前段拒否 |
| DB 残在庫（一覧 API で確認） | 0 |
| OpenSearch プロジェクションの残在庫 | 0（InventoryChanged で同期） |
| oversold | **false**（confirmed 5 = 在庫 5） |

- 前段拒否された 17 件（7 + 10）は PostgreSQL に到達していない（purchases への記録なし = フィルタの設計意図どおり）。
- 売り切れ後の拒否レイテンシ（ALB 経由 10 サンプル）: p50 24.6ms / min 24.3ms / max 83.8ms。

### 判断できること

- Aurora 条件付き更新 + Valkey 前段フィルタの組で、クラウド環境でも在庫超過 0 を維持できた。
- 売り切れ後のトラフィックが Aurora に到達しないことをクラウド実機で確認できた（検証計画フェーズ 1 の受け入れ基準「Valkey により売り切れ後の不要な PostgreSQL 到達数が減る」に対応）。
- destroy → 再 apply で環境を Terraform のみから再現できる。

### まだ判断できないこと

- k6 による高負荷時のレイテンシ分布・エラー率（今回は機能検証レベルの並列数）。
- 人気イベント集中時の他イベント影響隔離（複数イベント同時負荷は未実施）。
- SQS FIFO の要否（ADR-0004 のとおり、スパイク検証の測定後に判断）。

## 次の候補

1. k6 負荷テストを dev 環境に対して実施し、p50 / p95 / p99・エラー率・PostgreSQL 到達数を記録する。
2. 人気イベント 1 件 + 通常イベント複数の同時負荷で影響隔離を測定する。
3. 測定結果から SQS FIFO / スケーリング方針を ADR として判断する。

## 運用メモ

- 検証しない期間は destroy 済みが定常状態。再開手順: `terraform-apply.yml`（dev）→ `deploy-app.yml`（dev）。
- GitHub Environments `dev` / `dev-destroy` には required reviewer が未設定（無人実行のため）。**本格運用前に required reviewer の設定を推奨**。
