# alert_email 変数のテスト（Issue #623）。mock provider で plan するため AWS 認証は不要。
# 実行: terraform -chdir=terraform/environments/staging init -backend=false
#       terraform -chdir=terraform/environments/staging test
# 値を渡さない場合（required variable）は terraform test の expect_failures で表せないため、PR の検証で
# 「変数なしの plan が No value for required variable で止まること」を別に確認する。

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

# メール形式の値を渡すと、ap-northeast-1（observability モジュール）と us-east-1（edge）の
# 両方の SNS email subscription がその値を宛先にして作られる。
run "valid_email_creates_subscriptions" {
  command = plan

  variables {
    alert_email = "alerts@example.com"
  }

  assert {
    condition     = length(module.observability.alarm_action_arns) == 1
    error_message = "alert_email を渡したら observability の SNS トピックを作ること"
  }

  assert {
    condition     = nonsensitive(aws_sns_topic_subscription.edge_alerts_email[0].endpoint == "alerts@example.com")
    error_message = "edge アラートの subscription の宛先が alert_email であること"
  }
}

# 空文字（secret が渡らなかった場合）は validation で拒否し、subscription を消す plan を作らせない。
run "rejects_empty" {
  command = plan

  variables {
    alert_email = ""
  }

  expect_failures = [var.alert_email]
}

# メール形式でない値も拒否する。
run "rejects_invalid_format" {
  command = plan

  variables {
    alert_email = "not-an-email"
  }

  expect_failures = [var.alert_email]
}
