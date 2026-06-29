# 在庫購入 PoC

## ステータス

初期実装。

この PoC は、PostgreSQL の条件付き更新で同時購入時の在庫超過を防げるかを確認するための最小検証です。

## 対象

- NestJS API。
- PostgreSQL。
- `ticket_inventory.remaining_quantity` の条件付き更新。
- API 経由の並列購入検証。

Valkey 前段フィルタ、k6 負荷テスト、SQS FIFO、OpenSearch はこの Issue では対象外です。

## 購入 API

```text
POST /events/:eventId/purchases
```

リクエスト例:

```json
{
  "buyerId": "00000000-0000-4000-8000-000000000001",
  "quantity": 1,
  "requestId": "optional-idempotency-key"
}
```

処理概要:

1. イベントの存在を確認する。
2. トランザクション内で `ticket_inventory` を条件付き更新する。
3. 更新成功時は `purchases.status = confirmed` を記録する。
4. 更新失敗時は `purchases.status = rejected` と `insufficient_inventory` を記録する。

`requestId` は任意です。指定した場合、同じ購入者の確定購入（`confirmed`）では `purchases_request_id_uq` により一意になります。同じ buyer / event / requestId の確定済み購入を再試行した場合は、元の確定結果を返します。拒否された購入（`rejected`）の `requestId` は同じ値を再利用できるため、在庫補充後の再試行を妨げません。省略した場合は冪等性チェックを行いません。

在庫更新の最終ガード:

```sql
UPDATE ticket_inventory
SET
  remaining_quantity = remaining_quantity - :quantity,
  version = version + 1,
  updated_at = now()
WHERE event_id = :event_id
  AND remaining_quantity >= :quantity;
```

## ローカル実行手順

依存関係をインストールする。

```bash
npm install
```

ローカル環境変数ファイルを作成する。

```bash
cp .env.example .env
```

PostgreSQL を起動する。

```bash
docker compose up -d
docker compose ps
```

スキーマを適用する。

```bash
docker compose exec -T postgres psql -U ticket_poc -d ticket_poc < database/schema.sql
```

API を起動する。

```bash
npm run start:dev
```

別ターミナルで検証スクリプトを実行する。

```bash
npm run poc:inventory
```

## 検証スクリプト

`npm run poc:inventory` は次を行います。

- 検証用イベントを 1 件作成する。
- 同じイベントに初期在庫を作成する。
- API 経由で在庫数を超える購入リクエストを並列送信する。
- 成功数、拒否数、API エラー数、残在庫、確定購入数、p50 / p95 / p99 レイテンシを出力する。
- 在庫超過、または API エラーがあれば終了コード `1` にする。

検証スクリプトは、実行ごとに新しいイベントと在庫を作成します。ローカル DB を作り直して検証データを消す場合は、DB データを破棄してよいことを確認してから `docker compose down -v` を使います。

環境変数:

| 変数 | 既定値 | 説明 |
|---|---:|---|
| `DATABASE_URL` | 必須 | PostgreSQL 接続先 |
| `API_BASE_URL` | `http://localhost:3000` | API 接続先 |
| `POC_TOTAL_QUANTITY` | `20` | 検証イベントの総在庫 |
| `POC_PURCHASE_ATTEMPTS` | `50` | 並列購入試行数 |
| `POC_PURCHASE_QUANTITY` | `1` | 1 リクエストあたりの購入枚数 |

受け入れ確認の観点:

- `database.confirmedQuantity <= database.totalQuantity`。
- `database.remainingQuantity >= 0`。
- `database.totalQuantity - database.remainingQuantity = database.confirmedQuantity`。
- `oversold = false`。

## 初回ローカル検証結果

実行日: 2026-06-29

条件:

- `POC_TOTAL_QUANTITY=20`
- `POC_PURCHASE_ATTEMPTS=50`
- `POC_PURCHASE_QUANTITY=1`

結果:

| 指標 | 値 |
|---|---:|
| API confirmed | 20 |
| API rejected | 30 |
| API errors | 0 |
| DB total quantity | 20 |
| DB remaining quantity | 0 |
| DB confirmed purchases | 20 |
| DB confirmed quantity | 20 |
| DB rejected purchases | 30 |
| DB inventory version | 20 |
| p50 latency | 154.58 ms |
| p95 latency | 170.86 ms |
| p99 latency | 174.41 ms |
| oversold | false |
