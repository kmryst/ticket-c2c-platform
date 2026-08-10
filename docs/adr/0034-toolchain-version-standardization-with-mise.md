# 0034. ローカルツールチェーンの正本を `.mise.toml` に置き、CI pin との一致を CI で機械検査する

## ステータス

Accepted

## 日付

2026-08-10

## 背景

本リポジトリには、ローカル実行環境の Terraform / Node.js バージョンを宣言する仕組みが無かった。`.mise.toml` / `.tool-versions` / `.nvmrc` のいずれも存在せず、「このリポジトリを手元で触るときにどのバージョンを使うのか」がどこにも書かれていない状態だった。

一方で CI 側には値がある。2026-08-10 時点で、Terraform CLI を setup する 9 つの workflow すべてに `terraform_version: "1.14.8"` が直書きされている。

| workflow | 用途 |
| --- | --- |
| `pr-check.yml` | fmt / validate（required status check） |
| `terraform-plan.yml` | PR の plan |
| `terraform-apply-bootstrap.yml` | bootstrap の apply |
| `terraform-apply-dev.yml` | dev の apply |
| `terraform-apply-staging.yml` | staging の apply |
| `terraform-destroy-dev.yml` | dev の destroy |
| `terraform-destroy-staging.yml` | staging の destroy |
| `dev-smoke-test.yml` | dev の `terraform output` 取得 |
| `staging-smoke-test.yml` | staging の `terraform output` 取得 |

リモート state の `terraform_version` も、2026-08-10 の実測（3 リポジトリ横断の調査。結果は idp-golden-path ADR-0014 に記録）で bootstrap / dev / staging の 3 層すべて 1.14.8 だった。値はすべて CI 由来であり、本リポジトリに限れば CI と state は最初から一致している。

したがって本リポジトリの問題は「バージョンが割れていること」ではない。**正本が無いことと、一致を検査する仕組みが無いこと**である。これは 2 つの実害を生んでいた。

1. **手元から state を扱えない。** ローカル WSL の開発ツールを mise へ一本化した結果（2026-08-10）、Terraform は 1.12.1 しか解決されなくなった。state は前方互換がなく、記録された `terraform_version` より古い CLI での操作を拒否するため、1.14.8 の state を手元から `plan` することすらできない。リポジトリがバージョンを宣言していれば起きなかった。
2. **一致が偶然に依存している。** 現在 9 箇所が揃っているのは、誰かが 9 箇所を同時に書いたからにすぎない。1 箇所だけ書き換えた PR を人間のレビューが見逃せば、その workflow だけ別バージョンで動く。Terraform の場合、それは「その層をもう更新できない」という回復困難な事故に直結する。

3 リポジトリ（`idp-golden-path` / `terraform-hannibal` / 本リポジトリ）のツールチェーン統一の第 2 段階として、この 2 点を解消する。標準の正本は idp-golden-path ADR-0014 であり、本 ADR はそれを本リポジトリへ適用した際の判断を記録する。

## 決定

### 1. `.mise.toml` をローカル実行環境の正本とする

リポジトリルートに `.mise.toml` を置き、`terraform = "1.14.8"` と `node = "24.18.0"` を宣言する。ローカルでのバージョンはここが正本であり、`mise install` で取得する。

宣言するのは**本リポジトリで実際に使うツールだけ**とする。`tflint` / `terraform-docs` / `pre-commit` は、設定ファイル（`.tflint.hcl` / `.pre-commit-config.yaml`）が存在せず CI からも呼ばれていないため宣言しない。他リポジトリの `.mise.toml` との差分は意図的なものである。

### 2. CI は `.mise.toml` を読まず、明示的に pin する

CI（GitHub Actions）は `hashicorp/setup-terraform` / `actions/setup-node` を使い続け、バージョンは workflow 内に明示 pin する。`.mise.toml` の値と CI pin は二重管理になるが、その唯一の欠点である drift は次項の検査で潰す。

### 3. Terraform pin は直書きのまま維持する（`env` 変数へ集約しない）

9 workflow の `terraform_version: "1.14.8"` は直書きのまま残す。workflow ごとに `env: TERRAFORM_VERSION` を定義して `${{ env.TERRAFORM_VERSION }}` で参照する形へは変えない。

### 4. `.mise.toml` と CI pin の一致を CI で機械検査する

idp-golden-path の reusable workflow を `uses: kmryst/idp-golden-path/.github/workflows/toolchain-version-check.yml@v1` で呼ぶ caller workflow を追加する（配布方式は idp-golden-path ADR-0008）。check run 名は `toolchain-version-check / Toolchain Version Check` になる。

この検査は `.mise.toml` の `[tools] terraform` と、workflow 中の `TERRAFORM_VERSION:` / `terraform_version:` の**リテラル値**を突き合わせる。`.mise.toml` 不在は skip ではなく fail とする仕様のため、`.mise.toml` の追加と caller の追加は同一 PR で行う。Dependabot PR も免除しない。

### 5. `package.json` の `engines.node` を実態に合わせる

`">=20"` を `">=24"` に変更する。CI の `setup-node` は `node-version: "24"`、`Dockerfile` と `frontend/Dockerfile` はいずれも `node:24-slim` であり、Node 20 で動作を確認している経路は 1 つも無い。本 ADR で `.mise.toml` に `node = "24.18.0"` を宣言する以上、同じリポジトリの `engines` が Node 20 を許容し続けるのは、本 ADR が解こうとしている「宣言と実態の乖離」そのものである。

## 根拠

### バージョン 1.14.8 は選択ではなく制約

state の前方非互換により、既に 1.14.8 で記録された 3 層をダウングレードするには state ファイル内の `terraform_version` を手で書き換えるしかない。bootstrap の 22 リソースを含む state に対する手動編集は、可逆な「バージョンを揃える」作業のために不可逆な破壊リスクを取ることになり、割に合わない。本リポジトリでは CI も state も既に 1.14.8 のため、そもそも変更が発生しない。

### 直書きを維持した理由（決定 3）

「9 ファイルに散在する直書きを `env` へ集約する」ことが当初の狙いだったが、実測すると **9 ファイルはいずれも `terraform_version` の出現が 1 箇所ずつ**で、各ファイルに `hashicorp/setup-terraform` step が 1 つしか無い。

したがって `env` 化しても、

- ファイル内の重複は 0 件から 0 件になるだけで、何も解消しない
- 更新点は 9 箇所のまま変わらない（GitHub Actions には複数 workflow で共有できる env の仕組みが無い）
- 検査対象が `terraform_version:` の行から `TERRAFORM_VERSION:` の行に移るだけで、検査の強度も変わらない（チェッカーは `${{ env.X }}` のような間接参照を pin とみなさない仕様のため、参照行ではなく env 定義行が検査される）

正味の効果は、読み手が `setup-terraform` の step を見たときにバージョンが分からなくなり、ファイル先頭まで戻る必要が生じることだけである。**得られるものが無い抽象化は入れない**。

「9 箇所を同時に更新し忘れる」というリスクは、集約ではなく決定 4 の機械検査で潰す。1 箇所だけ書き換えた PR は CI で落ちるため、更新点が 9 箇所であること自体はもはや事故要因ではない。

### 二重管理（決定 2）を許容する理由

CI で mise を使えば正本は 1 つになるが、`hashicorp/setup-terraform` / `actions/setup-node` のキャッシュと実績を捨てることになる。二重管理の唯一の欠点である drift を CI 検査で潰せるなら、この構成のほうが安い。

## 反対材料・トレードオフ

- **更新点が 9 箇所のまま残る。** Terraform を上げるときは 9 ファイル + `.mise.toml` の計 10 箇所を書き換える必要がある。検査があるので「ズレたまま気付かない」ことは起きないが、「書き換える作業量」は減っていない。将来 1 ファイル内で複数回 Terraform を setup する workflow が現れたら、そのファイルに限り `env` 化する（決定 3 はファイル内に重複が無いことを前提にしている）。
- **二重管理そのものは残る。** `.mise.toml` と CI pin は別々に書かれており、片方だけ直せば CI が落ちる。落ちることは設計どおりだが、更新作業が 1 手で終わらないのは事実である。CI を mise 実行へ寄せれば正本は 1 つになる。
- **検査対象が Terraform だけである。** `.mise.toml` は Node.js も宣言するが、チェッカーは Terraform しか見ない。CI の `node-version: "24"` と `.mise.toml` の `24.18.0` の関係（前者は後者を包含する range 表現）は機械検査されない。Node は state のような前方非互換の制約を持たず、drift の実害が桁違いに小さいため、現時点では検査しない。
- **外部リポジトリへの依存が 1 本増える。** 検査ロジックの正本は idp-golden-path にあり、本リポジトリからは `@v1` タグで参照する。idp-golden-path 側の変更が本リポジトリの CI に波及しうる。これは既存 8 本の reusable workflow と同じトレードオフであり、タグ固定（ADR-0008 の配布方式）で緩和している。
- **`engines.node` の引き上げは、Node 20 環境の利用者を締め出す。** ただし `engines` は既定で警告どまりであり（`engine-strict` は設定していない）、実際に Node 20 で本リポジトリを動かしている経路も確認されていない。

## 再検討のトリガー

- **Terraform の新しいメジャーバージョンが出た場合**（2.x など）。state 互換性・provider 互換性・`hashicorp/setup-terraform` の対応状況を確認し、統一先を更新するか判断する。
- **1.14.8 に固有の不具合が判明した場合。** 移行先は 1.14.x の patch 上位であり、ダウングレードではない（前方非互換の制約は変わらない）。
- **1 つの workflow 内で Terraform を複数回 setup する必要が生じた場合。** そのファイルに限り決定 3 を見直し、`env` 化する。
- **CI が mise を直接実行する構成へ移行した場合。** ローカル正本と CI pin の二重管理そのものが不要になり、決定 2 と決定 4 の検査は役目を終える。
- **`.mise.toml` 以外のツールチェーン宣言方式へ移行した場合**（`.tool-versions` / devcontainer / Nix など）。検査対象のパーサを差し替える必要がある。
- **tflint / terraform-docs / pre-commit を導入した場合。** 決定 1 の「実際に使うツールだけ宣言する」に従い、導入と同じ PR で `.mise.toml` に追加する。

## 関連

- Issue: [#459](https://github.com/kmryst/ticket-c2c-platform/issues/459)
- [ADR-0003](./0003-terraform-state-and-environment-isolation.md): Terraform の state / 環境分離設計
- kmryst/idp-golden-path ADR-0014: Terraform ツールチェーンのバージョンを 3 リポジトリで 1.14.8 に統一し、ローカル正本と CI pin の整合性を CI で検査する（本標準の正本）
- kmryst/idp-golden-path ADR-0008: CI ガードレールを reusable workflows として提供し、タグ固定（`@v1`）で参照する
- [Terraform Docs: State — version compatibility](https://developer.hashicorp.com/terraform/language/state)
- [mise: Configuration](https://mise.jdx.dev/configuration.html)
