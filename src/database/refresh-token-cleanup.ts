// ファイル概要:
// このファイルは refresh_tokens の期限切れ row を削除するクリーンアップロジック本体です
// （L-9 残課題、Issue #195）。エントリポイント（cleanup-refresh-tokens.ts）と
// 単体テストの両方から使えるよう、SQL と実行関数だけを持つ純粋な module にしています。
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
// - revoked_at による早期削除はしない。失効済みファミリーも上記の期限で自然に消え、
//   それまでは盗難調査の証跡として残る（削除条件が 1 つになり誤削除の余地も減る）。
// - rotate-on-use / reuse detection（refresh-tokens.service.ts）の状態遷移には一切関与しない。
//   削除対象は「全世代の絶対期限が猶予を超えて過ぎたファミリー」だけで、
//   これらは refresh に使われても期限切れとして 401 になるだけの row である。

// PoolClient 互換の最小 interface です。pg の Client / PoolClient のどちらでも動きます。
export interface QueryableClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rowCount: number | null }>;
}

// DEFAULT_RETENTION_DAYS は期限切れ後に row を保持する猶予日数の既定値です。
export const DEFAULT_RETENTION_DAYS = 30;

// CLEANUP_SQL はファミリー単位の削除 SQL です。$1 は猶予日数（整数）。
// make_interval で日数をパラメータ化し、SQL 文字列への埋め込みを避けます。
export const CLEANUP_SQL = `
DELETE FROM refresh_tokens
WHERE family_id IN (
  SELECT family_id
  FROM refresh_tokens
  GROUP BY family_id
  HAVING max(expires_at) < now() - make_interval(days => $1)
)
`;

// cleanupExpiredRefreshTokenFamilies は猶予超過ファミリーの row を削除し、削除件数を返します。
export async function cleanupExpiredRefreshTokenFamilies(
  client: QueryableClient,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    throw new Error(
      `retentionDays must be a non-negative integer, got: ${retentionDays}`,
    );
  }
  const result = await client.query(CLEANUP_SQL, [retentionDays]);
  return result.rowCount ?? 0;
}
