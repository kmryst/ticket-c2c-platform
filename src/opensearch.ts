// ファイル概要:
// このファイルは OpenSearch クライアントの生成 helper です。
// AWS 上（AWS_REGION が注入される ECS タスク）では SigV4 署名付きクライアントを生成し、
// staging 以降で OpenSearch のアクセスポリシーを IAM 認証必須へ切り替えられるようにします
// （production-readiness M-3。dev のアクセスポリシー自体は staging で切り替えるまで現状維持）。
// ローカル PoC など AWS 外では従来どおり無署名クライアントを返します。

import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { getOptionalEnv } from './config';

// ParsedEndpoint は endpoint の scheme と node URL です。
interface ParsedEndpoint {
  // scheme は 'http' / 'https' / 'none'（スキームなしホスト名）。
  scheme: 'http' | 'https' | 'none';
  // node は OpenSearch client へ渡す最終 URL。scheme なしは https:// を付与する。
  node: string;
}

// parseEndpoint は endpoint 文字列を検証し、scheme と node を返します。
// 空文字・不正 protocol・malformed endpoint は throw します（review 8: fail-open しない）。
function parseEndpoint(endpoint: string): ParsedEndpoint {
  if (typeof endpoint !== 'string' || endpoint.trim().length === 0) {
    throw new Error('OpenSearch endpoint is missing or empty');
  }
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(endpoint);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error(
        `unsupported OpenSearch endpoint protocol: ${schemeMatch[1]}`,
      );
    }
    // URL として妥当かも検証する（malformed は throw）。
    try {
      // eslint-disable-next-line no-new
      new URL(endpoint);
    } catch {
      throw new Error(`malformed OpenSearch endpoint: ${endpoint}`);
    }
    return { scheme, node: endpoint };
  }
  // スキームなしホスト名（AWS の OpenSearch ドメイン endpoint）。https:// を付与する。
  const node = `https://${endpoint}`;
  try {
    // eslint-disable-next-line no-new
    new URL(node);
  } catch {
    throw new Error(`malformed OpenSearch endpoint: ${endpoint}`);
  }
  return { scheme: 'none', node };
}

// isLocalHost は host が local / test container のものかを判定します。
function isLocalHost(host: string): boolean {
  return (
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host === 'opensearch'
  );
}

// createOpenSearchClient は production factory です（Issue #377 / review 8）。
// AWS runtime（AWS_REGION / AWS_DEFAULT_REGION あり）では SigV4 必須とし、http:// への
// fail-open を許しません。
// - region あり + スキームなしホスト -> https 化して SigV4
// - region あり + https           -> SigV4
// - region あり + http            -> throw（unsigned へ降格しない。明確な configuration error）
// - region なし + local/test HTTP  -> unsigned（現在の local / CI 互換）
// - 不正 protocol / malformed      -> throw
//
// local / CI の test 用 unsigned client は createTestOpenSearchClient を使い、AWS runtime の
// trust 判断（この関数）と混ぜません。
export function createOpenSearchClient(endpoint: string): Client {
  const { scheme, node } = parseEndpoint(endpoint);

  // ECS Fargate は AWS_REGION / AWS_DEFAULT_REGION をタスクへ自動注入します。
  const region =
    getOptionalEnv('AWS_REGION') ?? getOptionalEnv('AWS_DEFAULT_REGION');

  if (region) {
    if (scheme === 'http') {
      // AWS region が存在する runtime で http:// を渡された場合、無署名 client へ fail-open せず
      // 明確な configuration error として失敗させる（review 8）。
      throw new Error(
        'refusing to create an unsigned OpenSearch client for an http:// endpoint while an AWS region is configured; ' +
          'use https:// (SigV4) for AWS domains, or the explicit test-only client for local HTTP',
      );
    }
    return new Client({
      // AwsSigv4Signer が全リクエストへ SigV4 署名を付与します（service: es = マネージド OpenSearch ドメイン）。
      // 認証情報は task role（ECS のコンテナ認証情報エンドポイント）から defaultProvider で解決します。
      ...AwsSigv4Signer({
        region,
        service: 'es',
        getCredentials: () => defaultProvider()(),
      }),
      node,
    });
  }

  // region なし: local / CI。scheme を問わず無署名クライアント（現行 local Docker 開発経路）。
  return new Client({ node });
}

// createTestOpenSearchClient は local / CI の test 専用の無署名 client 生成経路です（review 8）。
// AWS runtime の trust 判断（createOpenSearchClient）と混ぜないため分離しています。
// local / test container 以外の host には接続させません。
export function createTestOpenSearchClient(endpoint: string): Client {
  const { node } = parseEndpoint(endpoint);
  const host = new URL(node).hostname;
  if (!isLocalHost(host)) {
    throw new Error(
      `createTestOpenSearchClient refuses non-local host: ${host}`,
    );
  }
  return new Client({ node });
}
