# 0016. 購入 API の SLI（成功率・レイテンシ）を定義する

## ステータス

Accepted

## 日付

2026-07-09

## 背景

Issue #218 で ALB / ECS / Aurora の Golden Signal アラームと既存 EMF メトリクス（`ValkeyFailOpen` / `WorkerProcessingLagMs`）へのアラームを追加したが、これらは「壊れていることに気づける」インフラ層の監視であり、SRE 的な「ユーザー体験としての SLI（Service Level Indicator）」を定義したものではない。

購入 API（`POST /events/:eventId/purchases`）は C2C チケット販売の中核フローであり、何をもって「正常に動作している」とするかを明確化し、後続の SLO 目標値・burn-rate アラーム（フェーズ3、別 Issue）の土台を作る必要がある（Issue #225）。

### Issue #218 の ALB 5xx アラームでは代替できない理由

Issue #218 で追加した `<name>-alb-5xx` アラームは、ALB 配下の全エンドポイント（`/auth/*`、`/events`、`/events/:eventId/purchases` 等）を横断した 5xx 合算であり、購入 API に固有の成功率・レイテンシを表さない。役割分担は次のとおりとする。

| レイヤ | 監視対象 | 目的 |
| --- | --- | --- |
| ALB 5xx アラーム（Issue #218） | 全エンドポイント横断、ALB 起因 + ターゲット起因の 5xx 合算 | インフラ層の粗い異常検知（「何かが壊れている」） |
| 本 ADR の SLI（`PurchaseRequestOutcome` / `PurchaseRequestLatencyMs`） | 購入 API 単体、アプリ到達後（Guard 通過後）の応答 | ユーザー体験としての「購入という中核フローが機能しているか」の精密な計測 |

## 決定

### 成功率 SLI

購入 API の 1 リクエストごとに、HTTP 応答レベルの技術的な成否を `Outcome` dimension（値は次の 4 種の有限集合）で分類し、新規メトリクス `PurchaseRequestOutcome`（Count）として EMF で出力する。

| Outcome | 該当する応答 | SLI 計算上の扱い |
| --- | --- | --- |
| `success` | 2xx（購入 API では confirmed / rejected のいずれの業務判定も HTTP 200 で返る。ADR-0012） | 成功率の分子・分母両方に算入 |
| `technical_failure` | 上記以外の例外（5xx、DB 接続断等の未分類エラー、タイムアウト） | 成功率の分母には算入するが分子には含めない |
| `rate_limited` | 429（レート制限超過） | 成功率の分母・分子いずれからも除外し、別途ガードレールとして分離集計する |
| `invalid_request` | 400 / 401 / 404 / 409（クライアント起因） | 成功率の分母から除外する（システム障害ではないため） |

成功率 SLI は次の式で算出する。

```text
成功率 = count(Outcome=success) / (count(Outcome=success) + count(Outcome=technical_failure))
```

**`sold_out_precheck` / `insufficient_inventory` による購入拒否は `success` に含まれる**。購入 API は在庫切れ時も HTTP 200 + `rejectionReason` を返す設計（ADR-0012）であり、「売り切れで拒否された」は正常なビジネス動作でシステム障害ではない。既存の `PurchaseConfirmed` / `PurchaseRejected`（ADR-0014）は「業務判定の結果」を表すメトリクスであり、本 ADR の `PurchaseRequestOutcome` は「HTTP 応答レベルでシステムとして正しく応答できたか」を表す別軸のメトリクスとして併存させる。

**`rate_limited`（429）を成功率の分子・分母から除外する理由**: レート制限超過はシステム障害ではなく、想定内の防御機構（ADR-0015）が正しく動作した結果である。成功率 SLI に混ぜると、ボットの物量攻撃が来ただけで「成功率が悪化した」ように見えてしまい、SLI の意味が変わってしまう。レート制限の発生量自体は既存の `PurchaseRateLimited` メトリクス（`rate-limit.service.ts`、Issue #204）が既に持っており、本 ADR ではこれを重複計測せず、`PurchaseRequestOutcome` 側は「成功率 SLI の分母を完結させるための分類の一つ」として `rate_limited` を持つに留める。両者は役割を分離したまま併存する。

**`invalid_request`（400/401/404/409）を分母から除外する理由**: クライアントの入力不備・認証失敗・存在しない event・requestId 競合はいずれもクライアント起因であり、システムが「正しく動いていない」わけではない。分母に含めると、クライアントの誤操作が多いだけで SLI が悪化して見えてしまう。

### レイテンシ SLI

新規メトリクス `PurchaseRequestLatencyMs`（Milliseconds）を EMF で出力する。計測範囲は「JwtAuthGuard 通過後から応答（成功 / 例外いずれか）までの所要時間」とする。これは Issue #225 が「SRE 的なユーザー体験としての SLI」と定義した意図（認証・レート制限を含めた、ユーザーが API を叩いてから応答が返るまで）を反映したものであり、`purchases.service.ts` 内部の DB transaction 処理時間のみを計測する狭い実装（当初案）は採用しなかった。

実装は NestJS の共通 Interceptor（`src/observability/request-outcome.interceptor.ts`）とし、`performance.now()`（単調増加クロック。`Date.now()` はシステム時刻補正で負の経過時間になり得るため使わない）で計測する。メトリクス名をコンストラクタ引数として受け取る汎用実装にし、将来他のエンドポイントにも再利用できるようにした。

`PurchaseRequestLatencyMs` にも `Outcome` dimension を付与し、`PurchaseRequestOutcome` と対にして「成功時のレイテンシ」「技術的失敗時のレイテンシ」を分けて見られるようにする。

### 401 が計測対象外になる理由（NestJS の実行順序による技術的制約）

NestJS のリクエストライフサイクルは Guard → Interceptor → Handler の順に実行される。購入 API の `JwtAuthGuard`（認証失敗時に 401 を投げる）は Guard として適用されているため、認証に失敗したリクエストは Interceptor に到達する前に短絡し、`RequestOutcomeInterceptor` は実行されない。

一方、レート制限（429）は `PurchasesController` の handler 本体内で直接呼び出し（`await this.rateLimit.enforce(...)`、Guard ではない）として実装されているため Interceptor が正しく捕捉できる。同様に 400（入力検証）/ 404（event 不在）/ 409（requestId 競合）/ 5xx はいずれも `purchases.service.ts` から handler 実行の一部として投げられるため、Interceptor が正しく捕捉する。

401 のみ計測できないこの制約は、Issue #225 が元々「認証・検索は将来拡張」としてスコープ外にしていた範囲と一致するため、追加のスコープ縮小ではなく、既存のスコープ判断を裏付ける技術的な帰結として扱う。認証自体の SLI（ログイン成功率等）は将来のフェーズで別途検討する。

### 高カーディナリティ dimension を避ける方針

`Outcome` は 4 値の有限集合のみを dimension に使う。`eventId` / `buyerId` / `requestId` のような値が事実上無制限に増える dimension は、CloudWatch のメトリクス系列数（課金対象）を際限なく増やすため、本 SLI メトリクスには一切含めない。

## 根拠

- 購入 API は C2C チケット販売における唯一の収益発生ポイントであり、Issue #225 で最優先の SLI 対象と位置づけられている。
- 既存の ALB 5xx アラーム（全エンドポイント横断）と EMF ビジネスメトリクス（`PurchaseConfirmed` / `PurchaseRejected`、業務判定結果）は、いずれも「システムとしての技術的成功率」を単体では表せない。両者の間を埋める指標として本 SLI を新設する。
- 成功率・レイテンシいずれも既存の EMF 基盤（`src/observability/emf.ts`、追加 IAM 権限不要）をそのまま再利用でき、実装コストが小さい。

## 反対材料・トレードオフ

- **401 を計測できない**: 上記のとおり NestJS の実行順序による制約。認証失敗を含めた完全な「ユーザーが API を叩いてから」の計測をしたい場合は、Guard より前段（Fastify の middleware 等）で計測を始める設計に変更する必要があるが、複雑さに見合わないと判断し見送った。
- **`rate_limited` の分離集計は既存 `PurchaseRateLimited` メトリクスとの二重管理に見える**: 実際には目的が異なる（既存メトリクスはガードレールとしての発生量監視、`PurchaseRequestOutcome` の `rate_limited` は成功率 SLI の分母を完結させるための分類）ため、統合はしない。
- **Interceptor は 1 リクエストにつき 2 回 `emitMetric` を呼ぶ（レイテンシ・件数）**: EMF は stdout への `console.log` のみで追加 IAM 権限・API 呼び出しコストがないため、実質的なコスト増は無視できる。

## 再検討のトリガー

- フェーズ3（SLO 目標値・burn-rate アラーム）着手時、本 SLI をそのまま `metric math` の入力として使えるか再検証する。
- 401 を含めた認証込みの計測が必要になったとき（別 Issue で認証 SLI を検討する際に合わせて再設計する）。
- 購入 API 以外のエンドポイント（認証・検索）に SLI を拡張する際、`RequestOutcomeInterceptor` の Outcome 分類がそのまま転用できるか確認する。

## 関連

- [Issue #218 / Golden Signal アラーム](https://github.com/kmryst/ticket-c2c-platform/issues/218)
- [Issue #225 / 購入 API SLI 定義](https://github.com/kmryst/ticket-c2c-platform/issues/225)
- [ADR-0012: 認証レート制限（fail-open、trusted-hops）](./0012-refresh-token-rotation-and-auth-hardening.md)
- [ADR-0014: X-Ray 分散トレーシング + EMF ビジネスメトリクス](./0014-xray-distributed-tracing-with-adot-sidecar.md)
- [ADR-0015: 購入エンドポイントのレート制限（dual-key）](./0015-purchase-rate-limit-dual-key.md)
- [docs/architecture/observability.md](../architecture/observability.md)
