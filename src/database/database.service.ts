// ファイル概要:
// このファイルは NestJS API から PostgreSQL へ接続するための共有 service です。
// node-postgres の Pool を 1 つ管理し、購入処理が transaction 用の client を借り、
// アプリ終了時には pool を閉じる責務を持ちます。

// dotenv/config は .env の DATABASE_URL を process.env から読めるようにするために import します。
import 'dotenv/config';
// Injectable は DatabaseService を NestJS の DI 対象として登録する decorator です。
// OnModuleDestroy はアプリ終了時に呼ばれる lifecycle hook の interface です。
import { Injectable, OnModuleDestroy } from '@nestjs/common';
// Pool は PostgreSQL 接続プール、PoolClient はプールから借りた 1 接続を表します。
import { Pool, PoolClient } from 'pg';
// buildDatabaseUrl は DATABASE_URL、または dev 環境の DB_* 分解値から接続文字列を作ります。
// isDatabaseSslEnabled は Aurora など TLS 接続が必要な環境かを判定します。
import { buildDatabaseUrl, isDatabaseSslEnabled } from '../config';

// @Injectable() により、他の service から constructor injection で使えるようになります。
@Injectable()
// DatabaseService は API 全体で共有する PostgreSQL 接続管理役です。
export class DatabaseService implements OnModuleDestroy {
  // pool は API プロセス内で 1 つだけ作る PostgreSQL 接続プールです。
  // 購入処理ごとにこの pool から client を借りて、明示的な transaction を張ります。
  private readonly pool = new Pool({
    // 接続文字列はローカル（DATABASE_URL）と dev（DB_* + Secrets Manager 注入）の両対応です。
    connectionString: buildDatabaseUrl(),
    // Aurora では TLS で接続します。dev は VPC 内 + SG 制限を信頼し証明書検証を省略します。
    ssl: isDatabaseSslEnabled() ? { rejectUnauthorized: false } : undefined,
    // 接続確立が 5 秒を超えたら失敗させ、API が固まったように見える状態を避けます。
    connectionTimeoutMillis: 5000,
    // 未使用接続は 30 秒で pool から閉じ、ローカル PoC の余計な接続保持を抑えます。
    idleTimeoutMillis: 30_000,
    // API 側 pool の最大接続数です。PoC script の同時実行数はこれを超えないよう調整しています。
    // 人気イベント集中時に 1 タスクが Aurora のコネクションを食い尽くさないための上限でもあります。
    max: 10,
  });

  // constructor は DatabaseService 作成時に一度だけ実行されます。
  constructor() {
    // node-postgres では idle connection の予期しないエラーが pool の error event として出ます。
    // listener を置かないと Node.js の unhandled EventEmitter error としてプロセスが落ちる可能性があります。
    this.pool.on('error', (error) => {
      // ここでは回復処理まではせず、ローカル PoC で原因が見えるようログに残します。
      console.error('Unexpected pg pool error:', error);
    });
  }

  // connect は transaction を張りたい処理へ生の PoolClient を渡すための method です。
  connect(): Promise<PoolClient> {
    // PurchasesService は BEGIN / COMMIT / ROLLBACK を直接実行したいので、query wrapper ではなく client を借ります。
    return this.pool.connect();
  }

  // onModuleDestroy は NestJS が終了処理を行うときに呼び出されます。
  async onModuleDestroy() {
    // pg pool を閉じることで、ローカル実行時に Node.js の open handle が残るのを防ぎます。
    await this.pool.end();
  }
}
