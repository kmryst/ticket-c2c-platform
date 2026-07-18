# 0023. B2C 購入ジャーニーのレイテンシ SLI を 2 つに分ける

## ステータス

Accepted

## 日付

2026-07-16

## 背景

B2C 目標フローでは、Protected Zone Access Token の交換、Purchase Session、Ticket Hold、決済認可、Purchase 確定、結果確認を複数の API と Worker が処理する。Customer の操作時間を除き、プラットフォームが Customer を待たせた時間をレイテンシ SLI として計測する必要がある。

同期 API の処理時間は通常ミリ秒から数秒だが、`payment_unknown` の結果確定は最大 15 分かかる。この 2 種類を 1 つの分布へ混ぜると、`payment_unknown` の割合が 5% 未満では p95 に現れず、5% を超えたときに p95 が数秒から数分へ急変する。これは継続的な性能劣化ではなく、異なる事象の構成比を表すため、単一のレイテンシ SLI として解釈しにくい。

また、結果確認 API 自体が短時間で `processing` を返しても、Customer が決済結果を待つ実時間は短くならない。各 API の処理時間を合計するだけでは、非同期の結果確定待ちを表現できない。

## 決定

B2C 購入ジャーニーのレイテンシを単一の SLI にせず、次の 2 つへ分ける。具体的なメトリクス名、対象 Outcome、percentile、SLO 目標値、保存方式、emit 主体は後続の設計で決定する。同期購入処理時間の正式な SLO と集計方式は [ADR-0025](./0025-b2c-synchronous-purchase-latency-slo.md)、決済結果解決時間の計測単位と SLO 構造は [ADR-0026](./0026-measure-payment-resolution-per-attempt.md) で決定する。

### 同期購入処理時間

Customer が購入フローの各同期 API の応答を待つ、プラットフォーム管理下の処理時間を扱う。

含める処理:

- Protected Zone Access Token から Purchase Session への交換。
- Ticket Hold の作成。
- Purchase の確定。Fake Payment API の同期応答待ちはこの処理時間に含め、別に加算しない。
- Purchase 結果確認 API の 1 回分。

除外する時間:

- Waiting Room の待ち時間。
- API 呼び出し間のチケット選択、決済入力、Customer の放置時間。
- Session / Hold 期限切れまでの idle time。
- `payment_processing` 以降の非同期な結果確定待ち。

各 API のレイテンシ SLI は、同期購入処理時間が悪化したときに原因となる段階を特定できる形で別に維持する。後続の ADR-0025 では、この個別 SLI を正式な SLO の正本にも使用する。

### 決済結果解決時間

Aurora PostgreSQL で Hold が `payment_processing` へ遷移した時点から、その決済試行の確定結果が Aurora PostgreSQL へ記録されるまでの経過時間を扱う。確定結果には決済拒否後の `held` への復帰を含む。これは API 処理時間の合計ではなく、サーバー側の wall-clock time とする。payment attempt 単位の詳細は ADR-0026 に従う。

- 通常の同期決済と、`payment_unknown` を経由して最大 15 分以内に解決する処理を同じ決済結果解決経路として計測する。
- `payment_unknown` の件数と滞留時間に対する Amazon CloudWatch Alarm は、結果確定後に集計される SLI より早く異常を検知するため別に維持する。
- 15 分後も未解決の `payment_unknown` は、[ADR-0022](./0022-b2c-purchase-journey-success-sli.md) に従って技術的失敗として扱う。

### 単一の wall-clock time を SLI にしない

Access Token 発行から Purchase 結果までの単純な wall-clock time には、Customer の選択、入力、放置が含まれるため、プラットフォーム性能の SLI には採用しない。実際の Customer 体験を開始 cohort 単位で分析する診断値として、構造化ログまたは負荷試験結果には記録できるようにする。

### 現行 SLO との関係

現行 Purchase API の p95 800ms は、B2C 目標フローへ切り替えるまで現役 SLO として維持する。同期購入処理時間、決済結果解決時間、または新しい各 API へこの数値を自動的に流用しない。

## 根拠

- ミリ秒から数秒の同期処理と、最大 15 分の決済結果解決を別の分布にすることで、percentile の意味を安定させられる。
- 決済結果解決時間を Aurora PostgreSQL の状態遷移間で測ることで、結果確認 API の応答時間やポーリング間隔に左右されず、Customer が結果を待つサーバー側の時間を表現できる。
- 各 API のレイテンシを診断用に残すことで、同期購入処理時間が悪化した段階を特定できる。
- `payment_unknown` の Amazon CloudWatch Alarm と結果確定後の SLI を分けることで、リアルタイム検知と SLO 評価の責務を混同しない。

## 反対材料・トレードオフ

- 購入レイテンシを 1 つの数字では説明できなくなり、Dashboard と SLO が増える。
- 同期購入処理時間を 1 ジャーニーの値として集計する場合、複数 API の処理時間を API / Worker 間で引き継ぐ仕組みが必要になる。
- 決済結果解決時間は、同期 API のレイテンシより桁が大きく、同じ SLO 目標値や burn-rate 閾値を使用できない。
- サーバー側計測だけでは Customer と Amazon CloudFront 間のネットワーク時間を含まない。k6 のクライアント側計測と突き合わせて差を確認する必要がある。

## 再検討のトリガー

- 実際の Payment Service Provider の API または Webhook により、決済結果の確定方式が変わるとき。
- staging full の実測で、同期購入処理時間が Outcome ごとに分離しないと解釈できないと判明したとき。
- Customer の操作時間を除いた end-to-end latency をクライアント側で信頼できる形で計測できるようになったとき。
- 同期購入処理時間または決済結果解決時間の具体的な SLO と burn-rate アラームを決定するとき。
