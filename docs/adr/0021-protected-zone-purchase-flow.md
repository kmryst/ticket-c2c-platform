# 0021. Protected Zone の購入フローに Purchase Session と Ticket Hold を採用する

## ステータス

Accepted

## 日付

2026-07-16

## 背景

現行実装は `POST /events/:eventId/purchases` の 1 request で在庫更新と購入確定を行う。この方式は在庫正確性の PoC には適するが、Waiting Room から入場した Customer が数量または座席を選択し、在庫を一時確保し、外部決済を経て購入結果を確認する時間と複数段階の負荷を表現できない。

Protected Zone Access Token を Ticket Hold 作成時だけ使う方式では、将来の Reserved Seating で Hold 前に必要になるリアルタイム空席確認を保護しにくい。実際の Payment Service Provider を導入すると PCI DSS、Webhook、返金、個人情報の範囲まで広がる一方、決済依存の遅延や不明状態は信頼性検証に必要である。

## 決定

Waiting Room を通過した Customer へ 60 秒有効な Protected Zone Access Token を発行し、その Token を 1 つの Purchase Session へ交換する。Purchase Session では最大 5 分間の選択時間を提供し、1 Customer / 1 Event につき 1 つの Ticket Hold を作成できる。

Ticket Hold は作成から 5 分間、1 Event の複数明細を合計 4 枚まで全件単位で確保する。Customer による延長は許可しない。購入確定は同期処理とし、1 Ticket Hold から最大 1 Purchase、1 Customer / 1 Event につき最大 1 Purchase を作成する。

local / staging には決定的な応答を返す Fake Payment API を独立サービスとして置き、staging では Amazon ECS Service Connect で NestJS API から内部接続する。production には Fake Payment API を配置しない。timeout などで決済結果が不明な場合は `payment_unknown` として在庫を隔離し、決済結果確認 Worker（Payment Reconciliation Worker）が結果を突き合わせる。

現在の同期 Purchase API は、目標フローを段階的に実装して置き換えるまで維持する。具体的な DB schema、API contract、Worker の deploy 単位は後続 Issue で決定する。

## 根拠

- Access Token、Purchase Session、Ticket Hold、Purchase の責務と有効期限を分離できる。
- General Admission の数量在庫を維持しつつ、将来の Reserved Seating の空席確認と個別座席確保を追加できる。
- 1 Customer の複数 API request、操作待ち、キャンセル、期限切れ、決済障害を k6 で再現できる。
- Fake Payment API により、実カード情報を扱わず、timeout、5xx、決済拒否、再送、結果不明を検証できる。
- Ticket Hold Expiry と決済結果確認（Payment Reconciliation）を、Search Projection Worker とは別の責務として監視できる。

## 反対材料・トレードオフ

- API、DB table、状態遷移、Worker、metric、alarm、runbook が増える。
- Purchase Session と Ticket Hold の最大時間により、Protected Zone の最大同時利用者数と必要容量が増える。
- Fake Payment API は実際の Payment Service Provider の SLA、Webhook、取消、返金を保証しない。
- Amazon ECS Service Connect の導入は、既存 ECS module、task resource、CloudWatch metrics、Security Group の変更を伴う。
- `payment_unknown` では在庫を安全側に隔離するため、障害中の販売可能数が減る。

## 再検討のトリガー

- staging full で Purchase Session と Ticket Hold を含む同期フローが SLO を満たさないとき。
- Ticket Hold Expiry の Aurora 定期検索が DB 負荷または在庫復帰 SLO を満たせないとき。
- 実際の Payment Service Provider と契約し、その API、SLA、Webhook、取消、返金の要件が確定したとき。
- Reserved Seating の座席表、座席属性、隣接席、価格帯を具体化するとき。
- Worker を同じ process / Amazon ECS Service に置くことで、障害隔離または scaling に問題が出たとき。
