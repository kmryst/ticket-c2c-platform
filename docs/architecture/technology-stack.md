# 技術スタックドラフト

## ステータス

ドラフト。

このドキュメントは、C2C チケット販売プラットフォームのシステム設計課題における、現時点の技術スタック方針を記録するものです。実装計画、ADR、最終決定ではありません。

## 対象システム

対象システムは、1 人のユーザーが購入者（Buyer）と販売者（Seller）の両方として利用できる C2C チケット販売プラットフォームです。

スコープ:

- イベント開催地、イベント種別、イベント開催日による検索。
- 将来的な検索条件追加への対応。
- 検索条件に一致したイベント一覧の表示。
- イベントチケットの購入。

スコープ外:

- 決済管理。
- 購入キャンセル。
- 料金や収容人数による検索。
- 購入者（Buyer）/ 販売者（Seller）間メッセージ。

主な制約:

- 最大 500 万人のユーザーを想定する。
- 人気イベントでは通常の約 100 倍のトラフィックが発生する可能性がある。
- 人気イベントへのトラフィック集中が他イベントの性能を劣化させない必要がある。
- チケット予約は在庫数を超えてはならない。
- 検索と購入は、イベントリスティングの約 10 倍の頻度で行われる想定。

## 推奨スタック

| レイヤ | 推奨 |
| --- | --- |
| フロントエンド | Next.js（App Router / SSR）/ React / TypeScript / Tailwind CSS（[ADR-0011](../adr/0011-nextjs-ssr-on-ecs-with-cloudfront-unified-origin.md)） |
| API 入口 | ALB（prod では CloudFront + WAF を前段に追加。[ADR-0005](../adr/0005-alb-as-api-entry.md)） |
| バックエンド | NestJS / TypeScript |
| API 形式 | REST + OpenAPI |
| 実行環境 | ECS Fargate |
| 正本 DB | Aurora PostgreSQL |
| 検索 | OpenSearch |
| キャッシュ / 在庫前段フィルタ | ElastiCache Valkey |
| キュー | SQS Standard。イベント単位の購入順序制御が必要な箇所のみ SQS FIFO（[ADR-0004](../adr/0004-defer-sqs-fifo.md)） |
| イベントバス | EventBridge |
| 検索同期 | EventBridge + SQS + ECS Fargate Worker から OpenSearch へ同期（[ADR-0006](../adr/0006-ecs-fargate-worker.md)） |
| インフラ | Terraform |
| CI/CD | GitHub Actions |
| 可観測性 | CloudWatch + OpenTelemetry/ADOT + X-Ray |

## 設計方針

Aurora PostgreSQL は、ユーザー、イベント、チケット在庫、購入の正本とする。購入確定では、過剰販売を防ぐためにデータベーストランザクションと条件付き更新を使う。

OpenSearch はイベント検索を担当する。検索条件には位置情報、イベント種別、イベント開催日が含まれ、将来的に検索軸が増える可能性もあるためです。Aurora を正本にし、OpenSearch は読み取り最適化された検索用プロジェクションとして扱います。

Valkey は、特に人気イベントの購入フロー前段で高速な在庫フィルタとして使う。売り切れ後のリクエストを Aurora に到達する前に拒否するためです。Valkey は最終的な正本ではありません。

一般的な非同期処理には SQS Standard が適している。イベント単位の順序制御や流量制御が必要な購入パスだけ、`eventId` をメッセージグループキーとして SQS FIFO を導入する。

EventBridge では、`EventListed`、`EventUpdated`、`InventoryChanged`、`TicketPurchased` などのドメインイベントを発行する。検索インデックス更新はこれらのイベントを購読し、OpenSearch を非同期に更新する。

REST + OpenAPI は、今回のスコープが比較的明確で、運用が単純で、キャッシュや観測もしやすいため初期案として適している。GraphQL は、フロントエンドのクエリ形状が複雑になった段階で BFF レイヤとして再検討する。

## 購入フロー方針

購入パスでは、正確性とスループットの両方を守る設計にする。

1. 購入者（Buyer）が購入リクエストを送る。
2. API レイヤで認証、レート制限、基本的なバリデーションを行う。
3. バックエンドが Valkey の在庫カウンタを確認・減算し、高速拒否を行う。
4. より厳密なイベント単位の直列化が必要な場合は、`MessageGroupId = eventId` で SQS FIFO に投入する。
5. ワーカーまたはバックエンドが Aurora PostgreSQL で条件付き在庫更新を行い、購入を確定する。
6. EventBridge に `TicketPurchased` または `InventoryChanged` を発行する。
7. 後続コンシューマーが OpenSearch やその他の読み取りモデルを更新する。

最終的な在庫正確性は Aurora PostgreSQL で保証する。Valkey と SQS は、負荷低減、スパイク吸収、人気イベントトラフィックの影響隔離のために使う。

## 検索フロー方針

検索パスは、書き込みパスとは分けて最適化する。

1. 購入者（Buyer）が位置情報、イベント種別、イベント開催日、将来追加される検索条件で検索する。
2. API が検索リクエストを検索サービスまたはバックエンドにルーティングする。
3. バックエンドが OpenSearch に問い合わせ、一致するイベント ID と概要データを取得する。
4. 頻繁に参照される検索結果は、必要に応じてキャッシュする。
5. Aurora は、正本確認が必要な場合にだけ参照する。

この分離により、検索と購入がイベントリスティングより高頻度で行われるという要件に対応しやすくなる。

## Claude Code レビュー記録

Claude Code は初期スタック方針をレビューし、全体として妥当と評価した。

主な懸念:

- API Gateway または ALB を API 入口およびスロットリングレイヤとして明示すべき。
- Aurora だけで在庫更新する方式は正確だが、人気イベントではホット行ボトルネックになる可能性がある。
- 人気イベントの購入スパイクが Aurora のコネクション、CPU、I/O を消費し、他イベントに影響する可能性がある。
- Aurora から OpenSearch への同期方式を明示すべき。

レビューで推奨された調整:

- Aurora の前段に高速な在庫フィルタとして Valkey を置く。
- イベント単位の購入直列化が必要な箇所でのみ SQS FIFO を使う。
- Aurora PostgreSQL を最終的な正本として維持する。
- OpenSearch 更新の初期案として EventBridge + Lambda を使う。
- 読み取り分離が必要な箇所では Aurora Reader Endpoint を検討する。

## 未決事項

- Aurora と OpenSearch の間で、どの程度の整合性遅延を許容するか。
- 認証は Cognito にするか、Auth0 などの外部プロバイダーにするか。
- 在庫サービスは最初から分離するか、NestJS バックエンドがボトルネックになってから分離するか。

## 確定済み事項

以下は ADR として決定を記録済み。

- API 入口は ALB（[ADR-0005](../adr/0005-alb-as-api-entry.md)）。
- 購入確定は当面 Valkey 後の同期処理とし、SQS FIFO はスパイク検証の結果を見て判断（[ADR-0004](../adr/0004-defer-sqs-fifo.md)）。
- 非同期 Worker は ECS Fargate（[ADR-0006](../adr/0006-ecs-fargate-worker.md)）。
- dev 環境の構成は [dev 環境設計](./dev-environment.md) を正本とする。
