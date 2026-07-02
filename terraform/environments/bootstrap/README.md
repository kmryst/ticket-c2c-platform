# bootstrap

tfstate backend（S3）、GitHub OIDC provider、CI 用 IAM ロールを管理する root module。

この state は dev / staging / prod の app state とは分離されており、destroy workflow の対象外（[ADR-0003](../../../docs/adr/0003-terraform-state-and-environment-isolation.md)）。

## 管理リソース

- tfstate 用 S3 バケット（versioning / SSE / パブリックアクセスブロック / `prevent_destroy`）
- GitHub OIDC provider
- `ticket-c2c-platform-gha-plan`: plan 用読み取りロール（本リポジトリの全 workflow から引き受け可）
- `ticket-c2c-platform-gha-apply`: apply / destroy / deploy 用ロール（GitHub Environment `dev` / `dev-destroy` からのみ引き受け可）

## 初回 apply 手順（鶏卵問題の解消）

state を格納するバケット自身を作るため、初回のみ local state で apply してから移行する。

```bash
cd terraform/environments/bootstrap

# 1. backend.tf の terraform { backend "s3" { ... } } ブロックを一時的にコメントアウト

# 2. local state で apply（AWS リソース作成のためユーザー確認必須）
terraform init
terraform plan
terraform apply

# 3. backend.tf のコメントアウトを元に戻す

# 4. local state を作成済みバケットへ移行
terraform init -migrate-state

# 5. 移行を確認したらローカルの state ファイルを削除
rm terraform.tfstate terraform.tfstate.backup
```

2 回目以降は通常どおり `terraform init` → `plan` → `apply`。

## 出力

| output | 用途 |
|---|---|
| `state_bucket_name` | 各環境の backend 設定に使う |
| `plan_role_arn` | GitHub Variables `AWS_PLAN_ROLE_ARN` |
| `apply_role_arn` | GitHub Variables `AWS_APPLY_ROLE_ARN` |

## 注意

- apply ロールは dev 構築期間中 `AdministratorAccess`。staging 追加前に最小権限へ絞る。
- バケット名にはグローバル一意性のためアカウント ID を含む。アカウント分離時は環境ごとに backend 設定を持つ（ADR-0003）。
