// ファイル概要:
// このファイルは refresh_tokens の期限切れ row を削除するクリーンアップロジック本体です
// （L-9 残課題、Issue #195。実行経路は Issue #542 / ADR-0041 で api 内の定期実行へ移した）。
// api の定期実行（refresh-token-cleanup.service.ts）、手動実行の入口（cleanup-refresh-tokens.ts）、
// 単体テストのすべてから使えるよう、SQL と実行関数だけを持つ純粋な module にしています。
//
// 設計判断:
// - 監査・不正利用調査（reuse detection の追跡）のため、期限切れ直後には消さず
//   30 日（既定）の猶予を置く。expires_at は発行から 14 日（ADR-0012）の絶対期限なので、
//   削除対象は「発行からおよそ 44 日以上前」の row になる。
// - row 単位ではなくトークンファミリー単位で削除する。refresh_tokens は
//   parent_token_id / replaced_by_token_id の自己参照 FK で世代の系譜を持つため、
//   row 単位で消すと「親は猶予超過・子はまだ猶予内」のとき FK 違反で失敗する。
//   ファミリー内の最大 expires_at が猶予を超えた時点でファミリー全 row を
//   1 statement で消せば、自己参照 FK は statement 終了時点で整合し安全に削除できる。
//   （ファミリーの寿命は最後の rotate から 14 日で尽きるため、遅延は最大でも 14 日。）
// - 1 statement で消すファミリー数に上限（batchSize）を置き、上限に達した間は statement を繰り返す。
//   各 statement は autocommit で、ファミリー単位の削除は statement 内で完結するので FK は常に整合する。
//   大量に溜まった場合でも 1 transaction の row lock・WAL を一定量に抑え、api のリクエスト処理と
//   長時間競合しないようにする（Issue #542）。
// - revoked_at による早期削除はしない。失効済みファミリーも上記の期限で自然に消え、
//   それまでは盗難調査の証跡として残る（削除条件が 1 つになり誤削除の余地も減る）。
// - rotate-on-use / reuse detection（refresh-tokens.service.ts）の状態遷移には一切関与しない。
//   削除対象は「全世代の絶対期限が猶予を超えて過ぎたファミリー」だけで、
//   これらは refresh に使われても期限切れとして 401 になるだけの row である。
//
// 多重実行の防止（Issue #542 / ADR-0041）:
// - api は複数タスク（staging full で 2〜4）で動くため、PostgreSQL の session-level advisory lock
//   （pg_try_advisory_lock）で同時刻の実行を 1 つに絞る。lock を取れなかった側は何もしない。
// - transaction-level lock（pg_try_advisory_xact_lock）にしないのは、バッチごとに commit したいため。
//   xact lock は transaction の終了で解放されるので、全バッチを 1 transaction に入れることになり、
//   バッチに分けて row lock の保持時間を短くする意味がなくなる。
// - session-level lock は「lock と unlock を同じ接続で行う」「解放を忘れない」が前提になる。
//   このため呼び出し側は pool から借りた接続ではなく、この処理専用の接続（pg Client）を使い、
//   最後に必ず接続を閉じる。unlock に失敗しても、接続を閉じれば session 終了で lock は解放される。

// pg の Client 互換の最小 interface です。pg の Client / PoolClient のどちらでも動きます。
export interface QueryableClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rowCount: number | null; rows: unknown[] }>;
}

// DEFAULT_RETENTION_DAYS は期限切れ後に row を保持する猶予日数の既定値です。
export const DEFAULT_RETENTION_DAYS = 30;

// DEFAULT_BATCH_SIZE は 1 statement で削除するファミリー数の上限の既定値です。
// 1 ファミリーは rotate の回数だけ row を持つ（14 日の寿命で多くても数十 row）ため、
// 1 statement あたりの削除 row 数はおおむね数千〜数万に収まります。
export const DEFAULT_BATCH_SIZE = 1000;

// DEFAULT_MAX_BATCHES は 1 回の実行で繰り返す statement 数の上限の既定値です。
// 想定外に溜まっていても 1 回の実行時間に上限を置き、残りは翌日の実行に回します。
export const DEFAULT_MAX_BATCHES = 100;

// REFRESH_TOKEN_CLEANUP_ADVISORY_LOCK_KEY は多重実行防止に使う advisory lock のキーです。
// run-migrations.ts の MIGRATION_ADVISORY_LOCK_KEY（7513594）と衝突しない値にしています。
export const REFRESH_TOKEN_CLEANUP_ADVISORY_LOCK_KEY = 7513595;

// CLEANUP_SQL はファミリー単位の削除 SQL です。$1 は猶予日数（整数）、$2 は 1 statement の
// ファミリー数上限。make_interval で日数をパラメータ化し、SQL 文字列への埋め込みを避けます。
// 削除した row 数とファミリー数を 1 行で返し、ファミリー数が上限未満なら残りは無いと判断します。
export const CLEANUP_SQL = `
WITH target AS (
  SELECT family_id
  FROM refresh_tokens
  GROUP BY family_id
  HAVING max(expires_at) < now() - make_interval(days => $1)
  LIMIT $2
),
deleted AS (
  DELETE FROM refresh_tokens
  WHERE family_id IN (SELECT family_id FROM target)
  RETURNING family_id
)
SELECT
  count(*)::int AS deleted_rows,
  count(DISTINCT family_id)::int AS deleted_families
FROM deleted
`;

export const TRY_LOCK_SQL = 'SELECT pg_try_advisory_lock($1) AS locked';
export const UNLOCK_SQL = 'SELECT pg_advisory_unlock($1) AS unlocked';

export interface CleanupOptions {
  // batchSize は 1 statement で削除するファミリー数の上限です。
  batchSize?: number;
  // maxBatches は 1 回の実行で繰り返す statement 数の上限です。
  maxBatches?: number;
}

export interface CleanupResult {
  // deletedRows は削除した row の合計です。
  deletedRows: number;
  // deletedFamilies は削除したファミリーの合計です。
  deletedFamilies: number;
  // batches は実行した削除 statement の数です。
  batches: number;
  // reachedMaxBatches は上限に達して打ち切った（残りがある可能性がある）ことを表します。
  reachedMaxBatches: boolean;
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got: ${value}`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
}

// cleanupExpiredRefreshTokenFamilies は猶予超過ファミリーの row をバッチに分けて削除し、件数を返します。
// lock は取りません。多重実行の防止が必要な経路は runRefreshTokenCleanupWithLock を使います。
export async function cleanupExpiredRefreshTokenFamilies(
  client: QueryableClient,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  assertNonNegativeInteger('retentionDays', retentionDays);
  assertPositiveInteger('batchSize', batchSize);
  assertPositiveInteger('maxBatches', maxBatches);

  const result: CleanupResult = {
    deletedRows: 0,
    deletedFamilies: 0,
    batches: 0,
    reachedMaxBatches: false,
  };

  while (result.batches < maxBatches) {
    const response = await client.query(CLEANUP_SQL, [retentionDays, batchSize]);
    const row = response.rows[0] as
      | { deleted_rows: number; deleted_families: number }
      | undefined;
    const deletedRows = row?.deleted_rows ?? 0;
    const deletedFamilies = row?.deleted_families ?? 0;
    result.batches += 1;
    result.deletedRows += deletedRows;
    result.deletedFamilies += deletedFamilies;
    // 上限未満なら、この時点の削除対象はすべて消えています。
    if (deletedFamilies < batchSize) {
      return result;
    }
  }
  result.reachedMaxBatches = true;
  return result;
}

export interface LockedCleanupOptions extends CleanupOptions {
  retentionDays?: number;
  // minLockHoldMs は lock を保持する最短時間です。削除がすぐ終わっても、この時間が経つまで
  // unlock しません。各タスクの定期実行の発火時刻は接続確立や Aurora の再開待ちで数秒ずれるため、
  // 先に終わったタスクが unlock した後に遅れたタスクが lock を取り、同じ日に 2 回目を実行するのを防ぎます。
  // （2 回目を実行しても DELETE は冪等で 0 件になるだけですが、実行を 1 回に揃えます。）
  minLockHoldMs?: number;
  // sleep は minLockHoldMs の待機に使う関数です（テストで差し替えます）。
  sleep?: (ms: number) => Promise<void>;
  // now は経過時間の計測に使う関数です（テストで差し替えます）。
  now?: () => number;
  // onUnlockError は unlock の失敗を通知する関数です。失敗しても例外にはしません
  // （呼び出し側が接続を閉じれば session 終了で lock は解放されるため）。
  onUnlockError?: (error: unknown) => void;
}

export type LockedCleanupResult =
  | ({ status: 'completed' } & CleanupResult)
  | { status: 'skipped' };

// runRefreshTokenCleanupWithLock は advisory lock を取れたときだけクリーンアップを実行します。
// lock を取れなかった（他のタスクが実行中）ときは何もせず skipped を返します。
// client はこの処理専用の接続を渡し、呼び出し側が最後に必ず閉じてください（ファイル冒頭の説明）。
export async function runRefreshTokenCleanupWithLock(
  client: QueryableClient,
  options: LockedCleanupOptions = {},
): Promise<LockedCleanupResult> {
  const now = options.now ?? Date.now;
  const lockResponse = await client.query(TRY_LOCK_SQL, [
    REFRESH_TOKEN_CLEANUP_ADVISORY_LOCK_KEY,
  ]);
  const locked = (lockResponse.rows[0] as { locked?: boolean } | undefined)
    ?.locked;
  if (locked !== true) {
    return { status: 'skipped' };
  }

  const startedAt = now();
  try {
    const result = await cleanupExpiredRefreshTokenFamilies(
      client,
      options.retentionDays ?? DEFAULT_RETENTION_DAYS,
      options,
    );
    const remainingHoldMs = (options.minLockHoldMs ?? 0) - (now() - startedAt);
    if (remainingHoldMs > 0 && options.sleep) {
      await options.sleep(remainingHoldMs);
    }
    return { status: 'completed', ...result };
  } finally {
    try {
      await client.query(UNLOCK_SQL, [REFRESH_TOKEN_CLEANUP_ADVISORY_LOCK_KEY]);
    } catch (error) {
      options.onUnlockError?.(error);
    }
  }
}
