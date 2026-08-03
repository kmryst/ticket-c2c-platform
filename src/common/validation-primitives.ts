// ファイル概要:
// このファイルは複数の domain boundary が共有する最小の validation primitive です
// （Issue #377 review 対応）。UUID 形式判定と PostgreSQL INTEGER 上限のような、
// 領域に依存しない純粋な事実だけをここへ集約します。
//
// 設計方針（review 9 対応）:
// - drift 防止のため、同じ「UUID 形式」「int4 上限」の定義を複数ファイルへ重複させない。
// - ただし各 domain boundary 固有の validation 責務（positive / nonnegative /
//   remaining <= total / field 固有のエラーメッセージ）はここへ寄せない。呼び出し側に残す。
// - 汎用 validation framework や巨大な utils module へ広げない。この module は
//   純粋関数のみで、他の src module へ依存しない（import cycle を作らない）。

// POSTGRES_INT4_MAX は PostgreSQL INTEGER（int4）の上限値です。
// 数量・version はこの範囲の safe integer に収めます。
export const POSTGRES_INT4_MAX = 2_147_483_647;

// UUID_PATTERN は canonical な UUID 文字列（大小文字許容）を判定する正規表現です。
// 直接 export せず、判定は isUuidString 関数経由で行います（drift の単一化）。
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// isUuidString は value が canonical UUID 文字列かどうかを判定します。
export function isUuidString(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
