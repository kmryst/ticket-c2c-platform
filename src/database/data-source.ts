// ファイル概要:
// このファイルは TypeORM versioned migrations 専用の DataSource 定義です（Issue #92）。
// アプリ本体は従来どおり pg Pool（DatabaseService）で raw SQL を使い、
// TypeORM は「migration の適用と適用履歴の管理」だけに使います（entity は定義しない）。
// 接続設定は schema-on-boot が使っていたものと同じ config helper を再利用します。

import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDatabaseUrl, getDatabaseSslConfig } from '../config';
import { Baseline1751594400000 } from './migrations/1751594400000-baseline';
import { AddUsers1783251707172 } from './migrations/1783251707172-add-users';
import { AddPurchasesBuyerFk1783252676631 } from './migrations/1783252676631-add-purchases-buyer-fk';
import { AddRefreshTokens1783307740648 } from './migrations/1783307740648-add-refresh-tokens';

// migrations は glob ではなく明示 import で列挙する。
// ts-node（ローカル）と dist（ECS）のどちらで実行してもパス解決が壊れないようにするため。
export const dataSource = new DataSource({
  type: 'postgres',
  url: buildDatabaseUrl(),
  // Aurora では RDS CA バンドルによる証明書検証つき TLS で接続する（production-readiness M-4）。
  ssl: getDatabaseSslConfig(),
  entities: [],
  migrations: [
    Baseline1751594400000,
    AddUsers1783251707172,
    AddPurchasesBuyerFk1783252676631,
    AddRefreshTokens1783307740648,
  ],
  // 適用履歴 table 名。既定の "migrations" は汎用的すぎるため明示する。
  migrationsTableName: 'typeorm_migrations',
});
