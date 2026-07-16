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
| キュー | SQS Standard。購入パスの SQS FIFO は未採用（[ADR-0004](../adr/0004-defer-sqs-fifo.md)） |
| イベントバス | EventBridge |
| 検索同期 | EventBridge + SQS + ECS Fargate Worker から OpenSearch へ同期（[ADR-0006](../adr/0006-ecs-fargate-worker.md)） |
| インフラ | Terraform |
| CI/CD | GitHub Actions |
| 可観測性 | CloudWatch + OpenTelemetry/ADOT + X-Ray |

## 設計方針

Aurora PostgreSQL は、ユーザー、イベント、チケット在庫、購入の正本とする。購入確定では、過剰販売を防ぐためにデータベーストランザクションと条件付き更新を使う。

OpenSearch はイベント検索を担当する。検索条件には位置情報、イベント種別、イベント開催日が含まれ、将来的に検索軸が増える可能性もあるためです。Aurora を正本にし、OpenSearch は読み取り最適化された検索用プロジェクションとして扱います。

Valkey は、特に人気イベントの購入フロー前段で高速な在庫フィルタとして使う。売り切れ後のリクエストを Aurora に到達する前に拒否するためです。Valkey は最終的な正本ではありません。

一般的な非同期処理には SQS Standard を使う。購入パスへの SQS FIFO 導入は、イベント単位の順序制御や流量制御が必要かを staging full で再測定してから判断する未採用の候補とする。

EventBridge では、`EventListed`、`EventUpdated`、`InventoryChanged`、`TicketPurchased` などのドメインイベントを発行する。検索インデックス更新はこれらのイベントを購読し、OpenSearch を非同期に更新する。

REST + OpenAPI は、今回のスコープが比較的明確で、運用が単純で、キャッシュや観測もしやすいため初期案として適している。GraphQL は、フロントエンドのクエリ形状が複雑になった段階で BFF レイヤとして再検討する。

## 購入フロー方針

現行の購入パスは、次の同期処理として実装している。

1. 購入者（Buyer）が購入リクエストを送る。
2. API レイヤで認証、レート制限、基本的なバリデーションを行う。
3. NestJS API が Valkey の在庫カウンタを確認・減算し、高速拒否を行う。
4. 同じ NestJS API が Aurora PostgreSQL で条件付き在庫更新を行い、購入を同期的に確定する。
5. EventBridge に `TicketPurchased` または `InventoryChanged` を発行する。
6. Search Projection Worker が SQS Standard キューからイベントを受け取り、OpenSearch を更新する。

現行の Worker は OpenSearch の検索プロジェクション更新専用であり、購入確定や Aurora PostgreSQL の更新は行わない。以下でいう Purchase Worker は、SQS FIFO を導入する場合に新設を検討する別の責務である。

最終的な在庫正確性は Aurora PostgreSQL で保証する。Valkey は売り切れ後の Aurora 到達を抑えるが、在庫が残っている間の購入集中を平準化するものではない。

### 人気イベント集中時の候補

[ADR-0004](../adr/0004-defer-sqs-fifo.md) に従い、現時点では同期購入経路を維持する。次の方式は、[負荷シナリオと容量計画](capacity-planning.md) に定める staging full の測定結果から比較する候補であり、採用済みの構成ではない。

| 候補 | 制御・保護する場所 | 購入 API の応答 | 主に解決する問題 | 主なトレードオフ |
| --- | --- | --- | --- | --- |
| 現行の同期処理 | Valkey で売り切れ後のリクエストを拒否し、NestJS API から Aurora を直接更新 | 同期的に購入結果を返す | 在庫正確性と売り切れ後の DB 保護 | 在庫がある間の接続プール枯渇、ホット行競合、他イベントへの影響は残る |
| プール・ECS タスク・Aurora ACU の適正化 | API と Aurora の処理容量 | 同期応答を維持 | 現構成の容量不足 | 単純だが、流入量の制御やイベント間の隔離にはならない |
| イベント単位の同時実行制限 | API 内で DB 接続取得より前 | 同期応答を維持できる。上限超過時の拒否または待機方法は別途設計する | 人気イベントによる接続プール占有を制限し、他イベントを隔離 | 上限値、再試行、ユーザーへの応答を設計する必要がある |
| Virtual Waiting Room | 購入 API を含む Protected Zone の前段 | 入場許可前は待機させ、許可後の購入処理は同期のまま維持できる | システム全体へ到達する流量と同時利用者数を制御 | 待ち順、入場トークン、離脱、再入場、待ち時間表示の設計と運用が増える |
| SQS FIFO + Purchase Worker | Valkey と Aurora の間で、`MessageGroupId = eventId` により購入処理をキューイング | 非同期化されるため、受付後のポーリング、WebSocket、または別の結果通知が必要 | Aurora への書き込み平準化とイベント単位の順序制御 | Purchase Worker の冪等性、失敗時処理、結果通知、キュー滞留の監視が必要になる |

AWS Architecture Blog で公開されている SeatGeek の事例では、Virtual Waiting Room が事前に定めたスループットと最大同時利用者数に基づき、Protected Zone への入場を制御している。この事例は [AWS 公式の外部参考資料](https://aws.amazon.com/blogs/architecture/build-a-virtual-waiting-room-with-amazon-dynamodb-and-aws-lambda-at-seatgeek/) であり、このリポジトリの実測結果でも、同じ AWS サービス構成を採用する決定でもない。

候補の比較では、まず現行同期処理で購入 SLO を満たせる流入レートと、人気イベント負荷から background イベントを隔離できる範囲を測る。その上で、容量調整だけで足りるか、API 内のイベント単位制限が必要か、Protected Zone 前段で待機させる必要があるか、購入処理自体を非同期化する必要があるかを判断する。SQS FIFO + Purchase Worker を採用する場合は、ADR-0004 の再検討条件に従って新しい ADR を起票する。

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
- 人気イベント集中への対応を、容量調整、イベント単位の同時実行制限、Virtual Waiting Room、SQS FIFO + Purchase Worker のどこまでで行うか。

## 確定済み事項

以下は ADR として決定を記録済み。

- API 入口は ALB（[ADR-0005](../adr/0005-alb-as-api-entry.md)）。
- 購入確定は当面 Valkey 後の同期処理とする。staging full で容量調整と同期の流量制御を適用しても購入 SLO を破る場合、SQS FIFO を新しい ADR で再検討する（[ADR-0004](../adr/0004-defer-sqs-fifo.md)）。
- 非同期 Worker は ECS Fargate（[ADR-0006](../adr/0006-ecs-fargate-worker.md)）。
- dev 環境の構成は [dev 環境設計](./dev-environment.md) を正本とする。
