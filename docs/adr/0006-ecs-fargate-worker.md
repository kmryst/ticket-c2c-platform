# 0006. Worker を ECS Fargate にする

## ステータス

Accepted

## 日付

2026-07-02

## 背景

EventBridge に発行されたドメインイベント（`EventListed`、`TicketPurchased` など）を購読し、OpenSearch プロジェクション更新などの非同期処理を行う Worker の実行形態として、Lambda と ECS Fargate が候補だった。`docs/architecture/technology-stack.md` は初期案として「EventBridge + Lambda から OpenSearch へ同期」としていた。

Lambda 案の主な利点は、アイドル時のコストがゼロになる点だった。しかし ADR-0002 のとおり、dev 環境は使わない期間を destroy workflow で削除する運用のため、アイドルコストの差はほぼ消える。

## 決定

Worker は ECS Fargate で動かす。API と同じ NestJS コードベースの standalone エントリポイントとし、同一コンテナイメージをタスク定義の command 差し替えで API / Worker に使い分ける。

メッセージフローは EventBridge → SQS Standard + DLQ → ECS Worker のロングポーリング消費とする。

## 根拠

- destroy 前提運用により Lambda のアイドルコスト優位性が消える（稼働中の Worker タスクは約 $10/月で、環境ごと落とすため実質影響は軽微）。
- API と Worker でランタイム・ログ・メトリクスの観測方法が揃い、prod に近い形になる。
- ECR リポジトリとビルドが 1 つで済み、Lambda 用のパッケージング（esbuild + コンテナイメージ）が不要になる。deploy workflow は ECS 2 サービスの更新のみと単純になる。
- Lambda の 15 分実行時間制限を気にせず、将来の重い非同期処理（プロジェクションのバックフィルなど）にも使える。
- Worker のスケールは SQS キュー深度ベースの Auto Scaling を後から追加できる。

## 反対材料・トレードオフ

- 環境稼働中は処理がなくても Worker タスクが常駐する（Lambda なら呼び出し課金のみ）。
- イベント駆動の並列スケールは Lambda のほうが速い。スパイク時のプロジェクション遅延が問題になったら、キュー深度ベースのスケーリングで対応する。

## 再検討のトリガー

- dev の運用が destroy 前提から常時稼働へ変わり、アイドルコストが再び効いてくる場合。
- プロジェクション更新の遅延が要件を満たさず、スケールアウトの応答性が必要になった場合。
