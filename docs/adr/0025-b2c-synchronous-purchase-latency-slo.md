# 0025. B2C 同期購入レイテンシの SLO と集計方式を定義する

## ステータス

Accepted

## 日付

2026-07-17

## 背景

[ADR-0023](./0023-split-b2c-purchase-journey-latency-sli.md) では、B2C 購入ジャーニーのレイテンシを同期購入処理時間と決済結果解決時間へ分けた。[ADR-0024](./0024-b2c-synchronous-api-latency-boundary.md) では 4 つの同期 API に共通するサーバー側計測境界を定義したが、正式な SLO を API ごとに置くか、ジャーニー単位の合算値へ置くかは決定していなかった。

同期 API の構成は業務結果によって異なる。`confirmed` の正常系は 4 API を各 1 回呼び出すが、`sold_out` は早期に終了し、決済拒否、再試行、結果確認のポーリングでは呼び出し回数が増える。これらを 1 つの分布へ混ぜると、業務結果の構成比によって percentile が変化する。

一方、API 個別の p95 は原因となる段階を特定しやすいが、4 API すべてが個別目標を満たしてもジャーニー全体の p95 を保証しない。正式な SLO、設計時のレイテンシ配分、容量試験と診断に使う合算値の責務を分ける必要がある。

## 決定

### 正式なレイテンシ SLO

production / staging の同期購入レイテンシに関する正式な SLO は、次の 4 API の個別 SLI に対して定義する。

- Protected Zone Access Token から Purchase Session への交換。
- Ticket Hold の作成。
- Purchase の確定。
- Purchase 結果確認。

各 SLI は ADR-0024 の境界で計測し、endpoint の契約どおりに技術的成功を返した request の p95 を使用する。具体的なメトリクス名、目標値、低トラフィック時の評価方法、burn-rate アラームは、staging full の実測後に決定する。現行 Purchase API の p95 800ms は流用しない。

### 同期購入ジャーニーのレイテンシ予算

`confirmed` 正常系の 4 API を各 1 回呼び出す経路に、同期購入ジャーニー全体のレイテンシ予算を設ける。この予算は各 API の目標値を導く設計配分基準であり、正式な SLO または Amazon CloudWatch Alarm の対象にはしない。

API 個別 p95 の達成はジャーニー全体の p95 を保証しない。各 API の p99 は API 単体の tail latency を確認する検証指標とし、ジャーニー予算を保証する guardrail にはしない。p99 の具体値、正式な SLO への採用、アラーム化は、staging full のサンプル数と分布を確認して別途判断する。

Amazon CloudWatch metric math で 4 API の p95 を合計しても、呼び出し元の母集団が異なるため、ジャーニー全体の p95 にはならない。この値を表示する場合は Amazon CloudWatch Dashboard の参考値に限定し、アラームには使用しない。

### Outcome 別のジャーニー集計

B2C 購入フローの各 API と Worker は、ジャーニー識別子を構造化ログの属性として記録する。ジャーニー識別子は高カーディナリティになるため、Amazon CloudWatch Embedded Metric Format の dimension には含めない。

同期購入ジャーニーの補助集計は、同期フェーズの終端 Outcome である `confirmed`、`sold_out`、`payment_failed`、`payment_unknown` ごとに分け、`abandoned` は除外する。この分類は同期フェーズの業務結果であり、ADR-0022 の `success` / `technical_failure` 分類とは独立して扱う。

終端 Outcome があるジャーニーでは、同期フェーズ終端までに発生した再試行、idempotent replay、`client_aborted` となった試行を含む全 request のサーバー側処理時間と API 呼び出し回数を集計対象にする。集計は同期フェーズの終端 Outcome が確定した時点で閉じる。`payment_unknown` 確定後の結果確認 request は同期ジャーニーの合算へ追加せず、各 API の SLI と ADR-0023 の決済結果解決時間 SLI で扱う。

この合算値はプラットフォームのサーバー側処理時間であり、Customer の実待ち時間ではない。k6 のクライアント側 HTTP duration と、将来候補の Amazon CloudWatch RUM は、Customer 側から見た時間を別に計測する。

### 補助指標の位置づけ

k6 とジャーニー識別子付きログによる Outcome 別の合算値は、Protected Zone の容量試験、受入判定、診断に使用し、正式な SLO にはしない。計測だけを目的とする Aurora PostgreSQL への書き込みは追加しない。

Amazon CloudWatch Logs Insights の具体的なクエリ、集計の自動化と実行周期、k6 を 1 iteration = 1 Customer journey へ変更する実装は後続 Issue で扱う。

決済結果解決時間 SLI は ADR-0023 のサーバー側 wall-clock time として独立して維持し、この判断では変更しない。

## 根拠

- 正式な SLO を API 個別に置くことで、Customer へ応答する各段階の劣化を継続監視し、原因となる endpoint を特定できる。
- 業務結果ごとに API 構成と呼び出し回数が異なるため、単一のジャーニー分布より Outcome 別の補助集計の方が解釈を安定させられる。
- レイテンシ予算を設計配分基準に限定することで、API 個別 percentile からジャーニー percentile を保証できない統計上の制約を隠さない。
- ジャーニー識別子をログ属性に限定することで、高カーディナリティの Amazon CloudWatch カスタムメトリクスを作らずに API と Worker を相関できる。
- 計測専用の Aurora PostgreSQL 書き込みを避けることで、販売スパイク時のホットパスへ診断目的の負荷を追加しない。

## 反対材料・トレードオフ

- API 個別 SLO がすべて正常でも、複数 API の緩やかな劣化や再試行回数の増加により、ジャーニー全体が遅くなる可能性がある。Outcome 別ログ集計と k6 で補完するが、リアルタイムの正式 SLO にはならない。
- p99 は低トラフィック時に十分なサンプルを得にくく、短い評価期間ではほぼ最大値として振る舞う可能性がある。
- 構造化ログの欠損や集計期間を跨ぐジャーニーがあると、補助集計が不完全になる。具体的な集計方式で欠損と重複を扱う必要がある。
- サーバー側処理時間の合計は、ネットワーク、再試行間の backoff、Customer 側の描画時間を含まず、実際の Customer 体験を直接表さない。

## 再検討のトリガー

- Amazon CloudWatch RUM などにより、Customer の操作時間を除いたジャーニー全体のレイテンシを継続的かつ信頼できる形で計測できるようになったとき。
- Product 要件として、同期購入ジャーニー全体に正式な SLO が必要になったとき。
- staging full の実測で API 個別 SLO だけでは容量劣化を検知できないと判明したとき。
- B2C 購入フローの API 構成、再試行方針、結果確認方式が変わるとき。
- ログ量または集計対象のジャーニー数が Amazon CloudWatch Logs Insights で扱える規模を超えるとき。
