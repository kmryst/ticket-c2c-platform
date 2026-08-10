# 0033. Ticket Type 移行の不可逆境界を policy / enforcement / evidence 分離で配置する

## ステータス

Accepted

## 日付

2026-08-08

## 背景

Issue #335（Ticket Type 単位在庫への段階移行 milestone）は rolling wave 計画を名乗りながら、13 件先の未着手 Issue（Phase 3/4）の実行手順まで親 Issue 本文の散文で確定しようとしていた。計画レビューを重ねてもマージ済み成果物はゼロである一方、CI を持った PR として切り出された作業（#336 / #376 / #389 / #377、いずれも統合テスト込みで CLOSED）はすべて収束した。散文で先の wave を確定する方式は、読むたびに穴が見つかり往復が終わらない。

計画の痩身の過程で、もう 1 つの構造的欠陥が見つかった。本 ADR の初期ドラフトは不変条件そのものを規範的に列挙し、#335 が「詳細は ADR-0033」と参照する構造になっていた。これは ADR を「決定の記録」ではなく「生きた仕様書（正本）」として使う構造であり、ADR は append-only・supersede 運用（`docs/adr/README.md`）のため、後続 ADR が一項目を差し替えるたびに supersede チェーンを辿らないと現行の不変条件が読めなくなる。同 README は「現在の仕様・構成・運用手順は領域ごとの正本に従い、ADR はそれを置き換えない」と定めており、ADR を不変条件の参照先にすること自体が規約違反である。

一方で、レビューの往復から「早い wave の実装がそれに従わないと後で作り直しになる」不可逆な境界がいくつか特定された。これらは着手時詳細化に委ねられない。本 ADR は (1) その不変条件（policy）の正本をどこに置き、強制機構・証跡とどう対応付けるかを決定し、(2) 不可逆境界に関する個別の設計判断（採用・不採用とその理由）を記録し、(3) それ以外の詳細を runbook / Issue 着手時へ委譲する境界線を引く。

## 決定

### 1. policy / enforcement / evidence を分離し、policy の正本は #335「不可逆境界」節に置く

- 不変条件を 3 つの役割に分離する。policy（何を守るか。要求仕様）/ enforcement（強制点: fail-closed guard・IAM 条件・required CI・merged runbook / workflow 定義）/ evidence（negative test・attest・Gate 証跡）。enforcement と evidence は policy の正本ではない。guard とそのテストを同じ PR で弱める変更は、独立した policy との突合がなければ検出できないためである。
- policy の正本は #335「不可逆境界」節に恒久配置する。強制点のマージは「正本の移動」ではなく「強制化完了」であり、該当 policy 項目へ強制点と検証テストのリンクを追記する。policy → enforcement → evidence の対応付けの網羅性は、#335 の受け入れ条件と最終 session の attest で検証する。
- 機械強制できない不変条件は 2 種に分けて強制点を定める。手順（二段階 apply の実行順・activation 順序）の強制点は versioned な runbook / workflow 定義、人の行為（forward-fix 宣言・AWS 実行承認）の強制点は Gate 証跡（#335 comment）。検査の書き方に対する規則（false-green 禁止）は機械的強制点を持たず、policy 文書 + runbook レビュー観点に恒久的に残る。
- attest による事後検出は予防的強制点の代替にしない。
- 本 ADR は判断の記録であり、policy の参照先にしない。要求仕様の本文は #335 が一元的に持ち、本 ADR はそれを重複記載しない。

### 2. guard の参照正本は 3 phase で切り替える（bootstrap manifest → manifest + control row → DB marker）

digest/schema guard が実行時に参照する正本は 3 phase で切り替える。bootstrap phase（`inventory_writer_control` row の生成前。control row は migration `1785542400000-add-ticket-type-compatibility-writer` の up で初めて作成される）では「state-empty・第1段 apply lineage を持つ承認済み session manifest」、control row 生成後〜final cleanup marker 永続化前（final-cleanup one-off task 自身の起動を含む期間）では同 manifest に加えて control row と migration head を照合、marker 永続化後は「DB marker」とする。phase 不明・正本不達・不一致は fail closed。

不採用案: (i) control row を migration 外で先行 seed する——migration の冪等性と「schema 再適用でも既存 mode を上書きしない」保護（ADR-0029）を壊す。(ii) bootstrap 期間だけ guard を無効化する——guard 前置の不変条件に反し、最も危険な期間（環境が空で何でも起動できる）を無防備にする。(iii) 中間 phase を定義しない 2 phase 構成——control row 生成後〜marker 前は final cleanup 実行を含む最長の期間であり、正規 task 自身が正本不達で fail closed になり実行不能になる。

manifest の具体スキーマ・許可 digest / task definition revision / command の列挙は、要求仕様（#335 不可逆境界 4）と #419 着手時・#445 の provisioning runbook が持つ。

### 3. writer mode 切替の所有を final cleanup transaction へ移管する

fresh session の final cleanup に限り、writer mode の legacy → ticket_type 切替は final cleanup transaction が fence として所有する。ADR-0029 の「mode transition は #378 所有」はこの範囲で本決定が変更し、ADR-0032 の切替 CLI は移管後に退役する（本 ADR を merge する PR で ADR-0029 / ADR-0032 と正本 `docs/poc/inventory-schema.md` に参照注記を追加する）。Gate B（#378 PR-3 の workflow / runbook）における切替は引き続き ADR-0032 の CLI が実行し、本決定の影響を受けない。

理由: 切替・bridge/control object と legacy object の drop・marker 永続化を別 transaction に分けると、失敗時に中間状態が永続化しうる。単一 transaction への原子化は ADR-0032 が切替 CLI で確立した性質の継承である。control object は同一 transaction で drop されるため、切替の事後証跡は marker に一本化される。marker の必須項目は要求仕様として #335（不可逆境界 2）が持ち、DB 表現は #384 着手時に確定する。

### 4. forward-fix 境界を 3 分割する

運用上の forward-fix 宣言（staging Gate B PASS 時点）/ `legacyRollbackEligible` / `schemaDownEligible` を独立に扱う。宣言の正本は Gate 証跡、各 eligibility の正本は fail-closed guard（切替 transaction 内 / 各 migration 内）、checker 値は時点情報。

理由: 運用宣言を技術的 eligibility の判定材料に混ぜると、宣言済みという理由だけで技術的に可能な rollback を封じる（またはその逆の誤許可）。人の宣言と機械の判定は failure domain が異なるため、正本も分離する。

### 5. evidence は destroy 前に remote へ永続化し provenance を検証可能にする

環境 destroy より前に evidence（attest versioned JSON・負荷結果・revision/workload）を remote Git へ永続化し、hash と provenance（workflow run / ECS task / artifact digest への lineage）を検証できる状態で残す。destroy 後は merged evidence/config decision PR 内の versioned JSON が writer 遷移を含む runtime 証跡の唯一の正本になる。

理由: ephemeral 環境では destroy が runtime 状態を消すため、事後検証可能性は destroy 前の永続化でしか担保できない。受け入れ条件としての正本は #335、branch 運用・保存手順は #445 runbook が持つ。

### 6. fresh 構築は二段階 apply とし、cleanup 完了まで activation しない

- 二段階 apply: 現行 root は apply 内で task definition を必ず latest image で作成し、ECR も同一 apply で作られる（`terraform/modules/ecs-service/main.tf:11` の無条件 TD 作成）ため、単段では guard を registration より前に置けない。段間の resource 境界として、第1段では task definition / service / autoscaling / Scheduler / canary を作成せず、guard PASS 後の第2段でのみ作成する。不採用案: TD 作成をモジュール外へ出す単段構成は module refactor を要し、移行期間中の全環境に影響するため見送る。第2段の方式は同一 root・phase 付き apply を第一候補として #445 着手時に確定する。
- activation 順序: 公開 CloudFront 経路の POST・未認証 signup・Worker の即時 SQS poll は起動後の遮断では止められないため、migration と final cleanup が完了するまで service / autoscaling / Scheduler / canary を activation せず、到達しない構造で保証する。
- 手順の正本は #445 の provisioning runbook / workflow 定義であり、dev リハーサルの実測で詳細化する。手動実行による手順迂回は guard 前置（#335 不可逆境界 3・4）が fail closed で補強する。

### 7. 計画詳細と Gate C/D 再編は rolling wave へ委譲する

- #335 本文が確定で持つのは、不可逆境界（policy）・Gate 判定主体・wave 定義・受け入れ条件のみとする。実行手順・IAM 条件・marker の DB 表現・digest 固定方式・staging mutation 排他の具体機構・saga 手順などの可逆な詳細は、それぞれ #445 runbook・各 Issue 着手時・dry-run 付きスクリプト PR へ委譲する。
- Gate C / Gate D の定義再編（fresh staging-full session 方式——構築検証 → final cleanup → attest → 最終アーキテクチャへの負荷試験——に合わせた再配置）は、本 ADR では決定しない。旧 Gate C / D はいずれも NOT RUN であり、Phase 4 着手前にこの定義へ従うべき実装が存在しない。一方、いま #335 だけを改称すると、旧語義で Gate を参照する live 子 Issue（#383 / #384 / #390 / #391）と語義が食い違う。再編は Phase 4 着手時に子 Issue の一括整合（saga）とまとめて確定し、本 ADR への追補または後続 ADR として記録する。

## 根拠

- 実測: #335 の正式な子 Issue 17 件のうち、PR + CI として切り出された 4 件はすべて統合テスト込みで収束し、Issue 散文に留まった作業は 10 ラウンドのレビューでもマージ済み成果物を生まなかった。収束装置は文書の精緻化ではなく、強制点（PR + CI + guard）である。強制化完了を受け入れ条件に置く決定はこの実測の一般化である。
- `docs/adr/README.md` は「現在の仕様・構成・運用手順は領域ごとの正本に従い、ADR は判断の記録」と定める。本決定はこの規約の適用であり、例外ではない。既存 ADR（0029/0032 等）が規範的・断定形で詳細に書けているのは、実装コードと同時に書かれ、書いた時点から強制点がコード側に存在したためである。本 ADR は実装に先行するため、policy 正本（#335）と強制化完了イベントの明示が必要になる。
- 不可逆境界（guard 前置、writer 切替の原子所有、marker、二段階 apply の段間境界、activation 順序）は、Phase 2〜3 の実装がこれに従わないと Phase 4 で作り直しになるため、着手時詳細化に委ねられない。逆に fresh 構築の実行順・preflight 細目・digest 固定方式・排他の具体機構・Gate C/D の定義再編は、dev リハーサルと担当 Issue 着手時に固めるほうが誤りが少ない。

## 反対材料・トレードオフ

- 本 ADR 単体では現行の不変条件を読めない（意図的。現在状態は #335 の policy と強制点を読む。README の「現在状態の確認では正本を優先」どおり）。
- policy の正本が可変な live Issue（#335）に恒久的に置かれる。編集は hidden marker・hash 照合・dry-run 付き saga スクリプトで管理するが、Git 履歴のような強い不変性はない。
- 手順の強制点（runbook / workflow）は手動 terraform 実行で迂回できる。guard 前置が fail closed で補強するが、手順そのものの機械強制は完全ではない。
- 機械強制できない項目（false-green 禁止、forward-fix 宣言）は、レビューと証跡という人の規律に残り続ける。
- 親 Issue 本文だけでは実行手順を再現できなくなる（意図的。再現性は runbook と script が担う）。
- Gate C/D の定義再編を先送りするため、再編までの間、#335 の計画（cleanup 後に最終アーキテクチャへ負荷試験）と現行の Gate C/D 定義（public contract 検証に負荷を含む）の間に表記のずれが残る。両 Gate とも Phase 4 まで実行しないため、このずれが判定に使われることはない。

## 追補（2026-08-10）

### 8. provisioning runbook の所有 Issue を #445 として採番する

本 ADR は §2 / §5 / §6 / §7 で fresh 構築の実行順・preflight 細目・evidence 保存手順・二段階 apply の段間方式の所有先を「#388 runbook」と表記していた。しかし #388 は Gate C 負荷検証の rate-limit 変更・復元 workflow であり、provisioning runbook を所有していない。#335 Phase 4 の新規採番（新規(a) = #418 / 新規(b) = #421 / 新規(d1) = #419 / 新規(d2) = #420）では新規(c) にあたる runbook Issue が起票されておらず、所有先が実在しない参照になっていた。#445 を新規(c) として採番し、本文の該当参照を修正する。#388 の実体（rate-limit workflow）は変更していない。あわせて §2 / §7 の「新規(d1)」表記を採番済みの #419 へ置き換えた。

この誤参照は、参照先の実在性を検証する強制点が存在しなかったために ADR merge 時のレビューを通過した。#335 の受け入れ条件が要求する policy → enforcement → evidence の対応付け検証は、対応先 Issue が実在することの確認を含む。

### 9. 子 Issue と Gate を 1 本に射影した実行順序ビューを #335 に置く

親 Issue #335 は Gate の状態（Gate 表）と子 Issue の依存（子 Issue 表）を別々に持ち、両者を貫く実行順序をどこにも持っていなかった。Gate と子 Issue の前後関係は各子 Issue 本文の散文（「証跡は #335 Gate C が所有する」等）からしか復元できず、親 Issue だけを読んでも実行順が定まらなかった。加えて #335 は wave 表・Gate 表・子 Issue 表という 3 つの表で同一の母集団を 3 通りに切っており、依存が 2 箇所に別記法で重複していた。#335 の表を「実行計画（子 Issue × Gate）」1 つへ統合し、全子 Issue と全 Gate が過不足なく 1 回ずつ現れる射影として置く。wave 区分は Phase 列、Gate の状態と証跡は状態列へ吸収し、3 表は廃止する。

- 本節は新しい依存を決めない。依存の正本は各子 Issue 本文であり、統合表はそこからの導出である。正本の二重化を避けるため、導出であることを節冒頭に明記する。
- 不採用案（配置）: (i) 実行順序を ADR に置く——append-only の ADR に可変な順序を置くと現在状態が読めなくなる（§1 と同じ理由）。(ii) Gate 表に子 Issue 列を足す——4 行の Gate 表に 22 件の子 Issue を詰めると、並行可能性と前提の区別を表現できない。(iii) 順序を持たず各子 Issue 本文に委ねる——これが従来であり、Gate C/D の再編方針と子 Issue 側の旧 Gate C 語義の食い違いを検出できなかった。
- 現行方針（Gate C/D を fresh staging-full session 内で実行）と、子 Issue 本文の旧 Gate C 語義（public contract 検証時点の負荷判定）の食い違いは §7 のとおり Phase 4 着手時の再編と saga で解消する。それまでの間、実行順序の現行方針は #335 の統合表を優先する旨を同節の注記に置く。

### 10. 進行状態は複製せず、GitHub 側を正本とする。Gate だけ人が持つ

統合表の状態列は Gate 行だけを埋め、子 Issue 行は埋めない。子 Issue の進行状態（open / closed）は GitHub が権威であり、#335 本文はそれを複製しない。子 Issue 集合の機械可読な正本は GitHub の Sub-issues とし、#335 受け入れ条件「全子 Issue が close され」の検証入力に使う。Gate は GitHub 上に実体を持たず、PASS 判定の主体が人の承認であるため、状態と証跡を #335 が持つ。

判断の原則は「機械が権威を持てるものは複製しない、機械が持てないものだけ人が持つ」である。統合表が持つのは構造（順序・依存・Phase・Gate の位置）であり、現況ではない。現況は GitHub の Sub-issues 欄が同一画面に描画するため、一覧性は失われない。

- 不採用案（状態の持ち方）: (iv) 状態列を手で複製する——Phase 4 完了までに 40 回前後の本文手編集が発生し、直し忘れによるドリフトと、16KB の本文編集時に無関係な節を壊すリスクを負う。本 ADR §8 の誤参照と同じ経路で腐る。(v) 生成器（YAML + 同期スクリプト + workflow）で状態列を自動生成する——権威ある情報源のコピーを維持するためだけの機構を新設する案。コピー自体をやめれば機構ごと不要になり、保守対象を 3 つ増やす分だけ純損になる。toil は自動化する前に消す。(vi) 状態をタスクリスト（チェックボックス）にする——表セル内のタスクリストは GitHub でクリック可能にレンダリングされないため、統合表と両立しない。加えて本文全体のタスク進捗に合算され、「子 Issue がすべて close されても本 Issue は完了しない」という #335 の設計と矛盾する指標を生む。
- Sub-issues の進捗表示も同じ理由で完了判定に使わない。その旨を #335 の注記に置く。チェックボックスは受け入れ条件にのみ用いる。
- 再検討の条件: 子 Issue 数がさらに増えて Sub-issues 欄の一覧性が失われた場合、または Gate の状態遷移が人の承認以外の入力を持つようになった場合。

## 再検討のトリガー

- dev リハーサル / Gate B の実測が本 ADR の決定と矛盾した場合。
- #419 / #384 / #445 の設計で、3 phase の参照正本・final cleanup marker・二段階 apply の段間境界のいずれかが実装不能と判明した場合。
- policy → enforcement → evidence の対応付けが #335 の受け入れ条件どおりに検証できない（強制点・検証テストと policy 項目の対応が取れない）事例が出た場合。
- prod 環境を実際に作る判断が生じた場合（本 ADR の前提は ephemeral dev/staging のみ）。
