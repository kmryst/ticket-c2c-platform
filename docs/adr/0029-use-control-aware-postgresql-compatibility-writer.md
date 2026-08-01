# 0029. Ticket Type在庫切替にcontrol-aware PostgreSQL compatibility writerを採用する

## ステータス

Accepted

## 日付

2026-08-01

## 背景

ADR-0028とIssue #336は、Event単位の`ticket_inventory`を正本に残し、Ticket Type schemaをshadowとして追加した。次の段階では、旧backendとのrollback余地を残しながら、Aurora PostgreSQLのauthoritative writerを`ticket_type_inventory`へ切り替える必要がある。

application設定だけで正本を切り替えると、複数ECS taskの設定差、rolling deploy中の旧binary、直接SQL writerにより両側が同時に更新される。単純な双方向triggerは相互再帰し、異なるTicket Typeの並行更新をEvent合計へ反映するとlost updateも起こり得る。

冪等性もconfirmedとrejectedで別々のpartial unique indexを持っていたため、同じbuyer、Event、requestIdを両statusに1件ずつ保存できた。同じkeyの異なるTypeまたは数量を直列化し、在庫更新前にpayload衝突として拒否するDB共有境界が必要である。

## 決定

### 共有control state

singleton table `inventory_writer_control`を作り、`writer_mode`を`legacy`または`ticket_type`に制限する。migrationが作る初期rowは必ず`legacy`とし、schema再適用でも既存modeを上書きしない。

PR merge、deploy、migration適用はactive writerを変更しない。exclusive barrier、preflight、環境ごとのmode transitionとrollbackはIssue #378が所有する。

### barrierとlock順序

control-awareなEvent作成とPurchase transactionは、最初のtable accessより前に固定key `(335, 376)` のtransaction-level shared advisory lockを取得する。PurchaseにrequestIdがある場合は、次にbuyer、Event、requestIdだけから導出したadvisory lockを取得する。

lock順序を次に固定する。

1. shared writer barrier
2. requestId advisory lock
3. control rowとdomain tableへのaccess

request lockにpayloadを含めない。同じkeyの異なるpayloadも同じlockで直列化し、先行transactionの結果を読んでから409を返す。hash collisionは無関係なrequestを余分に直列化するだけで、安全性を弱めない。

DB triggerはcontrol rowを`FOR SHARE`で読み、旧binaryのtransactionもmode updateとすれ違わないようにする。Issue #378は同じ固定keyのexclusive advisory lockを取得する。

各在庫tableの`UPDATE`にはstatement-level writer fenceも置く。row triggerだけでは条件付き更新が0件だったstatementを観測できないため、statement fenceがrow探索より前にmodeを検査し、inactive側を対象にした旧writerを更新件数に関係なく拒否する。

### active writerとmirror

`legacy` modeでは、既存の`ticket_inventory`条件付き更新をactive writerとして維持し、ADR-0028のbridgeで正確に1件の既定Typeへ同値同期する。

`ticket_type` modeでは、`event_id + ticket_type_id + requested quantity`を条件に`ticket_type_inventory`を更新する。更新成功時は、更新後の`remaining_quantity`と単調増加`version`を同じ`RETURNING`で取得する。

Ticket Type更新後は、同じEventのType在庫を合計し、legacy `ticket_inventory`をEvent API用の互換集計として更新する。異なるTypeの並行更新では、Eventのlegacy rowを`FOR UPDATE`でmutexにしてからfresh statement snapshotで合計を読み直し、lock待ち前の古い集計による後勝ち上書きを防ぐ。

transaction-local `ticket_c2c.inventory_mirror_origin`と`pg_trigger_depth()`を併用し、mirror writeだけをinactive側に許可する。GUCだけをclientが偽装してもtop-level writeは許可しない。Ticket Typeからlegacyへのmirrorが既存forward bridgeを再発火させた場合は、そのnested bounceをrow triggerでskipする。

inactive側への非mirror `INSERT` / `UPDATE`、activation後の旧legacy writer、予期しないnested writeはfail closedで拒否する。inventory rowの直接`DELETE` / `TRUNCATE`はactive / inactiveを問わず許可しない。削除はEvent親rowの削除に伴う外部キーcascadeだけを許可し、在庫tableを独立したlifecycle ownerにしない。

### Eventと既存read contract

Event作成もcontrol-aware writerとする。公開入力`totalQuantity`は変更せず、`legacy`ではlegacy row、`ticket_type`ではEvent triggerが作った既定Type rowを初期化し、mirrorで他方を補完する。

Event一覧とOpenSearch未設定時のDB fallbackは`ticket_inventory`を読み続ける。`ticket_type` modeではこのrowをType合計の互換projectionとするため、artifact deployだけで既存read pathやtop-level数量contractを変えない。

### Purchase冪等性

`(buyer_id, event_id, request_id) WHERE request_id IS NOT NULL`をstatus横断で一意にする。migrationは既存のcross-status重複をindex変更前に検出し、自動削除・統合せずtransaction全体をrollbackする。

冪等性payloadは`ticket_type_id + quantity`とする。

- 同じkey / 同じpayloadは、元のconfirmedまたはrejected結果を返し、在庫を再更新しない。
- 同じkeyでTypeまたは数量が異なる場合は、在庫更新前にHTTP 409を返す。
- unified unique indexは、advisory lockを持たない旧binaryとのrolling raceに対するDB最終ガードとする。

Valkeyが`sold_out`を返しても、requestId付きrequestはPostgreSQL transactionへ進め、authoritativeなconfirmed / rejected結果を永続化する。これにより、同じpayloadの再送は永続rowをreplayし、異なるpayloadは在庫更新前に409となる。requestIdなしのrequestだけは従来どおりValkeyで早期拒否できる。Ticket Type単位のValkey namespace、reserve / release / syncとそのrace境界はIssue #389が所有する。

Purchaseは`ticket_type_id`を常に記録し、applicationはEventとの所有関係を検証する。検証済み複合FK `(event_id, ticket_type_id) -> ticket_types(event_id, id)`も最終的に別EventのTypeを拒否する。

### 公開contractとversionの境界

既存Purchase APIでType選択を省略した場合、EventにTypeが正確に1件あるときだけ内部解決する。複数Type作成、明示的なrequest field、response形状はIssue #379まで公開しない。

Issue #376はtransaction由来の`ticketTypeId + Type remaining quantity + Type inventory version`を内部resultとして保持する。一方、既存Purchase responseと既存`TicketPurchased` / `InventoryChanged` eventの`remainingQuantity`は、両modeともEvent互換集計を返し、既存contractの意味を変えない。Type単位のresponse公開はIssue #379、version付きevent payload、producer、consumer、OpenSearch projectionはIssue #377が所有する。

### rollback

Issue #376 migrationのdownは、control modeが`legacy`で、各Eventが正確に1件の既定Typeだけを持ち、legacy/default在庫が全列一致し、全PurchaseがそのTypeを参照するときだけ許可する。unified indexを旧confirmed/rejected partial indexへ戻し、追加guard、reverse mirror、control tableを撤去する。

`ticket_type` activation後はschema downを直接実行しない。まずIssue #378のcontrolled rollbackでlegacyへ戻す。複数Type在庫や非default Purchaseをlegacyで損失なく表現できない場合は、downをfail closedとし、forward fixまたはbackup/restoreを選ぶ。

## 根拠

- PostgreSQL共有rowとadvisory lockは、ECS taskやapplication processをまたいで同じ切替境界になる。
- active writerを常に1つに限定し、mirrorを同一transactionに閉じることで二重正本を作らない。
- statement fenceとDB trigger guardは、0件更新を含む旧binaryのinactive-side writeと直接SQL writerを停止できる。
- Event row単位のaggregate mutexにより、Type row lockが異なる並行更新でも合計のlost updateを防げる。
- status横断unique indexとpayload非依存request lockにより、confirmed/rejectedとpayload raceを同じfailure domainで閉じられる。
- legacy compatibility rowを既存read pathとして維持するため、deployとactivationを分離できる。

## 反対材料・トレードオフ

- triggerとtransaction-local markerはapplication SQLから見えにくい暗黙writeを増やす。
- request-key lockは同じkeyのretryを直列化し、hash collision時は無関係なrequestも一時的に直列化する。
- requestId付きrequestはValkeyの`sold_out`後もPostgreSQLへ進むため、requestIdなしの早期拒否よりDB負荷が高い。
- inactive側の誤writeをavailabilityよりconsistency優先で拒否するため、mode不整合時は販売を停止し得る。
- 在庫rowの直接削除を許可しないため、運用上の削除はEvent lifecycleまたは明示的なschema変更として扱う必要がある。
- Type更新ごとにEvent合計を再計算するため、1 EventのType数が大幅に増えるとwrite costが上がる。
- `ticket_inventory`の互換集計ではType別内訳を表現できない。
- PostgreSQL単一clusterのadvisory lockは、複数clusterやshardをまたぐwriter fenceにはならない。

## 再検討のトリガー

- compatibility objectをIssue #391またはcontract cleanupで撤去するとき。
- 1 EventのType数増加により、transaction内の全Type集計が許容latencyを超えたとき。
- writerが複数PostgreSQL clusterまたはshardへ分割され、単一control rowとadvisory lockが全writerを覆わなくなったとき。
- requestIdのscopeまたは冪等性payload contractを変更するとき。
- Purchase Session / Ticket Holdが直接購入の単一`ticket_type_id`構造を置き換えるとき。
