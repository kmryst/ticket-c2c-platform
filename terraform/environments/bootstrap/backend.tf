# 初回 apply 時のみ、この backend ブロックをコメントアウトして local state で apply し、
# バケット作成後に元へ戻して `terraform init -migrate-state` を実行する。
# 手順の詳細は同ディレクトリの README.md を参照。
terraform {
  backend "s3" {
    bucket       = "ticket-c2c-platform-tfstate-258632448142"
    key          = "bootstrap/terraform.tfstate"
    region       = "ap-northeast-1"
    use_lockfile = true
  }
}
