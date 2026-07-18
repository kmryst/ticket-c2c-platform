# 0027. 決済依存の timeout 境界と結果不明遷移を定義する

## ステータス

Accepted

## 日付

2026-07-17

## 背景

[ADR-0021](./0021-protected-zone-purchase-flow.md) と [ADR-0026](./0026-measure-payment-resolution-per-attempt.md) は、Fake Payment API の結果を同期確定できない場合に `payment_unknown` へ進み、Payment Reconciliation Worker が最大 15 分間照会する方針を定めた。一方、一次販売の正本には `payment_processing` を最大 60 秒確認してから `payment_unknown` へ進む記述があり、Customer の同期待ち時間、通信 timeout、API 停止後の stale attempt 回収時間が区別されていなかった。

Terraform では Amazon CloudFront の origin response timeout と Application Load Balancer の idle timeout を明示しておらず、AWS の既定値である 30 秒と 60 秒に依存している。Fastify target の keep-alive timeout も暗黙の既定値に依存している。また、現行 DB pool の `connectionTimeoutMillis=5000` は、Purchase 確定 API に 5 秒の処理期限を設ける場合、処理期限全体と同じ長さになり、決済応答後の状態確定に必要な時間を残せない。

Customer を長時間同期的に待たせず、決済結果を推測して在庫を戻さず、各レイヤーの timeout が内側から順に失敗を処理できる境界が必要になる。

## 決定

### timeout と deadline の順序

次の境界を採用する。

| 境界 | 目標値 | 責務 |
| --- | --- | --- |
| Fake Payment API outbound response deadline | 3 秒 | 同期確定を待つ上限 |
| Purchase 確定 API application processing deadline | 5 秒 | 契約準拠応答または 5xx を返すまでの処理期限 |
| Amazon CloudFront origin response timeout | 30 秒 | origin から応答を待つエッジ側の上限 |
| Application Load Balancer idle timeout | 60 秒 | idle connection を維持する上限 |
| Fastify target keep-alive timeout | 60 秒より長い値 | Application Load Balancer より先に target が接続を閉じないための制約 |
| stale `payment_processing` 回収閾値 | 60 秒 | API 停止後に残った attempt を Worker が回収し始める基準 |

通信経路では `3 秒 < 5 秒 < 30 秒 < 60 秒` を不変条件とする。stale `payment_processing` の 60 秒は通信 timeout または Customer の同期待ち時間ではない。Amazon CloudFront、Application Load Balancer、Fastify target の値は実装時に設定へ明示し、暗黙の既定値依存をなくす。

### 決済試行と結果不明への遷移

決済試行の受理、Purchase Session の累計試行回数増加、`held` から `payment_processing` への遷移を、1 つ目の Aurora PostgreSQL transaction（tx1）で原子的に commit する。Fake Payment API の応答待ちでは Aurora PostgreSQL transaction と DB connection を保持しない。

3 秒以内に `authorized` または `declined` を得た場合は、2 つ目の transaction（tx2）で対応する終端状態を条件付き UPDATE により記録する。connect 失敗、connect timeout、response timeout、Fake Payment API の HTTP 5xx を含め、3 秒以内に結果を確定できない場合は、初期方針としてすべて結果不明とみなし、tx2 で `payment_unknown` へ遷移する。結果を推測して在庫を戻さない。

未送達が確実な connect 失敗だけを `held` へ戻す最適化は採用しない。実際の Payment Service Provider が障害分類と未送達を保証する契約を提供した場合に再検討する。

`payment_unknown` の commit 成功後、Purchase 確定 API は Customer へ HTTP `202 Accepted` で結果確認中であることを返す。応答 body、`Location`、`Retry-After`、結果確認 API の詳細は API contract の後続 Issue で決定する。

同じ Idempotency Key の再送は新しい payment attempt を作らず、既存 attempt の現在状態を返す。`payment_processing` または `payment_unknown` が未解決の間は、新しい Idempotency Key でも同じ Purchase Session の新しい attempt を受理しない。遅れて到着した Fake Payment API の応答、API の tx2、Worker の状態更新は、遷移元の状態を条件にした UPDATE で競合を排除する。affected rows が 1 になり commit に成功した主体だけが状態遷移後の処理と Amazon CloudWatch Embedded Metric Format の出力を行う。

### application processing deadline と回収

5 秒の application processing deadline は socket を切断する server timeout ではなく、アプリケーションが契約準拠応答または 5xx を返すための処理期限とする。3 秒で結果を確定できなければ、残りの処理時間で `payment_unknown` を commit して HTTP `202 Accepted` を返す。

5 秒以内に状態を commit して応答できなければ、Customer 可視の 5xx / timeout として [ADR-0022](./0022-b2c-purchase-journey-success-sli.md) の `technical_failure` に計上する。状態が `payment_processing` に残った場合は、60 秒を超えた時点で Payment Reconciliation Worker が stale attempt として回収する。状態遷移と stale 判定の時刻には Aurora PostgreSQL の時刻を使用する。

Worker が Fake Payment API を照会して Idempotency Key の記録が見つからない場合も、初期方針では結果不明として扱う。tx1 の commit 後かつ request 送信前の停止、または遅延して記録が現れる可能性を考慮し、15 分の照会窓内で照会を継続する。未達確定として直ちに `held` へ戻す最適化は、connect 失敗の扱いと同じ再検討事項とする。

5 秒の通常終端は Fastify `onTimeout` に依存しない。HTTP 応答を返した場合は `onResponse`、Customer が切断した場合は `onRequestAbort` で [ADR-0024](./0024-b2c-synchronous-api-latency-boundary.md) の計測を閉じる。`onTimeout` は将来 server timeout を有効化した場合の防御的な終端として維持する。

DB connection の取得待ちは、その時点で残っている application processing deadline より短くする。現行の `connectionTimeoutMillis=5000` はこの制約に違反するため、B2C Purchase 確定 API の実装時に変更する。具体値、Worker の走査間隔、Reconciliation backoff、5 秒 deadline の NestJS / Fastify 実装方式は後続 Issue で決定する。

### SLI と Alarm

`payment_unknown` の HTTP `202 Accepted` は契約どおりの同期応答であり、その時点では購入ジャーニーの `technical_failure` にしない。Purchase 確定 API の技術的成功 request として同期 API の SLO 用 p95 に含め、購入ジャーニーの Outcome は最大 15 分以内の最終結果で確定する。

3 秒 cutoff により、同期依存の劣化が `ResolutionPath=sync` の p95 ではなく `payment_unknown` 件数の増加として現れる場合がある。`payment_unknown` 件数の Amazon CloudWatch Alarm は維持し、閾値と severity は staging full の通常時発生率から決定する。`payment_processing` / `payment_unknown` の滞留時間、`unresolved_timeout` 件数、購入ジャーニーの `technical_failure` による監視も維持する。

### ADR-0026 との関係

ADR-0026 のステータスは Accepted のまま維持する。この ADR は、ADR-0026 のうち同期処理から `payment_unknown` へ進む時間と補完監視の前提を、60 秒の同期待ちから 3 秒 cutoff へ更新する。payment attempt の単位、開始と終了、SLO の系列、条件付き UPDATE と commit をゲートにする emit 規律は変更しない。

現在の仕様と運用境界は、正本である [B2C 一次チケット販売フロー](../architecture/primary-ticket-sales.md) と [可観測性設計](../architecture/observability.md) に記録する。

## 根拠

- Customer の同期待ちを 3 秒で打ち切り、結果不明を非同期確認へ移すことで、Application Load Balancer の 60 秒境界と競合せず、長時間応答しない Purchase 確定 API を避けられる。
- 内側の依存ほど短い deadline にすることで、外側の Amazon CloudFront または Application Load Balancer に切断される前に、アプリケーションが状態を保存して応答できる。
- Fake Payment API の応答待ちで DB connection を保持しないことで、遅い外部依存が Aurora PostgreSQL connection pool の占有時間へ直接変換されることを防げる。
- transport または HTTP 5xx の詳細を結果不明へ安全側に寄せることで、決済が成立した可能性を残したまま在庫を再販売する事態を防げる。
- HTTP `202 Accepted` と `payment_unknown` の件数 Alarm を分けることで、Customer 向けの契約準拠応答と依存先劣化の早期検知を両立できる。

## 反対材料・トレードオフ

- connect 失敗が未送達であっても `payment_unknown` にするため、Fake Payment API の全断時は販売可能在庫が必要以上に隔離される。
- 未解決中は新しい Idempotency Key でも attempt を受理しないため、Customer は最大 15 分間、同じ Purchase Session で決済を再試行できない。
- HTTP `202 Accepted` の約 3 秒から 5 秒の経路を Purchase 確定 API の技術的成功 p95 に含めるため、`payment_unknown` の構成比により同期 API の分布が多峰化し、p95 が動く可能性がある。
- 3 秒後から 5 秒までに tx2 の DB connection を再取得して commit する必要があり、pool 飽和時は `payment_processing` が残って Worker 回収まで遅延する。
- stale 回収を 60 秒後に始めるため、API 停止後の結果確定には少なくとも約 60 秒の遅延が加わる。
- Amazon CloudFront と Application Load Balancer の値は Next.js SSR と API で共有する。明示設定によって意図しない 5xx または SSR timeout が増えないことを staging full で検証する必要がある。

## 再検討のトリガー

- 実際の Payment Service Provider を導入し、connect 失敗の未送達、soft decline、hard decline、照会 API の結果を信頼できる契約で分類できるようになったとき。
- staging full の実測で、正常な Fake Payment API 応答が 3 秒を継続的に超える、または 3 秒後の残余時間で tx2 を安定して commit できないとき。
- `payment_unknown` の通常時発生率が高く、件数 Alarm の閾値または severity では依存先劣化を有効に検知できないとき。
- DB connection pool の飽和により、決済結果取得後の tx2 失敗または stale `payment_processing` が継続的に発生したとき。
- HTTP `202 Accepted` 後に最大 15 分再試行できないことが Customer 体験または購入完了率へ許容できない影響を与えたとき。
- Amazon CloudFront、Application Load Balancer、Fastify target の接続境界で 502 / 504 が発生する、または Next.js SSR に回帰が確認されたとき。
