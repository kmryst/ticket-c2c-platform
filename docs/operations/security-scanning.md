# セキュリティスキャン運用

本リポジトリの CI で実行するセキュリティスキャンの責務分担を示します。

各スキャンの severity 閾値・fail/warn ポリシー・検出時の対応フロー・reusable workflow の inputs は、
共通の正本である [kmryst/idp-golden-path `docs/operations/security-scanning.md`](https://github.com/kmryst/idp-golden-path/blob/main/docs/operations/security-scanning.md)
に従います。本ドキュメントは「このリポジトリで何がどう呼ばれているか」だけを持ちます。

## 責務分担

| workflow | 検出対象 | 実行タイミング | 検出時の扱い |
| --- | --- | --- | --- |
| [Gitleaks Secret Scan](../../.github/workflows/gitleaks-secret-scan.yml) | git 履歴への secret / credential 混入 | PR | fail（required status check） |
| [Dependency Audit](../../.github/workflows/dependency-audit.yml) | npm 依存（root / `frontend/`）の既知脆弱性（CVE） | PR / 週次 / 手動 | high 以上で fail（[期限付き例外](#dependency-audit-の期限付き例外)を除く） |
| [CodeQL](../../.github/workflows/codeql.yml) | 自分が書いたコードの脆弱なパターン（SAST） | PR / main push / 週次 | Security > Code scanning alerts に集約 |
| [Security Scan / trivy-image-backend, trivy-image-frontend](../../.github/workflows/security-scan.yml) | コンテナイメージの中身（`node:24-slim` の OS パッケージ、Node 公式イメージ同梱の npm 自身の依存） | 週次 / 手動 | 非 blocking。Security > Code scanning alerts と Step Summary |
| [Trivy Config Scan](../../.github/workflows/trivy-config-scan.yml) | IaC（`terraform/**`）と Dockerfile の設定不備（misconfiguration） | PR（paths filter 付き）/ 週次 / 手動 | 非 blocking。Step Summary + artifact |

検出レイヤーが異なり、相互に代替できません。

- **Gitleaks**: 自分が書いたものに秘密情報が混入していないか
- **Dependency Audit**: lockfile が宣言する依存に既知脆弱性がないか
- **CodeQL**: 自分が書いたコードに脆弱なパターンがないか
- **Trivy Image Scan**: アプリを載せる土台（ベースイメージ）に既知脆弱性がないか
- **Trivy Config Scan**: まだ動いていない設定ファイルの書き方が危険でないか

`npm audit` と Dependabot alerts はいずれも lockfile が宣言する依存しか見ないため、
ベースイメージの OS パッケージや `/usr/local/lib/node_modules/npm/node_modules/` 配下は原理的に対象外です。
その空白を Trivy Image Scan が埋めます。

## npm 依存の CVE を Dependency Audit に一本化している理由

lockfile 由来の CVE は Dependency Audit（`npm audit`）と Dependabot alerts の 2 経路で見ます。
かつて `security-scan.yml` にあった Trivy `fs` は同じ領域の 3 経路目であり、
重複による alert fatigue を避けるため撤去しました（[ADR-0035](../adr/0035-consolidate-dependency-cve-scanning.md)）。

Trivy Image Scan は `fs` の代替ではありません。実行イメージは devDependencies を含みません
（backend は `Dockerfile` の `npm prune --omit=dev`、frontend は Next.js standalone output）。
devDependencies を含む全依存区分を見ているのは
`npm audit`（`--include=prod --include=dev --include=optional --include=peer`）です。

## Dependency Audit の期限付き例外

修正版のない advisory は、reusable workflow の `npm-audit-exceptions` input で期限付き例外にできます
（idp-golden-path ADR-0008 追記 2026-07-28 / [ADR-0036](../adr/0036-expiring-npm-audit-exception-for-braces.md)）。
宣言場所は [dependency-audit.yml](../../.github/workflows/dependency-audit.yml) の各 job の `with:` です。

- 各要素は `id`（GHSA ID）・`expires`（UTC の `YYYY-MM-DD`、登録日から最大 90 日）・`tracking`（追跡 Issue の URL）の 3 つだけを持つ
- 例外は full audit にだけ適用される。本番依存（`--omit=dev`）の audit は例外なしで先に判定され、そこで high 以上があれば例外を適用する前に fail closed になる
- critical は例外にできない。期限切れ・書式不正も fail closed になる
- 判定結果は job の Step Summary（`Dependency Audit exception gate (npm)`）に表で出る。例外の GHSA が検出されなくなると `not detected (remove the stale exception)` と表示される

### 現在の例外

| GHSA | package | job | 依存経路 | expires | tracking |
| --- | --- | --- | --- | --- | --- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | `braces@3.0.3`（修正版なし） | root | devDependency の `markdownlint-cli2` → `micromatch` → `braces` | 2026-12-31 | [#522](https://github.com/kmryst/ticket-c2c-platform/issues/522) |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | `braces@3.0.3`（修正版なし） | frontend | devDependency の `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces` | 2026-12-31 | [#522](https://github.com/kmryst/ticket-c2c-platform/issues/522) |

root は本番依存に別の high が残っている間、本番依存の判定で fail closed になるため、braces の例外は適用されません。

### 解除手順

上流で修正版が出た（braces 3.0.4 以上の公開、または依存経路から braces がなくなった）ら、次を 1 つの PR で行います。

1. 依存を更新し、`npm audit --include=dev` で該当 GHSA が出ないことを確認する
2. `dependency-audit.yml` から該当要素を削除する（要素が空になったら `npm-audit-exceptions` ごと削除する）
3. 上の「現在の例外」表から該当行を削除し、追跡 Issue を close する

Step Summary に stale 警告が出た場合も同じ手順で削除します。撤去 PR は自動では作られません。

### 期限の更新手順

`expires` までに解除できない場合は、期限が切れる前に次を行います。

1. 追跡 Issue に、現在の依存経路・上流の修正状況・継続理由（実行イメージに含まれないこと、外部入力の経路がないこと）を記録する
2. `expires` を更新日から最大 90 日の日付にする PR を出し、上の表の `expires` も同じ PR で更新する

## Trivy Image Scan / Trivy Config Scan を PR ごとに実行しない理由

- **image**: ビルド込みで 1〜2 分かかる一方、finding はすべてベースイメージ由来で、
  アプリコードの変更では動かない。週次 + `workflow_dispatch` で十分
- **config**: 4.5 秒と安価なので `pull_request` で実行するが、`terraform/**` /
  `Dockerfile` / `frontend/Dockerfile` / 当該 caller 自身を変更した PR に paths filter で限定する

## 非 blocking にしている理由（`exit-code: '0'`）

Trivy Image Scan / Trivy Config Scan はどちらも `exit-code: '0'` で、finding があっても job は success です。

- image: 検出の大半が修正不能（ローカル実測で 29 件中 22 件が `affected` / `fix_deferred` / `will_not_fix`）。
  `'1'` にするとベースイメージを最新にしても恒久的に fail し、alert fatigue で検知能力を失う
- config: finding（ローカル実測で 41 件）が未棚卸しで、accepted risk 候補（ALB の公開、ECR タグ可変性）を含む

blocking 化（`exit-code: '1'` / required status check 昇格）は、finding の棚卸しと accepted risk の記録を
終えてから別 Issue で判断します。`exit-code` は reusable workflow の input なので caller の 1 行変更で切り替わります。

## required status checks との関係

Trivy Image Scan / Trivy Config Scan は required status checks に**昇格させていません**。
どちらも非 blocking であり、Trivy Config Scan は paths filter 付きで実行されるため、
required にすると filter に一致しない PR で check run が作成されず、required check が永久に pending になります。
