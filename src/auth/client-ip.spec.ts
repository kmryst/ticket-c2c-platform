// ファイル概要:
// このファイルは resolveClientIp（trusted-hops 方式の X-Forwarded-For 解決。ADR-0012）の単体テストです。
// 「インフラが末尾に追加した既知の段数だけを信用し、クライアントの偽装値を拾わない」ことを検証します。

import { resolveClientIp } from './client-ip';

describe('resolveClientIp', () => {
  const ORIGINAL_ENV = process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS;
    } else {
      process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS = ORIGINAL_ENV;
    }
  });

  it('hops 未設定（ローカル既定）では XFF を信用せず TCP 接続元を返す', () => {
    delete process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS;

    const ip = resolveClientIp({
      headers: { 'x-forwarded-for': 'forged-ip' },
      ip: '127.0.0.1',
    });

    expect(ip).toBe('127.0.0.1');
  });

  it('hops=1（CloudFront→ALB 構成）では右から 2 番目（CloudFront が追記した viewer IP）を返す', () => {
    process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS = '1';

    // viewer 1.2.3.4 → CloudFront（viewer を追記）→ ALB（CloudFront edge を追記）
    const ip = resolveClientIp({
      headers: { 'x-forwarded-for': '1.2.3.4, 130.176.0.1' },
      ip: '10.0.1.5',
    });

    expect(ip).toBe('1.2.3.4');
  });

  it('クライアントが偽装値を先頭に足しても、右からの解決には影響しない', () => {
    process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS = '1';

    const ip = resolveClientIp({
      headers: { 'x-forwarded-for': '9.9.9.9, 1.2.3.4, 130.176.0.1' },
      ip: '10.0.1.5',
    });

    // 偽装値 9.9.9.9 ではなく、CloudFront が実際に見た viewer IP を採用する。
    expect(ip).toBe('1.2.3.4');
  });

  it('XFF の段数が足りない（想定経路を通っていない）場合は TCP 接続元へフォールバックする', () => {
    process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS = '2';

    const ip = resolveClientIp({
      headers: { 'x-forwarded-for': '130.176.0.1' },
      ip: '10.0.1.5',
    });

    expect(ip).toBe('10.0.1.5');
  });

  it('XFF ヘッダが無い場合も TCP 接続元へフォールバックする', () => {
    process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS = '1';

    const ip = resolveClientIp({ headers: {}, ip: '192.168.1.10' });

    expect(ip).toBe('192.168.1.10');
  });

  it('不正な hops 値（負数・非整数）は 0 として扱う（安全側）', () => {
    process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS = 'abc';

    const ip = resolveClientIp({
      headers: { 'x-forwarded-for': 'forged-ip, 1.2.3.4' },
      ip: '127.0.0.1',
    });

    expect(ip).toBe('127.0.0.1');
  });
});
