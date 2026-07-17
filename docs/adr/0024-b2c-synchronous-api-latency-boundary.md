# 0024. B2C 同期 API のサーバー側レイテンシ計測境界を定義する

## ステータス

Accepted

## 日付

2026-07-17

## 背景

[ADR-0023](./0023-split-b2c-purchase-journey-latency-sli.md) では、B2C 購入ジャーニーのレイテンシを同期購入処理時間と決済結果解決時間へ分けた。同期購入処理時間を算出するには、各同期 API のサーバー側処理時間を同じ境界で計測する必要がある。

現行 Purchase API の `PurchaseRequestLatencyMs` は NestJS Interceptor で JwtAuthGuard 通過後から handler 完了までを計測する。この境界では、認証、レスポンスのシリアライズと送信、Guard が短絡する 401 を含められない。また、正常な応答完了だけを終了点にすると、クライアント切断やサーバー側 timeout による遅いリクエストが分布から欠落する。

## 決定

B2C 目標フローの同期 API は、NestJS Interceptor ではなく Fastify の request lifecycle hook でサーバー側レイテンシを計測する。この計測は目標設計であり、現時点では未実装とする。

### 対象 API

次の B2C 同期 API だけを opt-in で対象にする。具体的な path と route config は API contract の実装時に確定する。

- Protected Zone Access Token から Purchase Session への交換。
- Ticket Hold の作成。
- Purchase の確定。
- Purchase 結果確認。

health check、未知 route の 404、および B2C 購入フロー以外の API は対象外とする。将来 Server-Sent Events または long polling を採用する endpoint は、接続保持時間が通常の HTTP 応答レイテンシと異なるため、この SLI には含めない。

### 開始と終了

- **開始**: Fastify の `onRequest` hook で `performance.now()` を記録する。body parse、認証、レート制限、入力検証より前から計測する。
- **正常または HTTP エラー応答の終了**: Fastify の `onResponse` hook で記録する。NestJS の例外処理が 4xx / 5xx に変換した応答も対象にする。
- **クライアント切断の終了**: Fastify の `onRequestAbort` hook で記録する。
- **サーバー側 timeout の終了**: Fastify の `onTimeout` hook で記録する。
- 複数の終了 hook が同じ request で呼ばれても、最初の終端だけを採用し、1 request につき正確に 1 回記録する。

`onResponse` の終了は、サーバーがレスポンスをソケットバッファへ書き終えた時点であり、Customer の端末への到達確認ではない。この制約はクライアント側計測との責任分担で補う。

### 含める処理

- JWT 認証。
- レート制限。
- body parse と入力検証。
- NestJS Controller / Service。
- Valkey、Aurora PostgreSQL、Fake Payment API への同期アクセス。
- レスポンスのシリアライズと送信処理。

### Outcome と percentile

- SLO 用のレイテンシ percentile には、endpoint の契約どおりに技術的成功を返した request だけを含める。
- 400 / 401 などのクライアント起因 4xx と、Bot または未入場利用者に対する防御的な 429 は計測するが、SLO 用 percentile から除外する。
- Protected Zone へ正規入場した Customer への 429、5xx、サーバー側 timeout は技術的失敗とし、[ADR-0022](./0022-b2c-purchase-journey-success-sli.md) の成功率 SLI へ反映する。失敗時レイテンシは診断用に記録し、成功時 percentile には混ぜない。
- `onRequestAbort` は `client_aborted` として件数と切断までの経過時間を診断用に記録し、SLO 用 percentile には含めない。
- 429 が防御的な拒否か正規入場後の失敗かは HTTP status code だけでは判定できないため、認可・レート制限処理から計測処理へ低カーディナリティの分類を渡す。

### レイヤー間の責任分担

サーバー側レイテンシ SLI は、Amazon CloudWatch Embedded Metric Format で出力するアプリケーションメトリクスを正本とする。次の計測は同じリクエストを別レイヤーから観測する診断・補完であり、二重計測とは扱わない。

| レイヤー | 計測・監視 | 主な目的 |
| --- | --- | --- |
| NestJS / Fastify | B2C 同期 API のサーバー側レイテンシ | SLO の正本、アプリケーション処理の評価 |
| Application Load Balancer | `TargetResponseTime`、ELB / target 5xx | ターゲット手前の待ち、接続障害、502 / 504、アプリメトリクス欠落の補完 |
| Amazon CloudFront | `OriginLatency`、`5xxErrorRate` | オリジンまでの経路とエッジ側の診断 |
| Amazon CloudWatch Synthetics | CloudFront 経由の外形監視 | DNS、TLS、CDN、WAF、オリジンを含む到達性 |
| k6 | クライアント側 HTTP duration | 負荷試験時の end-to-end 応答時間とサーバー側 SLI の比較 |
| Amazon CloudWatch RUM / Core Web Vitals | 将来候補 | 実ブラウザのネットワーク時間と画面描画体験 |

同じ障害に対して各レイヤーから重複通知しないよう、アラームの severity と通知責務は可観測性設計で分ける。

### 現行 Purchase API との関係

- 現行 Purchase API は、B2C へ切り替えるまで `PurchaseRequestLatencyMs` の既存境界と p95 800ms の現役 SLO を維持する。
- B2C 同期 API は、新しい Fastify hook の境界と新しいメトリクスを使用する。既存メトリクス名と p95 800ms を流用しない。
- 新旧の計測境界は異なるため、数値を直接比較しない。

## 根拠

- Fastify の `onRequest` を開始点にすることで、認証、レート制限、body parse、入力検証を含むサーバー側処理を同じ境界で計測できる。
- `onResponse` だけでなく `onRequestAbort` と `onTimeout` を終端にすることで、遅延時に発生しやすい切断と timeout を計測漏れにしない。
- 技術的成功だけを SLO 用 percentile に含めることで、速い 4xx / 429 がレイテンシ分布を良く見せることを防ぐ。
- Application Load Balancer と Amazon CloudFront のメトリクスを残すことで、アプリケーションメトリクスが出ない障害とレイヤー間の遅延を補完できる。

## 反対材料・トレードオフ

- 現行の NestJS Interceptor と異なる Fastify 固有の計測実装が必要になる。
- `onRequestAbort` は Customer 起因の切断と、サーバー遅延に耐えられず切断した場合を単独では区別できない。
- Application Load Balancer が先に 504 を返し、ターゲットが処理を継続する場合は、サーバー側 Outcome と Customer が受け取った結果が一致しない。Application Load Balancer の 5xx 監視で補完する必要がある。
- 4 つの API を個別の分布として扱うか、ジャーニー単位で合算するかは、この ADR では決定せず、[ADR-0025](./0025-b2c-synchronous-purchase-latency-slo.md) で決定する。
- server timeout と Application Load Balancer の idle timeout の整合値は、API 実装と負荷試験条件を踏まえて別途決定する。

## 再検討のトリガー

- NestJS の HTTP adapter を Fastify 以外へ変更するとき。
- B2C の結果確認を Server-Sent Events、WebSocket、long polling へ変更するとき。
- 実測でクライアント切断または Application Load Balancer 504 とサーバー側 Outcome の不一致が多発するとき。
- Amazon CloudWatch RUM を導入し、実ブラウザ側のレイテンシを SLO の正本に含めるとき。
