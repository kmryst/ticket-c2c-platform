# 在庫購入 PoC

## ステータス

初期実装。初回ローカル検証結果を整理済み。

この PoC は、PostgreSQL の条件付き更新で同時購入時の在庫超過を防げるかを確認するための最小検証です。

コードを読む入口として、[在庫購入 PoC 読み解きガイド](./inventory-purchase-reading-guide.md) も参照してください。

## 対象

- NestJS API。
- PostgreSQL。
- `ticket_inventory.remaining_quantity` の条件付き更新。
- API 経由の並列購入検証。

Valkey 前段フィルタ、k6 負荷テスト、SQS FIFO、OpenSearch は現行 PoC では対象外です。

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

`requestId` は任意です。指定した場合、同じ購入者・同じイベントの確定購入（`confirmed`）では `purchases_request_id_uq` により一意になります。同じ buyer / event / requestId の確定済み購入を再試行した場合は、元の確定結果を返します。拒否された購入（`rejected`）は同じ buyer / event / requestId で重複記録しないようにしつつ、在庫補充後に確定購入として再試行できます。省略した場合は冪等性チェックを行いません。

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
- API 経由で在庫数を超える購入リクエストを、設定した concurrency で並列送信する。
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
| `POC_PURCHASE_CONCURRENCY` | `9` | 同時に送る購入リクエスト数 |
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
- `POC_PURCHASE_CONCURRENCY=9`
- `POC_PURCHASE_QUANTITY=1`

結果:

| 指標 | 値 |
|---|---:|
| API concurrency | 9 |
| API confirmed | 20 |
| API rejected | 30 |
| API errors | 0 |
| DB total quantity | 20 |
| DB remaining quantity | 0 |
| DB confirmed purchases | 20 |
| DB confirmed quantity | 20 |
| DB rejected purchases | 30 |
| DB inventory version | 20 |
| PostgreSQL total UPDATE attempts | 未記録 |
| p50 latency | 11.23 ms |
| p95 latency | 54.41 ms |
| p99 latency | 72.68 ms |
| oversold | false |

`DB inventory version` は在庫を減らした成功 UPDATE 回数を表します。成功と失敗を合算した PostgreSQL の総 UPDATE 試行数は、現行 PoC では DB レイヤーの計装が未実装のため未記録です。

## 初回結果の整理

この検証では、在庫 `20` に対して購入リクエスト `50` 件を concurrency `9` で送信しました。結果として、確定購入は `20` 件、拒否は `30` 件、API エラーは `0` 件でした。

`oversold = false` は、在庫数を超えた確定購入が発生していないことを表します。今回の検証では、DB 上の総在庫 `20`、残在庫 `0`、確定購入 `20` 件（`20` 枚）であり、在庫超過は発生していません。`POC_PURCHASE_QUANTITY=1` のため、この検証では確定購入の件数と枚数は同じ値になります。

受け入れ観点と追加確認の判定:

| 観点 | 結果 | 判定 |
|---|---:|---|
| `confirmedQuantity <= totalQuantity` | `20 <= 20` | OK |
| `remainingQuantity >= 0` | `0 >= 0` | OK |
| `totalQuantity - remainingQuantity = confirmedQuantity` | `20 - 0 = 20` | OK |
| `oversold = false` | `false` | OK |
| API エラー率（追加確認） | `0 / 50 = 0%` | OK |

API エラー率は、検証スクリプトの終了コード判定に基づく追加確認です。ここでの API エラーは 5xx やネットワーク障害などを指し、在庫不足による拒否応答は期待される結果として `API rejected` に集計します。

現時点で判断できること:

- PostgreSQL の条件付き更新は、今回の並列購入条件では在庫超過を防げた。
- `purchases` には確定と拒否の結果が記録され、DB の最終状態と整合していた。
- `ticket_inventory.version = 20` であり、在庫を減らした成功更新回数は確定購入数と一致していた。
- `p50 = 11.23 ms`、`p95 = 54.41 ms`、`p99 = 72.68 ms` の API レイテンシを初回基準値として残せた。

現時点では判断できないこと:

- Valkey 前段フィルタにより、売り切れ後の PostgreSQL 到達数がどれだけ減るか。
- PostgreSQL の総更新試行数、ロック待ち、クエリレイテンシ。
- より高い concurrency や購入試行数で同じ性質を維持できるか。
- 1 つの人気イベントへの集中負荷が、無関係なイベントの購入レイテンシを悪化させないか。
- 購入スパイク中の検索トラフィックへの影響。
- SQS FIFO などのイベント単位の流量制御が必要か。

次に検証する候補:

1. Valkey なしの現行経路を基準値として、PostgreSQL 到達数と API レイテンシを継続測定する。
2. Valkey 前段フィルタを追加し、売り切れ後リクエストの拒否数と PostgreSQL 到達数を比較する。
3. k6 で負荷テストを追加し、p50 / p95 / p99、エラー率、DB 更新試行数を同じ形式で記録する。
4. 人気イベント 1 件に負荷を集中させ、同時に通常イベントへ購入リクエストを送り、影響隔離を確認する。
5. 検証結果から、購入パスに Valkey を必須化するか、SQS FIFO を追加検討するかを判断メモまたは ADR 候補として残す。
