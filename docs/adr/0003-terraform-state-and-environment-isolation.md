# 0003. Terraform の state / 環境分離設計

## ステータス

Accepted

## 日付

2026-07-02

## 背景

dev を staging / prod へ育てる前提のため、環境分離の方式を最初に決める必要がある。Terraform の環境分離には workspace 方式、環境別 root module 方式、tfvars 切り替え方式などがあり、state の分割粒度と locking 方式にも選択肢がある。

## 決定

1. **環境ごとに root module を分離する**（`terraform/environments/{bootstrap,dev,...}`）。Terraform workspace による環境分離はしない。
2. **state は環境ごとに必ず分離する**。backend key は `<env>/<layer>/terraform.tfstate` の階層規約とする。初期は次の 2 state 構成とする。
   - `bootstrap/terraform.tfstate`: state バケット本体、GitHub OIDC provider、CI 用 IAM ロール
   - `dev/app/terraform.tfstate`: dev の全リソース
3. **state locking は S3 ネイティブロック**（`use_lockfile = true`、Terraform 1.10+）を使う。DynamoDB ロックテーブルは作らない。
4. 共通部品は `terraform/modules/*` に切り、環境 root module から呼び出す。単一巨大 main.tf にしない。
5. AWS アカウントは当面単一（dev を現行アカウントに構築）とするが、**将来の dev / staging / prod アカウント分離を前提**に、アカウント ID をコードにハードコードせず、provider / backend 設定を環境 root module 内に閉じる。
6. bootstrap は初回のみ local state で人間が手動 apply し、作成した S3 バケットへ `terraform init -migrate-state` で移行する。手順は `terraform/environments/bootstrap/README.md` に記載する。

## 根拠

- workspace 方式は state こそ分かれるが、コードが全環境共通になるため「dev だけ構成を変える」「prod だけ保護を強める」といった差分が条件分岐だらけになる。環境別 root module は差分を root module に閉じ込められ、誤って別環境へ apply する事故も起きにくい。
- backend key の階層規約（`dev/app/...`）を最初に決めておくことで、将来 `dev/network/`、`dev/data/` へ state 分割する際に規約変更が不要になる。
- S3 ネイティブロックは DynamoDB テーブルという bootstrap 対象を 1 つ減らし、コストもゼロになる。Terraform 1.14 を使用しており要件（1.10+）を満たす。
- bootstrap state を app state と分けることで、destroy workflow の対象から state バケット自体を構造的に除外できる。

## 反対材料・トレードオフ

- 環境別 root module は環境間でコードの重複が生じる。モジュール化を徹底し、root module は「モジュールの組み合わせと環境固有値」だけにして緩和する。
- S3 ネイティブロックは DynamoDB ロックより歴史が浅い。問題が出た場合は backend 設定の変更のみで DynamoDB ロックへ移行できる（可逆）。
- 初期 2 state 構成は、dev が大きくなると plan が遅くなる。dev root module 内をレイヤ（network / data / app / observability）ごとのモジュールブロックに整理しておき、閾値を超えたら state 分割する。

## 再検討のトリガー

- `terraform plan` の所要時間が開発の妨げになった場合（state のレイヤ分割）。
- staging 追加時（AWS アカウント分離の実施判断、backend 設定の環境別バケット化の要否）。
