# 技術スタック

## ステータス

現行実装と未実装の B2C 目標構成を併記する技術スタック方針の正本。各項目の実装状態は本文で区別する。

このドキュメントは、B2C 一次チケット販売プラットフォームの現行実装と目標構成における、技術スタック方針を記録するものです。購入フローの仕様は [B2C 一次チケット販売フロー](primary-ticket-sales.md) を正本とし、トレードオフを伴う判断の背景・採択理由・再検討条件は ADR に記録します。

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
| API 入口 | CloudFront + WAF → ALB。ALB を API / Frontend origin として使用（[ADR-0005](../adr/0005-alb-as-api-entry.md) / [ADR-0011](../adr/0011-nextjs-ssr-on-ecs-with-cloudfront-unified-origin.md)） |
| バックエンド | NestJS / TypeScript |
| API 形式 | REST（実装済み）。OpenAPI 定義は未実装 |
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

Aurora PostgreSQL は、ユーザー、イベント、チケット在庫、購入の正本とする。B2C 目標構成では Purchase Session と Ticket Hold も正本として保持する。Ticket Hold と購入確定では、過剰販売を防ぐためにデータベーストランザクションと条件付き更新を使う。現行 API は Aurora 管理ユーザーで接続しており、migration role と runtime role の分離は [Production Readiness M-15](./production-readiness.md) で追跡する。

OpenSearch はイベント検索を担当する。検索条件には位置情報、イベント種別、イベント開催日が含まれ、将来的に検索軸が増える可能性もあるためです。Aurora を正本にし、OpenSearch は読み取り最適化された検索用プロジェクションとして扱います。

Valkey は、特に人気イベントの購入フロー前段で高速な在庫フィルタとして使う。売り切れ後のリクエストを Aurora に到達する前に拒否するためです。Valkey は最終的な正本ではありません。prod 化前の RBAC / authentication と key / command 最小権限化は [Production Readiness L-26](./production-readiness.md) で追跡する。

一般的な非同期処理には SQS Standard を使う。購入パスへの SQS FIFO 導入は、イベント単位の順序制御や流量制御が必要かを staging full で再測定してから判断する未採用の候補とする。

EventBridge では、`EventListed`、`EventUpdated`、`InventoryChanged`、`TicketPurchased` などのドメインイベントを発行する。検索インデックス更新はこれらのイベントを購読し、OpenSearch を非同期に更新する。

SQS Standard の重複・順序入れ替わりに対し、現行の検索 projection は version による単調性を保証していない。staging で観測した在庫表示の巻き戻りは [Production Readiness M-10](./production-readiness.md) で追跡する。この対応は検索 projection の条件更新であり、購入パスを SQS FIFO へ変更する判断とは分ける。

Aurora の commit と EventBridge への発行も同一 transaction ではなく、現行実装は発行失敗時にログを残して API の成功を維持する。commit 後停止または発行失敗によるイベント欠損と検索 projection の復旧方式は [Production Readiness M-12](./production-readiness.md) で追跡し、監視用 EMF の best-effort 計数とは別の業務データ同期問題として扱う。

現行 API は REST で実装している。OpenAPI 定義は、B2C API contract を実装する段階で追加する目標とする。GraphQL は、フロントエンドのクエリ形状が複雑になった段階で BFF レイヤとして再検討する。

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

## 初期レビュー記録（歴史的記録）

初期スタック方針に対する外部 AI レビューを、当時の検討経緯として残す。後続 ADR と現行実装がこの節の候補を更新している場合は、ADR と本文の現行方針を優先する。

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
- 在庫サービスは最初から分離するか、NestJS バックエンドがボトルネックになってから分離するか。
- Waiting Room の AWS 実装、Protected Zone 入場レート、最大同時利用者数。
- B2C 購入ジャーニーの具体的な成功率 SLO、同期 API ごとのレイテンシ SLO 目標値、Alarm 閾値。SLI と計測境界は ADR-0022〜ADR-0027 で定義済みだが、数値は実装後の staging full 実測まで確定しない。

## 確定済み事項

以下は ADR として決定を記録済み。

- API 入口は ALB（[ADR-0005](../adr/0005-alb-as-api-entry.md)）。
- 購入確定は当面 Valkey 後の同期処理とする。staging full で容量調整と同期の流量制御を適用しても購入 SLO を破る場合、SQS FIFO を新しい ADR で再検討する（[ADR-0004](../adr/0004-defer-sqs-fifo.md)）。
- プラットフォームを B2C 一次チケット販売へ再定義する（[ADR-0020](../adr/0020-reframe-as-b2c-primary-ticketing.md)）。
- Protected Zone の目標購入フローに Purchase Session、Ticket Hold、Fake Payment API を採用する（[ADR-0021](../adr/0021-protected-zone-purchase-flow.md)）。
- 非同期 Worker は ECS Fargate（[ADR-0006](../adr/0006-ecs-fargate-worker.md)）。
- 認証はメール+パスワード、JWT access token、opaque refresh token の自前実装とし、Cognito / Auth0 は採用しない（[ADR-0010](../adr/0010-email-password-jwt-auth.md) / [ADR-0012](../adr/0012-refresh-token-rotation-and-auth-hardening.md)）。
- B2C 購入ジャーニーの SLI と計測境界は ADR-0022〜ADR-0027 に従い、具体的な SLO 目標値と本格アラームは計測実装・staging full 実測後に決める（[B2C 購入ジャーニーの可観測性](b2c-purchase-journey-observability.md)）。
- dev 環境の構成は [dev 環境設計](./dev-environment.md) を正本とする。
