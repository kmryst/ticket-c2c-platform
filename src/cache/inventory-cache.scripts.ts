// ファイル概要:
// このファイルは Valkey 在庫カウンタの Lua script のうち、InventoryCacheService と
// Gate B の seed / reconcile CLI（Issue #378 / src/cutover/reconcile-inventory-counters.ts）が
// 共有するものの正本です（キー生成規則の正本は inventory-cache.keys.ts）。
// 既存 script の文字列は InventoryCacheService から移動しただけで変更していません。
//
// RESERVE / RELEASE 系と legacy SYNC_SCRIPT は購入 API（InventoryCacheService）専用の
// まま service 側に残します（CLI から購入経路の script を実行できる面を増やさない）。

// INIT_SCRIPT はイベント作成時の Event 単位カウンタ初期化です。
// KEYS[1]=カウンタ、KEYS[2]=version。version を進めることで、
// 初期化をまたいだ古い syncCounter の CAS を失敗させます。
export const INIT_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1])
redis.call('INCR', KEYS[2])
return 'initialized'
`;

// TICKET_TYPE_INIT_SCRIPT は Ticket Type 単位 counter の明示的な初期化です。
// #378 の seed か、EventsService が ticket_type mode で作った default Type だけが呼びます。
export const TICKET_TYPE_INIT_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1])
redis.call('INCR', KEYS[2])
return 'initialized'
`;

// TICKET_TYPE_SYNC_SCRIPT は DB の Ticket Type 残数による CAS 上書きです。
// counter 不在時はキーを作らず skip します（未 seed の Type を暗黙 activation しない）。
// ARGV[2]（DB 判定前に控えた revision）と現在の revision が一致する場合だけ SET します。
export const TICKET_TYPE_SYNC_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'skipped'
end
local revision = redis.call('GET', KEYS[2])
if revision == false then
  revision = '0'
end
if revision ~= ARGV[2] then
  return 'skipped'
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('INCR', KEYS[2])
return 'synced'
`;

// CLI_LEGACY_GUARDED_SYNC_SCRIPT は seed / reconcile CLI 専用の legacy Event counter
// CAS sync です（Issue #378）。購入 API の SYNC_SCRIPT（inventory-cache.service.ts）には
// EXISTS ガードが無く、counter 不在 + version 不在（'0' 扱い）で expected '0' が一致すると
// キーを新規作成してしまいます。counter の捏造は RELEASE_SCRIPT が明示的に避けている
// 設計（実在庫と無関係なカウンタが誤拒否の温床になる）に反するため、CLI の reconcile は
// この EXISTS ガード付き script を使い、counter 不在時はキーを作らず skip します。
// 購入 API 側の既存 script は変更しません（挙動互換の維持）。
export const CLI_LEGACY_GUARDED_SYNC_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'skipped'
end
local version = redis.call('GET', KEYS[2])
if version == false then
  version = '0'
end
if version ~= ARGV[2] then
  return 'skipped'
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('INCR', KEYS[2])
return 'synced'
`;
