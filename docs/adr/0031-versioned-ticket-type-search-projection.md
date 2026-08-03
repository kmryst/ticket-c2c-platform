# 0031. version 付き Ticket Type 在庫 event と検索 projection を実装する

## ステータス

Accepted

## 日付

2026-08-03

## 背景

親 Issue #335 の internal inventory cutover に向けて、#376 が採番する transaction 由来
version を使う additive inventory event を発行し、Search Projection Worker と OpenSearch を
Ticket Type 対応にする必要がある（Issue #377）。

この判断領域は次の 1 つの failure domain を所有する。

> Aurora PostgreSQL で commit 済みの Ticket Type 在庫 → additive InventoryChanged event →
> EventBridge → SQS Standard / DLQ → Search Projection Worker → OpenSearch →
> reconciliation / rebuild による収束。

PostgreSQL を在庫の正本とし、OpenSearch は再構築可能な projection とする。EventBridge / SQS /
Worker / OpenSearch の障害で、commit 済み Purchase transaction を rollback してはいけない。
欠損・遅延・差分を検出し、Aurora から rebuild して回復する。OpenSearch から PostgreSQL への
逆同期は行わない。

前段（在庫の正本 write と version 採番）は #376、Valkey 前段は #389 が所有する。Gate B での
呼び出し順序・cross-store checker・evidence・activation・controlled rollback は #378 が所有する。
本判断は projection 固有の contract / telemetry / reconciliation / rebuild primitive を提供する。

現行実装には次の弱点があった。

- InventoryChanged は Event 集計残数だけを発行し、Ticket Type 単位の state や version を持たない。
- Worker の `ensureIndex()` は index 存在時に早期 return し、追加 mapping を適用しない。
- EventListed / EventUpdated が document 全置換で Ticket Type 在庫 field を消し得る。
- InventoryChanged が version 比較なしで残数を上書きする。
- EventBridge publish が `FailedEntryCount > 0` を見逃し得る。
- `createOpenSearchClient()` が常に `https://` を付け、local / CI の HTTP endpoint を扱えない。
- dashboard に source queue の backlog / oldest age が無い。

## 決定

### additive event contract と dual-version

version 付き InventoryChanged payload を additive に拡張する。既存 field（`eventId`,
`remainingQuantity`）を保持し、旧 Worker が既存 field を処理して追加 field を無視できる形式にする。
追加する field は少なくとも次のとおり。

- `inventoryEventVersion`（contract version の明示 discriminant）
- `ticketTypeId` / `ticketTypeName` / `ticketTypeTotalQuantity` / `ticketTypeRemainingQuantity`
- `inventoryVersion`（対象 Ticket Type 単位の version）
- `eventTotalQuantity` / `eventRemainingQuantity`
- `eventInventoryVersion`（Event 互換集計単位の version）

Ticket Type A と B の `inventoryVersion` には順序関係がない。したがって
**Ticket Type state（`ticketTypeId` + `inventoryVersion`）** と
**Event 互換集計（`eventInventoryVersion`）** を独立に比較する。Type version だけで Event 集計を
guard しない（別 Type event の順序逆転で Event 合計が巻き戻るため）。

Ticket Type 名・総数・残数・両 version は、Purchase 更新と同じ PostgreSQL transaction から取得する
（publish 後の再 query で組み立てない）。内部 version を公開 Purchase response へ漏らさない。

### 型と runtime validation

producer は compile-time 型（`VersionedInventoryChangedPayload`）を、consumer は runtime
validation（`parseInventoryChangedDetail`）を持つ。contract version・UUID 形式・finite safe
integer・数量 0 以上・remaining <= total・version 0 以上・必須 field 存在を検証する。
一部だけ新 field を持つ壊れた payload を legacy として扱わない。壊れた versioned payload は
処理を失敗させ、SQS message を削除せず retry / DLQ へ進める。trace context は業務 contract と分離する。

### OpenSearch mapping と atomic version guard

Ticket Type UUID を dynamic field 名にせず、明示 mapping された nested 配列
（`ticket_types`）で保持する（mapping explosion 回避）。`ensureEventsIndex()` は未存在時に完全
mapping で作成し、存在時も idempotent な additive `putMapping` を適用する。mapping 適用失敗時は
message consumption を開始しない。

version 比較は Node.js 側の read→compare→write ではなく、OpenSearch 側の Painless scripted
update（単一 atomic update）で行う。script へ ID や値を文字列連結せず、すべて params で渡す。
Ticket Type state と Event 集計を独立に判定する（incoming > stored は apply、== かつ同値は
idempotent no-op、== かつ差異は contract corruption として error、< は stale no-op）。
document 競合時の retry は有限回にし、解消しなければ throw して SQS message を削除しない。
Worker と rebuild は同じ version guard script を共有する。

### legacy compatibility

新 Worker は versioned InventoryChanged / version なし旧 InventoryChanged / 旧・新
EventListed・EventUpdated を処理する。version なし旧 InventoryChanged は versioned state が
未作成のときだけ legacy top-level 残数を更新し、versioned state 作成後は巻き戻さない。
EventListed / EventUpdated は metadata だけを merge し、Ticket Type 在庫と version を削除・上書き
しない（InventoryChanged 先着でも upsert、EventListed 後着で metadata 補完）。在庫 projection の
更新源は InventoryChanged に固定し、TicketPurchased を第二の更新源にしない。

### publish failure

EventBridge publish で SDK call の throw と、HTTP 成功でも `FailedEntryCount > 0` / entry error の
両方を検出する。ただし Purchase transaction や成功済み API response を rollback / 失敗させない。
TicketPurchased publish が失敗しても、続く InventoryChanged publish を試行する。低カーディナリティ
metric（dimension は DetailType / Outcome / Operation の有限集合のみ）と trace 付き構造化 log を出す。
eventId / ticketTypeId / trace id / error message を metric dimension に含めない。

### reconciliation / rebuild（Aurora を正本とする）

read-only reconciliation は Aurora と OpenSearch を変更せず、missing / unexpected document・
Ticket Type / Event 集計の total / remaining / version 差分・malformed projection を検出する。
REPEATABLE READ READ ONLY、bounded keyset pagination、machine-readable JSON、category 別件数、
exit code で差分 0 / 差分あり / 実行エラーを区別する。

rebuild は Aurora を正本として bounded keyset pagination + bounded bulk size で reindex する。
restart 可能・idempotent・Worker と同じ atomic version guard を共有する。index 全削除や破壊的
recreate をしない。bulk API が HTTP 200 でも item error が 1 件でもあれば失敗させる。snapshot
version N の処理前 / 途中 / 後に event N+1 が届いても N+1 を巻き戻さない。DB と OpenSearch 双方へ
接続できる既存 API artifact から command override で実行する。新しい scheduler / 常駐 service /
transactional outbox / EventBridge target DLQ / SQS FIFO は追加しない。

### mixed Worker rollout 制約

新 payload は旧 Worker が既存 field を処理し追加 field を無視できるが、旧 Worker は EventListed の
全置換で versioned field を消し得る。したがって mixed Worker 期間は新 projection を active 扱い
しない。old Worker 0 件確認後に rebuild / reconciliation する。versioned state 作成後、
pre-version-guard Worker だけへ独立 rollback しない。controlled rollout は #378 が所有する。

## 根拠

- **per-Type version と Event 集計 version の分離**: SQS Standard は順序を保証しない。別 Type の
  event が順序逆転すると、Type version だけで Event 集計を guard した場合に Event 合計が巻き戻る。
  2 つの version を独立に比較することで、順序に依存せず正しく収束する。
- **atomic scripted update**: Node.js 側 read→compare→write は 2 つの往復の間に別 Worker /
  rebuild の書き込みが割り込み、lost update / rollback を起こす。OpenSearch 側の単一 atomic update
  なら compare と write が原子的で、有限 retry と併せて収束が保証される。
- **Aurora を正本とする reconciliation / rebuild**: OpenSearch は再構築可能な projection であり、
  欠損・遅延・差分は Aurora から復旧できる。逆同期は正本を汚染するため行わない。
- **transactional outbox 等を今回採用しない**: 定期実行頻度・alarm・EventBridge target delivery
  用 DLQ・transactional outbox・SQS FIFO の採否は Production Readiness M-12 / L-30 で決める。
  本判断では新しい定期実行基盤を設計せず、少なくとも手動 / 既存運用経路から検出・復旧 primitive を
  再実行可能にする。additive event + version guard + rebuild で結果整合の収束は担保できるため、
  outbox の複雑さを前倒しで持ち込まない。

## 反対材料・トレードオフ

- nested 配列は 1 Type の更新でも document 全体を再 index するため、Type 数が非常に多い Event では
  書き込みコストが増える。本 PoC の Ticket Type 数（少数）では許容範囲。Type 数が実運用で大きく
  増える場合は、Type ごとの child document 化などを再検討する。
- cross-store snapshot は原子的ではない。reconciliation は queue drain 後に実行し、必要なら再実行
  する運用でカバーする（runbook 参照）。
- rebuild を自動化せず手動 / command override に留めるため、恒久運用の自動収束は M-12 / L-30 まで
  持ち越す。一度の Gate B PASS を将来の整合性保証として扱わない。

## rollback / forward-fix 境界

rollback / recovery 方針は次に統一する。

> Aurora PostgreSQL を正本として、互換 artifact へ戻すか修正版 Worker を展開し、version guard 付き
> rebuild で OpenSearch を再収束させる。OpenSearch から PostgreSQL へ逆同期しない。

- Gate B 前はこの変更を revert し、直前 artifact へ戻せる。
- mapping は additive なので rollback 時に field や index を削除しない。
- mixed Worker 期間は Type projection を active 扱いしない。
- versioned state 作成後、pre-version-guard Worker だけへ独立 rollback しない。
- 必要なら Worker を止め、互換 artifact / 修正版展開後に Aurora から rebuild する。
- 在庫 read/write 全体の activation / rollback は #378 が所有する。
- この変更では deploy / rebuild / activation を実行しない。

## 再検討のトリガー

- Ticket Type 数が 1 Event あたり大きく増え、nested 配列の再 index コストが問題になる。
- M-12 / L-30 で定期実行・alarm・transactional outbox・SQS FIFO の採否を確定する。
- SQS を FIFO へ切り替える（ADR-0004 の再検討と連動）。
- OpenSearch の major version 更新で Painless / nested の挙動が変わる。
