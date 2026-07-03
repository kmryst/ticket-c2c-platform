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

// createOpenSearchClient は endpoint（スキームなしのホスト名）からクライアントを生成します。
export function createOpenSearchClient(endpoint: string): Client {
  const node = `https://${endpoint}`;

  // ECS Fargate は AWS_REGION / AWS_DEFAULT_REGION をタスクへ自動注入します。
  // どちらも無い環境（ローカル）は AWS 外とみなし、無署名クライアントにします。
  const region =
    getOptionalEnv('AWS_REGION') ?? getOptionalEnv('AWS_DEFAULT_REGION');
  if (!region) {
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
