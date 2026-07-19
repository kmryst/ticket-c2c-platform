# 0017. 購入 API の SLO 目標値と閾値アラームを実装する

## ステータス

Accepted

## 日付

2026-07-09

## 用語補正

2026-07-19 の文書レビューで、実装を multi-window multi-burn-rate alert と呼ぶのは不正確であると確認した。実装自体は変更しない。

- error 系の fast / slow は error burn rate を使うが、互いに独立したアラームであり、短時間窓と長時間窓を AND 条件で結合していない。
- slow は 30 分を 1 つの window として集計するのではなく、5 分 period の閾値超過を 6 回連続で要求する。
- latency 系は `p95_latency / 800ms` という SLO 目標に対する閾値倍率であり、error budget の消費速度ではない。
- AWS アラーム名と Terraform resource / variable に含まれる `burn-rate` は、既存リソース・runbook・検証記録との対応を維持するため変更しない。

以下の決定はこの用語補正を前提に読む。B2C では、計測実装後に staging full のトラフィック特性と Product 要件から SLO を確定したうえで、本格的な multi-window multi-burn-rate alert を設計する。

## 背景

Issue #225 / ADR-0016 で購入 API の SLI（成功率・レイテンシ）を定義し、`PurchaseRequestOutcome`（Count, dimension: `Service` + `Outcome`）/ `PurchaseRequestLatencyMs`（Milliseconds, dimension: `Service` + `Outcome`）として EMF 計測を実装した。しかし「何を計測するか」を定義しただけで、具体的な目標値（SLO）も、目標値からの逸脱を検知する閾値アラームもなかった。

本 ADR で SLO 目標値を確定し、CloudWatch metric math による短期検知用と持続検知用の独立したアラームを実装する。設計は terraform-hannibal（別プロジェクト）の ADR-0026「ALB系SLIをCloudWatch metric mathで算出しSLO burn-rateアラートに接続する」を参考にしたが、そのまま流用せず、ticket-c2c-platform 固有の事情に合わせて調整した。

実装前に、Issue 起票前の設計ドラフトを外部 AI（Codex）にレビューさせ、指摘を反映した。以下の決定内容には、そのレビューで訂正・追加された点を含む。

## 決定

### SLO 目標値

| 項目 | 値 |
| --- | --- |
| 成功率 SLO | 99.5% |
| レイテンシ SLO | p95 < 800ms（`Outcome=success` のみ対象） |
| 最小リクエスト数（低トラフィックガード） | 5 件 / 5 分 |

### dimension の正確な扱い（外部レビューで訂正）

`PurchaseRequestOutcome` / `PurchaseRequestLatencyMs` の dimension は `Outcome` 単体ではなく `Service` + `Outcome` の組み合わせである（`src/observability/emf.ts` の実装。dimension set は `[['Service'], ['Service', 'Outcome']]` の2系統で記録される。`docs/architecture/observability.md` 参照）。CloudWatch のカスタムメトリクスは dimension の組み合わせごとに別系列になるため、metric math で参照する際は必ず `Service = "api"` を明示し、`Outcome = "success"` / `"technical_failure"` と組み合わせて指定する。当初のIssueドラフトはこの点を誤って `Outcome` dimension のみとして記述していたが、外部レビューで訂正した。

### error burn-rate アラート（成功率 SLO の逸脱検知）

「成功率」ではなく「error burn rate（error budget 消費速度）」を正本の式にする（外部レビュー指摘: success_rate に対して倍率を当てると比較演算子・しきい値の向きが直感に反しやすいため）。

```text
m1 = PurchaseRequestOutcome{Service="api", Outcome="technical_failure"}, stat=Sum, period=300
m2 = PurchaseRequestOutcome{Service="api", Outcome="success"},           stat=Sum, period=300

eligible_count = m1 + m2
error_rate      = IF(eligible_count >= 5, (m1 / eligible_count) * 100, 0)
error_burn_ratio = error_rate / (100 - 99.5)   -- error budget = 0.5%
```

- **fast burn**: 5分window（`evaluation_periods=1`）、`error_burn_ratio > 14.4` で発報
- **slow burn**: 5分periodの `error_burn_ratio > 3` が6回連続した場合に発報
- 最小リクエスト数（5件/5分）未満の期間は `error_rate = 0`（non-breaching）として扱う
- CloudWatch metric math は欠損値を算術上 0 と扱う（`m1` / `m2` にデータがない場合、加算・除算はエラーにならず 0 として計算される）ため、`FILL()` は使わない。`FILL()` を使うと、実際にはデータが来なくなった障害時（EMF 出力が完全に止まった等）でも最後の値で埋め続け、異常を見逃すリスクがある（外部レビュー指摘）。

### technical_failure 絶対数アラーム（低頻度時の見逃し防止。外部レビューで追加）

購入 API はイベントごとに数回しか呼ばれない性質上、上記の低トラフィックガード（5件/5分）を割り込む時間帯が多く発生しうる。burn-rate アラートだけでは、技術的失敗が実際に起きていても `eligible_count < 5` のため常に non-breaching になり、見逃すリスクがある。これを補うため、`PurchaseRequestOutcome{Service="api", Outcome="technical_failure"}` の絶対数に対する静的閾値アラームを別途設ける（Issue #218 の Golden Signal アラームと同じパターン）。

- **弱め通知（早期検知）**: 5分間で `Sum >= 1`
- **通常通知（持続検知）**: 30分間で `Sum >= 3`

このプロジェクトには重大度別の通知チャネル（例: PagerDuty の severity 別ルーティング）がないため、「弱め / 通常」はアラーム名・`alarm_description` で区別するに留め、通知先は同じ SNS トピック（`module.observability.alarm_action_arns`）を使う。

### latency p95 閾値倍率アラート

レイテンシ SLI は **`Outcome=success` のみを対象とした p95** を正本にする（外部レビュー指摘）。全 Outcome を混ぜると次の3つの問題がある。

1. 速い `invalid_request` / `rate_limited` が平均・パーセンタイルを薄める
2. 遅い `technical_failure`（例: タイムアウトまで待たされるケース）を error burn-rate と二重に扱うことになる
3. 平均だけでは尾の遅延（p95/p99）を隠す

```text
p95_latency  = PurchaseRequestLatencyMs{Service="api", Outcome="success"}, stat=p95, period=300
sample_count = PurchaseRequestOutcome{Service="api", Outcome="success"},   stat=Sum, period=300  -- ガード用のサンプル数代理

latency_threshold_ratio = IF(sample_count >= 5, p95_latency / 800, 0)
```

- **短期検知**: 5分periodの `latency_threshold_ratio > 2.0`（p95が SLO目標の2倍 = 1600ms 超過）で発報
- **持続検知**: 5分periodの `latency_threshold_ratio > 1.2`（p95が SLO目標の1.2倍 = 960ms 超過）が6回連続した場合に発報
- `PurchaseRequestLatencyMs` 自体の `SampleCount` は metric math で直接参照できないため、同時刻に増える `PurchaseRequestOutcome{Outcome=success}` の Sum を低トラフィックガードの代理指標として使う（同一リクエストで両メトリクスが同時に出力されるため、件数は一致する）。
- `technical_failure` のレイテンシ（診断用）は本アラームの対象外。必要ならダッシュボードで別途参照する（本 Issue では新規アラームを追加しない）。
- Terraform の metric math label は既存名の `latency_burn_ratio` を維持するが、意味は上記の `latency_threshold_ratio` とする。

### 14.4 / 3 という倍率について（外部レビューで明確化）

Google SRE本の「30日間のerror budgetの2%を1時間で消費」という前提（月次error budget）由来の数値だが、本設計は月次ではなく「起動期間中」を対象にしたSLOであり、厳密には前提が異なる。したがって、これを「Google SREを参考にしたheuristicな2段階アラート」の初期値として扱い、月次error budget理論の厳密な適用とは位置づけない。実際の運用で誤検知・見逃しが観測されたら、この倍率自体を見直す（再検討のトリガー参照）。

composite alarm（AND条件、追加コスト$0.50/月/個）は terraform-hannibal と同様の理由（規模に対して過剰、短期・持続アラームの独立通知で十分な検知性能）で不採用とする。このため、現行実装を multi-window multi-burn-rate alert とは位置づけない。

## 根拠

- 購入API固有のアプリレベルメトリクス（`PurchaseRequestOutcome` / `PurchaseRequestLatencyMs`）を入力にできる点が terraform-hannibal（ALB集約値の `TargetResponseTime` を使う）との違い。より精度の高いSLI設計が可能。
- error burn rateを正本の式にすることで、実装・レビューの両方で「大きいほど悪い」という直感的な向きに統一できる。
- technical_failure絶対数アラームの併設により、burn-rateだけでは検知できない低頻度時の障害も見逃さない。

## 反対材料・トレードオフ

- **14.4/3倍数の理論的厳密性の欠如**: 月次error budget理論由来の数値を「起動期間中」ベースのSLOにそのまま適用しており、理論的な裏付けは弱い。運用しながら調整する前提。
- **technical_failure絶対数アラームとburn-rateアラームの役割重複に見える**: 実際には低頻度時（burn-rateが機能しない領域）を補完する別軸のアラームであり、意図的な併設。
- **latency 系の物理名に `burn-rate` が残る**: AWS アラーム名を変更すると既存リソースとの対応や検証記録の追跡性を損なうため、物理名は維持する。運用上の意味は p95 閾値倍率であり、error budget burn rate ではない。
- **latencyのサンプル数ガードがPurchaseRequestLatencyMs自体のSampleCountではなく代理指標**: `PurchaseRequestOutcome{Outcome=success}`のSumで代用しており、両メトリクスの同時性に依存する。Interceptor実装（`RequestOutcomeInterceptor.record()`）は両メトリクスを同一リクエスト処理内で同時に emit するため、実運用上は一致するが、将来どちらかのメトリクスだけ変更された場合は再確認が必要。
- **`FILL()`を使わない設計のリスク**: EMFメトリクスがCloudWatch Logsから抽出されるまでの遅延（数分〜十数分）により、実際にはデータが来ているのに評価時点でまだ反映されていない「見かけ上のmissing data」が起こりうる。`treat_missing_data = notBreaching`により誤発火は防げるが、逆に本当の異常も一時的にnotBreaching扱いになる可能性がある。

## 再検討のトリガー

- 実際の運用で短期・持続アラームの誤検知（false positive）または見逃し（false negative）が観測されたとき、14.4/3・2.0/1.2の倍率を見直す。
- 購入APIのトラフィックが増加し、5件/5分の低トラフィックガードが実態に合わなくなったとき。
- technical_failure絶対数アラームの弱め/通常の区別を、実際に異なる通知チャネル（複数SNSトピック等）で表現したくなったとき。
- レイテンシSLIについて、p95以外の指標（p99等）やOutcome横断の指標が必要になったとき。

## 関連

- [Issue #218 / Golden Signal アラーム](https://github.com/kmryst/ticket-c2c-platform/issues/218)
- [Issue #225 / ADR-0016: 購入 API SLI 定義](https://github.com/kmryst/ticket-c2c-platform/issues/225)
- [Issue #227 / 本 Issue](https://github.com/kmryst/ticket-c2c-platform/issues/227)
- [ADR-0016: 購入 API の SLI（成功率・レイテンシ）を定義する](./0016-purchase-api-sli-definition.md)
- [docs/architecture/observability.md](../architecture/observability.md)
