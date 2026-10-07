// ファイル概要:
// 実 PostgreSQL を使う spec が作成した一時 DB を、決定的に削除するテスト専用 helper です（Issue #534）。
// #394 / #395 で purchases の統合テストに入れた方式を、各 spec にコピーせずここに集約します。
//
// 背景（57P01）:
// client 側の pool.end() / DataSource.destroy() が resolve しても、server 側 backend の終了は
// 非同期に遅れる。この間に DROP DATABASE ... WITH (FORCE) を実行すると、残っている backend が
// 強制終了され、まだ idle client として追跡されている接続へ 57P01（terminating connection due to
// administrator command）が届く。error listener の無い pg.Pool では、これが Jest の unhandled error
// になり job が失敗する。
//
// 方式:
// pg_stat_activity 上の対象 DB の session 数が 0 になるまで待ってから、FORCE なしで DROP DATABASE する。
// 終了させる backend が存在しない状態で DROP するため、57P01 は発生しない。固定 sleep ではなく
// session 数を条件に即座に抜ける poll とし、待ち時間には上限を設ける。上限を超えた場合は、
// 残っている session の情報付きで明示的に失敗させる。
//
// production の build（tsconfig.json）からは src/testing/** を除外しています。

import type { Client } from 'pg';

/** session 数が 0 になるまで待つ時間の上限（#395 の実装と同じ値）。 */
export const DROP_DATABASE_IDLE_DEADLINE_MS = 5_000;
/** pg_stat_activity を確認する間隔（#395 の実装と同じ値）。 */
export const DROP_DATABASE_IDLE_POLL_INTERVAL_MS = 50;

export interface DropDatabaseWhenIdleOptions {
  /** 待ち時間の上限。既定は {@link DROP_DATABASE_IDLE_DEADLINE_MS}。 */
  deadlineMs?: number;
  /** 確認間隔。既定は {@link DROP_DATABASE_IDLE_POLL_INTERVAL_MS}。 */
  intervalMs?: number;
}

/**
 * 対象一時 DB への接続を spec 側ですべて閉じた後に呼ぶ。
 *
 * @param adminClient 対象 DB 以外（通常は postgres DB）に接続した管理用 client
 * @param databaseName 削除する一時 DB の名前（quote 前）
 */
export async function dropDatabaseWhenIdle(
  adminClient: Client,
  databaseName: string,
  options: DropDatabaseWhenIdleOptions = {},
): Promise<void> {
  const deadlineMs = options.deadlineMs ?? DROP_DATABASE_IDLE_DEADLINE_MS;
  const intervalMs = options.intervalMs ?? DROP_DATABASE_IDLE_POLL_INTERVAL_MS;
  const quotedName = quoteIdentifier(databaseName);
  const startedAt = Date.now();

  for (;;) {
    const { rows } = await adminClient.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`,
      [databaseName],
    );
    if (rows[0].n === 0) break;
    if (Date.now() - startedAt >= deadlineMs) {
      // 上限超過。残っている session を診断できるようにして失敗させる。
      // credential は connection string 側の情報で query text には出ないため、
      // pid / state / wait_event / query 先頭のみを出力する。
      const diagnostics = await adminClient.query(
        `SELECT pid, state, wait_event_type, wait_event, left(query, 120) AS query
           FROM pg_stat_activity
          WHERE datname = $1`,
        [databaseName],
      );
      // 失敗時に限り、一時 DB を残さないよう best-effort で FORCE DROP してから失敗させる。
      // FORCE はこの失敗時だけに限定し、正常時（session 0 を確認済み）には使わない。
      try {
        await adminClient.query(`DROP DATABASE ${quotedName} WITH (FORCE)`);
      } catch {
        // best-effort。DROP の失敗も下の残存 session 情報付きエラーで表面化する。
      }
      throw new Error(
        `一時 DB ${databaseName} の残存 session が ${deadlineMs}ms 以内に 0 になりませんでした。` +
          ` 残存 session: ${JSON.stringify(diagnostics.rows)}`,
      );
    }
    await delay(intervalMs);
  }

  await adminClient.query(`DROP DATABASE ${quotedName}`);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
