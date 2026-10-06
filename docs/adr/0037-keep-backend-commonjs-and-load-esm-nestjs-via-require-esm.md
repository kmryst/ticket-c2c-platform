# 0037. NestJS 12 系への移行で backend を CommonJS のまま維持し、ES Module の `@nestjs/*` を `require(esm)` で読み込む

## ステータス

Accepted

## 日付

2026-10-06

## 背景

backend（root の NestJS API）は NestJS 11 系で、`npm audit --omit=dev` が本番依存の high advisory を検出していた。

- `@nestjs/platform-fastify` < 11.2.4: [GHSA-9c5c-9qcx-q35q](https://github.com/advisories/GHSA-9c5c-9qcx-q35q)
- `fastify` < 5.12.5: [GHSA-p68q-wchp-6fh7](https://github.com/advisories/GHSA-p68q-wchp-6fh7) ほか 6 件

`@nestjs/platform-fastify` は `fastify` を exact pin しており、HTTP を処理する `fastify` は `@nestjs/*` の更新でしか上がらない（`.github/dependabot.yml` の `fastify` ignore、Issue #455）。
NestJS 12 系（12.1.2）は `fastify` 5.12.5 を pin しており、上記の advisory をすべて解消する。

NestJS 12 では `@nestjs/common` / `core` / `platform-fastify` / `jwt` などが `"type": "module"` の ES Module として配布される。
[移行ガイド](https://docs.nestjs.com/migration-guide) と [v12.0.0 のリリースノート](https://github.com/nestjs/nest/releases/tag/v12.0.0) は、Node.js の `require(esm)` により既存の CommonJS アプリケーションはそのまま動き、アプリケーション側の ESM 移行は任意だとしている。

一方、このリポジトリでは次の 2 点がそのままでは動かなかった（Dependabot PR #495 で Backend Build と Playwright E2E が失敗）。

- `tsconfig.json` の `"module": "Node16"` では、TypeScript が CommonJS のファイルから ES Module を import する箇所を TS1479 として拒否する。
  `require(esm)` を前提に CommonJS から ES Module の import を許可するのは `"module": "Node20"` / `"NodeNext"` だけである（TypeScript 5.8 以降）
- Jest（30 系、`ts-jest` で CommonJS に変換）は自前のモジュールローダーで `require()` を実装しているため、Node.js 本体の `require(esm)` を使わない。
  フラグなしでは 17 suite が `SyntaxError`（ES Module の `export` 文）で失敗した。Jest が ES Module を読み込むには Node.js の `vm` module API を有効にする `--experimental-vm-modules` が必要

## 決定

backend のモジュール形式は CommonJS（`package.json` に `"type"` なし）のまま維持し、ES Module の `@nestjs/*` は Node.js の `require(esm)` で読み込む。backend 全体の ESM 移行は行わない。
方式は kmryst/terraform-hannibal の ADR 0034 と揃える。

- `tsconfig.json` の `"module"` を `"Node16"` から `"Node20"` に変える。`moduleResolution` は `"Node16"` のまま。出力は従来どおり CommonJS（`require()`）である
- Jest を呼ぶ npm script（`test` / `test:migration:*` / `test:integration:*`）は `node --experimental-vm-modules node_modules/jest/bin/jest.js` で実行する。
  CI（`pr-check.yml`）で `npx jest` を直接呼んでいた 2 step と、`scripts/ci/dependabot-unblock.json` の probe も npm script 経由に変える
- runtime（`node:24-slim`）、CI（`actions/setup-node` の `"24"`）、ローカル（`.mise.toml` の Node.js 24.18.0）はいずれも Node.js 24 で、`require(esm)` はフラグなし・警告なしで使える（移行ガイドの要件は Node.js 20.19+ / 22.12+ / 24+）

## 根拠

- 変更範囲が `package.json` / `package-lock.json` / `tsconfig.json` / CI の Jest 呼び出しに収まり、`src/` のアプリケーションコードと Dockerfile は変更しない。依存更新と同じ PR でロールバック単位を小さく保てる
- main と同じコマンドで比較し、型チェック、unit（28 suites / 324 tests）、DB / Valkey / OpenSearch を使う統合テスト、build、Playwright E2E（7 tests）の結果が変わらないことを確認した（Issue #528 の PR）
- 本番イメージは起動ログに `ERR_REQUIRE_*` や `ExperimentalWarning` を出さず、起動ログの内容は main と同じだった。代表的な API 34 件の応答（Cookie 属性、JSON body parse のエラー、body サイズ上限、`/api` prefix の除去、CORS 未設定）も main と同じだった
- 目的は fastify の advisory 解消と NestJS 11 系に留まるリスクの回避であり、ESM 移行はこの目的に不要である

## 反対材料・トレードオフ

- **テストが Node.js の実験的機能に依存する。** `--experimental-vm-modules`（`vm.Module` API、Stability: 1 - Experimental）は Node.js の更新でフラグ名や挙動が変わる可能性がある。
  変わった場合はテストが全 suite 失敗として必ず表面化し、本番 runtime はこのフラグを使わないため影響はテストに限られる。テスト実行時に `ExperimentalWarning: VM Modules is an experimental feature` が出るが、依存していることが見えるよう抑止しない
- **`npx jest` を直接呼ぶと失敗する。** npm script を経由しないと ES Module を読めない。CI と `scripts/ci/dependabot-unblock.json` の呼び出しは npm script に揃えた
- **CommonJS と ES Module の混在が残る。** 依存に top-level `await` を含む ES Module が入ると `require(esm)` で読み込めず（`ERR_REQUIRE_ASYNC_MODULE`）、起動時に失敗する
- **全面 ESM 化（`"type": "module"`、`"module": "NodeNext"`、import への拡張子付与、Vitest への移行など）は採らなかった。** NestJS 12 の新規プロジェクトの既定に揃い、上記 2 つの制約から外れる利点はあるが、
  `ts-node` を使う開発用スクリプトや TypeORM の migration、Jest の設定まで変更範囲が広がり、依存更新と同じ PR では原因の切り分けとロールバックが難しくなる
- **`@nestjs/platform-fastify` だけ 11.2.4 に上げる案（Dependabot PR #518）は採らなかった。** GHSA-9c5c-9qcx-q35q は解消するが、11.2.4 が pin する `fastify` は 5.12.5 未満で、`fastify` の advisory が残る

## 再検討のトリガー

- `require(esm)` で読み込めない依存（top-level `await` を含む ES Module など）が backend の依存に入ったとき
- Node.js の次の major 更新（Node.js 26 への移行など）で、`require(esm)` または `--experimental-vm-modules` の扱いが変わったとき
- Jest の ESM 対応が安定版になった、またはフラグが不要になったとき（フラグを外す）
- Jest から Vitest への移行を検討するとき（ESM 移行と合わせて評価する）
- NestJS が CommonJS アプリケーションのサポートを縮小する方針を出したとき

## 関連

- Issue [#528](https://github.com/kmryst/ticket-c2c-platform/issues/528)、Dependabot PR #495 / #518
- [ADR-0034](./0034-toolchain-version-standardization-with-mise.md)（ツールチェーンの版の正本）、[ADR-0035](./0035-consolidate-dependency-cve-scanning.md)（npm audit による依存 CVE の検査）
- kmryst/terraform-hannibal ADR 0034（同じ方式の前例）
- [NestJS Migration guide](https://docs.nestjs.com/migration-guide)、[Node.js: Loading ECMAScript modules using require()](https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require)
