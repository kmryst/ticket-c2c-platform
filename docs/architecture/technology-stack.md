# 技術スタックドラフト

## ステータス

ドラフト。

このドキュメントは、B2C 一次チケット販売プラットフォームの現行実装と目標構成における、技術スタック方針を記録するものです。購入フローの仕様は [B2C 一次チケット販売フロー](primary-ticket-sales.md)、判断の背景は ADR を正本とします。

## 対象システム

対象システムは、イベント主催者（Organizer）が保有する一次販売チケットを購入者（Customer）へ販売する B2C チケット販売プラットフォームです。

スコープ:

- イベント開催地、イベント種別、イベント開催日による検索。
- 将来的な検索条件追加への対応。
- 検索条件に一致したイベント一覧の表示。
- General Admission の一次販売チケット購入。
- Waiting Room と Protected Zone による人気イベントの流入制御。
- Purchase Session、Ticket Hold、Purchase の段階的な購入フロー。
- local / staging の Fake Payment API による決済依存障害の検証。

スコープ外:

- 実際の Payment Service Provider とカード情報の処理。
- 購入確定後のキャンセルと返金。
- 料金や収容人数による検索。
- 個人によるチケット再出品、個人間取引、売上金精算、チケット譲渡。
- チケットの二次流通。

主な制約:

- 最大 500 万人のユーザーを想定する。
- 人気イベントでは通常の約 100 倍のトラフィックが発生する可能性がある。
- 人気イベントへのトラフィック集中が他イベントの性能を劣化させない必要がある。
- Ticket Hold と Purchase は在庫数を超えてはならない。
- Protected Zone への入場レートと最大同時利用者数を、実測した安全な範囲へ制御する必要がある。

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
| ECS Service 間通信 | 目標構成の NestJS API から Fake Payment API へ Amazon ECS Service Connect で接続 |
| 決済依存の検証 | local / staging 限定の Fake Payment API。production には配置しない |
| インフラ | Terraform |
| CI/CD | GitHub Actions |
| 可観測性 | CloudWatch + OpenTelemetry/ADOT + X-Ray |

## 設計方針

Aurora PostgreSQL は、ユーザー、イベント、チケット在庫、購入の正本とする。B2C 目標構成では Purchase Session と Ticket Hold も正本として保持する。Ticket Hold と購入確定では、過剰販売を防ぐためにデータベーストランザクションと条件付き更新を使う。

OpenSearch はイベント検索を担当する。検索条件には位置情報、イベント種別、イベント開催日が含まれ、将来的に検索軸が増える可能性もあるためです。Aurora を正本にし、OpenSearch は読み取り最適化された検索用プロジェクションとして扱います。

Valkey は、特に人気イベントの購入フロー前段で高速な在庫フィルタとして使う。売り切れ後のリクエストを Aurora に到達する前に拒否するためです。Valkey は最終的な正本ではありません。

一般的な非同期処理には SQS Standard を使う。購入パスへの SQS FIFO 導入は、イベント単位の順序制御や流量制御が必要かを staging full で再測定してから判断する未採用の候補とする。

EventBridge では、`EventListed`、`EventUpdated`、`InventoryChanged`、`TicketPurchased` などのドメインイベントを発行する。検索インデックス更新はこれらのイベントを購読し、OpenSearch を非同期に更新する。

REST + OpenAPI は、今回のスコープが比較的明確で、運用が単純で、キャッシュや観測もしやすいため初期案として適している。GraphQL は、フロントエンドのクエリ形状が複雑になった段階で BFF レイヤとして再検討する。

## 購入フロー方針

現行の購入パスは、次の同期処理として実装している。

1. 認証済み利用者が購入リクエストを送る。
2. API レイヤで認証、レート制限、基本的なバリデーションを行う。
3. NestJS API が Valkey の在庫カウンタを確認・減算し、高速拒否を行う。
4. 同じ NestJS API が Aurora PostgreSQL で条件付き在庫更新を行い、購入を同期的に確定する。
5. EventBridge に `TicketPurchased` または `InventoryChanged` を発行する。
6. Search Projection Worker が SQS Standard キューからイベントを受け取り、OpenSearch を更新する。

現行の Worker は OpenSearch の検索プロジェクション更新専用であり、購入確定や Aurora PostgreSQL の更新は行わない。以下でいう Purchase Worker は、SQS FIFO を導入する場合に新設を検討する別の責務である。

最終的な在庫正確性は Aurora PostgreSQL で保証する。Valkey は売り切れ後の Aurora 到達を抑えるが、在庫が残っている間の購入集中を平準化するものではない。

### B2C 目標フロー

[ADR-0021](../adr/0021-protected-zone-purchase-flow.md) により、次の目標フローを採用する。これは現時点では未実装であり、現行 Purchase API を段階的に置き換える。

1. Waiting Room を通過した Customer が Protected Zone Access Token を受け取る。
2. Access Token を Purchase Session へ交換する。
3. General Admission の数量、または将来の Reserved Seating の座席を選択する。
4. Ticket Hold で在庫を 5 分間確保する。
5. NestJS API が local / staging の Fake Payment API へ同期的に決済認可を要求する。
6. Aurora PostgreSQL で Purchase を確定する。
7. Customer が Purchase 結果を確認する。

時間制約、購入上限、期限切れ回収、決済結果不明時の動作は [B2C 一次チケット販売フロー](primary-ticket-sales.md) を正本とする。

### 人気イベント集中時の候補

[ADR-0004](../adr/0004-defer-sqs-fifo.md) に従い、購入確定の同期処理を維持する。[ADR-0021](../adr/0021-protected-zone-purchase-flow.md) では Waiting Room と Ticket Hold を含む B2C 目標フローを採用した。次の表は現行方式、目標方式、将来候補の位置づけを分けて示す。

| 方式 | 位置づけ | 制御・保護する場所 | 購入 API の応答 | 主に解決する問題 | 主なトレードオフ |
| --- | --- | --- | --- | --- | --- |
| 現行の同期処理 | 実装済み | Valkey で売り切れ後の request を拒否し、NestJS API から Aurora を直接更新 | 同期的に購入結果を返す | 在庫正確性と売り切れ後の DB 保護 | 在庫がある間の connection pool 枯渇、hot row 競合、他 Event への影響は残る |
| Pool・Amazon ECS task・Aurora ACU の適正化 | 継続測定 | API と Aurora の処理容量 | 同期応答を維持 | 現構成の容量不足 | 流入量の制御や Event 間の隔離にはならない |
| Event 単位の同時実行制限 | 将来候補 | API 内で DB connection 取得より前 | 同期応答を維持できる | 人気 Event による connection pool 占有を制限する | 上限値、再試行、Customer への応答を設計する必要がある |
| Virtual Waiting Room + Ticket Hold | B2C 目標構成 | Protected Zone の前段と在庫確保 | 入場許可後の処理は同期を維持する | 到達流量、最大同時利用者数、在庫占有時間を制御する | 待ち順、Token、Session、離脱、再入場の実装と運用が増える |
| Amazon SQS FIFO + Purchase Worker | 将来候補 | Valkey と Aurora の間で `MessageGroupId = eventId` により購入処理を queueing | 非同期化される | Aurora への書き込み平準化と Event 単位の順序制御 | 冪等性、失敗時処理、結果通知、Queue 滞留の監視が必要になる |

AWS Architecture Blog で公開されている SeatGeek の事例では、Virtual Waiting Room が事前に定めたスループットと最大同時利用者数に基づき、Protected Zone への入場を制御している。この事例は [AWS 公式の外部参考資料](https://aws.amazon.com/blogs/architecture/build-a-virtual-waiting-room-with-amazon-dynamodb-and-aws-lambda-at-seatgeek/) であり、このリポジトリの実測結果でも、同じ AWS サービス構成を採用する決定でもない。

B2C 目標構成では、Purchase Session と Ticket Hold を含む Customer journey が SLO を満たす入場レートと最大同時利用者数を staging full で測定する。同期購入確定でも SLO を満たせない場合は、Event 単位の同時実行制限と Amazon SQS FIFO + Purchase Worker を [ADR-0004](../adr/0004-defer-sqs-fifo.md) の再検討条件に従って比較する。

## 検索フロー方針

検索パスは、書き込みパスとは分けて最適化する。

1. Customer が位置情報、イベント種別、イベント開催日、将来追加される検索条件で検索する。
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
- Waiting Room の AWS 実装、Protected Zone 入場レート、最大同時利用者数。
- Purchase Session と Ticket Hold を含む購入フロー全体の SLI / SLO。
- Worker を process または Amazon ECS Service のどの単位で分離するか。

## 確定済み事項

以下は ADR として決定を記録済み。

- API 入口は ALB（[ADR-0005](../adr/0005-alb-as-api-entry.md)）。
- 購入確定は当面 Valkey 後の同期処理とする。staging full で容量調整と同期の流量制御を適用しても購入 SLO を破る場合、SQS FIFO を新しい ADR で再検討する（[ADR-0004](../adr/0004-defer-sqs-fifo.md)）。
- プラットフォームを B2C 一次チケット販売へ再定義する（[ADR-0020](../adr/0020-reframe-as-b2c-primary-ticketing.md)）。
- Protected Zone の目標購入フローに Purchase Session、Ticket Hold、Fake Payment API を採用する（[ADR-0021](../adr/0021-protected-zone-purchase-flow.md)）。
- 非同期 Worker は ECS Fargate（[ADR-0006](../adr/0006-ecs-fargate-worker.md)）。
- dev 環境の構成は [dev 環境設計](./dev-environment.md) を正本とする。
