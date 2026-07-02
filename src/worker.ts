// ファイル概要:
// このファイルは Worker プロセスの起動入口です（ADR-0006: API と同一イメージ・command 差し替え）。
// ECS タスク定義で `node dist/src/worker.js` を command に指定して起動します。

import 'dotenv/config';
import { getOptionalEnv } from './config';
import { SearchProjectionWorker } from './worker/search-projection.worker';

async function main() {
  const queueUrl = getOptionalEnv('SQS_QUEUE_URL');
  const opensearchEndpoint = getOptionalEnv('OPENSEARCH_ENDPOINT');

  if (!queueUrl || !opensearchEndpoint) {
    throw new Error(
      'SQS_QUEUE_URL and OPENSEARCH_ENDPOINT are required for the worker process',
    );
  }

  const worker = new SearchProjectionWorker(queueUrl, opensearchEndpoint);

  // ECS のタスク停止（SIGTERM）でポーリングループを閉じ、処理中メッセージを完了させてから終了します。
  process.on('SIGTERM', () => worker.stop());
  process.on('SIGINT', () => worker.stop());

  await worker.start();
}

void main().catch((error) => {
  console.error('worker fatal error:', error);
  process.exit(1);
});
