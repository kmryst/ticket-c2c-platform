// ファイル概要:
// dropDatabaseWhenIdle（一時 DB を session 0 確認後に FORCE なしで DROP する helper）の単体テストです（Issue #534）。
// 実 PostgreSQL は使わず、pg_stat_activity の応答を返す fake client で制御フローだけを検証します。
// 実 PostgreSQL 上の挙動は、この helper を使う migration / integration spec が検証します。

import type { Client } from 'pg';
import { dropDatabaseWhenIdle } from './drop-database-when-idle';

interface FakeAdminClient {
  client: Client;
  queries: string[];
}

// sessionCounts を先頭から順に count(*) の応答として返し、尽きたら最後の値を返し続ける。
function createFakeAdminClient(
  sessionCounts: number[],
  options: { failForceDrop?: boolean } = {},
): FakeAdminClient {
  const queries: string[] = [];
  let index = 0;
  const query = jest.fn(async (text: string) => {
    queries.push(text);
    if (text.includes('count(*)::int AS n')) {
      const n = sessionCounts[Math.min(index, sessionCounts.length - 1)];
      index += 1;
      return { rows: [{ n }] };
    }
    if (text.includes('SELECT pid, state')) {
      return { rows: [{ pid: 4242, state: 'idle', query: 'SELECT 1' }] };
    }
    if (text.includes('WITH (FORCE)') && options.failForceDrop) {
      throw new Error('force drop failed');
    }
    return { rows: [] };
  });
  return { client: { query } as unknown as Client, queries };
}

const dropStatements = (queries: string[]) =>
  queries.filter((q) => q.startsWith('DROP DATABASE'));

describe('dropDatabaseWhenIdle', () => {
  it('session が 0 なら確認 1 回で FORCE なしの DROP を発行する', async () => {
    const fake = createFakeAdminClient([0]);

    await dropDatabaseWhenIdle(fake.client, 'tmp_db_1');

    expect(fake.queries).toHaveLength(2);
    expect(dropStatements(fake.queries)).toEqual([
      'DROP DATABASE "tmp_db_1"',
    ]);
  });

  it('session が残っている間は待ち、0 になってから FORCE なしで DROP する', async () => {
    const fake = createFakeAdminClient([3, 1, 0]);

    await dropDatabaseWhenIdle(fake.client, 'tmp_db_2', {
      deadlineMs: 1_000,
      intervalMs: 1,
    });

    const counts = fake.queries.filter((q) => q.includes('count(*)'));
    expect(counts).toHaveLength(3);
    expect(dropStatements(fake.queries)).toEqual([
      'DROP DATABASE "tmp_db_2"',
    ]);
  });

  it('上限内に 0 にならなければ、残存 session 情報付きで失敗し、best-effort の FORCE DROP だけを発行する', async () => {
    const fake = createFakeAdminClient([2]);

    await expect(
      dropDatabaseWhenIdle(fake.client, 'tmp_db_3', {
        deadlineMs: 20,
        intervalMs: 5,
      }),
    ).rejects.toThrow(
      /tmp_db_3 の残存 session が 20ms 以内に 0 になりませんでした.*"pid":4242/,
    );

    expect(dropStatements(fake.queries)).toEqual([
      'DROP DATABASE "tmp_db_3" WITH (FORCE)',
    ]);
  });

  it('上限超過時の FORCE DROP が失敗しても、残存 session 情報付きのエラーで失敗する', async () => {
    const fake = createFakeAdminClient([1], { failForceDrop: true });

    await expect(
      dropDatabaseWhenIdle(fake.client, 'tmp_db_4', {
        deadlineMs: 0,
        intervalMs: 1,
      }),
    ).rejects.toThrow(/tmp_db_4 の残存 session/);
  });

  it('DB 名の二重引用符を escape して DROP する', async () => {
    const fake = createFakeAdminClient([0]);

    await dropDatabaseWhenIdle(fake.client, 'odd"name');

    expect(dropStatements(fake.queries)).toEqual([
      'DROP DATABASE "odd""name"',
    ]);
  });
});
