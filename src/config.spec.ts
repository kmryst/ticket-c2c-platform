// ファイル概要:
// このファイルは getJwtSecrets（JWT_SECRET の current/previous 解釈。ADR-0012、Issue #168）の単体テストです。
// プレーン文字列（ローカル PoC 後方互換）と JSON 形式（Secrets Manager）の両対応、
// 壊れた JSON での fail fast を検証します。

import { getJwtSecrets } from './config';

describe('getJwtSecrets', () => {
  const ORIGINAL = process.env.JWT_SECRET;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = ORIGINAL;
    }
  });

  it('プレーン文字列は current のみのシークレットとして扱う（後方互換）', () => {
    process.env.JWT_SECRET = 'plain-local-secret';

    expect(getJwtSecrets()).toEqual({ current: 'plain-local-secret' });
  });

  it('JSON 形式は current / previous の組として読む', () => {
    process.env.JWT_SECRET = JSON.stringify({
      current: 'new-secret',
      previous: 'old-secret',
    });

    expect(getJwtSecrets()).toEqual({
      current: 'new-secret',
      previous: 'old-secret',
    });
  });

  it('previous が空文字・省略の場合は「無し」として扱う（Terraform 初期値）', () => {
    process.env.JWT_SECRET = JSON.stringify({ current: 'only', previous: '' });
    expect(getJwtSecrets()).toEqual({ current: 'only' });

    process.env.JWT_SECRET = JSON.stringify({ current: 'only' });
    expect(getJwtSecrets()).toEqual({ current: 'only' });
  });

  it('未設定は起動時に失敗させる（fail fast）', () => {
    delete process.env.JWT_SECRET;

    expect(() => getJwtSecrets()).toThrow(/JWT_SECRET is required/);
  });

  it('JSON らしいのに parse できない値は失敗させる（壊れた設定で稼働しない）', () => {
    process.env.JWT_SECRET = '{"current": broken';

    expect(() => getJwtSecrets()).toThrow(/could not be parsed/);
  });

  it('current が無い・空の JSON は失敗させる', () => {
    process.env.JWT_SECRET = JSON.stringify({ previous: 'old-only' });
    expect(() => getJwtSecrets()).toThrow(/non-empty "current"/);

    process.env.JWT_SECRET = JSON.stringify({ current: '' });
    expect(() => getJwtSecrets()).toThrow(/non-empty "current"/);
  });
});
