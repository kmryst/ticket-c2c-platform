# 在庫 PoC DB スキーマ

## ステータス

ドラフト。

このドキュメントは、在庫 PoC で使う最小 DB スキーマを記録するものです。本番用の完全なデータモデルではありません。

## 目的

在庫 PoC では、同時購入リクエストが集中しても在庫数を超えた購入が確定しないことを検証します。

そのため、最初のスキーマは次のテーブルに絞ります。

| テーブル | 目的 |
|---|---|
| `users` | 購入者アカウント（メール+パスワード認証。ADR-0010） |
| `events` | イベント本体 |
| `ticket_inventory` | イベントごとの在庫 |
| `purchases` | 購入結果 |

## `users`

メール+パスワード認証（ADR-0010、Issue #132）の購入者アカウントを表します。

| 列 | 型 | 説明 |
|---|---|---|
| `id` | `UUID` | ユーザー ID。JWT の `sub` claim に入る値 |
| `email` | `TEXT` | ログイン ID。`lower(email)` の unique index で一意 |
| `password_hash` | `TEXT` | bcrypt（コストファクター 12）のハッシュ。平文は保存しない |
| `created_at` | `TIMESTAMPTZ` | 作成日時 |
| `updated_at` | `TIMESTAMPTZ` | 更新日時 |

`purchases.buyer_id -> users.id` の FK は、購入 API の認証必須化（Issue #135）で追加済みです。認証導入前のローカル DB に残る過去データを壊さないよう、FK は `NOT VALID`（既存 row は未検査、新規書き込みには強制）で付与しています。

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
| `buyer_id` | `UUID` | 購入者 ID。`users.id` への FK（`NOT VALID`）。JWT の `sub` claim 由来 |
| `request_id` | `TEXT` | リクエスト ID。冪等性検証用 |
| `quantity` | `INTEGER` | 購入枚数 |
| `status` | `purchase_status` | `confirmed` または `rejected` |
| `rejection_reason` | `TEXT` | 拒否理由 |
| `remaining_quantity_after` | `INTEGER` | 確定購入後の残在庫。拒否時は `NULL` |
| `created_at` | `TIMESTAMPTZ` | 作成日時 |

`request_id` は任意ですが、同じ購入者・同じイベントの確定購入（`confirmed`）では一意にします。拒否された購入（`rejected`）は同じ購入者・同じイベント・同じ `request_id` で重複記録しないようにしつつ、在庫補充後に確定購入として再試行できるようにします。将来的にリトライや二重送信の検証に使います。

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
