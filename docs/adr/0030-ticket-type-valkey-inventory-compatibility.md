# 0030. Ticket Type 単位の Valkey 在庫前段フィルタを compatibility artifact として実装する

## ステータス

Accepted

## 日付

2026-08-01

## 背景

ADR-0029 と Issue #376 は、Aurora PostgreSQL の authoritative writer を Event 単位から
Ticket Type 単位へ切り替える control-aware compatibility writer を導入した。
`inventory_writer_control.writer_mode`（`legacy` / `ticket_type`）が正本の active writer を
決め、その切替・seed・reconciliation・activation・rollback は Issue #378 が所有する。

購入 API の前段には Valkey の売り切れ前段フィルタがある。従来は Event 単位 counter
（`inventory:<eventId>` と `inventory:<eventId>:v`）だけを持ち、reserve / release / CAS sync /
requestId marker を Event scope で扱っていた。Ticket Type 単位 cutover では、この前段
フィルタも Ticket Type scope へ対応させる必要がある。ただし Valkey は在庫の正本ではなく、
実環境の seed・activation・rollback は #378 / #335 Gate B が所有する。

本 ADR は Issue #389 の Valkey failure domain だけを対象とし、PostgreSQL authoritative
writer（#376）、Search Projection（#377）、正本 activation（#378）、公開 Ticket Type API
（#379）は扱わない。

## 決定

### namespace

既存の Event 単位 key（`inventory:<eventId>` / `inventory:<eventId>:v`）は変更・削除しない。
Ticket Type 用に衝突しない新 namespace を追加する。

- `inventory:ticket-type:{<eventId>:<ticketTypeId>}:remaining`
- `inventory:ticket-type:{<eventId>:<ticketTypeId>}:revision`

同じ Lua script で扱う counter と revision は、Redis Cluster でも同じ hash slot に乗るよう
hash tag `{<eventId>:<ticketTypeId>}` を共有する。

Valkey の CAS revision は「counter 変更回数」を数える Valkey ローカルの値であり、#376 が
PostgreSQL transaction から返す inventory version（在庫行の `version` 列）とは別物として、
命名と型（`TicketTypeReserveResult.revision: string | null`）を分ける。

### 前段フィルタの経路選択（writer mode 追従）

前段フィルタが使う namespace（Event 単位 / Ticket Type 単位）は、#378 が所有する DB 上の
`writer_mode` に追従する。Valkey 単独の activation switch は追加しない。

- `legacy` mode: 従来どおり Event 単位 counter を使う（旧挙動を据え置く）。
- `ticket_type` mode: Ticket Type 単位 counter を使う。

経路選択のため、sold-out prefilter より前に `writer_mode` と Event の Ticket Type scope を
event 単位に in-process cache（既定 TTL 5 秒、`TICKET_TYPE_PREFILTER_CACHE_TTL_MS` で変更可）
で解決する。cache hit では PostgreSQL へ到達しないため、通常の sold-out request は解決目的の
DB クエリを発生させない。cache miss のときだけ `writer_mode` と Ticket Type 一覧を 1 接続で
まとめて読み、cache する。この read は routing hint であり advisory barrier を取らない。
在庫更新の正本判定は #376 の transaction が barrier 下で mode を再読する。

### Ticket Type 解決順と冪等性境界

prefilter scope の Type は次の優先順で解決する。

1. 内部呼び出しで明示された `ticketTypeId`
2. Event→単一/default Ticket Type cache
3. cache miss のときだけ PostgreSQL 問い合わせ

複数 Type かつ Type 省略で scope を安全に決められない場合は Valkey を bypass し、#376 の
transaction に判断させる。新規の Type 省略 request は Event に Type が正確に 1 件のときだけ
DB 側で許可する。保存済み requestId の replay は現在の Type 構成より優先し、Type 省略で保存
された requestId は後から Type が増えても replay できる（DB transaction が既存 row を replay
してから Type を解決するため）。

### reserve と CAS

reserve の Lua script は「counter 存在確認 → 在庫比較 → 減算 → revision 更新 → race-safe な
revision 取得」を原子的に行い、`reserved` 時だけ減算後の revision を返す。reserve 後に別の
`getCounterVersion` を呼ぶ設計にはしない（reserve と revision 取得の隙間に別 request が割り込む
ため）。reserve 結果は `reserved` / `sold_out` / `unknown` と、sync に使える revision または
利用不能を表す `null` を安全に表現する。

### fail-open と未 seed

新 Ticket Type counter は明示的な初期化または #378 の seed でのみ作成する。

- counter 未存在: `unknown` として PostgreSQL へ fail-open。
- Valkey 障害: PostgreSQL へ fail-open。
- `release` / `sync` は存在しない counter を作らない（Lua script が EXISTS を先に検査する）。
- merge または artifact deploy だけで新 counter を暗黙 activation しない。

`ticket_type` mode の EventsService は、PostgreSQL commit 後にだけ、作成した default Type の
counter と mapping を初期化する。commit 失敗時は Valkey へ何も作らない。`legacy` mode は
既存の Event counter 初期化を維持する。既存 Event 全件の seed / reconciliation は #378 の責務。

### Type 単位の補償

reserve / release / sync / revision / PostgreSQL 失敗時の補償は、すべて同じ
`eventId + ticketTypeId` scope を使う。Type A への操作が Type B の counter を変更しない。

reserve 後に新規在庫消費が成立しなかった場合（transaction error / rejected / idempotent
replay / payload 相違 409）は、reserve した Type と数量だけを補償する。PostgreSQL から sync
する値には Event 互換集計ではなく実際の Ticket Type 残数を使う。prefilter で解決した Type と
transaction が返す Type が異なる場合は、一方の DB 残数を別 Type の Valkey key へ sync せず、
安全側（reserve 分の release + log + metric）に倒す。

### requestId

`requestId + sold_out` は Valkey で即時終了させず PostgreSQL へ進め、DB が authoritative に
confirmed / rejected / 409 を決める。request marker の scope は既存どおり buyer + event +
requestId を維持する（DB の idempotency scope が Event 単位のため Ticket Type 単位へ変更しない）。

### rollback 境界

- Gate B 前: 新 Ticket Type 経路は `writer_mode = legacy` で自然に bypass され、直前の backend
  artifact へ戻せる。旧・新 namespace は削除しない。
- Gate B 後: Valkey だけを独立 rollback しない。#378 の controlled rollback により、在庫
  read / write 全体を `ticket_type` から `legacy` へ戻す。

## 根拠

- namespace を分離し hash tag を共有することで、Event 単位 key の意味を変えずに Ticket Type
  isolation と Redis Cluster での同一 slot 配置を両立できる。
- 経路選択を DB `writer_mode` に追従させることで、Valkey 単独の switch を増やさず、activation
  境界を #378 の単一 control に一致させられる。cache により Gate B 前の legacy 前段フィルタを
  維持したまま、cache hit の sold-out request を DB へ到達させない。
- reserve と revision を 1 script で原子的に返すことで、reserve と CAS 取得の間の race を閉じる。
- counter 未存在・障害を `unknown` fail-open にすることで、Valkey を正本にせず Aurora の条件付き
  更新を最終ガードにできる。
- 補償を Type scope に閉じ、cross-Type sync を禁止することで、別 Type の在庫を壊さない。

## 反対材料・トレードオフ

- writer mode を prefilter の routing に使うため、cache miss のとき（TTL 失効・新規 Event の
  初回・invalidate 後）は 1 回の軽量 DB read が発生する。sold-out flood が新しい event へ集中し、
  かつ cache が温まっていない瞬間は、その read が Aurora へ届く。
- writer mode は global だが per-event cache に snapshot するため、mode 切替は TTL の範囲で反映
  される。即時反映が必要な #378 は TTL 経過を待つか明示 invalidate / prime する。
- `requestId + sold_out` は Valkey の早期拒否後も PostgreSQL へ進むため、requestId を変え続ける
  traffic は DB 到達数と rejected row を増やす。前段 guard の再評価条件は
  `docs/runbooks/alarm-valkey-fail-open.md` に記録する。
- gate=unknown の confirmed drift 補正では reserve を伴わないため revision を別途読む。この経路は
  reserve と revision 取得の原子性を持たないが、自身の減算を保護する必要がないため CAS だけで足りる。
- in-process cache は ECS task ごとに独立するため、task 間で mapping の反映タイミングがずれる。

## 再検討のトリガー

- #379 が複数 Type 作成を公開し、単一 Type 前提の cache 境界が成り立たなくなるとき。
- requestId を変え続ける sold-out traffic の DB 到達率・rejected insert rate が Aurora 保護の
  閾値を超え、前段 guard / rate limit / 容量制御の追加が必要になったとき。
- Valkey が Redis Cluster へ移行し、hash tag 前提や単一ノード運用が変わるとき。
- requestId の scope または冪等性 payload contract を変更するとき（ADR-0029 と同期）。
- Purchase Session / Ticket Hold が直接購入の単一 `ticket_type_id` 構造を置き換えるとき。
