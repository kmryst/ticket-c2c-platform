# image_tag 変数のテスト（Issue #543 / ADR-0040）。mock provider で plan するため AWS 認証は不要。
# 実行: terraform -chdir=terraform/environments/dev init -backend=false
#       terraform -chdir=terraform/environments/dev test

# mock provider は computed 属性にランダムな文字列を返す。JSON・list・ARN として検査される属性と、
# plan 時点で for_each に使う属性だけ、形の合う値を与える（値そのものはテストの対象ではない）。
mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["ap-northeast-1a", "ap-northeast-1c", "ap-northeast-1d"]
    }
  }
  mock_resource "aws_acm_certificate" {
    override_during = plan
    defaults = {
      arn = "arn:aws:acm:ap-northeast-1:111122223333:certificate/mock"
      domain_validation_options = [{
        domain_name           = "mock.ticket-c2c.click"
        resource_record_name  = "_mock.ticket-c2c.click."
        resource_record_type  = "CNAME"
        resource_record_value = "_mock.acm-validations.aws."
      }]
    }
  }
  mock_resource "aws_acm_certificate_validation" {
    override_during = plan
    defaults = {
      certificate_arn = "arn:aws:acm:ap-northeast-1:111122223333:certificate/mock"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_resource "aws_acm_certificate" {
    override_during = plan
    defaults = {
      arn = "arn:aws:acm:us-east-1:111122223333:certificate/mock"
      domain_validation_options = [{
        domain_name           = "mock.ticket-c2c.click"
        resource_record_name  = "_mock.ticket-c2c.click."
        resource_record_type  = "CNAME"
        resource_record_value = "_mock.acm-validations.aws."
      }]
    }
  }
  mock_resource "aws_acm_certificate_validation" {
    override_during = plan
    defaults = {
      certificate_arn = "arn:aws:acm:us-east-1:111122223333:certificate/mock"
    }
  }
}

mock_provider "random" {}
mock_provider "archive" {}

# 既定値（pending-deploy）で plan が通る。
run "default_image_tag_plans" {
  command = plan

  assert {
    condition     = var.image_tag == "pending-deploy"
    error_message = "image_tag の既定値は pending-deploy であること"
  }
}

# pending-deploy 以外（Issue #543 より前の既定値 latest、commit SHA タグ）は validation で拒否する。
run "rejects_latest" {
  command = plan

  variables {
    image_tag = "latest"
  }

  expect_failures = [var.image_tag]
}

run "rejects_commit_sha" {
  command = plan

  variables {
    image_tag = "abc1234"
  }

  expect_failures = [var.image_tag]
}
