// ファイル概要:
// このファイルは Playwright E2E の設定です（Issue #148）。
// 既定ではローカル full-stack（backend + frontend を webServer として起動）で実行し、
// E2E_BASE_URL を指定すると実環境（dev / staging の CloudFront URL）へ同じテストを流せます。
//
// ローカル / CI 実行の前提:
// - PostgreSQL / Valkey が起動済み（docker compose または CI service container）
// - スキーマ適用済み（npm run migration:run:local）
// - backend 用の環境変数（DATABASE_URL / VALKEY_URL / JWT_SECRET / COOKIE_SECURE=false / PORT=3100）
//   と frontend 用（API_PROXY_TARGET / API_BASE_URL = http://127.0.0.1:3100）を親プロセスで設定する
//   （webServer は親プロセスの環境変数を引き継ぐ）。

import { defineConfig, devices } from "@playwright/test";

// 実環境検証時は E2E_BASE_URL（例: https://ticket-app-dev.ticket-c2c.click）を指定する。
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3101";

export default defineConfig({
  testDir: "./e2e",
  // 購入フロー（在庫）はテスト間で状態を共有するため、直列実行にする。
  fullyParallel: false,
  workers: 1,
  // 実環境では検索プロジェクション（EventBridge → SQS → Worker → OpenSearch）の
  // 反映待ちがあるため、テスト全体のタイムアウトを長めにする。
  timeout: 120_000,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // 実環境（E2E_BASE_URL 指定時）はサーバーを起動しない。
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          // backend API（リポジトリルートで起動。環境変数は親プロセスから引き継ぐ）。
          command: "npm run start:dev",
          cwd: "..",
          url: "http://127.0.0.1:3100/health",
          reuseExistingServer: true,
          timeout: 60_000,
        },
        {
          // frontend は production build + next start で起動する。
          // - rewrites はビルド時に評価されるため、API_PROXY_TARGET をビルド時にも渡す必要がある
          // - dev サーバー（next dev / Turbopack）はこの実行環境で hydration が安定しないため使わない
          command: "npm run build && npx next start -p 3101",
          url: "http://127.0.0.1:3101/healthz",
          reuseExistingServer: true,
          timeout: 180_000,
        },
      ],
});
