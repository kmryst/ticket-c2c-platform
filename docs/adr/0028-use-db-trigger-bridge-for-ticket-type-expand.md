# 0028. Ticket Type 移行の expand 段階に DB trigger bridge を採用する

## ステータス

Accepted

## 日付

2026-07-27

## 背景

現行の購入処理は、Event ごとに1行ある `ticket_inventory` を PostgreSQL 在庫の正本として条件付き更新し、`purchases` へ購入結果を記録する。B2C 一次販売では Ticket Type 単位の在庫が必要になるため、Issue #335 は `expand -> 内部処理切替 -> API 公開 -> contract cleanup` の順で段階移行する方針を定めている。

expand 段階の Issue #336 では、既存 Event、在庫、Purchase を既定 Ticket Type `General Admission` へ backfill する。一方、migration 適用後も直前の backend task が同じ DB に書き込む時間帯があり、Event 作成、在庫更新、Purchase 作成を一回限りの backfill だけでは取り込めない。backfill と旧 task の書き込みが競合すると、Ticket Type 未紐付け、在庫差分、Purchase 欠損が生じる。

候補には、DB trigger で旧書き込みを継続的に取り込む方式と、旧 writer を停止する writer fence、書き込み drain、最終 catch-up を同じ境界で行う方式がある。現行 deploy には、すべての旧 task と直接 DB を使用する PoC script を同時に停止し、migration 完了まで書き込みを拒否する仕組みがない。そのため、expand 段階だけで安全な writer fence を成立させるには、migration 自体とは別の運用機構が必要になる。

## 決定

### expand 段階の正本

Issue #336 と親 Issue #335 の Rollout Gate A では、Event 単位の `ticket_inventory` を在庫の唯一の正本として維持する。現行の PostgreSQL 条件付き更新と旧 backend の SQL は変更しない。

`ticket_types` と `ticket_type_inventory` を追加するが、`ticket_type_inventory` は `ticket_inventory` から同期する移行用の shadow とする。両方を独立した在庫正本として更新してはならない。Ticket Type 単位の在庫を正本へ切り替えるのは Issue #337 が所有する。

### Ticket Type の制約

`ticket_types` は、独立した UUID 主キー `id`、所有 Event を示す `event_id`、表示名 `name`、既定 Type を示す `is_default` を持つ。DB で次の不変条件を強制する。

- `name` は空文字列を禁止し、前後の空白を保存しない。
- 同じ Event 内では、`lower(name)` が同じ Ticket Type を複数作れない。
- `is_default = true` の行は Event ごとに最大1件とする。
- `(event_id, id)` に通常の unique 制約を置き、複合外部キーの参照先にする。

Event ごとの既定 Type が「最低1件」存在することは partial unique index だけでは保証できない。migration の backfill、Event 作成 trigger、cutover 前の fail-closed checker を組み合わせ、正確に1件であることを保証する。

`ticket_type_inventory` と `purchases.ticket_type_id` は、`(event_id, ticket_type_id) -> ticket_types(event_id, id)` の複合外部キーを持つ。これにより、別 Event の Ticket Type を在庫または Purchase へ紐付けることを禁止する。`purchases.ticket_type_id` の既存行は同じ migration で backfill し、外部キーを `VALIDATE CONSTRAINT` まで完了させる。検証されていない外部キーを後続 Issue へ持ち越さない。

### migration と live-write bridge

versioned migration は TypeORM migration runner の1 transaction 内で実行する。source table の backfill を始める前に、既知 writer の入口である `events` を `EXCLUSIVE`、続いて `purchases` を `ACCESS EXCLUSIVE NOWAIT`、`ticket_inventory` を `SHARE ROW EXCLUSIVE NOWAIT` の順で lock する。必要な最大 lock を先に取得し、旧 Purchase が `purchases` の read lock を保持したまま在庫更新を待つ lock upgrade deadlock を防ぐ。

現行 API writer は同じ transaction 内で `events` を先に lock するため、`events` の gate で既存 transaction を drain できる。一方、既存 PoC script には Event と在庫を別の autocommit transaction で作る経路がある。migration が `events` を保持した後に、その script が後段 table の lock を先取していた場合は、`NOWAIT` により migration 全体を即時 rollback する。migration が `events` を保持したまま相手の transaction を待つ循環を作らず、script 完了後に migration を再実行する。

`events` の `lock_timeout` は10秒、各 statement の `statement_timeout` は5分とする。競合 transaction または想定外のデータ量でdeadlineを超えた場合も、販売処理を無期限に待たせずmigration全体をrollbackして再実行する。適用先は `public` schema に固定する。一時 trigger function の恒久table参照は`public.*`で完全修飾し、実行時`search_path`も`pg_catalog, public, pg_temp`へ固定して一時schemaを末尾に置く。`events`と`ticket_inventory`のplain readは継続できるが、`purchases`のreadはtransaction完了まで待機する。

lock を保持したまま次を行い、trigger を有効にしてからcommitする。

1. Ticket Type 用の table、列、制約、index を追加する。
2. 既存 Event ごとに既定 `General Admission` を作成する。
3. `ticket_inventory` の数量、残数、version、更新日時を対応する `ticket_type_inventory` へ backfill する。
4. 既存 Purchase の `ticket_type_id` を対象 Event の既定 Type で backfill する。
5. 旧書き込みを取り込む trigger function と trigger を作成する。
6. `NOT NULL`、外部キー、整合性検査を完了し、transaction を commit する。

一時 bridge は次の方向だけに同期する。

- `events` の作成後、同じ transaction で既定 `General Admission` を作成する。
- `ticket_inventory` の作成または更新後、同じ transaction で既定 Type の `ticket_type_inventory` を upsert する。
- 旧 writer が `purchases.ticket_type_id` を省略した場合、`purchases` の作成前に対象 Event の既定 Type を補完する。

trigger が既定 Type を特定できない、または制約に違反する場合は、旧書き込みも同じ transaction で失敗させる。同期エラーを握りつぶして legacy row だけを commit しない。

migration が途中で失敗した場合は、追加した schema、backfill、trigger を migration transaction ごと rollback する。再実行では、TypeORM の migration 履歴に記録されていない transaction を最初から再実行する。

### readiness と trigger の撤去境界

Issue #337 の activation 前には、自動 checker で少なくとも次を検査し、1件でも違反があれば切替を停止する。

- Event ごとの既定 Ticket Type が正確に1件である。
- cutover 前の各 Event に Ticket Type が正確に1件あり、既定 Type である。
- legacy 在庫と既定 Type 在庫の数量、残数、version、更新日時に差分がない。
- Purchase が同じ Event の Ticket Type にすべて紐付いている。
- 未紐付け、孤児参照、Event または Purchase の欠損がない。
- 3つの bridge trigger が存在して通常 write で有効である。
- Ticket Type 関連の外部キーが存在して検証済みであり、Purchase の `ticket_type_id` が `NOT NULL` である。
- Ticket Type の複合参照 key、正規化名、既定 Type を守る3つの unique index が有効である。

同じ Event 内の正規化後の同名 Ticket Type は unique index が書き込み時に拒否する。checkerは`REPEATABLE READ READ ONLY` transactionで実行し、同じsnapshotでの判定とDB非変更をDB側で強制する。PR merge は環境への migration 適用完了を意味しない。dev と staging の実データ、旧 backend binary、migration 後の live write は、親 Issue #335 の Rollout Gate A で別々に検証する。環境ごとのbackend deploy、独立DB migration、readinessは共通concurrency groupで直列化し、Gate A が同じ環境で PASS するまで、Issue #337 の内部切替をその環境で有効化しない。

legacy 在庫から Ticket Type 在庫への一方向 trigger を残したまま、Ticket Type 在庫を正本として独立更新してはならない。Issue #337 は、旧 writer を drain して preflight を PASS させた activation 境界で、この bridge を削除するか新しい互換方式へ置き換えてから Ticket Type 単位の write path を有効化する。

Event 作成時の既定 Type 補完と、Purchase の `ticket_type_id` 省略補完は、旧 contract の互換経路である。これらは first-party client の明示的な `ticketTypeId` 使用と旧 task の停止を Gate C で確認した後、Issue #339 の contract cleanup で撤去する。

### rollback と down migration

expanded schema は旧 backend binary と互換であるため、Gate A の通過後も Issue #337 の activation 前までは application rollback として旧 binary の再 deploy を許容する。schema の down migration は、Ticket Type 側のデータを Event 単位へ損失なく戻せる場合だけ許可する。

複数または非既定 Ticket Type、legacy 在庫との差分、既定 Type 以外へ紐付く Purchase など、legacy schema で表現できないデータが1件でもある場合は down migration を明示的に停止する。Issue #337 の activation 後は、原則として down migration ではなく forward fix または backup/restore を使用する。

### 将来の Ticket Hold との境界

`purchases.ticket_type_id` は、現行の「1 Purchase row = 1 Event の1種類の Ticket Type と quantity」という直接購入 API を expand する互換構造である。複数 Ticket Type の明細を持つ Ticket Hold と Purchase の最終スキーマではない。

Ticket Hold の複数明細、Purchase Session、Hold から Purchase への確定、将来の Reserved Seating は各実装 Issue で別途設計する。この ADR から、将来も Purchase が単一 `ticket_type_id` だけを持つと決定したものとは解釈しない。

## 根拠

- DB 境界の trigger は、旧 backend binary と直接 DB を使う PoC script の両方を、application release に依存せず同じ transaction で取り込める。
- backfill 前の table lock と commit 前の trigger 有効化を組み合わせることで、backfill と live write の間に未同期の時間窓を残さない。
- legacy 在庫から shadow への一方向同期に限定することで、expand 中に二重の在庫正本を作らない。
- 複合外部キーは、Ticket Type の存在だけでなく、Event との所有関係を DB で保証する。
- `purchases.ticket_type_id` の外部キーを同じ migration で検証することで、最も高リスクな内部切替へ未検証参照を持ち込まない。
- writer fence 用の新しい運用機構を Issue #336 へ追加せず、現行 deploy と旧 binary の混在条件で Gate A を検証できる。

## 反対材料・トレードオフ

- trigger は application code から見えにくい暗黙の書き込みを増やし、Event 作成と購入の write latency を増やす。
- bridge の障害は安全側に旧書き込みも rollback するため、過剰販売や欠損を避ける代わりに販売を停止する可能性がある。
- migration 中のtable lockは既存writerの完了を待ち、backfillが終わるまで新しい書き込みを待機させる。`purchases`はreadも待機する。API の入口外で後段 table を先取した writer がいれば `NOWAIT` で即時失敗する。データ量が増えるとdeploy時間と販売停止リスクが増えるため、10秒の`events` lock待ちまたは各statementの5分上限を超えたmigrationもrollbackする。
- `ticket_type_inventory` は移行中の shadow であり、監視や調査で正本と誤認しない運用が必要になる。
- writer fence と final catch-up は trigger の暗黙性を避けられるが、すべての writer を特定して停止し、失敗時に安全に再開する仕組みが必要になる。
- normalized name の unique index は、大文字小文字だけが異なる Ticket Type を意図的に使う要求とは両立しない。

## 再検討のトリガー

- populated な dev または staging の測定で、table lock の待ち時間または一括 backfill 時間が許容できないと判明したとき。
- DB を直接更新する writer を廃止し、deploy 基盤で writer fence、drain、final catch-up を安全に実行できるようになったとき。
- Issue #337 で Ticket Type 在庫を正本へ切り替えるとき。一方向 bridge の削除または置換は activation の必須条件とする。
- 同一 Event 内で大文字小文字だけが異なる Ticket Type 名を区別する商品要件が確定したとき。
- 複数 Ticket Type の Ticket Hold、Purchase 明細、または Reserved Seating の具体的な DB スキーマを決定するとき。
