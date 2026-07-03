# ticket-c2c-platform

チケット購入者と販売者の両方の機能を提供する、C2C チケット販売プラットフォームのシステム設計プロジェクトです。

## ステータス

設計 + dev 環境構築中。

システム要件、技術選定、アーキテクチャ方針の整理に加え、ローカル在庫 PoC の実施を経て、AWS 上の dev 環境（本番系トラックの最初の環境）の構築を進めています。

## ドキュメント

| パス | 目的 |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | Issue / Branch / Commit / PR / Label の運用ルール |
| [AGENTS.md](AGENTS.md) | Codex 向け作業ルール |
| [CLAUDE.md](CLAUDE.md) | Claude Code 向け作業ルール |
| [docs/requirements/system-requirements.md](docs/requirements/system-requirements.md) | 課題要件、スコープ、制約の整理 |
| [docs/architecture/technology-stack.md](docs/architecture/technology-stack.md) | 技術スタックと設計方針のドラフト |
| [docs/poc/technical-validation-plan.md](docs/poc/technical-validation-plan.md) | PoC と技術検証の計画 |
| [docs/architecture/dev-environment.md](docs/architecture/dev-environment.md) | AWS dev 環境設計の正本 |
| [docs/architecture/staging-environment.md](docs/architecture/staging-environment.md) | AWS staging 環境設計の正本候補 |
| [docs/architecture/production-readiness.md](docs/architecture/production-readiness.md) | dev 環境の本番化ギャップ一覧（未対応課題バックログ） |
| [docs/adr/README.md](docs/adr/README.md) | ADR（設計判断の記録）一覧と運用ルール |
| [docs/poc/dev-environment-verification.md](docs/poc/dev-environment-verification.md) | dev 環境の初回構築・検証記録 |
| [docs/poc/inventory-purchase-poc.md](docs/poc/inventory-purchase-poc.md) | 在庫購入 PoC の実行手順 |
| [docs/poc/inventory-purchase-reading-guide.md](docs/poc/inventory-purchase-reading-guide.md) | 在庫購入 PoC の構成図と読み解きメモ |

## 現在のスコープ

- 購入者（Buyer）/ 販売者（Seller）ロールを持つユーザー設計
- イベント検索
- イベント一覧表示
- チケット購入
- 人気イベントへのトラフィック集中対策
- 在庫超過予約の防止

## スコープ外

- 決済管理
- 購入キャンセル
- 料金や収容人数による検索
- 購入者（Buyer）/ 販売者（Seller）間メッセージ

## リポジトリ方針

- 実装コードは、要件定義と設計方針が固まってから追加する。
- 設計判断は必要に応じて `docs/architecture/` または ADR として記録する。
- 秘密情報、`.env`、認証情報はコミットしない。

## ローカル在庫 PoC

PostgreSQL の条件付き更新で在庫超過を防ぐ最小 PoC を実行できます。

```bash
npm install
cp .env.example .env
docker compose up -d
docker compose exec -T postgres psql -U ticket_poc -d ticket_poc < database/schema.sql
npm run start:dev
```

別ターミナルで検証します。

```bash
npm run poc:inventory
```
