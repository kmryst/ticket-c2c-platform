# 0026. 決済結果解決時間を決済試行単位で計測する

## ステータス

Accepted

## 日付

2026-07-17

## 背景

[ADR-0023](./0023-split-b2c-purchase-journey-latency-sli.md) では、決済結果解決時間を Aurora PostgreSQL の `payment_processing` 遷移から決済結果の確定までのサーバー側 wall-clock time と定義した。ただし、1 つの Purchase Session では決済拒否後に最大 3 回の決済試行があり、試行間には Customer の入力・操作時間が入る。最初の試行から Purchase Session の終端までを 1 サンプルにすると、プラットフォーム管理外の時間が SLI に混ざる。

通常の同期決済は短時間で確定する一方、`payment_unknown` を経由する決済は Payment Reconciliation Worker により最大 15 分間照会される。両者を 1 つの percentile 系列に混ぜると、`payment_unknown` の構成比によって分布が急変し、同期決済の劣化を解釈しにくい。

また、Amazon CloudWatch Embedded Metric Format の出力を API と Worker の両方が担当するため、計測専用の DB 書き込みを追加せず、同じ決済試行を二重に記録しない境界が必要になる。

## 決定

### 決済試行の単位と上限

決済結果解決時間は payment attempt 単位で計測する。payment attempt は、プラットフォームが Product policy と業務状態を検証し、Ticket Hold を `payment_processing` へ原子的に遷移させて受理した 1 エピソードとする。専用の payment attempt table の存在は前提にしない。

決済試行の上限は 1 Ticket Hold 単位ではなく、1 Purchase Session の累計で最大 3 回とする。Hold をキャンセルまたは再作成しても累計を戻さない。初期 Product policy では、決済拒否後の新しい試行は、それまでと異なる決済方法に限って認める。

新しい試行の受理判定、Purchase Session の累計試行回数の増加、`held` から `payment_processing` への状態遷移は、同じ Aurora PostgreSQL transaction 内で原子的に実行する。具体的な SQL と column の配置は後続 Issue で決定する。

Idempotency Key は request の冪等性に使用する。同じ Key による内部再送、timeout 再送、idempotent replay は同じ payment attempt とし、新しいサンプルを作らない。新しい Key は新しい attempt の必要条件だが十分条件ではなく、原子的な受理処理が成功した場合だけ attempt が成立する。同じ Key で異なる payload を送った場合の HTTP 契約は後続の API contract で決定する。

### 開始と終了の境界

開始時刻は `payment_processing` 状態遷移を記録する UPDATE 文の実行時点、終了時刻はその attempt の確定結果を記録する UPDATE 文の実行時点とし、どちらも Aurora PostgreSQL が生成する時刻を使用する。開始と終了は別々の transaction で記録し、transaction の開始時刻に依存させない。使用する PostgreSQL 関数と schema は後続 Issue で決定する。

- Fake Payment API の `approved` が同期確定した場合は、Purchase を確定した時点で `authorized` として閉じる。
- `declined` が同期確定した場合は、Hold が `held` へ戻るか、期限切れにより `expired` へ進んだ時点で閉じる。
- Purchase Session 累計 3 回目の `declined` は、同期確定か Payment Reconciliation Worker による確定か、Hold の元の期限を問わず、その時点の Hold を `payment_failed` へ遷移させて Session を終了する。`held` への復帰と `expired` は累計 3 回未満の attempt にだけ適用する。
- `payment_unknown` は中間状態であり、その遷移時点では閉じない。遷移時点から最大 15 分間、Payment Reconciliation Worker が `authorized` または `declined` へ解決するまで同じ attempt を継続する。
- 15 分後も未解決の場合は `unresolved_timeout` として attempt の計測を閉じるが、在庫は隔離したまま運用対応へ送る。後から結果が確定しても同じ attempt のメトリクスを再出力しない。

API が `payment_processing` を commit した後に停止して状態が滞留した場合は、Payment Reconciliation Worker が stale な `payment_processing` を検出し、Fake Payment API の結果と突き合わせて回収する。`payment_unknown` の 15 分はその状態へ遷移した時点から数え、attempt 全体の滞留は `payment_processing` の滞留時間監視で補完する。

[ADR-0027](./0027-payment-timeout-boundaries.md) により、同期処理から `payment_unknown` へ進む境界は、60 秒の同期待ちではなく Fake Payment API の 3 秒 cutoff に更新する。stale `payment_processing` の 60 秒は、API 停止後に Worker が回収を始める基準として維持する。この更新は payment attempt の計測単位、開始と終了、SLO の系列を変更しない。

Purchase 確定 API の同期レイテンシと決済結果解決時間は一部の時間窓が重なる。前者は HTTP request の応答性能、後者は 1 payment attempt の結果確定時間を評価するため、二重計上とは扱わない。

### SLI、SLO、dimension

決済結果解決時間のレイテンシメトリクスは、既存の EMF 規約に従って `Service` と `ResolutionPath` を dimension に使用する。`ResolutionPath` は `sync` と `reconciled` の有限集合とし、正式なメトリクス名は後続 Issue で決定する。

- 正式な SLO は `Service=api`、`ResolutionPath=sync` の、仕様どおりに `authorized` または `declined` へ確定した attempt の p95 に置く。
- `ResolutionPath=reconciled` は低サンプル時に percentile が不安定になるため、初期段階では Amazon CloudWatch Dashboard、件数、滞留時間による検証指標とする。
- レイテンシメトリクスには `Outcome` dimension を加えない。Amazon CloudWatch の percentile は系列間で合成できないため、追加すると sync 全体の p95 を算出できなくなる。
- `unresolved_timeout` ではレイテンシメトリクスを出力しない。真の解決時間が不明な右側打ち切りサンプルであり、percentile からの除外は emit 自体を抑止して実現する。

決済試行の結果件数メトリクスは `Service` と `Outcome` を dimension に使用し、`authorized`、`declined`、`unresolved_timeout` を有限集合として記録する。`payment_failed` は 3 回目の `declined` 後の Hold / Purchase Session の終端であり、payment attempt の Outcome には含めない。正式なメトリクス名は後続 Issue で決定する。

Product policy により拒否した request は `payment_processing` エピソードが成立しないため、決済結果解決時間と決済試行結果件数の対象外とする。同期 API SLI ではクライアント起因 4xx として扱い、有限集合の拒否理由による診断件数は後続 Issue で検討する。

### emit の一回性

同期確定では Purchase 確定 API、`payment_unknown` からの解決、15 分 timeout、stale `payment_processing` の回収では Payment Reconciliation Worker が emit 主体になる。

終端状態遷移の条件付き UPDATE で affected rows が 1 になり、commit に成功した主体だけが Amazon CloudWatch Embedded Metric Format を stdout へ出力する。計測専用の recorded flag、transactional outbox、厳密な exactly-once は初期設計では採用しない。アプリケーションからの emit は at-most-once とし、commit 後かつ emit 前のクラッシュによる稀な欠損を許容する。ログ配送層で発生し得る稀な重複は残余リスクとして許容する。

payment attempt の識別子は構造化ログの属性として記録し、Amazon CloudWatch Embedded Metric Format の dimension には含めない。決済方法の識別子は dimension、通常ログ、trace 属性へ出力しない。

### 補完監視

percentile だけでは障害時に遅い attempt が母集団から抜けるため、次の責務分担を SLO の guardrail とする。

| 劣化モード | 検知手段 |
| --- | --- |
| 同期決済の解決遅延 | `ResolutionPath=sync` の p95 |
| 3 秒 cutoff による `payment_unknown` 増加 | `payment_unknown` の件数に対する Amazon CloudWatch Alarm。閾値と severity は staging full で決定 |
| Payment Reconciliation Worker の遅延・停止 | `payment_processing` / `payment_unknown` の滞留時間に対する Amazon CloudWatch Alarm |
| 15 分後も未解決 | `unresolved_timeout` 件数、ADR-0022 の `technical_failure`、運用エスカレーション |
| EMF の欠損 | Aurora PostgreSQL の解決済み attempt 件数と結果件数メトリクスの突き合わせ。運用方法は後続 Issue |

### 決済方法の識別とセキュリティ境界

異なる決済方法の判定に、生のカード番号、セキュリティコードなどの決済情報を保存しない。local / staging の Fake Payment API では test token を使用する。将来の Payment Service Provider では非機密な token または fingerprint などを候補とするが、識別方式、保存先、保持期間、暗号化、PCI DSS 境界は security / API contract の後続 Issue で決定する。

決済方法の識別子は、Amazon CloudWatch Embedded Metric Format の dimension、通常ログ、trace 属性へ出力しない。

## 根拠

- payment attempt 単位にすることで、試行間にある Customer の入力・操作時間を SLI から除外できる。
- attempt の成立を Aurora PostgreSQL の原子的な状態遷移と一致させることで、Idempotency Key の変更や並行 request による試行上限の回避と、SLI 母集団の水増しを防げる。
- `ResolutionPath` で同期解決と Worker 解決を分けることで、秒未満から数秒の分布と最大 15 分の分布を同じ percentile に混ぜずに済む。
- `unresolved_timeout` を件数、成功率 SLI、滞留時間 Alarm で扱うことで、percentile に現れにくい技術的失敗を不可視にしない。
- 条件付き状態遷移を emit のゲートにも使うことで、計測専用の Aurora PostgreSQL 書き込みを追加せずに、API と Worker の二重 emit を抑制できる。

## 反対材料・トレードオフ

- at-most-once のため、commit 後かつ emit 前にプロセスが停止するとメトリクスが欠損する。欠損が障害や高レイテンシと相関し、SLO 判定へ影響した場合は、より信頼性の高い記録方式を再検討する必要がある。
- Aurora PostgreSQL の状態遷移時刻は厳密な commit timestamp ではなく、timestamp の記録から commit 完了までの時間は計測誤差になる。
- 同じ決済方法の再試行を禁止する初期 Product policy は、決済方法を 1 つしか持たない Customer に厳しい。
- `payment_failed` または期限切れ後に Waiting Room へ再参加すると新しい Purchase Session が作られ、試行累計はリセットされる。この経路は Waiting Room の待機コストと Fake Payment API の決定的応答により初期段階では許容する。
- `authorized` と `declined` の処理形状に差がある場合、構成比の変化で sync p95 が動く可能性がある。
- Worker の実行単位または `METRICS_SERVICE` を変更すると、Amazon CloudWatch の SLO クエリと Alarm が参照する `Service` 系列も更新する必要がある。

## 再検討のトリガー

- 実際の Payment Service Provider を導入し、soft decline と hard decline を区別できるようになったとき。
- 同じ決済方法の再試行禁止、Purchase Session ごとの上限、または Waiting Room 再参加後の上限リセットが Customer 体験や abuse 対策上の問題になったとき。
- staging full の実測で、`authorized` と `declined` の処理時間差により sync p95 の解釈が不安定になったとき。
- Aurora PostgreSQL の解決済み attempt 件数と結果件数メトリクスに継続的な乖離が確認されたとき。
- incident の事後検証で EMF の欠損または重複が SLO 判定に影響したとき。
- Payment Reconciliation Worker の実行単位または `METRICS_SERVICE` を変更するとき。
