terraform {
  backend "s3" {
    bucket       = "ticket-c2c-platform-tfstate-258632448142"
    key          = "dev/app/terraform.tfstate"
    region       = "ap-northeast-1"
    use_lockfile = true
  }
}
