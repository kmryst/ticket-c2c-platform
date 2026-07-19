# 在庫購入 PoC

## ステータス

実装済み。現行スクリプトの実行手順と、2026-06-29 の初回ローカル検証結果を記録する。

この PoC は、PostgreSQL の条件付き更新で同時購入時の在庫超過を防げるかを確認するための最小検証です。

コードを読む入口として、[在庫購入 PoC 読み解きガイド](./inventory-purchase-reading-guide.md) も参照してください。

## 対象

- JWT 認証を含む NestJS API。
- PostgreSQL。
- Valkey 前段フィルタ（PoC script は DB へ直接 seed するためカウンタ未初期化となり、現行実行では fail-open の DB 判定経路を通る）。
- `ticket_inventory.remaining_quantity` の条件付き更新。
- API 経由の並列購入検証。

k6 負荷テスト、SQS FIFO、OpenSearch はこの PoC の対象外です。Valkey による売り切れ後の前段拒否そのものは別の単体テストと dev / staging の負荷検証で扱います。

## 購入 API

```text
POST /events/:eventId/purchases
```

有効な access token を `Authorization: Bearer <token>` で付けます。購入者 ID は JWT の `sub` claim からサーバー側で決めるため、body では受け付けません。

リクエスト body 例:

```json
{
  "quantity": 1,
  "requestId": "optional-idempotency-key"
}
```

処理概要:

1. JWT を検証し、購入者 ID を `sub` claim から取得する。
2. user ID / IP の dual-key レート制限を確認する。
3. Valkey 前段フィルタを通す。カウンタ不在・障害時は DB へ fail-open する。
4. トランザクション内で再送確認と `ticket_inventory` の条件付き更新を行う。
5. 更新成功時は `purchases.status = confirmed`、更新失敗時は `rejected` と拒否理由を記録する。
6. 確定後に EventBridge 用イベントを発行する。ローカル PoC では `EVENT_BUS_NAME` 未設定のため no-op。

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

API を起動する。この PoC は既定で同じ検証ユーザーから 50 回購入を試みるため、通常運用の user ID 単位レート制限（15 分に 10 回）へ先に到達しないよう、ローカル PoC 実行時だけ上限を試行数以上へ引き上げます。

```bash
AUTH_RATE_LIMIT_PURCHASE_IP=10000 \
AUTH_RATE_LIMIT_PURCHASE_SECONDARY=10000 \
npm run start:dev
```

この上書きは、短時間に PoC を繰り返しても 15 分窓のカウンターへ先に到達しないよう十分に大きくしたローカル限定設定です。dev / staging の通常運用値は変更しません。`POC_PURCHASE_ATTEMPTS` と実行回数の積が 10000 を超える場合は、両方をそれ以上へ引き上げます。

別ターミナルで検証スクリプトを実行する。

```bash
npm run poc:inventory
```

## 検証スクリプト

`npm run poc:inventory` は次を行います。

- 検証用イベントを 1 件作成する。
- 同じイベントに初期在庫を作成する。
- signup API で検証用ユーザーを作成し、access token を取得する。
- API 経由で在庫数を超える購入リクエストを、設定した concurrency で並列送信する。
- 成功数、拒否数、API エラー数、残在庫、確定購入数、p50 / p95 / p99 レイテンシを出力する。
- 在庫超過、または API エラーがあれば終了コード `1` にする。

検証スクリプトは、実行ごとに新しいイベントと在庫を作成します。ローカル DB を作り直して検証データを消す場合は、DB データを破棄してよいことを確認してから `docker compose down -v` を使います。

環境変数:

| 変数 | 既定値 | 説明 |
| --- | ---: | --- |
| `DATABASE_URL` | 必須 | PostgreSQL 接続先 |
| `API_BASE_URL` | `http://localhost:3000` | API 接続先 |
| `POC_TOTAL_QUANTITY` | `20` | 検証イベントの総在庫 |
| `POC_PURCHASE_ATTEMPTS` | `50` | 並列購入試行数 |
| `POC_PURCHASE_CONCURRENCY` | `9` | 同時に送る購入リクエスト数 |
| `POC_PURCHASE_QUANTITY` | `1` | 1 リクエストあたりの購入枚数 |

API 側の `AUTH_RATE_LIMIT_PURCHASE_IP` / `AUTH_RATE_LIMIT_PURCHASE_SECONDARY` は、上記のとおり `POC_PURCHASE_ATTEMPTS` 以上にしてから API を起動します。これは検証スクリプト自身の環境変数ではなく、NestJS API のレート制限設定です。

受け入れ確認の観点:

- `database.confirmedQuantity <= database.totalQuantity`。
- `database.remainingQuantity >= 0`。
- `database.totalQuantity - database.remainingQuantity = database.confirmedQuantity`。
- `oversold = false`。

## 初回ローカル検証結果（歴史的記録）

実行日: 2026-06-29

この結果は認証・レート制限・Valkey 前段フィルタの現行実装より前の初回測定であり、現在の性能値として読み替えません。在庫条件付き更新の基礎検証記録として保持します。

条件:

- `POC_TOTAL_QUANTITY=20`
- `POC_PURCHASE_ATTEMPTS=50`
- `POC_PURCHASE_CONCURRENCY=9`
- `POC_PURCHASE_QUANTITY=1`

結果:

| 指標 | 値 |
| --- | ---: |
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

この検証の条件と結果の数値は、上記の条件一覧と結果テーブルを正本とします。このセクションでは、結果テーブルの読み方と後続判断への含意を整理します。

PostgreSQL の総 UPDATE 試行数は、結果テーブルの `PostgreSQL total UPDATE attempts` に示すとおり、現行 PoC では未記録です。

`oversold = false` は、在庫数を超えた確定購入が発生していないことを表します。今回の検証では、DB 上の総在庫、残在庫、確定購入枚数の関係が成立しており、在庫超過は発生していません。`POC_PURCHASE_QUANTITY=1` のため、この検証では確定購入の件数と枚数は同じ値になります。

受け入れ観点と追加確認の判定:

| 観点 | 結果 | 判定 |
| --- | ---: | --- |
| `confirmedQuantity <= totalQuantity` | 結果テーブル上で成立 | OK |
| `remainingQuantity >= 0` | 結果テーブル上で成立 | OK |
| `totalQuantity - remainingQuantity = confirmedQuantity` | 結果テーブル上で成立 | OK |
| `oversold = false` | `false` | OK |
| API エラー率（追加確認） | API エラーなし | OK |

API エラー率は、検証スクリプトの終了コード判定に基づく追加確認です。ここでの API エラーは 5xx やネットワーク障害などを指し、在庫不足による拒否応答は期待される結果として `API rejected` に集計します。

現時点で判断できること:

- PostgreSQL の条件付き更新は、今回の並列購入条件では在庫超過を防げた。
- 追加観察として、結果テーブル上の `API rejected` と `DB rejected purchases` は同じ値だった。ただし、拒否件数の一致は上記の受け入れ観点には含めていない。
- 結果テーブル上の `DB inventory version` から、在庫を減らした成功更新回数は確定購入数と一致していた。
- 結果テーブル上の p50 / p95 / p99 API レイテンシを初回基準値として残せた。

現時点では判断できないこと:

- Valkey 前段フィルタにより、売り切れ後の PostgreSQL 到達数がどれだけ減るか。
- PostgreSQL の総更新試行数、ロック待ち、クエリレイテンシ。
- より高い concurrency や購入試行数で同じ性質を維持できるか。
- 1 つの人気イベントへの集中負荷が、無関係なイベントの購入レイテンシを悪化させないか。
- 購入スパイク中の検索トラフィックへの影響。
- SQS FIFO などのイベント単位の流量制御が必要か。

次に検証する候補:

1. Valkey なしの現行経路を基準値として、PostgreSQL 到達数と API レイテンシの計測を追加する。
2. Valkey 前段フィルタを追加し、売り切れ後リクエストの拒否数と PostgreSQL 到達数を比較する。
3. k6 で負荷テストを追加し、p50 / p95 / p99、エラー率、DB 更新試行数を同じ形式で記録する。
4. 人気イベント 1 件に負荷を集中させ、同時に通常イベントへ購入リクエストを送り、影響隔離を確認する。
5. 検証結果から、購入パスに Valkey を必須化するか、SQS FIFO を追加検討するかを判断メモまたは ADR 候補として残す。
