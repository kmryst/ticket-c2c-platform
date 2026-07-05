// ファイル概要:
// このファイルは jest の設定です（Issue #129 で単体テスト基盤として導入）。
// - src 配下の *.spec.ts を対象にする（NestJS の慣例）
// - ts-jest で TypeScript のままテストを実行する（tsconfig.json の設定を使う）
// - InventoryCacheService の spec は実 Valkey（Docker Compose またはCI の service container、
//   既定 redis://127.0.0.1:6379）へ接続して Lua script の実挙動を検証する
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  // 本体ビルド（tsconfig.json）は spec を除外しているため、
  // テストは jest 用の tsconfig.spec.json（types に jest を追加）で変換します。
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.spec.json' }],
  },
  // Valkey へ接続する spec があるため、接続待ちを考慮して既定 5s より長めにします。
  testTimeout: 15000,
};
