# セキュリティスキャン運用

本リポジトリの CI で実行するセキュリティスキャンの責務分担を示します。

各スキャンの severity 閾値・fail/warn ポリシー・検出時の対応フロー・reusable workflow の inputs は、
共通の正本である [kmryst/idp-golden-path `docs/operations/security-scanning.md`](https://github.com/kmryst/idp-golden-path/blob/main/docs/operations/security-scanning.md)
に従います。本ドキュメントは「このリポジトリで何がどう呼ばれているか」だけを持ちます。

## 責務分担

| workflow | 検出対象 | 実行タイミング | 検出時の扱い |
| --- | --- | --- | --- |
| [Gitleaks Secret Scan](../../.github/workflows/gitleaks-secret-scan.yml) | git 履歴への secret / credential 混入 | PR | fail（required status check） |
| [Dependency Audit](../../.github/workflows/dependency-audit.yml) | npm 依存（root / `frontend/`）の既知脆弱性（CVE） | PR / 週次 / 手動 | high 以上で fail |
| [CodeQL](../../.github/workflows/codeql.yml) | 自分が書いたコードの脆弱なパターン（SAST） | PR / main push / 週次 | Security > Code scanning alerts に集約 |
| [Security Scan / dependency-scan](../../.github/workflows/security-scan.yml) | リポジトリ内の lockfile 由来の既知脆弱性（Trivy `fs`） | 週次 / 手動 | Security > Code scanning alerts に集約 |
| [Security Scan / trivy-image-backend, trivy-image-frontend](../../.github/workflows/security-scan.yml) | コンテナイメージの中身（`node:24-slim` の OS パッケージ、Node 公式イメージ同梱の npm 自身の依存） | 週次 / 手動 | 非 blocking。Security > Code scanning alerts と Step Summary |
| [Trivy Config Scan](../../.github/workflows/trivy-config-scan.yml) | IaC（`terraform/**`）と Dockerfile の設定不備（misconfiguration） | PR（paths filter 付き）/ 週次 / 手動 | 非 blocking。Step Summary + artifact |

検出レイヤーが異なり、相互に代替できません。

- **Gitleaks**: 自分が書いたものに秘密情報が混入していないか
- **Dependency Audit / Trivy `fs`**: lockfile が宣言する依存に既知脆弱性がないか
- **CodeQL**: 自分が書いたコードに脆弱なパターンがないか
- **Trivy Image Scan**: アプリを載せる土台（ベースイメージ）に既知脆弱性がないか
- **Trivy Config Scan**: まだ動いていない設定ファイルの書き方が危険でないか

`npm audit` / Dependabot alerts / Trivy `fs` はいずれも lockfile が宣言する依存しか見ないため、
ベースイメージの OS パッケージや `/usr/local/lib/node_modules/npm/node_modules/` 配下は原理的に対象外です。
その空白を Trivy Image Scan が埋めます。

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
