// ファイル概要:
// このファイルは stripApiPrefix の単体テストです（ADR-0011 決定 2、Issue #142）。
// CloudFront 経由の /api/* パスが既存ルートへ写像されること、
// 既存パスが書き換えられないことを検証します。

import { stripApiPrefix } from './api-prefix';

describe('stripApiPrefix', () => {
  it('/api/ 配下のパスからプレフィックスを取り除く', () => {
    expect(stripApiPrefix('/api/auth/login')).toBe('/auth/login');
    expect(stripApiPrefix('/api/events/search?eventType=music')).toBe(
      '/events/search?eventType=music',
    );
    expect(stripApiPrefix('/api/healthz')).toBe('/healthz');
  });

  it('/api 単独と /api?query はルートへ写像する', () => {
    expect(stripApiPrefix('/api')).toBe('/');
    expect(stripApiPrefix('/api?x=1')).toBe('/?x=1');
  });

  it('既存パス（プレフィックスなし）は書き換えない', () => {
    expect(stripApiPrefix('/auth/login')).toBe('/auth/login');
    expect(stripApiPrefix('/events')).toBe('/events');
    expect(stripApiPrefix('/healthz')).toBe('/healthz');
    expect(stripApiPrefix('/')).toBe('/');
  });

  it('/api で始まる別パス（/apixxx）は書き換えない', () => {
    expect(stripApiPrefix('/apixxx')).toBe('/apixxx');
  });
});
