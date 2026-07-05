terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    # random は JWT 署名シークレットの生成に使う（ADR-0010 / Issue #134）。
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project         = var.project
      Environment     = local.environment
      CapacityProfile = local.capacity_profile
      ManagedBy       = "terraform"
    }
  }
}

# CloudFront の viewer certificate は us-east-1 の ACM でしか発行できない（ADR-0011）。
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project         = var.project
      Environment     = local.environment
      CapacityProfile = local.capacity_profile
      ManagedBy       = "terraform"
    }
  }
}
