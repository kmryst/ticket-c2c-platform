# 0036. braces の advisory を Dependency Audit の期限付き例外にする

## ステータス

Accepted

## 日付

2026-10-06

## 背景

Dependency Audit（`npm audit --audit-level=high`、[ADR-0035](./0035-consolidate-dependency-cve-scanning.md)）の root / `frontend/` の両 job に、
braces の high advisory [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)（`braces <= 3.0.3`）が出ている。

| job | 依存経路 | 依存区分 |
| --- | --- | --- |
| root | `markdownlint-cli2` → `micromatch@4.0.8` → `braces@3.0.3`（`markdownlint-cli2` → `globby` → `fast-glob` → `micromatch` もある） | devDependency のみ |
| frontend | `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob@3.3.1` → `micromatch` → `braces@3.0.3` | devDependency のみ |

- braces の最新版は 3.0.3（2024-09 以降更新なし）で、修正版がない。lockfile の更新や `overrides` では解消できない
- frontend の `npm audit fix --force` は `eslint-config-next@14.2.35` への downgrade になり、Next.js 16 と組み合わせられない
- 実行イメージには含まれない。backend は `Dockerfile` の `npm prune --omit=dev`、frontend は Next.js standalone output で devDependencies を落とす
- advisory は深く入れ子にしたブレースパターンによるコールスタック枯渇（DoS）である。braces に渡るパターンは
  lint ツールの glob（リポジトリ内の設定とコマンドライン引数）だけで、外部の利用者が入力する経路はない

修正版のない advisory が残る限り、PR が何を変えても Dependency Audit は fail し続ける。常に fail しているゲートは誰も見なくなり、
新しい high が増えても気づけない。kmryst/idp-golden-path の reusable workflow は、同じ braces の advisory を受けて
期限付き例外の input（`npm-audit-exceptions`）を用意しており（idp-golden-path ADR-0008 追記 2026-07-28、#297）、
本リポジトリが pin している `@v1.7.1` に含まれている。kmryst/terraform-hannibal も同じ advisory を同じ方式で扱っている（ADR 0033、#655）。

## 決定

`.github/workflows/dependency-audit.yml` の root job と frontend job の両方で、reusable workflow に `npm-audit-exceptions` を渡し、
GHSA-vfj7-8cjw-p6xm を期限付き例外にする。

- 例外は `id: GHSA-vfj7-8cjw-p6xm` の 1 件だけ。`expires: 2026-12-31`、`tracking`: [#522](https://github.com/kmryst/ticket-c2c-platform/issues/522)
- `expires` は登録日から最大 90 日（評価器が強制する）。idp-golden-path #297 / terraform-hannibal #655 と同じ 2026-12-31 に揃え、見直し時期を合わせる
- 解除条件（braces 3.0.4 以上の公開、または `micromatch` / `fast-glob` / `markdownlint-cli2` / `@next/eslint-plugin-next` の braces 依存解消）は #522 で追跡する
- 不要になった例外を撤去する PR は自動では作らない。#522、Job Summary の stale 警告、期限切れによる fail closed で気づく

期限の更新・解除の手順は [セキュリティスキャン運用](../operations/security-scanning.md) を正本とする。

## 根拠

- 例外は GHSA 単位で、braces 以外の high はこれまでどおり fail する。評価器（idp-golden-path `scripts/ci/npm-audit-policy.mjs`）は
  `via` の連鎖を根本の advisory までたどるため、braces が原因で high になっている `micromatch` / `fast-glob` なども braces の例外として扱う
- 評価器は、まず本番依存（`--omit=dev`）を例外なしで判定し、通過した場合だけ full audit に例外を適用する。critical は例外にできず、
  期限切れ・書式の誤りは fail closed になる。例外が気づかないうちに恒久化することはない
- 評価器は idp-golden-path で実装・テスト済みで、pin した tag と同じ commit から取得される。本リポジトリで実装・保守するものは増えない
- 2026-10-06 にローカルで評価器（`v1.7.1`）を実行し、frontend は「Runtime dependencies: passed」「Full dependency graph: passed」、
  GHSA-vfj7-8cjw-p6xm が `allowed temporarily` になることを確認した

## 反対材料・トレードオフ

**root は、この例外だけでは success にならない。**
root の本番依存には別の high（`@grpc/grpc-js` / `@nestjs/platform-fastify` / `fastify` / `fast-uri`）が残っており、
評価器は例外を適用する前の本番依存の判定で fail closed になる。root で braces の例外が効くのは、これらを別 PR で解消した後である。
それでも root に先に入れておくのは、本番依存を解消した時点で braces だけが理由で fail し続ける状態を避けるためである。

**90 日ごとに期限を更新する PR が要る。** 更新する場合は露出を評価し直したうえで、その日から最大 90 日の期限にする。

検討して採らなかった案:

- **修正版が出るまで待つ**: 変更は不要だが、ゲートが fail し続けて検出の役目を果たさない状態が無期限に続く
- **`overrides` で braces を差し替える**: 指定できる修正版がない。fork への差し替えは `micromatch` との互換性をこちらで保証することになる
- **audit の閾値を下げる、または devDependency を audit から外す**: GHSA 単位ではなく severity・依存区分単位で検出をやめることになり、
  期限もない。ADR-0035 は devDependencies の CVE を `npm audit` だけが見ている前提に立っており、外すとその前提が崩れる
- **依存元を置き換える**（root の `markdownlint-cli2` を別 linter に、frontend の `eslint-config-next` を外す）: Dependency Audit を緑に戻す目的に対して変更範囲が大きく、
  Next.js 公式の lint 設定や idp-golden-path と揃えた Markdown Lint 設定を失う

## 再検討のトリガー

- braces 3.0.4 以上が公開された、または依存経路から braces がなくなった → 例外を削除し #522 を close する
- 2026-12-31 までに解除条件が揃わない → #522 に依存経路と継続理由を記録し、期限を更新する
- 期限の更新を 2 回以上繰り返しても修正版が出ない → 依存元の置き換えを再検討する
- 本番依存で修正版のない high が出た → 露出が違うため本 ADR の対象外として個別に判断する
- idp-golden-path が消費側にも撤去 PR を自動で作るようになった（idp-golden-path#310） → 運用を見直す

## 関連

- Issue: [#522](https://github.com/kmryst/ticket-c2c-platform/issues/522)（作業・解除条件の追跡）、[#521](https://github.com/kmryst/ticket-c2c-platform/issues/521)（next 16.3.8 への更新）
- [ADR-0035](./0035-consolidate-dependency-cve-scanning.md): npm 依存の CVE を Dependency Audit に一本化した判断
- [セキュリティスキャン運用](../operations/security-scanning.md)
- kmryst/idp-golden-path: [ADR-0008](https://github.com/kmryst/idp-golden-path/blob/main/docs/adr/0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md)（追記 2026-07-28）、[#297](https://github.com/kmryst/idp-golden-path/issues/297)、`scripts/ci/npm-audit-policy.mjs`
- kmryst/terraform-hannibal: [ADR 0033](https://github.com/kmryst/terraform-hannibal/blob/main/docs/adr/0033-adopt-expiring-npm-audit-exception-for-braces.md)、[#655](https://github.com/kmryst/terraform-hannibal/issues/655)
