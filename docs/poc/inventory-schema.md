# 在庫 PoC DB スキーマ

## ステータス

ドラフト。

このドキュメントは、在庫 PoC で使う最小 DB スキーマを記録するものです。本番用の完全なデータモデルではありません。

## 目的

在庫 PoC では、同時購入リクエストが集中しても在庫数を超えた購入が確定しないことを検証します。

そのため、最初のスキーマは次の 3 テーブルに絞ります。

| テーブル | 目的 |
|---|---|
| `events` | イベント本体 |
| `ticket_inventory` | イベントごとの在庫 |
| `purchases` | 購入結果 |

## `events`

イベント本体を表します。

| 列 | 型 | 説明 |
|---|---|---|
| `id` | `UUID` | イベント ID |
| `title` | `TEXT` | イベント名 |
| `event_type` | `TEXT` | イベント種別 |
| `starts_at` | `TIMESTAMPTZ` | 開催日時 |
| `location_latitude` | `NUMERIC(9, 6)` | 開催地の緯度 |
| `location_longitude` | `NUMERIC(9, 6)` | 開催地の経度 |
| `created_at` | `TIMESTAMPTZ` | 作成日時 |

緯度経度は、後続の検索 PoC で使い回せるように入れています。

## `ticket_inventory`

イベントごとの在庫を表します。

| 列 | 型 | 説明 |
|---|---|---|
| `event_id` | `UUID` | イベント ID。主キー |
| `total_quantity` | `INTEGER` | 総在庫数 |
| `remaining_quantity` | `INTEGER` | 残在庫数 |
| `version` | `INTEGER` | 更新回数。観測・楽観ロック検証用 |
| `updated_at` | `TIMESTAMPTZ` | 更新日時 |

制約:

- `total_quantity >= 0`
- `remaining_quantity >= 0`
- `remaining_quantity <= total_quantity`

在庫超過防止の正本はこのテーブルです。

## `purchases`

購入結果を表します。

| 列 | 型 | 説明 |
|---|---|---|
| `id` | `UUID` | 購入 ID |
| `event_id` | `UUID` | イベント ID |
| `buyer_id` | `UUID` | 購入者 ID |
| `request_id` | `TEXT` | リクエスト ID。冪等性検証用 |
| `quantity` | `INTEGER` | 購入枚数 |
| `status` | `purchase_status` | `confirmed` または `rejected` |
| `rejection_reason` | `TEXT` | 拒否理由 |
| `created_at` | `TIMESTAMPTZ` | 作成日時 |

`request_id` は任意ですが、指定された場合は一意にします。将来的にリトライや二重送信の検証に使います。

## 購入確定の基本クエリ

在庫の最終確定では、PostgreSQL の条件付き更新を使います。

```sql
UPDATE ticket_inventory
SET
  remaining_quantity = remaining_quantity - :quantity,
  version = version + 1,
  updated_at = now()
WHERE event_id = :event_id
  AND remaining_quantity >= :quantity;
```

更新件数が `1` の場合は購入確定、`0` の場合は在庫不足として扱います。

このクエリが、同時購入時に在庫超過を防ぐ最終ガードです。Valkey は前段で不要なリクエストを減らすために使いますが、最終的な正確性は PostgreSQL で保証します。

## 適用ファイル

スキーマ定義は次のファイルに置きます。

```text
database/schema.sql
```

ローカル PostgreSQL へ適用する場合:

```bash
docker compose exec -T postgres psql -U ticket_poc -d ticket_poc < database/schema.sql
```

