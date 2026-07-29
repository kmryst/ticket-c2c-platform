# 在庫 PoC DB スキーマ

## ステータス

実装済み。実際のローカル DB 定義は `database/schema.sql` を正本とし、このドキュメントはその構造と制約を説明する。

Issue #336 の expand 段階では、現行の Event 単位 `ticket_inventory` を在庫の正本として維持し、Ticket Type 単位の table と関連を後方互換に追加しています。`ticket_type_inventory` は移行用の shadow であり、Issue #337 の内部切替が完了するまで独立した在庫正本として更新しません。

このドキュメントは、在庫 PoC と Ticket Type 移行で使う DB スキーマを記録するものです。本番用の完全な Purchase Session / Ticket Hold データモデルではありません。expand 段階の設計判断は [ADR-0028](../adr/0028-use-db-trigger-bridge-for-ticket-type-expand.md) に記録します。

## 目的

在庫 PoC では、同時購入リクエストが集中しても在庫数を超えた購入が確定しないことを検証します。

そのため、最初のスキーマは次のテーブルに絞ります。

| テーブル | 目的 |
| --- | --- |
| `users` | 購入者アカウント（メール+パスワード認証。ADR-0010） |
| `refresh_tokens` | opaque リフレッシュトークンの hash・ローテーション系譜・失効状態（ADR-0012） |
| `events` | イベント本体 |
| `ticket_inventory` | イベントごとの legacy 在庫。expand 段階の正本 |
| `ticket_types` | Event 内の販売 Ticket Type |
| `ticket_type_inventory` | Ticket Type ごとの数量在庫。expand 段階では同期 shadow |
| `purchases` | 購入結果 |

## `users`

メール+パスワード認証（ADR-0010、Issue #132）の購入者アカウントを表します。

| 列 | 型 | 説明 |
| --- | --- | --- |
| `id` | `UUID` | ユーザー ID。JWT の `sub` claim に入る値 |
| `email` | `TEXT` | ログイン ID。`lower(email)` の unique index で一意 |
| `password_hash` | `TEXT` | bcrypt（コストファクター 12）のハッシュ。平文は保存しない |
| `created_at` | `TIMESTAMPTZ` | 作成日時 |
| `updated_at` | `TIMESTAMPTZ` | 更新日時 |

`purchases.buyer_id -> users.id` の FK は、購入 API の認証必須化（Issue #135）で追加済みです。認証導入前のローカル DB に残る過去データを壊さないよう、FK は `NOT VALID`（既存 row は未検査、新規書き込みには強制）で付与しています。

## `refresh_tokens`

リフレッシュトークンは生値を保存せず、SHA-256 hash とローテーション系譜を保存します。

| 列 | 型 | 説明 |
| --- | --- | --- |
| `id` | `UUID` | トークン row の主キー |
| `user_id` | `UUID` | `users.id` への FK。ユーザー削除時は cascade |
| `family_id` | `UUID` | login / signup から始まるトークンファミリーの失効単位 |
| `token_hash` | `TEXT` | opaque トークンの SHA-256 hash。unique index 付き |
| `parent_token_id` | `UUID` | rotate 元の `refresh_tokens.id` |
| `replaced_by_token_id` | `UUID` | rotate 後の `refresh_tokens.id` |
| `issued_at` | `TIMESTAMPTZ` | 発行日時 |
| `expires_at` | `TIMESTAMPTZ` | 絶対有効期限 |
| `used_at` | `TIMESTAMPTZ` | rotate-on-use で消費した日時 |
| `revoked_at` | `TIMESTAMPTZ` | logout / reuse detection で失効した日時 |
| `revoked_reason` | `TEXT` | 失効理由 |
| `created_ip` | `TEXT` | 発行元 IP。調査用 |
| `created_user_agent` | `TEXT` | 発行元 User-Agent。調査用 |

`family_id` は reuse detection / logout のファミリー一括失効、`user_id` はユーザー単位の調査に使うため、それぞれ index を持ちます。

## `events`

イベント本体を表します。

| 列 | 型 | 説明 |
| --- | --- | --- |
| `id` | `UUID` | イベント ID |
| `title` | `TEXT` | イベント名 |
| `event_type` | `TEXT` | イベント種別 |
| `starts_at` | `TIMESTAMPTZ` | 開催日時 |
| `location_latitude` | `NUMERIC(9, 6)` | 開催地の緯度 |
| `location_longitude` | `NUMERIC(9, 6)` | 開催地の経度 |
| `created_by` | `UUID` | イベント作成者。`users.id` への FK（`NOT VALID`）。JWT の `sub` claim 由来 |
| `created_at` | `TIMESTAMPTZ` | 作成日時 |

緯度経度は、後続の検索 PoC で使い回せるように入れています。

## `ticket_types`

Event 内の販売 Ticket Type を表します。初期実装は General Admission（自由席）の数量在庫だけを扱います。

| 列 | 型 | 説明 |
| --- | --- | --- |
| `id` | `UUID` | Ticket Type ID。独立した主キー |
| `event_id` | `UUID` | 所有する `events.id` への FK。Event 削除時は cascade |
| `name` | `TEXT` | 表示名。空文字列と前後の空白を禁止 |
| `is_default` | `BOOLEAN` | 既定 Ticket Type かどうか |
| `created_at` | `TIMESTAMPTZ` | 作成日時 |
| `updated_at` | `TIMESTAMPTZ` | 更新日時 |

一意性と参照整合性は次のように分けて保証します。

- `ticket_types_event_normalized_name_uq` は `(event_id, lower(name))` を一意にし、同じ Event 内の `VIP` と `vip` のような重複を禁止する。
- `ticket_types_one_default_per_event_uq` は `is_default = true` の row に限定した partial unique index で、Event ごとの既定 Type を最大1件にする。
- `ticket_types_event_id_id_key` は `(event_id, id)` を一意にし、在庫と Purchase が「存在する Ticket Type」だけでなく「同じ Event に属する Ticket Type」を参照できるようにする。

`id` は単独でも主キーですが、PostgreSQL の複合外部キー `(event_id, ticket_type_id)` の参照先には、同じ列構成の通常の unique 制約が必要です。そのため `(event_id, id)` の unique 制約を明示します。

partial unique index が保証するのは既定 Type が「最大1件」であることです。「最低1件」は、既存 Event の backfill、Event 作成 trigger、cutover 前の fail-closed checker により保証します。

## `ticket_inventory`

イベントごとの legacy 在庫を表します。

| 列 | 型 | 説明 |
| --- | --- | --- |
| `event_id` | `UUID` | イベント ID。主キー |
| `total_quantity` | `INTEGER` | 総在庫数 |
| `remaining_quantity` | `INTEGER` | 残在庫数 |
| `version` | `INTEGER` | 更新回数。観測・楽観ロック検証用 |
| `updated_at` | `TIMESTAMPTZ` | 更新日時 |

制約:

- `total_quantity >= 0`
- `remaining_quantity >= 0`
- `remaining_quantity <= total_quantity`

Issue #336 の expand 段階では、在庫超過防止の正本は引き続きこのテーブルです。現行 backend の PostgreSQL 条件付き更新は変更せず、その結果を DB trigger で `ticket_type_inventory` へ同期します。

## `ticket_type_inventory`

Ticket Type ごとの General Admission 数量在庫を表します。Issue #336 では legacy 在庫から同期する shadow であり、Issue #337 の controlled activation より前に独立更新しません。

| 列 | 型 | 説明 |
| --- | --- | --- |
| `ticket_type_id` | `UUID` | Ticket Type ID。主キー |
| `event_id` | `UUID` | Ticket Type を所有する Event ID |
| `total_quantity` | `INTEGER` | 総在庫数 |
| `remaining_quantity` | `INTEGER` | 残在庫数 |
| `version` | `INTEGER` | 更新回数。legacy 在庫の値を引き継ぐ |
| `updated_at` | `TIMESTAMPTZ` | legacy 在庫の更新日時を引き継ぐ |

数量には `ticket_inventory` と同じ制約を適用します。

- `total_quantity >= 0`
- `remaining_quantity >= 0`
- `remaining_quantity <= total_quantity`
- `version >= 0`

複合外部キー
`(event_id, ticket_type_id) -> ticket_types(event_id, id)` により、別 Event の Ticket Type 在庫を作れません。Ticket Type 削除時は対応する在庫を cascade で削除します。`event_id` からの照合用 index も持ちます。

## `purchases`

購入結果を表します。

| 列 | 型 | 説明 |
| --- | --- | --- |
| `id` | `UUID` | 購入 ID |
| `event_id` | `UUID` | イベント ID |
| `ticket_type_id` | `UUID` | 購入対象 Ticket Type ID。同じ Event の `ticket_types` への複合 FK |
| `buyer_id` | `UUID` | 購入者 ID。`users.id` への FK（`NOT VALID`）。JWT の `sub` claim 由来 |
| `request_id` | `TEXT` | リクエスト ID。冪等性検証用 |
| `quantity` | `INTEGER` | 購入枚数 |
| `status` | `purchase_status` | `confirmed` または `rejected` |
| `rejection_reason` | `TEXT` | 拒否理由 |
| `remaining_quantity_after` | `INTEGER` | 確定購入後の残在庫。拒否時は `NULL` |
| `created_at` | `TIMESTAMPTZ` | 作成日時 |

`request_id` は任意ですが、同じ購入者・同じイベントの確定購入（`confirmed`）では一意にします。拒否された購入（`rejected`）は同じ購入者・同じイベント・同じ `request_id` で重複記録しないようにしつつ、在庫補充後に確定購入として再試行できるようにします。将来的にリトライや二重送信の検証に使います。

`ticket_type_id` は既存 Purchase を対象 Event の既定 `General Admission` へ backfill した後に `NOT NULL` とします。複合外部キー
`(event_id, ticket_type_id) -> ticket_types(event_id, id)` により、別 Event の Ticket Type を購入できません。この外部キーは migration 内で `VALIDATE CONSTRAINT` まで完了し、未検証状態を Issue #337 へ持ち越しません。`buyer_id` の既存データ互換を目的とした `NOT VALID` FK とは扱いが異なります。

`(event_id, ticket_type_id, created_at)` の index は、Ticket Type ごとの購入照合と migration readiness 検査に使います。現行の `buyer_id + event_id + request_id` の冪等性 scope は Issue #336 では変更しません。

この `ticket_type_id` は現行の直接購入 API を後方互換に expand するための列です。複数 Ticket Type の明細を持つ Ticket Hold や Purchase の最終形ではありません。Ticket Hold 明細と Purchase 明細の table 境界は、Purchase Session / Ticket Hold の実装 Issue で決定します。

## expand migration と live-write bridge

既存データの backfill と旧 backend の live write の間に欠損を作らないため、versioned migration は1 transaction 内で、既知 writer の入口である `events`、最大 lock が必要な `purchases`、`ticket_inventory` の順に lock を取得し、backfill と一時 DB trigger の有効化を完了します。`lock_timeout` は10秒、各 statement の `statement_timeout` は5分とし、超過時は全体を rollback します。migration 中も Event と在庫の plain read は継続できますが、Purchase の read / write は transaction 完了まで待機します。

| Trigger | 対象 | expand 段階の動作 |
| --- | --- | --- |
| `events_ticket_type_expand_default_trg` | `events` の `AFTER INSERT` | 既定 `General Admission` を同じ transaction で作成する |
| `ticket_inventory_ticket_type_expand_sync_trg` | `ticket_inventory` の `AFTER INSERT OR UPDATE` | 既定 Type の `ticket_type_inventory` を legacy 在庫の値で upsert する |
| `purchases_ticket_type_expand_default_trg` | `purchases` の `BEFORE INSERT` | 旧 writer が省略した `ticket_type_id` を対象 Event の既定 Type で補完する |

同期方向は legacy から Ticket Type 側への一方向です。trigger が既定 Type を特定できない、または制約に違反する場合は source の書き込みも同じ transaction で失敗し、未同期の legacy row だけを commit しません。

Event 削除時は外部キーの cascade により `ticket_types` と `ticket_type_inventory` を削除するため、`ticket_inventory` の `DELETE` 同期 trigger は設けません。

一方向の在庫同期 trigger を残したまま、`ticket_type_inventory` を正本として独立更新してはいけません。Issue #337 は旧 writer の drain と fail-closed preflight を終えた activation 境界で、この trigger を削除するか新しい互換方式へ置き換えます。Event 作成と Purchase 補完の互換 trigger は、Gate C で旧 task と legacy fallback の終了を確認した後、Issue #339 で撤去します。

## migration readiness と rollback

Issue #337 の activation 前には readiness checker を実行し、16カテゴリの違反件数がすべて0件であることを確認します。checkerは期待するカテゴリの欠落・追加・重複や不正な件数もエラーとして扱います。1カテゴリでも1件以上、または結果集合が不完全ならprocessは終了コード1となり、切替をfail closedで停止します。

ローカルではTypeScriptを直接実行します。

```bash
npm run migration:check:ticket-type-expand
```

production imageではdevDependencyの`ts-node`を使わず、build済みJavaScriptを実行します。checkerは`REPEATABLE READ READ ONLY` transaction内の単一snapshotで照合し、この実行経路からDBを変更できないようDB側でも強制します。

```bash
npm run migration:check:ticket-type-expand:prod
```

| Category | 違反として数える状態 |
| --- | --- |
| `event_without_exactly_one_default` | 既定 Ticket Type が正確に1件ではないEvent |
| `event_without_exactly_one_ticket_type_before_cutover` | cutover前にTicket Typeが正確に1件ではないEvent |
| `event_without_legacy_inventory` | 正本の`ticket_inventory`がないEvent |
| `legacy_inventory_without_default_shadow` | 対応する既定`ticket_type_inventory`がないlegacy在庫 |
| `legacy_shadow_total_mismatch` | legacyとshadowの`total_quantity`差分 |
| `legacy_shadow_remaining_mismatch` | legacyとshadowの`remaining_quantity`差分 |
| `legacy_shadow_version_mismatch` | legacyとshadowの`version`差分 |
| `legacy_shadow_updated_at_mismatch` | legacyとshadowの`updated_at`差分 |
| `non_default_inventory_before_cutover` | 非既定Ticket Typeに作成された在庫 |
| `purchase_without_ticket_type` | `ticket_type_id`が未設定のPurchase |
| `purchase_ticket_type_event_mismatch` | PurchaseとTicket TypeのEvent不一致または孤児参照 |
| `ticket_type_inventory_event_mismatch` | shadow在庫とTicket TypeのEvent不一致または孤児参照 |
| `required_bridge_trigger_missing_or_disabled` | 必須bridge triggerの欠落、無効化、対象event・即時性・更新対象列・function本文/設定の不一致 |
| `required_ticket_type_fk_missing_or_unvalidated` | 必須FKの欠落、未検証、列対応・参照先・削除動作の不一致 |
| `required_ticket_type_not_null_missing` | expand tableと`purchases.ticket_type_id`の必須列欠落または`NOT NULL`未設定 |
| `required_unique_index_missing_or_invalid` | Ticket TypeのPK・複合参照key・正規化名・既定Type・shadow在庫PKの欠落または定義不一致 |

親Issue #335のRollout Gate Aでは、migrationと旧backend binaryによるlive write確認後、対象環境専用のmanual workflowを実行します。

- dev: `.github/workflows/ticket-type-expand-readiness-dev.yml`
- staging: `.github/workflows/ticket-type-expand-readiness-staging.yml`

各workflowは環境選択inputを持たず、GitHub Environmentの承認とAWS認証を使います。通常は現行API task definitionをECS RunTaskで一時起動し、allowlist済みの`ticket-type-readiness` modeから`node dist/src/database/check-ticket-type-expand-readiness.js`を実行します。DBのschemaやデータは変更しません。

workflow summaryにはUTCの開始・終了時刻、task definition、image、task ARN、checkerのJSON結果、container exit codeを記録します。checkerのJSONは`complete: true`と`categoryCount: 16`を完全性マーカーとして含みます。CloudWatch Logsは短時間retryし、完全性マーカーとreadiness結果を取得できなければcontainerが終了コード0でもworkflowを失敗させます。workflow URLと結果を親Issue #335へ記録します。このworkflowは整合性checkerの証跡だけを担当するため、Gate Aに必要なmigration前後の件数、migration名、旧binaryによるEvent作成・一覧・購入、rollbackまたはforward-fix判断も別途同じGateへ記録します。

backend deploy、独立DB migration、readinessは環境ごとの共通concurrency groupで直列化します。migration成功後にservice更新だけが失敗し、現行serviceの旧imageにcheckerがまだない場合は、readiness workflowの`task_definition_arn`へdeploy logに記録された新task definition ARNを指定します。通常のGate Aでは空欄のまま現行serviceを使います。

正規化後の Ticket Type 名重複は unique index が書き込み時に拒否します。PR merge は dev / staging への migration 適用完了を意味しません。migration 前後の Event / Ticket Type / 在庫 / Purchase 件数、populated data、旧 backend binary、migration 後の live write は親 Issue #335 の Rollout Gate A で検証し、同じ環境の Gate A が PASS するまで Issue #337 の内部切替を有効化しません。

down migration は、各 Event が legacy schema で表現できる既定 Ticket Type だけを持ち、legacy 在庫と shadow 在庫が一致し、全 Purchase が同じ Event の既定 Type に紐付く場合に限って実行できます。複数または非既定 Ticket Type、在庫差分、既定 Type 以外への Purchase 紐付けなど、contract 時に失われるデータがある場合は明示的に停止します。Issue #337 の activation 後は forward fix または backup/restore を原則とします。

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
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U ticket_poc -d ticket_poc < database/schema.sql
```
