# 在庫 PoC DB スキーマ

## ステータス

実装済み。実際のローカル DB 定義は `database/schema.sql` を正本とし、この文書は構造、制約、writer mode を説明する。

Issue #336 の expand schema に、Issue #376 の PostgreSQL compatibility writer を追加済みである。共有 control state の初期値は `legacy` であり、artifact の merge、deploy、migration 適用だけでは在庫正本、既存 API 応答、active read / write pathを切り替えない。設計判断は [ADR-0028](../adr/0028-use-db-trigger-bridge-for-ticket-type-expand.md) と [ADR-0029](../adr/0029-use-control-aware-postgresql-compatibility-writer.md) に記録する。

このスキーマは在庫 PoC と Ticket Type 移行用であり、完成形の Purchase Session / Ticket Hold データモデルではない。

## 目的

同時購入が集中しても在庫数を超えた購入を確定せず、legacy Event 在庫から Ticket Type 在庫へ rollback 可能な段階移行を行う。

| テーブル | 目的 |
| --- | --- |
| `users` | 購入者アカウント |
| `refresh_tokens` | refresh token の hash、系譜、失効状態 |
| `events` | イベント本体 |
| `ticket_types` | Event 内の販売 Ticket Type |
| `ticket_inventory` | `legacy` の正本、`ticket_type` の Event 互換集計 |
| `ticket_type_inventory` | `legacy` の shadow、`ticket_type` の正本 |
| `inventory_writer_control` | DB 共有の active writer mode |
| `purchases` | confirmed / rejected の購入結果と冪等性payload |

## 認証と Event のテーブル

### `users`

| 列 | 型 | 説明 |
| --- | --- | --- |
| `id` | `UUID` | ユーザー ID。JWT の `sub` |
| `email` | `TEXT` | `lower(email)` の unique index で一意 |
| `password_hash` | `TEXT` | bcrypt hash。平文は保存しない |
| `created_at` | `TIMESTAMPTZ` | 作成日時 |
| `updated_at` | `TIMESTAMPTZ` | 更新日時 |

`purchases.buyer_id -> users.id` は、新規書き込みには強制する `NOT VALID` FK である。認証導入前のローカル既存 row を検査対象外にするためである。

### `refresh_tokens`

生 token は保存せず、SHA-256 hash、`family_id`、親子関係、使用・失効時刻、調査用 IP / User-Agent を保存する。`token_hash` は一意、`family_id` と `user_id` は検索 index を持つ。

### `events`

| 列 | 型 | 説明 |
| --- | --- | --- |
| `id` | `UUID` | イベント ID |
| `title` | `TEXT` | イベント名 |
| `event_type` | `TEXT` | イベント種別 |
| `starts_at` | `TIMESTAMPTZ` | 開催日時 |
| `location_latitude` | `NUMERIC(9, 6)` | 緯度 |
| `location_longitude` | `NUMERIC(9, 6)` | 経度 |
| `created_by` | `UUID` | `users.id` への `NOT VALID` FK |
| `created_at` | `TIMESTAMPTZ` | 作成日時 |

## Ticket Type と在庫

### `ticket_types`

| 列 | 型 | 説明 |
| --- | --- | --- |
| `id` | `UUID` | Ticket Type ID。主キー |
| `event_id` | `UUID` | 所有 Event。削除時は cascade |
| `name` | `TEXT` | 表示名。空文字と前後空白を禁止 |
| `is_default` | `BOOLEAN` | 既定 Type か |
| `created_at` | `TIMESTAMPTZ` | 作成日時 |
| `updated_at` | `TIMESTAMPTZ` | 更新日時 |

DB は次を強制する。

- `(event_id, lower(name))` を一意にし、大文字小文字だけが異なる名前も重複させない。
- `is_default` の partial unique index により、既定 Type を Event ごとに最大1件にする。
- `(event_id, id)` を一意にし、在庫と Purchase の複合 FK が別 Event の Type を参照できないようにする。

既定 Type の最低1件は、#336 の backfill、Event 作成 trigger、readiness 検査で保証する。

### `inventory_writer_control`

| 列 | 型 | 説明 |
| --- | --- | --- |
| `singleton` | `BOOLEAN` | `true` だけを許す主キー |
| `writer_mode` | `TEXT` | `legacy` または `ticket_type` |
| `updated_at` | `TIMESTAMPTZ` | mode 更新日時 |

row は正確に1件で、初期値は `legacy` である。application writer は shared barrier の取得後にこの row を読む。Issue #376 は切替可能な artifact までを所有し、exclusive barrier、preflight、実環境 activation / rollback は Issue #378 が所有する。fresh session の final cleanup に限り、切替の所有は final cleanup transaction へ移管する（[ADR-0033](../adr/0033-ticket-type-migration-irreversible-boundaries.md)）。

### `ticket_inventory`

| 列 | 型 | 説明 |
| --- | --- | --- |
| `event_id` | `UUID` | Event ID。主キー |
| `total_quantity` | `INTEGER` | Event の総数または互換合計 |
| `remaining_quantity` | `INTEGER` | Event の残数または互換合計 |
| `version` | `INTEGER` | active legacy 更新、または互換集計更新の単調増加値 |
| `updated_at` | `TIMESTAMPTZ` | 更新日時 |

### `ticket_type_inventory`

| 列 | 型 | 説明 |
| --- | --- | --- |
| `ticket_type_id` | `UUID` | Ticket Type ID。主キー |
| `event_id` | `UUID` | 所有 Event ID |
| `total_quantity` | `INTEGER` | Type 総在庫 |
| `remaining_quantity` | `INTEGER` | Type 残在庫 |
| `version` | `INTEGER` | active Type の条件付き更新ごとに増える値 |
| `updated_at` | `TIMESTAMPTZ` | 更新日時 |

両在庫 table は `total >= 0`、`remaining >= 0`、`remaining <= total`、`version >= 0` を強制する。`ticket_type_inventory` の `(event_id, ticket_type_id)` は同じ Event の `ticket_types(event_id, id)` だけを参照できる。

mode ごとの役割は次のとおりである。

| Mode | active writer / 正本 | transaction 内 mirror | 非 active 側への直接 write |
| --- | --- | --- | --- |
| `legacy` | `ticket_inventory` | 正確に1件の既定 `ticket_type_inventory` へ同値同期 | Ticket Type 側を拒否 |
| `ticket_type` | `ticket_type_inventory` | Type の `SUM(total_quantity)` / `SUM(remaining_quantity)` を `ticket_inventory` へ集約 | legacy 側を拒否 |

`ticket_type` mode の legacy `version` は Event 互換集計の更新回数であり、個々の Type version と同値である必要はない。Type version は各 active row の条件付き更新 transaction が採番し、更新後残数と同じ `RETURNING` で取得する。version 付き event contract と projection は Issue #377 が所有する。

inactive側の条件付き`UPDATE`は、対象rowが0件でもstatement fenceがmode不一致として拒否する。inventory rowの直接`DELETE` / `TRUNCATE`はactive / inactiveを問わず拒否し、Event親rowの削除に伴う外部キーcascadeだけを許可する。

## `purchases` と冪等性

| 列 | 型 | 説明 |
| --- | --- | --- |
| `id` | `UUID` | Purchase ID |
| `event_id` | `UUID` | Event ID |
| `ticket_type_id` | `UUID` | 同じ Event の Ticket Type ID |
| `buyer_id` | `UUID` | JWT `sub` 由来の購入者 |
| `request_id` | `TEXT` | 任意の冪等性key |
| `quantity` | `INTEGER` | 要求枚数 |
| `status` | `purchase_status` | `confirmed` または `rejected` |
| `rejection_reason` | `TEXT` | rejected の理由 |
| `remaining_quantity_after` | `INTEGER` | confirmed 直後のEvent互換残数 snapshot |
| `created_at` | `TIMESTAMPTZ` | 作成日時 |

`purchases_event_ticket_type_fkey` は `(event_id, ticket_type_id)` を検証済み複合 FK とし、別 Event の Type を DB でも拒否する。

`request_id IS NOT NULL` の row は `(buyer_id, event_id, request_id)` を status 横断で一意にする。冪等性payloadは `ticket_type_id + quantity` である。

- 同じ key / 同じ payload は、元の confirmed または rejected row を返し、在庫を再更新しない。
- 同じ key で Type または数量が異なる場合は、在庫更新前に HTTP 409 とする。
- request-key advisory lock は payload を含めず、異なるpayloadも同じlockで直列化する。
- migration は既存の confirmed / rejected 横断重複を index 変更前に検出し、削除・統合せず全体を rollback する。
- `request_id = NULL` は冪等性対象外である。

requestId付きrequestは、Valkeyが`sold_out`を返してもPostgreSQLへ進み、authoritativeなconfirmed / rejected rowを永続化する。同じpayloadはそのrowをreplayし、異なるpayloadは409となる。requestIdなしだけはValkeyで早期拒否できる。Ticket Type単位のValkey処理はIssue #389が所有する。

公開 Purchase API で Ticket Type を指定する contract は Issue #379 が所有する。#376 の内部 writerは、Type指定を省略した場合に Event の Type が正確に1件のときだけ解決する。複数 Type の作成・選択を公開APIへ出してはいけない。

## Writer barrier と mirror

control-aware transaction は次の順序を守る。

1. `pg_advisory_xact_lock_shared(335, 376)`
2. `requestId` があれば buyer + Event + requestId から導出した transaction advisory lock
3. `inventory_writer_control` を含む最初の table access

request lock の hash collision は無関係なrequestを余分に直列化するだけで、安全性を弱めない。Issue #378 の mode transition は同じ固定 key の exclusive barrierを取得する。

DB trigger は transaction-local `ticket_c2c.inventory_mirror_origin` と `pg_trigger_depth()` を併用する。GUCだけをclientが設定してもinactive側のtop-level writeを偽装できない。

- inventory statement fence: inactive側の`UPDATE`を対象row数に関係なくstatement開始時に拒否する。
- `inventory_compatibility_guard_legacy_write_trg`: legacy の直接 write または Ticket Type 由来のnested mirrorだけを許可する。
- `inventory_compatibility_guard_ticket_type_write_trg`: Ticket Type の直接 writeまたはlegacy由来mirrorを許可し、reverse mirrorから#336 bridgeへのbounceをskipする。
- `inventory_compatibility_sync_ticket_type_to_legacy_trg`: Type合計をlegacy互換rowへ反映する。
- inventory delete guard: 直接`DELETE` / `TRUNCATE`を拒否し、Event親rowからの外部キーcascadeだけを許可する。

reverse mirror は `ticket_inventory` の Event row を `FOR UPDATE` でmutexにしてからfresh statement snapshotでType合計を読み直す。異なるTypeが並行更新されても、lock待ち前の古い合計で後勝ち上書きしない。

## Event API の互換境界

Event作成もinventory writerである。transactionはshared barrierとmodeを読み、`legacy`では従来どおりlegacy在庫を作り、`ticket_type`ではEvent triggerが作った既定Typeの在庫を作る。mirrorがもう一方を同じtransactionで補完する。

Event一覧とOpenSearch未設定時のDB fallbackは、既存どおり `ticket_inventory` を読む。`ticket_type` modeではこのrowがType合計の互換projectionになるため、top-level `totalQuantity` / `remainingQuantity` のAPI形状とread pathはdeployだけでは変わらない。

既存Purchase responseと既存`TicketPurchased` / `InventoryChanged` eventの`remainingQuantity`も、選択Typeの残数ではなく`ticket_inventory`のEvent互換集計を使う。transactionが取得したType単位の`ticketTypeId`、remaining、versionは内部値として保持し、Type単位responseはIssue #379、version付きevent contractはIssue #377で公開する。

## Migration、readiness、rollback

Issue #336 migration は backfill と次の既存 bridge を1 transactionで導入した。

- Event作成後に既定 `General Admission` を作る。
- legacy在庫を既定Type shadowへ同期する。
- 旧 Purchase writerが省略した `ticket_type_id` を既定Typeで補完する。

Issue #376 migration は exclusive barrierとrelation lockを取得し、次を原子的に行う。

- expand readinessとstatus横断request key重複のpreflight
- 初期 `legacy` control row
- status横断 unique index
- 0件更新も止めるinactive-side statement fence
- direct inventory `DELETE` / `TRUNCATE` guardとEvent親削除のcascade例外
- row guardとTicket Typeからlegacyへのaggregate mirror

Issue #336 readiness checkerは引き続き初期 `legacy` の16カテゴリを検査する。

```bash
npm run migration:check:ticket-type-expand
npm run migration:check:ticket-type-expand:prod
```

親Issue #335のGate Aはdev / stagingのmanual workflow、migration前後件数、旧binary live write、rollback判断を証跡化する。PR mergeは環境適用やactivationを意味しない。

Issue #376 downはmodeが`legacy`で、各Eventが正確に1件の既定Typeだけを持ち、legacy/default在庫が全列一致し、全PurchaseがそのTypeを参照するときだけ許可する。`ticket_type` modeや複数Type dataをlegacyへ表現できない場合はDDL前に停止する。activation後はIssue #378のcontrolled rollbackを先に使い、losslessに戻せなければforward fixまたはbackup/restoreとする。

## 購入確定クエリ

`legacy` mode:

```sql
UPDATE ticket_inventory
SET remaining_quantity = remaining_quantity - :quantity,
    version = version + 1,
    updated_at = now()
WHERE event_id = :event_id
  AND remaining_quantity >= :quantity
RETURNING remaining_quantity, version;
```

`ticket_type` mode:

```sql
UPDATE ticket_type_inventory
SET remaining_quantity = remaining_quantity - :quantity,
    version = version + 1,
    updated_at = now()
WHERE event_id = :event_id
  AND ticket_type_id = :ticket_type_id
  AND remaining_quantity >= :quantity
RETURNING remaining_quantity, version;
```

更新件数1件だけをconfirmedとする。PostgreSQL row lockと条件再評価が過剰販売を防ぐ最終ガードであり、Valkeyは正本ではない。

## 適用と検証

```bash
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U ticket_poc -d ticket_poc < database/schema.sql

npm run test:migration:ticket-type-expand
npm run test:migration:ticket-type-compatibility
```
