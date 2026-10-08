# 外形監視（CloudWatch Synthetics canary）の作成切り替えのテスト（Issue #546 / ADR-0043）。
# mock provider で plan するため AWS 認証は不要。
# 実行: terraform -chdir=terraform/environments/staging init -backend=false
#       terraform -chdir=terraform/environments/staging test
# mock provider の test は既存の state を持てないため、dev の moved（module.synthetic_check → [0]）の確認はここではしない。

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

# 既定値（false）では外形監視を作らない。最初の apply で canary が ALB 503 を記録しないようにするため。
run "default_does_not_create_synthetic_check" {
  command = plan

  assert {
    condition     = var.enable_synthetic_check == false
    error_message = "enable_synthetic_check の既定値は false であること"
  }

  assert {
    condition     = length(module.synthetic_check) == 0
    error_message = "既定値では外形監視（module.synthetic_check）を作らないこと"
  }

  assert {
    condition     = output.synthetic_check_canary_name == null
    error_message = "外形監視を作らないとき synthetic_check_canary_name は null であること"
  }
}

# true なら外形監視を作る（最初の deploy の後の 2 回目の apply）。
run "enabled_creates_synthetic_check" {
  command = plan

  variables {
    enable_synthetic_check = true
  }

  assert {
    condition     = length(module.synthetic_check) == 1
    error_message = "enable_synthetic_check = true なら外形監視（module.synthetic_check[0]）を作ること"
  }

  assert {
    condition     = output.synthetic_check_canary_name == "ticket-c2c-staging-synthetic-check"
    error_message = "synthetic_check_canary_name は作った canary の名前であること"
  }
}

# alb-http-only では CloudFront / app FQDN が無いため、true でも外形監視を作らない。
# module.dashboard は alb-http-only の plan で coalesce(null, "") が失敗する（この Issue より前からの不具合で、
# 外形監視とは関係しない）。この run は外形監視の count だけを確かめるため、dashboard は override_module で評価しない。
run "alb_http_only_does_not_create_synthetic_check" {
  command = plan

  override_module {
    target = module.dashboard
  }

  variables {
    public_endpoint_mode   = "alb-http-only"
    enable_synthetic_check = true
  }

  assert {
    condition     = length(module.synthetic_check) == 0
    error_message = "alb-http-only では enable_synthetic_check = true でも外形監視を作らないこと"
  }

  assert {
    condition     = output.synthetic_check_canary_name == null
    error_message = "外形監視を作らないとき synthetic_check_canary_name は null であること"
  }
}
