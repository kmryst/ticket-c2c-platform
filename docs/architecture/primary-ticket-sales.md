# B2C 一次チケット販売フロー

## ステータス

目標設計。現行実装との差分は未実装です。

このドキュメントは、B2C 一次チケット販売における Waiting Room、Protected Zone、Purchase Session、Ticket Hold、Purchase、および Fake Payment API の仕様と構成の正本です。設計判断の背景は [ADR-0020](../adr/0020-reframe-as-b2c-primary-ticketing.md)、[ADR-0021](../adr/0021-protected-zone-purchase-flow.md)、[ADR-0022](../adr/0022-b2c-purchase-journey-success-sli.md)、[ADR-0023](../adr/0023-split-b2c-purchase-journey-latency-sli.md)、[ADR-0024](../adr/0024-b2c-synchronous-api-latency-boundary.md)、[ADR-0025](../adr/0025-b2c-synchronous-purchase-latency-slo.md)、[ADR-0026](../adr/0026-measure-payment-resolution-per-attempt.md) に記録します。

## サービス境界

イベント主催者（Organizer）が保有する一次販売チケットを購入者（Customer）へ販売します。個人による再出品、個人間取引、売上金精算、チケットの二次流通は扱いません。

初期実装は General Admission（自由席）の数量在庫を扱います。Ticket Type と Ticket Hold の境界は、将来 Reserved Seating（指定席）を追加できる形にしますが、座席表と個別座席在庫は初期実装に含めません。

## 現行実装と目標構成

| 項目 | 現行実装 | B2C 目標構成 |
| --- | --- | --- |
| 購入 API | `POST /events/:eventId/purchases` 1 回で在庫更新と購入確定 | Purchase Session、Ticket Hold、決済認可、Purchase 確定、結果確認へ分割 |
| 在庫 | イベント単位の数量カウンタ | Ticket Type 単位の General Admission 在庫。将来は個別座席在庫を追加 |
| 流入制御 | 認証、レート制限、Valkey の売り切れ前段拒否 | Waiting Room から Protected Zone への入場レートと最大同時利用者数を制御 |
| 決済 | なし | local / staging 限定の Fake Payment API で外部依存を再現。実決済は対象外 |
| Worker | Search Projection Worker | Ticket Hold Expiry と決済結果確認（Payment Reconciliation）の責務を追加。実行単位の分割は未決定 |
| 負荷試験 | 1 iteration が Purchase API 1 回 | 1 iteration が 1 Customer の複数段階の購入フロー |

既存の PoC 結果、容量測定値、ADR は、現行実装を検証した歴史的記録として保持します。B2C 目標構成の実装済み証拠としては扱いません。

## 用語と責務

| 用語 | 責務 |
| --- | --- |
| Waiting Room Visitor Token | Waiting Room 内で利用者と待ち順を識別する |
| Protected Zone Access Token | Waiting Room を通過した Customer に Protected Zone への入場を許可する |
| Purchase Session | Protected Zone 内で購入操作を行う時間枠。Customer と Event に紐付く |
| Ticket Hold | 選択したチケット在庫を一時的に確保する |
| Purchase | 確定した購入結果。1 Customer / 1 Event につき最大 1 件 |
| Fake Payment API | local / staging で外部 Payment Service Provider の成功、拒否、遅延、障害を再現する |

Protected Zone Access Token は、Waiting Room へ入るための Token ではありません。AWS の SeatGeek 事例でいう access token と同じ方向の用語として、Protected Zone へ進む権利を表します。

## Waiting Room と入場

- 販売開始前に Waiting Room へ参加した Customer は、販売開始時にランダムな順番へ並べます。
- 販売開始後の参加者は、その待ち行列の末尾へ FIFO で追加します。
- Protected Zone への入場は、安全な入場レートと最大同時利用者数の両方で制御します。具体値は staging full の測定前に確定しません。
- Protected Zone Access Token は Customer と Event に紐付け、発行から 60 秒間だけ有効とします。
- Frontend は Access Token を自動的に 1 つの Purchase Session へ交換します。
- 同じ Access Token の再送では Purchase Session を重複作成しません。
- Purchase Session 作成に失敗しただけで入場権を失わないよう、Token 消費と再送を設計します。Token 保存先と Aurora 間の整合方式は実装設計で確定します。

AWS の参考資料:

- [Build a Virtual Waiting Room with Amazon DynamoDB and AWS Lambda at SeatGeek](https://aws.amazon.com/blogs/architecture/build-a-virtual-waiting-room-with-amazon-dynamodb-and-aws-lambda-at-seatgeek/)
- [Introducing AWS Virtual Waiting Room](https://aws.amazon.com/blogs/compute/introducing-aws-virtual-waiting-room/)

## 購入フロー

```text
Waiting Room
  -> Protected Zone Access Token
  -> Purchase Session
  -> Ticket Hold
  -> Fake Payment API authorization
  -> Purchase confirmation
  -> Purchase result
```

正常系では、Customer の業務 API 呼び出しは少なくとも次の 4 段階になります。

1. Purchase Session を作成する。
2. Ticket Hold を作成する。
3. Ticket Hold の購入を確定する。
4. Purchase 結果を 1 回確認する。

Fake Payment API は Customer から直接呼びません。購入確定処理中に NestJS API から内部接続します。

### Purchase Session

| 項目 | 方針 |
| --- | --- |
| 選択時間 | 作成から 5 分 |
| 延長 | 初期実装では不可 |
| 在庫確保 | 行わない |
| Protected Zone 同時利用者数 | Active Session として算入する |
| Ticket Hold | 1 Customer / 1 Event につき有効な Hold は 1 つ |
| 選択時間超過 | Session を終了し、再購入時は Waiting Room 末尾へ参加する |

Ticket Hold 作成後は、Purchase Session の選択時間ではなく Ticket Hold の有効期限で購入処理を制御します。選択を上限まで行った場合、Session 作成から Hold 期限切れまでの合計は最大 10 分です。

### Ticket Hold

| 項目 | 方針 |
| --- | --- |
| 有効期限 | 作成成功から 5 分 |
| Customer による延長 | 不可 |
| 対象 Event | 1 つ |
| 明細 | 複数 Ticket Type を許可する |
| 最大枚数 | 1 Customer / 1 Event につき合計 4 枚 |
| 確保結果 | 全明細を確保するか、全明細を失敗させる |
| Active Hold | 1 Customer / 1 Event につき 1 つ |
| キャンセル | 作成者本人だけ可能。即座に在庫を戻す |
| 枚数変更 | 初期実装では不可。キャンセル後に作り直す |

4 枚の上限は初期の販売ポリシーとして設定値で管理し、在庫更新ロジックへ定数として埋め込みません。

General Admission は `ticketTypeId + quantity`、将来の Reserved Seating は `ticketTypeId + seatIds` で Hold 明細を表現します。具体的な DB スキーマと API request は実装 Issue で確定します。

### Purchase

- 1 Ticket Hold から作成できる Purchase は最大 1 件です。
- 同じ購入確定要求を再送した場合は、作成済みの同じ Purchase を返します。
- 1 Customer / 1 Event につき確定 Purchase は 1 件、合計 4 枚までです。
- 確定購入後は、同じ Event の Waiting Room へ再参加して追加購入できません。
- 期限切れまたはキャンセルでは購入が成立していないため、Waiting Room 末尾から再参加できます。
- プラットフォーム障害で処理を継続できなかった場合は、Customer を末尾へ戻さず入場権を回復します。回復処理は監査ログへ記録します。

## Ticket Hold の期限切れ回収

Aurora PostgreSQL の `expires_at` と状態を正本とし、Ticket Hold Expiry Worker が期限切れ Hold を定期的に回収します。

| 項目 | 方針 |
| --- | --- |
| 確認間隔 | 10 秒 |
| 在庫復帰目標 | 期限切れ Hold の 99% 以上を 30 秒以内に戻す |
| DB アクセス | 状態と有効期限の複合インデックスを使い、batch で取得する |
| 重複実行 | 同じ Hold を複数回処理しても在庫を 1 回しか戻さない |
| Purchase 確定 | API 自身が `expires_at` を確認し、期限後の確定を拒否する |

### 回収方式の比較

| 候補 | 判断 | 理由 | 再検討条件 |
| --- | --- | --- | --- |
| Aurora を定期検索する Expiry Worker | 初期採用 | Aurora を正本にでき、DB 保存と Queue 送信の二重書き込みがない | 検索負荷または回収遅延が SLO を超える |
| Amazon SQS 遅延メッセージ | 将来候補 | 5 分は個別メッセージタイマーの最大 15 分以内 | 定期検索の負荷が問題になり、Outbox と取りこぼし確認を導入できる |
| Amazon EventBridge Scheduler | 初期不採用 | Hold ごとの Schedule 管理が増え、実行精度は 60 秒単位 | より長時間または複雑な予約処理が必要になる |
| Aurora PostgreSQL `pg_cron` | 初期不採用 | アプリケーションの業務処理と DB 運用が密結合になる | DB 内 Job を標準運用する方針になる |
| request 時の期限切れ回収 | 補助候補 | Worker 障害時の取りこぼしを需要発生時に回収できる | 単独方式にはしない |
| Valkey TTL | 正本には不採用 | 在庫の正確性と状態遷移は Aurora で保証する | cache または通知の補助用途に限定する |

AWS の制約は次を参照します。

- [Amazon SQS message timers](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-message-timers.html)
- [Schedule types in EventBridge Scheduler](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html)
- [Scheduling maintenance with the PostgreSQL pg_cron extension](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/PostgreSQL_pg_cron.html)

## Fake Payment API

実際のクレジットカード情報、個人情報、Payment Service Provider、Webhook、返金は扱いません。Fake Payment API は local / staging で外部依存の信頼性を検証するためだけに使い、production には配置しません。

| 環境 | 接続方式 |
| --- | --- |
| local | Docker Compose 内部 network の service name |
| staging | private subnet の独立 Amazon ECS Service。NestJS API から Amazon ECS Service Connect で接続 |
| production | Fake Payment API を配置しない |

Fake Payment API を Application Load Balancer の target には追加せず、Public IP も付与しません。Security Group は NestJS API から Fake Payment API の待受 port への通信だけを許可します。Amazon ECS Service 間通信の方式は、AWS 公式ドキュメントに記載された Service Connect を使用します。

- [Interconnect Amazon ECS services](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/interconnecting-services.html)

Fake Payment API は request ごとに乱数で結果を変えず、test token から決定的な結果を返します。障害率の組み合わせと乱数 seed は k6 側で管理します。

| Test token | 結果 |
| --- | --- |
| `test-approved` | 成功 |
| `test-declined` | 決済拒否 |
| `test-timeout` | timeout |
| `test-server-error` | HTTP 500 |
| `test-approved-slow` | 遅延後に成功 |

- 同期型の authorization API とします。
- Idempotency Key を必須とし、同じ Key には同じ結果を返します。
- 1 Purchase Session の累計で、異なる決済方法による試行は最大 3 回です。Hold をキャンセルまたは再作成しても累計を戻しません。
- timeout による同一 request の再送は試行回数へ含めません。
- Idempotency Key は request の冪等性に使用します。新しい Key だけでは新しい決済試行を成立させず、試行の受理、累計回数の増加、`payment_processing` への遷移を Aurora PostgreSQL で原子的に行います。
- 初期 Product policy では、決済拒否後に同じ決済方法を再試行できません。実際の Payment Service Provider で soft decline と hard decline を区別できるようになった時点で再検討します。
- 3 回目の決済拒否で、その時点の Hold を `payment_failed` とし、在庫を戻して Purchase Session を終了します。Waiting Room へ再参加して新しい Purchase Session を作成した場合、累計はリセットします。

### 決済処理中と結果不明

Hold の期限直前に決済が成功する競合を防ぐため、有効期限内に決済を開始した Hold を `payment_processing` へ移します。これは Customer が要求できる延長ではなく、決済中の在庫を別の Customer へ販売しないための server-side lock です。

```text
held
  -> payment_processing
     -> confirmed
     -> held or expired on declined before third attempt
     -> payment_failed on third declined
     -> payment_unknown on unresolved timeout
```

- `payment_processing` の自動確認時間は最大 60 秒です。
- Fake Payment API で `approved` なら Purchase を確定します。
- 累計 3 回未満の `declined` で元の Hold 期限内なら `held`、期限後なら `expired` として在庫を戻します。
- 累計 3 回目の `declined` は、同期処理または決済結果確認 Worker のどちらで確定した場合も `payment_failed` として Purchase Session を終了します。
- 60 秒で結果を確定できなければ `payment_unknown` とし、結果を推測して在庫を戻しません。
- 決済結果確認 Worker（Payment Reconciliation Worker）は Idempotency Key で Fake Payment API の結果と Aurora の状態を突き合わせます。API 停止で滞留した stale `payment_processing` も検出して回収します。
- 自動照会は最大 15 分間、間隔を徐々に延ばして実行します。
- 15 分の自動照会は `payment_unknown` へ遷移した時点から数えます。attempt 全体の滞留は `payment_processing` の滞留時間でも監視します。
- `payment_unknown` の発生件数は 1 件以上で Amazon CloudWatch Alarm を発報し、結果確定を待つ間も早期検知します。
- 15 分後も不明なら在庫を隔離したまま運用対応とし、滞留時間の Amazon CloudWatch Alarm でエスカレーションします。

## Worker の責務

| Worker | 責務 | 現在状態 |
| --- | --- | --- |
| Search Projection Worker | EventBridge / Amazon SQS から変更を受け、OpenSearch を更新する | 実装済み |
| Ticket Hold Expiry Worker | 期限切れ Ticket Hold を Aurora から取得し、状態と在庫を更新する | 目標設計 |
| 決済結果確認 Worker（Payment Reconciliation Worker） | Fake Payment API の決済結果と Aurora の購入状態を突き合わせ、`payment_unknown` と stale `payment_processing` を回収する | 目標設計 |

責務の分離は、必ず 3 つの Amazon ECS Service へ分割することを意味しません。process、Amazon ECS Service、Queue の分割単位は、負荷、障害隔離、deploy、scaling の実測に基づいて別途決定します。

## 可観測性と負荷試験

### 購入ジャーニーの技術的成功率 SLI

購入ジャーニーは、Protected Zone Access Token の発行成功時から、仕様上の終端状態が確定するまでとします。入場権回復による Access Token 再発行は同じジャーニーとして扱い、Outcome は終端確定時に 1 回だけ記録します。

```text
技術的成功率 = success / (success + technical_failure)
```

| 分類 | 対象 |
| --- | --- |
| `success` | Purchase 確定、正常な在庫拒否、3 回の決済拒否、15 分以内に解決した `payment_unknown` のうち利用者可視の技術障害がないもの |
| `technical_failure` | Customer へ返した 5xx / timeout、状態不整合、入場権喪失、正規入場後の 429、15 分後も未解決の `payment_unknown`、技術障害後の期限切れ・キャンセル |
| 除外 | 未使用 Token 失効、技術障害を伴わない放置期限切れ・本人キャンセル、防御的な 429、クライアント起因の 4xx |

内部再試行で回復し、Customer にエラーを返さず応答契約を満たした処理は `technical_failure` に含めず、再試行回数と回復時間を別指標にします。Bot または未入場利用者への防御的な 429 は除外しますが、Protected Zone へ正規入場した Customer への 429 は許可流量が処理容量を超えた結果として `technical_failure` に含めます。

`payment_unknown` は最大 15 分間の自動照会が終わるまで Outcome を確定しません。購入ジャーニー全体を一律に遅延評価せず、該当 Outcome だけを終端確定時に記録します。リアルタイム検知は `payment_unknown` の件数と滞留時間に対する Amazon CloudWatch Alarm が担います。

API と Worker を跨いで同じジャーニーを追跡する識別子を持ちますが、高カーディナリティになるため Amazon CloudWatch メトリクスの dimension には使用しません。識別子は Aurora の状態、構造化ログ、trace の相関に使用します。

現行 Purchase API の成功率 99.5%・p95 800ms は、B2C 目標フローへ切り替えるまで現役 SLO として維持します。切り替え後は旧 API 限定の履歴とし、新しい各 API またはジャーニー全体へ数値を自動的に流用しません。分類と判断根拠は [ADR-0022](../adr/0022-b2c-purchase-journey-success-sli.md) を参照してください。

### 購入ジャーニーのレイテンシ SLI

購入ジャーニーのレイテンシは、単一の合算値にせず次の 2 つへ分けます。

| SLI | 計測する時間 | 主な除外 |
| --- | --- | --- |
| 同期購入処理時間 | Session 交換、Ticket Hold 作成、Purchase 確定、結果確認の同期 API でプラットフォームが処理する時間。Fake Payment API の同期応答待ちは Purchase 確定処理に含める | Waiting Room、Customer の選択・入力・放置、API 間の idle time、非同期の決済結果待ち |
| 決済結果解決時間 | Aurora PostgreSQL で受理した 1 payment attempt の `payment_processing` 遷移から、その attempt の結果が確定するまでの wall-clock time | Waiting Room、Customer の操作時間、決済開始前の処理、決済試行間の idle time |

4 つの同期 API は、技術的成功 request のレイテンシ p95 を SLI とし、API ごとの正式な SLO を定義します。`confirmed` 正常系の 4 API を各 1 回呼び出す経路には、各 API の目標値を導くレイテンシ予算を設けますが、予算自体は SLO または Amazon CloudWatch Alarm の対象にはしません。API 個別 p95 の達成はジャーニー全体の p95 を保証せず、各 API の p99 は API 単体の tail latency を確認する検証指標として扱います。具体的な秒数は staging full の実測後に決定します。

ジャーニー識別子付きログによるサーバー側処理時間の合算は、同期フェーズの終端 Outcome である `confirmed`、`sold_out`、`payment_failed`、`payment_unknown` ごとに分け、`abandoned` は除外します。終端までの再試行、idempotent replay、`client_aborted` となった試行を含む全 request と API 呼び出し回数を対象にし、同期フェーズの終端 Outcome が確定した時点で集計を閉じます。`payment_unknown` 確定後の結果確認 request は各 API の SLI と決済結果解決時間 SLI で扱います。

この合算値は Customer の実待ち時間ではなく、容量試験、受入判定、診断に使うプラットフォームのサーバー側処理時間です。Customer 側の時間は k6、将来の Amazon CloudWatch RUM などで別に計測します。現行 Purchase API の p95 800ms は新しい各 API またはジャーニー予算へ流用しません。詳細は [ADR-0023](../adr/0023-split-b2c-purchase-journey-latency-sli.md) と [ADR-0025](../adr/0025-b2c-synchronous-purchase-latency-slo.md) を参照してください。

#### 同期 API ごとのサーバー側計測境界

B2C の同期 API は、Fastify の `onRequest` から計測を開始し、`onResponse`、`onRequestAbort`、`onTimeout` のうち最初の終端で 1 回だけ記録します。認証、レート制限、body parse、入力検証、Controller / Service、Valkey、Aurora PostgreSQL、Fake Payment API の同期応答待ち、レスポンスのシリアライズと送信を含めます。

SLO 用のレイテンシ percentile には技術的成功だけを含めます。クライアント起因 4xx と防御的な 429 は除外し、正規入場後の 429、5xx、server timeout は技術的失敗、`client_aborted` は診断指標として別に記録します。health check と将来の Server-Sent Events / long polling は対象外です。

Amazon CloudFront、Application Load Balancer、Amazon CloudWatch Synthetics、k6、将来の Amazon CloudWatch RUM は、エッジ、外形、クライアント側を別レイヤーから監視します。詳細は [ADR-0024](../adr/0024-b2c-synchronous-api-latency-boundary.md) を参照してください。

#### 決済結果解決時間の計測単位と SLO

決済結果解決時間は、サーバーが原子的に受理した 1 payment attempt を単位にします。開始と終了は別々の transaction で記録し、状態遷移を記録する UPDATE 文の実行時点に Aurora PostgreSQL が生成する時刻を使用します。

同期確定した `authorized` / `declined` は `Service=api`、`ResolutionPath=sync` の p95 を正式な SLO とします。`payment_unknown` から Worker が解決した `ResolutionPath=reconciled` は検証指標とし、15 分後も未解決の `unresolved_timeout` はレイテンシ percentile へ含めません。具体的なメトリクス名、SLO 目標値、Alarm 閾値は staging full の実測後に決定します。

Amazon CloudWatch Embedded Metric Format は、結果を確定する条件付き状態遷移の commit に成功した API または Worker が at-most-once で出力します。計測専用の recorded flag と transactional outbox は追加せず、commit 後の稀な欠損とログ配送層の稀な重複を許容します。決済試行の識別子はログ属性にだけ含め、決済方法の識別子は dimension、通常ログ、trace 属性へ出力しません。

`payment_unknown` の件数 Alarm は、遅い attempt が sync p95 の母集団から抜ける盲点を補います。Payment Reconciliation Worker の停止は `payment_processing` / `payment_unknown` の滞留時間 Alarm、15 分後も未解決の attempt は `unresolved_timeout` 件数と購入ジャーニーの `technical_failure` で検知します。詳細は [ADR-0026](../adr/0026-measure-payment-resolution-per-attempt.md) を参照してください。

### 計測項目

次の指標を段階別に記録します。

- Protected Zone Access Token の発行、交換、失効、重複拒否。
- Active Purchase Session 数、作成時間、期限切れ数。
- Ticket Hold の作成、拒否、キャンセル、期限切れ、在庫復帰遅延。
- Fake Payment API の結果別件数、p50 / p95 / p99、timeout、5xx。
- `payment_processing` と `payment_unknown` の件数、滞留時間、自動解決時間。
- Purchase の技術的成功率、業務結果、p50 / p95 / p99。
- Aurora connection 使用量、lock 待ち、query latency。
- Amazon ECS Service の CPU / memory、task 数、Application Auto Scaling の scaling activity。

k6 の rate は API request 数ではなく、原則として 1 秒あたりに開始する Customer journey 数として定義し直します。各段階の request 数と Customer の操作待ち時間を script で明示します。

## 未決定事項

| 項目 | 決定に必要な情報 |
| --- | --- |
| 同期購入レイテンシの具体値と運用 | `confirmed` 正常系のレイテンシ予算、各 API の p95 目標値と p99 検証値、メトリクス名、低トラフィック評価、burn-rate アラーム、ログ集計方法 |
| 決済結果解決時間の具体値と運用 | メトリクス正式名、同期解決の p95 目標値、低トラフィック評価、Alarm 閾値、EMF 欠損の突き合わせ方法 |
| timeout の整合 | server timeout、Application Load Balancer idle timeout、Fake Payment API timeout の値と責任分担 |
| B2C 購入ジャーニーの成功率 SLO 目標値 | Product 要件、staging full の実測結果、低トラフィック時の評価方法 |
| 各 API の SLO 目標値 | 段階別のエラー率・レイテンシ実測と、同期購入ジャーニーのレイテンシ予算からの配分 |
| Protected Zone 入場レート | staging full で SLO を満たす Customer journey 開始率 |
| Protected Zone 最大同時利用者数 | Active Session / Hold 数と Aurora / Amazon ECS の余力 |
| Waiting Room 開始時刻 | Product policy と販売開始前の参加行動 |
| Waiting Room の AWS 実装 | CloudFront 前段の gate、Token store、待ち順管理、運用コスト |
| Fake Payment の結果比率と latency | 検証目的ごとの再現シナリオ |
| Worker の実行単位 | 負荷、障害隔離、deploy、scaling の測定結果 |
| DB schema と API contract | 実装 Issue での migration と後方互換性 |
| GitHub / AWS resource の B2C naming | GitHub OIDC、IAM、Terraform state を含む移行順序 |
