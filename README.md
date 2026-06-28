# ticket-c2c-platform

チケット購入者と販売者の両方の機能を提供する、C2C チケット販売プラットフォームのシステム設計プロジェクトです。

## ステータス

設計ドラフト。

このリポジトリは現時点では実装プロジェクトではなく、システム要件、技術選定、アーキテクチャ方針、提出用の設計資料を整理するための場所です。

## ドキュメント

| パス | 目的 |
|---|---|
| [docs/requirements/system-requirements.md](docs/requirements/system-requirements.md) | 課題要件、スコープ、制約の整理 |
| [docs/architecture/technology-stack.md](docs/architecture/technology-stack.md) | 技術スタックと設計方針のドラフト |
| [docs/poc/technical-validation-plan.md](docs/poc/technical-validation-plan.md) | PoC と技術検証の計画 |

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
