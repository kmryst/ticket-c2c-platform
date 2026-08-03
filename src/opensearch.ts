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

// createOpenSearchClient は endpoint からクライアントを生成します。
// endpoint は次の 2 形式を受け付けます（Issue #377）:
// - スキーム付き URL（例: http://127.0.0.1:9200、https://example.com）: そのまま node に使う。
//   local / CI の security plugin 無効な HTTP endpoint を扱えるよう、常に https:// を付けない。
//   http:// を明示した endpoint は SigV4 署名を付けない（AWS SigV4 経路と混同しない）。
// - スキームなしホスト名（AWS の OpenSearch ドメイン endpoint）: https:// を付け、
//   AWS_REGION がある場合は SigV4 署名を付与する（AWS HTTPS + SigV4）。
export function createOpenSearchClient(endpoint: string): Client {
  const hasScheme = /^https?:\/\//i.test(endpoint);
  const node = hasScheme ? endpoint : `https://${endpoint}`;
  const isHttp = node.toLowerCase().startsWith('http://');

  // ECS Fargate は AWS_REGION / AWS_DEFAULT_REGION をタスクへ自動注入します。
  // region が無い、または明示 HTTP endpoint（local / CI）の場合は無署名クライアントにします。
  const region =
    getOptionalEnv('AWS_REGION') ?? getOptionalEnv('AWS_DEFAULT_REGION');
  if (!region || isHttp) {
    return new Client({ node });
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
