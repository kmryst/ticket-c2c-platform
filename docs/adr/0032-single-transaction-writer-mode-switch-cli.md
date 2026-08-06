# 0032. writer mode切替を排他barrier下の単一transaction CLIで行う

## ステータス

Accepted

## 日付

2026-08-06

## 背景

ADR-0029とIssue #376は、`inventory_writer_control`のsingleton rowを在庫正本の切替スイッチとし、application writerがtransaction冒頭で固定key `(335, 376)` のshared advisory lockを取得する構造を実装した。ADR-0028が activation の必須条件とした一方向bridgeの置換は、#376 migration（`1785542400000-add-ticket-type-compatibility-writer`）がforward bridgeの置換・mode-aware guard・reverse mirrorとして完了済みである。したがってIssue #378のactivation / rollbackに残る作業は、schema変更ではなくcontrol stateの切替そのものである。

切替には次の危険がある。

- in-flight writerが旧modeの前提でtable accessを続けている間にmodeを変えると、同一時刻に両側が正本として更新され得る。
- shared barrierを取得しない直接SQL writer（PoC script）や旧binaryは、advisory lockだけでは閉じられない。
- mode切替とparity検査を別transactionにすると、検査greenと切替の間にdriftが入り込み、失敗時に中間stateが永続化し得る。
- ValkeyとOpenSearchはPostgreSQL transactionに参加できないため、cross-storeの検査は原理的に切替と原子化できない。

Issue #378は、activation / rollbackが同じ固定keyの排他barrierを取得し、in-flight writerをdrainした後に既知writer入口を決定的なtable lock順で閉じ、state切替とDB parity検査を1 transactionで行い、fail closedで停止することを受け入れ条件としている。

## 決定

### 単一の双方向CLI

activationとrollbackを別実装にせず、`--target-mode legacy|ticket_type` を必須引数とする1つのfail-closed CLI（`src/cutover/switch-ticket-type-writer-mode.ts`）にする。rollbackはactivationの逆方向実行であり、同じdrain・lock順・検査・原子性を通る。

現在のmodeがtargetと同じ場合は暗黙のno-opにせず実行エラーで停止する。切替は原子的であり「途中まで進んだ再実行」は存在しないため、同一modeへの再実行は運用の状況誤認として扱う。

### Phase 1: in-process preflight

CLIは切替transactionの直前に、PR-1（PR #401）のchecker関数（`checkCutoverDatabase` / `checkCutoverValkey` / `checkCutoverOpenSearch`）を同一プロセスで再実行する（expected mode = 現mode、phase = `preflight`、`REPEATABLE READ READ ONLY` snapshot）。violationが1件でもあればexit 2で停止し、切替transactionを開始しない。

外部のevidence fileを事前入力として受け取る方式は採用しない。PR-1のevidence（version 1）は取得時刻を持たず鮮度を検証できない。また`schemaRevision`の一致だけでは同一revision内のデータdriftを検出できない。in-process再実行はTOCTOU窓を最小化し、PR-1のコードをそのまま再利用できる。

preflightのexpected modeを現modeにすることで、checkerのpreflight規則（切替先namespaceも厳密照合）により、切替先のValkey namespaceが#389のprimitiveでseed済みであることも切替前に強制される。

### Phase 2: 切替transaction（1 transactionで drain・lock・検査・切替・再検査）

```text
BEGIN (READ WRITE)
SET LOCAL lock_timeout = '10s'
SET LOCAL statement_timeout = '60s'
SET LOCAL idle_in_transaction_session_timeout = '60s'
SET LOCAL search_path = public, pg_catalog, pg_temp
SELECT pg_advisory_xact_lock(335, 376)            -- 排他barrier
LOCK TABLE events IN EXCLUSIVE MODE
LOCK TABLE purchases IN ACCESS EXCLUSIVE MODE NOWAIT
LOCK TABLE ticket_types IN SHARE ROW EXCLUSIVE MODE NOWAIT
LOCK TABLE ticket_inventory IN SHARE ROW EXCLUSIVE MODE NOWAIT
LOCK TABLE ticket_type_inventory IN SHARE ROW EXCLUSIVE MODE NOWAIT
-- checkCutoverDatabase(現mode): violation 0件、writerMode = 現mode、
--   schemaRevision = Phase 1と同一 を確認。1つでも破れば例外
UPDATE inventory_writer_control SET writer_mode = target, updated_at = now()
-- checkCutoverDatabase(target mode): violation 0件を確認
COMMIT
```

- **drain**: `pg_advisory_xact_lock(335, 376)` のexclusive取得は、shared保持中のin-flight writer transaction（`createEvent` / `executePurchaseTransaction`）のcommit / abortを待つことで自然にdrainし、新規writerはbarrier取得段階でblockする。advisory lockの取得待ちにも`lock_timeout`が効くため、drainは10秒で上限される。
- **table lock順**: #336 / #376 migrationと同一の順序・lock modeを使う。`events`を先頭のgateとして既存transactionを待ち、後段はすべて`NOWAIT`とし、後段lockを先取した想定外writerがいれば`events`を保持したまま待たずに即rollbackする。migrationと同順にすることで、切替とmigrationが同じlock獲得面を持ち、新しいdeadlockパターンを持ち込まない。table lockは、shared barrierを取得しない直接SQL writer・旧binaryに対するdefense-in-depthである（旧binaryのinactive-side writeは#376のstatement fenceも拒否する）。
- **1 transaction原子性**: mode UPDATEと前後2回のDB parity検査（`checkCutoverDatabase`を切替前=現mode・切替後=target modeの両方で実行）を同一transactionに閉じる。COMMIT前の失敗（timeout・lock競合・violation検出・COMMIT送信前の接続断）はどれも例外→ROLLBACKとなり、mode変更は永続化されない。advisory xact lockとtable lockはtransaction終了で自動解放されるため、crash時にlockが残留しない。
- **COMMIT応答喪失（結果不明）の扱い**: 唯一の例外はCOMMIT自体の失敗である。サーバ側でcommitが確定した直後、応答受信前にconnectionが切れた場合、clientは例外を受け取るが切替は既に有効であり、ROLLBACKでは取り消せない。CLIはCOMMITの失敗を他の失敗と区別した機械可読なエラー種別（`commit_outcome_unknown`）として扱い、現在のmodeを再確認して3分岐に分離する。再確認の順序が重要である: 「client側が接続断を検知したこと」と「サーバ側でCOMMIT処理が完了したこと」は独立事象で順序保証がないため、単純なSELECTではWAL flush中のCOMMITを追い越して旧source modeを読み「未適用」と誤報告するraceがある。そこで(1)まず元connectionを`release(error)`で破棄してsocket終了をサーバへ通知し、(2)検証は別transactionで同じ排他advisory barrier（`pg_advisory_xact_lock(335, 376)`）を取得してから`inventory_writer_control`を読む。advisory xact lockは元transactionの終了（commit確定/abort）まで解放されないため、取得できた時点で読んだmodeが最終状態である。barrier取得がtimeoutした場合（元transactionが終了しない等）はsource/targetのどちらにも断定せず実行エラーへ倒す。分岐は: (a) target modeを確認できたら「切替有効・postflightへ進む」（exit 3）、(b) source modeのままなら「未適用・新しいpreflightから再実行可能」（exit 4）、(c) 再確認自体が失敗したら実行エラーで停止し、手動確認を要求する（exit 1）。再実行時は「既にtarget mode」の明示エラーになるため、DB自体が中間状態になることはないが、この分岐がないと運用者/workflowが「失敗=source modeのまま」と誤認しpostflightを飛ばすriskがある。
- **timeout値の根拠**: `lock_timeout = 10s`は#336 / #376 migrationの既存実績値と同一。`statement_timeout = 60s`はPR-1 checkerのDB検査budgetと同一で、同じparity SQLがこのbudget内で完了することをcheckerの運用実績に依拠する（populated環境で超過した場合は再検討トリガー）。

### Valkey / OpenSearchの扱い

ValkeyとOpenSearchは切替transactionに参加できない。次の3層で扱う。

1. 切替前: Phase 1のin-process preflight（現mode・phase=preflight）で差分0を強制する。
2. 切替後: 既存CLI `cutover:check --expect-mode <target> --phase postflight` をworkflow / runbook（PR-3）が実行し、差分0を証跡として残す。
3. preflightと切替の間に現mode側の販売が進んだ分のValkey counter差は、postflightで検出し#389のreconcile primitiveで収束させる。この窓はcross-store構成で原理的に消せないため、runbook（PR-3）で切替sessionの手順順序として管理する。

### rollbackはcompatibility artifactを維持したまま全体を戻す

このCLIは`inventory_writer_control`の1行UPDATE以外に一切書き込まない。Valkey・OpenSearch・schemaへのwrite APIを持たず、部分rollback（Valkeyだけ戻す等）を可能にするflagも設けない。CLIの能力集合そのものを制約とすることで、「compatibility artifactのまま全体を`ticket_type -> legacy`へ戻す」以外の操作をツール上不可能にする。Valkey namespaceのseed / reconcileとOpenSearch rebuildは#389 / #377のprimitiveに委ね、rollback時の実行順序はrunbook（PR-3）が強制する。

### schema downとの分離

このCLIはmode rollback専用であり、schema down（#376 down migration）を実行しない。schema downの安全条件は#376 migrationの`ASSERT_SAFE_DOWN`（mode = legacy、全列parity、非default Type不在）が正本としてfail closedに強制する。`ticket_type` modeで作成したEventのversion parity回復（reconciliation）経路とdown実行手順はPR-3以降で扱う。

## 根拠

- 排他advisory lockはapplication writerと同じkey空間で衝突するため、ECS task・process横断で確実にdrain / blockできる。session-level lockと異なりtransaction終了で自動解放され、crash時の残留がない。
- migrationと同一のtable lock順は、検証済みのdrain挙動（`events` gate + 後段`NOWAIT`）を再利用し、lock獲得面を増やさない。
- `checkCutoverDatabase`の再利用により、Gate B checkerとactivationが同一のparity定義を共有する。checkerとCLIで検査条件が乖離する余地がない。
- 切替前後の2回検査により、「現modeとして整合していた」ことと「target modeとして整合している」ことの両方が同一snapshotで証明されてからcommitされる。
- CLIがcontrol row以外に書けない構造は、runbookの規律だけに依存せず部分rollbackを機械的に防ぐ。

## 反対材料・トレードオフ

- `purchases`の`ACCESS EXCLUSIVE`はreadも待たせるため、drain + 検査 + 切替の間（timeout上限まで）は購入APIが停止する。lock_timeout超過時は切替失敗として再試行する運用になる。
- Phase 1 preflightと切替transactionの間のcross-store TOCTOU窓は残る。DB parityはtransaction内で再検査されるが、Valkey差分はpostflight + reconcileでの事後収束になる。
- in-process preflightのため、CLI実行にはValkey / OpenSearch接続が必須になり、DBだけを対象にしたrehearsalはできない。
- 双方向を1つのCLIにするため、`--target-mode`の指定ミスが逆方向の切替になり得る。現mode一致エラーとworkflow（PR-3）での環境別固定引数で緩和する。
- resolverのprefilter planはbarrierを取らないTTL 5秒cacheのため、切替直後の最大5秒間は旧modeのrouting hintでValkey前段を判定し得る。在庫の正本判定は購入transactionがbarrier下でmodeを再読するため整合性は破れないが、前段フィルタの精度が一時的に落ちる。
- 単一PostgreSQL cluster前提であり、複数cluster / shard構成ではこのbarrierは切替境界にならない（ADR-0029と同じ制約）。
- COMMIT応答喪失の3分岐はexit codeを0/2/1の3値から0/2/3/4/1の5値へ増やし、workflow / runbook側の判定表を複雑にする。ただし分岐を潰すと「失敗=未切替」の誤認によるpostflight欠落riskが残るため、複雑さを受け入れる。

## 再検討のトリガー

- populated環境の実測で、drainが`lock_timeout` 10秒に収まらない、またはparity検査が`statement_timeout` 60秒を超えたとき。
- writerが複数PostgreSQL cluster / shardへ分割されたとき。
- evidence formatにversion 2（取得時刻等）が導入され、外部evidence入力の鮮度検証が可能になったとき。
- Issue #391 / contract cleanupでcompatibility artifactを撤去するとき。
- 切替の実行頻度が上がり、購入API停止を伴わないonline切替（段階的traffic shift等）が要件になったとき。
