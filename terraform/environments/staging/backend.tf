terraform {
  backend "s3" {
    bucket       = "ticket-c2c-platform-tfstate-85d4524d"
    key          = "staging/app/terraform.tfstate"
    region       = "ap-northeast-1"
    use_lockfile = true
  }
}
