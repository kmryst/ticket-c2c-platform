# 0022. B2C 購入ジャーニーの技術的成功率 SLI を定義する

## ステータス

Accepted

## 日付

2026-07-16

## 背景

[ADR-0021](./0021-protected-zone-purchase-flow.md) で採用した B2C 目標フローは、Protected Zone Access Token、Purchase Session、Ticket Hold、決済認可、Purchase 確定、結果確認に分かれる。各 API が個別に応答していても、途中で入場権を失う、決済結果が不明なまま残る、状態遷移が不整合になる場合は、Customer にとって購入ジャーニーが機能したとはいえない。

現行の単一 Purchase API には、[ADR-0016](./0016-purchase-api-sli-definition.md) と [ADR-0017](./0017-purchase-api-slo-burn-rate.md) による成功率 99.5%・p95 800ms の SLO がある。ただし、この数値を複数段階の B2C フローへそのまま適用すると、段階ごとの成功率の積によってジャーニー全体の成功率が下がり、Customer の放置や正常な業務拒否を技術障害と混同する。

Protected Zone の入場レートと最大同時利用者数を決める前に、購入ジャーニー全体で何を技術的成功と数えるかを定義する必要がある。

## 決定

B2C 購入ジャーニーの技術的成功率 SLI を、次の境界と分類で定義する。この SLI は目標設計であり、メトリクス実装と SLO 目標値は未決定とする。

### 計測境界

- 購入ジャーニーは、Waiting Room が Protected Zone Access Token の発行に成功した時点から開始する。
- Waiting Room への参加と待ち時間、Access Token 発行前の失敗は、Waiting Room 側の SLI として分離する。
- Access Token から Purchase Session への交換以降は、購入ジャーニーの対象に含める。
- プラットフォーム障害による入場権回復で Access Token を再発行した場合は、新しいジャーニーを作らず、同じ Customer / Event の購入試行として扱う。
- SLI の Outcome は、仕様上の終端状態が確定した時点で 1 ジャーニーにつき正確に 1 回記録する。
- ジャーニー識別子は Aurora、構造化ログ、trace の相関に使用し、高カーディナリティになるため Amazon CloudWatch メトリクスの dimension には含めない。

### 分母と分子

```text
技術的成功率 = success / (success + technical_failure)
```

- **分母**: 終端状態が確定した有効な購入ジャーニーのうち、`success` と `technical_failure` に分類した件数。
- **分子**: Customer に利用者可視の技術障害を返さず、仕様どおりの終端状態へ到達した `success` の件数。
- Customer の任意離脱とクライアント起因の無効な操作は、成功率を水増しまたは悪化させないよう分母から除外し、別指標へ記録する。

### Outcome 分類

| 分類 | 対象 |
| --- | --- |
| `success` | Purchase 確定、売り切れ・在庫不足による正常な拒否、3 回の決済拒否による `payment_failed`、15 分以内に確定結果へ解決した `payment_unknown` のうち利用者可視の技術障害がないもの |
| `technical_failure` | Customer へ返した 5xx / timeout、状態不整合、プラットフォーム障害による入場権喪失、正規入場後の Customer に対する 429、15 分後も未解決の `payment_unknown`、利用者可視の技術障害を経た後の期限切れ・キャンセル |
| 除外 | 未使用の Access Token 失効、利用者可視の技術障害を伴わない Session / Hold 期限切れと本人キャンセル、Bot または未入場利用者に対する防御的な 429、クライアント起因の 4xx だけで終了した操作 |

内部再試行で回復し、Customer に 5xx / timeout を返さず応答契約を満たした場合は `technical_failure` にしない。内部再試行回数と回復時間は、障害の前兆を隠さないため別の診断指標として記録する。

### `payment_unknown` の扱い

- `payment_unknown` へ遷移しただけでは、購入ジャーニーの成功または失敗を確定しない。
- 決済結果確認 Worker が最大 15 分間照会し、仕様どおりの結果へ解決し、かつ Customer に利用者可視の技術障害を返していなければ `success` とする。
- 15 分後も未解決なら `technical_failure` とし、終端確定時刻に Outcome を記録する。
- 購入ジャーニー全体の評価を一律に 15 分遅らせない。`payment_unknown` の Outcome だけが最大 15 分遅れて計上される。
- SLI の遅延をリアルタイム検知の代わりにしない。`payment_unknown` の発生件数と滞留時間は Amazon CloudWatch Alarm で別に監視する。

### 429 の扱い

Bot または Protected Zone へ入場していない利用者に対する防御的な 429 は、購入ジャーニーの分母から除外する。一方、Waiting Room が正規に入場を許可した Customer に 429 を返した場合は、Protected Zone の許可流量が処理容量を超えたことを示すため `technical_failure` とする。

### 現行 SLO との関係

- 現行 Purchase API が稼働している間は、ADR-0016 / ADR-0017 の成功率 99.5%・p95 800ms を現役 SLO として維持する。
- B2C 目標フローへ切り替えた後は、現行 SLO を旧 Purchase API 限定の履歴と各 API の計測方式の参考として扱う。
- 99.5% と p95 800ms を新しい各 API または購入ジャーニー全体へ自動的に流用しない。
- B2C 購入ジャーニーの SLO 目標値は、Product 要件と staging full の実測結果を合わせて別途決定する。

## 根拠

- Access Token 発行を開始境界にすることで、Protected Zone へ進む権利を得た後の Session 交換失敗を SLI から漏らさない。
- Customer の放置や本人キャンセルを成功に含めないことで、購入が進まなかったジャーニーによる成功率の水増しを防ぐ。
- 売り切れや決済拒否を `success` とすることで、正常な業務判定とシステム障害を分離する。
- 正規入場後の 429 を失敗とすることで、Waiting Room が安全な流量だけを許可するという Protected Zone の契約違反を error budget に反映する。
- 終端確定時に Outcome を 1 回だけ記録することで、開始時点と最大 15 分後の結果を同じ CloudWatch 集計期間へ無理に対応付ける必要がなくなる。
- 段階別 API SLI と `payment_unknown` の Amazon CloudWatch Alarm を併用することで、終端確定が遅いジャーニー SLI だけにリアルタイム検知を依存しない。

## 反対材料・トレードオフ

- 終端時点で集計する成功率 SLI は、開始時刻を基準にした cohort 分析とは一致しない。開始 cohort の分析が必要な場合はログまたは分析基盤で別に算出する。
- 任意離脱と技術障害後の離脱を分けるには、同じジャーニーを API と Worker の状態遷移で追跡できる識別子が必要になる。
- 内部再試行で回復した処理を成功に含めるため、再試行指標を監視しないと内部劣化を見逃す可能性がある。
- `payment_unknown` の結果は最大 15 分遅れて成功率へ反映されるため、短時間の障害検知には使えない。
- B2C の具体的な成功率 SLO と error budget は未決定であり、この ADR だけでは Protected Zone の許可流量を確定できない。

## 再検討のトリガー

- Waiting Room の待ち時間を購入体験全体の SLO に統合するとき。
- 実際の Payment Service Provider の非同期 API または Webhook を導入し、決済結果の確定条件が変わるとき。
- staging full の実測で、終端時点の集計では流量制御の判断が遅すぎると判明したとき。
- Customer の任意離脱と技術障害起因の離脱を信頼できる形で分類できないとき。
- B2C 購入ジャーニーの SLO 目標値と burn-rate アラートを決定するとき。
