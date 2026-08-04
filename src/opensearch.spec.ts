// ファイル概要:
// このファイルは createOpenSearchClient / createTestOpenSearchClient の単体テストです
// （Issue #377 review 8）。AWS runtime で http:// endpoint が渡された場合に無署名 client へ
// fail-open せず throw すること、不正 protocol / malformed endpoint を拒否すること、
// region なしの local/CI HTTP 経路が従来どおり動くことを固定します。
//
// 実ネットワークへは接続しません（Client 生成が throw するか否かだけを検証）。

import { createOpenSearchClient, createTestOpenSearchClient } from './opensearch';

describe('createOpenSearchClient（review 8: SigV4 fail-open 防止）', () => {
  const savedRegion = process.env.AWS_REGION;
  const savedDefaultRegion = process.env.AWS_DEFAULT_REGION;

  afterEach(() => {
    if (savedRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = savedRegion;
    if (savedDefaultRegion === undefined) delete process.env.AWS_DEFAULT_REGION;
    else process.env.AWS_DEFAULT_REGION = savedDefaultRegion;
  });

  it('region あり + スキームなしホストは https 化して SigV4 client を作る（throw しない）', () => {
    process.env.AWS_REGION = 'ap-northeast-1';
    delete process.env.AWS_DEFAULT_REGION;
    expect(() =>
      createOpenSearchClient('search-domain.ap-northeast-1.es.amazonaws.com'),
    ).not.toThrow();
  });

  it('region あり + https は SigV4 client を作る（throw しない）', () => {
    process.env.AWS_REGION = 'ap-northeast-1';
    expect(() =>
      createOpenSearchClient('https://search-domain.es.amazonaws.com'),
    ).not.toThrow();
  });

  it('region あり + http は unsigned へ降格せず throw する', () => {
    process.env.AWS_REGION = 'ap-northeast-1';
    expect(() => createOpenSearchClient('http://127.0.0.1:9200')).toThrow(
      /unsigned OpenSearch client/i,
    );
  });

  it('AWS_DEFAULT_REGION のみでも http は throw する', () => {
    delete process.env.AWS_REGION;
    process.env.AWS_DEFAULT_REGION = 'us-east-1';
    expect(() => createOpenSearchClient('http://localhost:9200')).toThrow();
  });

  it('region なし + local/test HTTP は無署名 client を作る（local/CI 互換）', () => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    expect(() => createOpenSearchClient('http://127.0.0.1:9200')).not.toThrow();
  });

  it('不正 protocol は throw する', () => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    expect(() => createOpenSearchClient('ftp://127.0.0.1:9200')).toThrow(
      /unsupported OpenSearch endpoint protocol/i,
    );
  });

  it('空文字の endpoint は throw する', () => {
    delete process.env.AWS_REGION;
    expect(() => createOpenSearchClient('')).toThrow(/missing or empty/i);
  });
});

describe('createTestOpenSearchClient（review 8: test 専用 unsigned 経路）', () => {
  const savedRegion = process.env.AWS_REGION;

  afterEach(() => {
    if (savedRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = savedRegion;
  });

  it('local host なら region の有無に関係なく無署名 client を作る', () => {
    process.env.AWS_REGION = 'ap-northeast-1';
    expect(() =>
      createTestOpenSearchClient('http://127.0.0.1:9200'),
    ).not.toThrow();
  });

  it('non-local host は拒否する（AWS trust 判断と混ぜない）', () => {
    delete process.env.AWS_REGION;
    expect(() =>
      createTestOpenSearchClient('http://search-domain.es.amazonaws.com'),
    ).toThrow(/non-local host/i);
  });
});
