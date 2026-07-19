# B2C 購入ジャーニーの可観測性（目標設計）

このドキュメントは、B2C 移行後の購入ジャーニーに対する SLI / SLO、計測境界、メトリクス、Alarm、負荷試験の観測項目の正本である。購入フロー、状態遷移、API の責務、3 秒・5 秒・15 分の処理境界は [B2C 一次チケット販売フロー](primary-ticket-sales.md) を正本とし、この文書では可観測性に必要な境界だけを参照する。ADR-0022〜ADR-0027 の目標設計はいずれも未実装であり、現行 Purchase API の SLI / SLO（[observability.md](observability.md) の「購入 API の SLI」「購入 API の SLO 目標値と閾値アラーム」節。ADR-0016 / ADR-0017）を置き換えた状態ではない。

## B2C 購入ジャーニーの成功率 SLI（目標設計）

[ADR-0022](../adr/0022-b2c-purchase-journey-success-sli.md) により、B2C 目標フローでは Protected Zone Access Token の発行成功から終端状態確定までを 1 購入ジャーニーとして扱う。この SLI と関連メトリクスは未実装であり、現行 Purchase API の SLI / SLO を置き換えた状態ではない。

```text
技術的成功率 = success / (success + technical_failure)
```

- **`success`**: Purchase 確定、正常な在庫拒否、決済拒否など、Customer に利用者可視の技術障害を返さず仕様どおりの終端状態へ到達したジャーニー。
- **`technical_failure`**: Customer へ返した 5xx / timeout、状態不整合、入場権喪失、正規入場後の 429、15 分後も未解決の `payment_unknown` など。
- **除外**: 未使用 Token 失効、技術障害を伴わない放置期限切れ・本人キャンセル、Bot または未入場利用者への防御的な 429、クライアント起因の 4xx。
- **記録時点**: Aurora PostgreSQL の終端状態とジャーニー識別子を Outcome の正本とする。終端状態遷移の条件付き UPDATE と commit に成功した API または Worker だけが、commit 後に Outcome を Amazon CloudWatch Embedded Metric Format（EMF）で at-most-once 出力する。`payment_unknown` の Outcome だけが最大 15 分遅れて計上される。
- **計数の信頼性**: EMF は監視用の best-effort データとし、commit 後かつ emit 前の停止による稀な欠損とログ配送層の稀な重複を許容する。厳密な exactly-once のための recorded flag と transactional outbox は導入しない。受入検証や incident の事後検証で正確な件数が必要な場合は、Aurora PostgreSQL の終端状態件数と EMF メトリクスを突き合わせる。
- **リアルタイム検知**: 段階別 API SLI に加え、`payment_unknown` の件数と滞留時間を Amazon CloudWatch Alarm で別に監視する。
- **相関 ID**: API と Worker を跨ぐジャーニー識別子は Aurora、構造化ログ、trace の相関に使い、高カーディナリティになるため Amazon CloudWatch メトリクスの dimension には含めない。

現行 Purchase API が稼働している間は、ADR-0016 / ADR-0017 の成功率 99.5%・p95 800ms が現役 SLO である。B2C 切り替え後は旧 API 限定の履歴と各 API の計測方式の参考として扱い、数値を新しい各 API または購入ジャーニー全体へ自動的に流用しない。B2C の具体的な成功率 SLO と burn-rate アラームは Product 要件と staging full の実測後に別途決定する。

## B2C 購入ジャーニーのレイテンシ SLI

[ADR-0023](../adr/0023-split-b2c-purchase-journey-latency-sli.md) により、購入ジャーニーのレイテンシは単一の分布にせず、次の 2 つへ分ける。いずれも目標設計であり、メトリクスは未実装である。[ADR-0025](../adr/0025-b2c-synchronous-purchase-latency-slo.md) は同期購入処理時間の正式な SLO と補助集計の責務を分ける。

| SLI | 境界 |
| --- | --- |
| 同期購入処理時間 | Session 交換、Ticket Hold 作成、Purchase 確定、結果確認の 4 API 個別レイテンシを正式な SLO とし、Outcome 別のジャーニー合算は補助指標として扱う。Customer の操作時間と非同期の決済結果待ちは除外する |
| 決済結果解決時間 | Aurora PostgreSQL の `payment_processing` 遷移から、決済結果に基づく終端状態の確定までをサーバー側 wall-clock time で扱う |

各 API は、ADR-0024 の計測境界で技術的成功 request のレイテンシ p95 を SLI とし、API ごとの正式な SLO を定義する。`confirmed` 正常系の 4 API を各 1 回呼び出す経路には、各 API の目標値を導くレイテンシ予算を設けるが、予算自体は SLO または Amazon CloudWatch Alarm の対象にはしない。API 個別 p95 の達成はジャーニー全体の p95 を保証しない。p99 は API 単体の tail latency を確認する検証指標とし、具体的な目標値、SLO 化、アラーム化は staging full の実測後に判断する。

B2C 購入フローの API と Worker は、ジャーニー識別子を構造化ログ属性として記録し、Amazon CloudWatch Embedded Metric Format の dimension には含めない。同期フェーズ終端 Outcome の `confirmed`、`sold_out`、`payment_failed`、`payment_unknown` ごとに全 request のサーバー側処理時間と API 呼び出し回数を集計し、`abandoned` は除外する。業務終端 Outcome は ADR-0022 の `success` / `technical_failure` 分類とは独立して扱う。

終端 Outcome があるジャーニーでは、再試行、idempotent replay、`client_aborted` となった試行も同期フェーズ終端までの補助集計に含める。`payment_unknown` の集計は同期フェーズで状態が確定した時点で閉じ、それ以降の結果確認 request は各 API の SLI と決済結果解決時間 SLI で扱う。合算値は Customer の実待ち時間ではなく、プラットフォームのサーバー側処理時間である。

k6 とジャーニー識別子付きログによる Outcome 別の合算値は、容量試験、受入判定、診断の補助指標であり、正式な SLO にはしない。CloudWatch metric math による各 API p95 の合計はジャーニー p95 ではないため、表示する場合も Amazon CloudWatch Dashboard の参考値に限定する。Amazon CloudWatch Logs Insights の集計方法、具体的なメトリクス名、SLO 目標値、低トラフィック時の評価方法、burn-rate アラームは後続 Issue で決定し、現行 Purchase API の p95 800ms を流用しない。

### B2C 同期 API のサーバー側計測境界

[ADR-0024](../adr/0024-b2c-synchronous-api-latency-boundary.md) により、B2C の同期 API は Fastify `onRequest` で計測を始め、`onResponse`、`onRequestAbort`、`onTimeout` のうち最初の終端で 1 request につき 1 回だけ記録する。これにより、認証前からレスポンス送信までを含め、切断と timeout を計測漏れにしない。

- SLO 用 percentile は、endpoint の契約どおりに技術的成功を返した request だけを対象にする。
- クライアント起因 4xx と防御的な 429 は percentile から除外する。
- 正規入場後の 429、5xx、server timeout は技術的失敗、`client_aborted` は診断指標として別に記録する。
- Application Load Balancer の `TargetResponseTime` / 5xx、Amazon CloudFront の `OriginLatency` / `5xxErrorRate`、Amazon CloudWatch Synthetics、k6 は、アプリケーションメトリクスが見ないレイヤーを診断・補完する。
- 現行 Purchase API の `PurchaseRequestLatencyMs` は B2C 切り替えまで境界を変えず、新しい B2C メトリクスと数値を直接比較しない。

[ADR-0027](../adr/0027-payment-timeout-boundaries.md) により、Purchase 確定 API は Fake Payment API の同期結果を最大 3 秒待ち、API 全体では 5 秒の application processing deadline を持つ。5 秒は socket を切断する server timeout ではなく、契約準拠応答または 5xx を返すためのアプリケーション処理期限である。通常は `onResponse`、Customer が切断した場合は `onRequestAbort` で計測を閉じ、`onTimeout` は将来 server timeout を有効化した場合の防御的な終端として維持する。

3 秒以内に決済結果を確定できない場合は、Aurora PostgreSQL で `payment_unknown` を commit した後に HTTP `202 Accepted` を返す。この応答は契約どおりの技術的成功として Purchase 確定 API の SLO 用 p95 に含める。5 秒以内に状態を commit して応答できず Customer へ 5xx / timeout を返した場合は `technical_failure` とする。3 秒 cutoff により同期依存の劣化が p95 ではなく `payment_unknown` 件数の増加として現れる場合があるため、両方を併用して監視する。

| 境界 | 目標値 | 観測上の役割 |
| --- | --- | --- |
| Fake Payment API outbound response deadline | 3 秒 | 超過または transport / HTTP 5xx を `payment_unknown` 件数で観測する |
| Purchase 確定 API application processing deadline | 5 秒 | 5xx / timeout を同期 API SLI と購入ジャーニーの `technical_failure` で観測する |
| Amazon CloudFront origin response timeout | 30 秒 | `OriginLatency` / `5xxErrorRate` と k6 でエッジ側の異常を観測する |
| Application Load Balancer idle timeout | 60 秒 | `TargetResponseTime` / `HTTPCode_ELB_5XX_Count` で接続境界の異常を観測する |
| Fastify target keep-alive timeout | 60 秒より長い値 | Application Load Balancer より先に接続を閉じる競合を防ぐ |
| stale `payment_processing` 回収閾値 | 60 秒 | API 停止後に残った attempt の滞留時間と Worker 回収時間を観測する |

DB connection の取得待ちは、処理時点で残っている application processing deadline より短くする。現行の `connectionTimeoutMillis=5000` は 5 秒の処理期限と同値であり、B2C 実装時に変更する。具体値、Worker 走査間隔、Reconciliation backoff、Alarm 閾値と severity は staging full の測定結果から決定する。

### 決済結果解決時間の計測境界と SLO

[ADR-0026](../adr/0026-measure-payment-resolution-per-attempt.md) により、決済結果解決時間は 1 payment attempt を単位にする。payment attempt は、プラットフォームが Ticket Hold を `payment_processing` へ原子的に遷移させて受理した 1 エピソードである。開始と終了には、それぞれの状態遷移 UPDATE 文の実行時点に Aurora PostgreSQL が生成する時刻を使用する。

レイテンシメトリクスは `Service` と `ResolutionPath` を dimension に持つ。正式な SLO は `Service=api`、`ResolutionPath=sync` で仕様どおり `authorized` または `declined` へ確定した attempt の p95 とする。`ResolutionPath=reconciled` は Amazon CloudWatch Dashboard、件数、滞留時間による検証指標とし、具体的な SLO 目標値は staging full の実測後に決定する。sync 全体の percentile を維持するため、レイテンシメトリクスへ `Outcome` dimension は追加しない。

決済試行の結果件数メトリクスは `Service` と `Outcome` を dimension に持ち、`authorized`、`declined`、`unresolved_timeout` を記録する。`unresolved_timeout` は右側打ち切りサンプルのためレイテンシメトリクスを emit せず、ADR-0022 の `technical_failure` と件数 Alarm で扱う。`payment_failed` は 3 回目の `declined` 後の Hold / Purchase Session 終端であり、payment attempt の Outcome には含めない。

終端状態遷移の条件付き UPDATE で affected rows が 1 になり、commit に成功した API または Worker だけが Amazon CloudWatch Embedded Metric Format を at-most-once で出力する。計測専用の recorded flag と transactional outbox は使用せず、commit 後の稀な欠損とログ配送層の稀な重複を許容する。payment attempt の識別子は構造化ログ属性にだけ含める。

| 劣化モード | 検知手段 |
| --- | --- |
| 同期決済の解決遅延 | `ResolutionPath=sync` の p95 |
| 3 秒 cutoff による `payment_unknown` 増加 | `payment_unknown` 件数の Amazon CloudWatch Alarm。Alarm は維持し、閾値と severity は staging full の通常時発生率から決定する |
| Payment Reconciliation Worker の遅延・停止 | `payment_processing` / `payment_unknown` の滞留時間に対する Amazon CloudWatch Alarm |
| 15 分後も未解決 | `unresolved_timeout` 件数、購入ジャーニーの `technical_failure`、運用エスカレーション |
| EMF の欠損・重複 | Aurora PostgreSQL の終端ジャーニー・解決済み attempt 件数と結果件数メトリクスの突き合わせ。運用方法は後続 Issue |

## 計測項目と負荷試験

次の指標を購入ジャーニーの段階別に記録する。

- Protected Zone Access Token の発行、交換、失効、重複拒否。
- Active Purchase Session 数、作成時間、期限切れ数。
- Ticket Hold の作成、拒否、キャンセル、期限切れ、在庫復帰遅延。
- Fake Payment API の結果別件数、p50 / p95 / p99、timeout、5xx。
- `payment_processing` と `payment_unknown` の件数、滞留時間、自動解決時間。
- Purchase の技術的成功率、業務結果、p50 / p95 / p99。
- Aurora PostgreSQL の connection 使用量、lock 待ち、query latency。
- Amazon ECS Service の CPU / memory、task 数、Application Auto Scaling の scaling activity。

k6 の rate は API request 数ではなく、原則として 1 秒あたりに開始する Customer journey 数として定義する。各段階の request 数、Customer の操作待ち時間、再試行、決済結果比率を script で明示する。具体的な rate、同時実行数、継続時間、合否基準は、検証目的と Product 要件を定める後続 Issue で決定する。

## B2C の本格アラーム設計

B2C の multi-window multi-burn-rate alert は、現行 Purchase API の閾値と window を流用して先に固定しない。B2C の計測を実装した後、次の順序で設計する。

1. staging full で通常時と負荷時のトラフィック特性、リクエスト数、エラー率、レイテンシ分布を計測する。
2. Product 要件と実測値から、購入ジャーニー全体と各同期 API の SLO、評価期間、error budget を確定する。
3. 成功率 SLI は error budget の消費速度を計算し、短時間窓と長時間窓の両方が閾値を超えた場合に発報する AND 条件の multi-window multi-burn-rate alert を設計する。
4. レイテンシで burn rate を使う場合は、まず「目標時間以内に完了した request」を good event、「超過した request」を bad event とする比率ベースの SLI を定義する。p95 を目標値で割っただけの値は burn rate と呼ばない。
5. window、burn-rate 倍率、最小リクエスト数、欠損データの扱い、severity は、確定した SLO と staging full の実測値から決定する。

計測実装前または SLO 確定前の段階では、具体的な window と倍率を決定済みとして扱わない。
