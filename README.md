# ticket-c2c-platform

人気イベントの販売開始時に発生するアクセス集中へ対応し、イベント主催者（Organizer）が購入者（Customer）へ一次販売チケットを提供する B2C チケット販売プラットフォームのシステム設計プロジェクトです。

## ステータス

既存の C2C 在庫購入基盤は staging 環境での検証まで完了。B2C 一次販売への転換方針と目標設計を確定し、実装は未着手です。prod 化も未着手です。

転換前の C2C 構成では、システム要件、技術選定、アーキテクチャ方針の整理とローカル在庫 PoC を経て、AWS 上の dev 環境を構築し、staging 環境（本番寄せ構成 `capacity_profile=full`）で k6 負荷検証・Aurora / Valkey / OpenSearch の failover 検証まで実施済みです。既存の実測値と ADR は歴史的記録として保持し、B2C 目標構成の実装済み証拠とは区別します。検証で見つかった課題や残作業は [docs/architecture/production-readiness.md](docs/architecture/production-readiness.md) にバックログとして記録しています。

GitHub リポジトリ名と AWS リソース名は、GitHub OIDC、IAM、Terraform state を安全に移行するまで `ticket-c2c-platform` のまま維持します。

## ドキュメント

| パス | 目的 |
| --- | --- |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Issue / Branch / Commit / PR / Label の運用ルール |
| [AGENTS.md](AGENTS.md) | Codex 向け作業ルール |
| [CLAUDE.md](CLAUDE.md) | Claude Code 向け作業ルール |
| [docs/requirements/system-requirements.md](docs/requirements/system-requirements.md) | 課題要件、スコープ、制約の整理 |
| [docs/architecture/technology-stack.md](docs/architecture/technology-stack.md) | 現行実装と B2C 目標構成の技術スタック方針 |
| [docs/architecture/primary-ticket-sales.md](docs/architecture/primary-ticket-sales.md) | B2C 一次販売フローの仕様と構成の正本 |
| [docs/architecture/observability.md](docs/architecture/observability.md) | 現行 dev / staging の可観測性・アラーム・運用方針の正本 |
| [docs/architecture/b2c-purchase-journey-observability.md](docs/architecture/b2c-purchase-journey-observability.md) | 未実装の B2C 購入ジャーニーに対する可観測性の目標設計 |
| [docs/architecture/observability-verification-log.md](docs/architecture/observability-verification-log.md) | 可観測性の実地検証記録 |
| [docs/poc/technical-validation-plan.md](docs/poc/technical-validation-plan.md) | PoC と技術検証の計画 |
| [docs/architecture/dev-environment.md](docs/architecture/dev-environment.md) | AWS dev 環境設計の正本 |
| [docs/architecture/staging-environment.md](docs/architecture/staging-environment.md) | AWS staging 環境設計の正本 |
| [docs/architecture/staging-environment-verification-log.md](docs/architecture/staging-environment-verification-log.md) | AWS staging 環境の構築・負荷・failover・機能検証記録 |
| [docs/architecture/capacity-planning.md](docs/architecture/capacity-planning.md) | 負荷シナリオと容量・コスト見積りの作業文書 |
| [docs/architecture/production-readiness.md](docs/architecture/production-readiness.md) | dev / staging / B2C / prod の未対応課題バックログ |
| [docs/architecture/production-readiness-log.md](docs/architecture/production-readiness-log.md) | Production Readiness 対応済み項目の実装・検証記録 |
| [docs/adr/README.md](docs/adr/README.md) | ADR（設計判断の記録）一覧と運用ルール |
| [docs/poc/dev-environment-verification.md](docs/poc/dev-environment-verification.md) | dev 環境の初回構築・検証記録 |
| [docs/poc/inventory-purchase-poc.md](docs/poc/inventory-purchase-poc.md) | 在庫購入 PoC の実行手順 |
| [docs/poc/inventory-purchase-reading-guide.md](docs/poc/inventory-purchase-reading-guide.md) | 在庫購入 PoC の構成図と読み解きメモ |

## 目標スコープ

- イベント主催者（Organizer）によるイベントと Ticket Type の登録
- 購入者（Customer）によるイベント検索と一次販売チケットの購入
- イベント検索
- イベント一覧表示
- Waiting Room と Protected Zone の流入制御
- Purchase Session、Ticket Hold、Purchase の段階的な購入フロー
- General Admission の数量在庫と、将来の Reserved Seating 拡張境界
- 在庫超過販売の防止
- local / staging 限定の Fake Payment API による決済依存障害の検証

## スコープ外

- 実際の Payment Service Provider とカード情報の処理
- 購入確定後のキャンセル、返金
- 料金や収容人数による検索
- 個人によるチケット再出品、個人間取引、売上金精算、チケット譲渡
- チケットの二次流通

## リポジトリ方針

- 現行の仕様・構成・運用手順は領域ごとの `docs/architecture/` 正本に記録し、トレードオフを伴う重要な設計判断の背景・理由・再検討条件は ADR に記録する。
- 秘密情報、`.env`、認証情報はコミットしない。

## ローカル在庫 PoC

PostgreSQL の条件付き更新で在庫超過を防ぐ最小 PoC を実行できます。

```bash
npm install
cp .env.example .env
docker compose up -d
docker compose exec -T postgres psql -U ticket_poc -d ticket_poc < database/schema.sql
AUTH_RATE_LIMIT_PURCHASE_IP=10000 \
AUTH_RATE_LIMIT_PURCHASE_SECONDARY=10000 \
npm run start:dev
```

別ターミナルで検証します。

```bash
npm run poc:inventory
```

レート制限の上書きは、同じ検証ユーザーから購入を繰り返す在庫 PoC 専用です。通常の dev / staging 設定には適用しません。
