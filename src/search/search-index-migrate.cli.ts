// ファイル概要:
// このファイルは OpenSearch events index の mapping migration CLI です（Issue #377 / ADR-0031）。
// index 未存在なら完全 mapping で作成し、存在すれば idempotent な additive putMapping を適用します
// （ensureEventsIndex）。破壊的変更・index 削除はしません。
//
// 位置づけ:
// - PostgreSQL の DDL を起動時ではなく 1 回きりの migration ステップ
//   （db-migrate-<env>.yml / migration:run:local）で扱うのと同じパターンです。
// - Worker の起動処理は mapping 更新 API を呼ばず、index の存在確認だけを行います。
//   mapping の作成・更新は、deploy 時にこの CLI を 1 回実行して済ませます。
// - AWS 環境では deploy-backend-<env>.yml（deploy-service.yml）が、サービス更新の前に毎回
//   API の task definition を command override した ECS run-task でこの CLI を実行します
//   （Issue #538 / ADR-0039）。冪等なので毎回実行してよく、失敗したらサービスは更新されません。
//
// exit code:
//   0 = 成功（mapping を作成 / additive 適用済み）
//   1 = 実行エラー
//
// 実行例:
//   node dist/src/search/search-index-migrate.cli.js
//   npm run search-index:migrate:local

import 'dotenv/config';
import { getOptionalEnv } from '../config';
import { createOpenSearchClient } from '../opensearch';
import { ensureEventsIndex, EVENTS_INDEX } from './events-projection.store';

async function main(): Promise<number> {
  const endpoint = getOptionalEnv('OPENSEARCH_ENDPOINT');
  if (!endpoint) {
    throw new Error('OPENSEARCH_ENDPOINT is required for search index migration');
  }
  const opensearch = createOpenSearchClient(endpoint);
  await ensureEventsIndex(opensearch, EVENTS_INDEX);
  process.stdout.write(
    `${JSON.stringify({ index: EVENTS_INDEX, status: 'ensured' })}\n`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        error:
          error instanceof Error ? error.message : 'search index migration failed',
      })}\n`,
    );
    process.exit(1);
  });
