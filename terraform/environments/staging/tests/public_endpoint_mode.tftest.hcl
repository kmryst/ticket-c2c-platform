# public_endpoint_mode = alb-http-only（ローカル apply 専用の escape hatch。ADR-0008 / ADR-0013）の plan のテスト（Issue #552）。
# mock provider で plan するため AWS 認証は不要。

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

# alb-http-only では CloudFront / WAF / frontend を作らないため、dashboard モジュールにはそれらの名前が null で渡る。
# その状態で plan が通り、dashboard 自体は作ることを確かめる。
run "alb_http_only_plan_succeeds" {
  command = plan

  variables {
    public_endpoint_mode = "alb-http-only"
  }

  assert {
    condition     = module.dashboard.dashboard_name == "ticket-c2c-staging-overview"
    error_message = "alb-http-only でも CloudWatch dashboard（<name>-overview）を作ること"
  }

  assert {
    condition     = length(module.cloudfront) == 0 && length(module.frontend_service) == 0
    error_message = "alb-http-only では CloudFront と frontend の ECS サービスを作らないこと"
  }
}
