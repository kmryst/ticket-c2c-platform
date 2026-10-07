# ecs_task_definition_arns output と task_config_check_value 変数のテスト（Issue #544 / ADR-0042）。
# mock provider で plan するため AWS 認証は不要。
# 実行: terraform -chdir=terraform/environments/staging init -backend=false
#       terraform -chdir=terraform/environments/staging test
#
# deploy workflow（deploy-service.yml）は ecs_task_definition_arns[<service 名>] の revision をコピー元にする。
# この output が「service 名 → その service の task definition（terraform が登録した revision）の ARN」で
# あることを確認する。ARN は plan 時点では未確定のため、override_resource で revision 番号付きの値を与える。


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

override_resource {
  target          = module.api_service.aws_ecs_task_definition.this
  override_during = plan
  values = {
    arn = "arn:aws:ecs:ap-northeast-1:111122223333:task-definition/ticket-c2c-staging-api:43"
  }
}

override_resource {
  target          = module.worker_service.aws_ecs_task_definition.this
  override_during = plan
  values = {
    arn = "arn:aws:ecs:ap-northeast-1:111122223333:task-definition/ticket-c2c-staging-worker:21"
  }
}

override_resource {
  target          = module.frontend_service[0].aws_ecs_task_definition.this
  override_during = plan
  values = {
    arn = "arn:aws:ecs:ap-northeast-1:111122223333:task-definition/ticket-c2c-staging-frontend:8"
  }
}

# https-dns（既定）: api / worker / frontend の 3 service。キーは ECS service 名、値はその service の
# task definition（terraform が登録した revision）の ARN。
run "task_definition_arns_https_dns" {
  command = plan

  assert {
    condition = output.ecs_task_definition_arns == {
      "ticket-c2c-staging-api"      = "arn:aws:ecs:ap-northeast-1:111122223333:task-definition/ticket-c2c-staging-api:43"
      "ticket-c2c-staging-worker"   = "arn:aws:ecs:ap-northeast-1:111122223333:task-definition/ticket-c2c-staging-worker:21"
      "ticket-c2c-staging-frontend" = "arn:aws:ecs:ap-northeast-1:111122223333:task-definition/ticket-c2c-staging-frontend:8"
    }
    error_message = "ecs_task_definition_arns は service 名 → terraform の task definition ARN であること"
  }

  assert {
    condition     = output.ecs_task_definition_arns["ticket-c2c-staging-api"] == module.api_service.task_definition_arn
    error_message = "api の ARN は api_service モジュールの task definition を指すこと"
  }

  assert {
    condition     = length(local.task_config_check_environment) == 0
    error_message = "task_config_check_value が空なら確認用の環境変数を足さないこと"
  }
}

# task_config_check_value を指定すると、api / worker / frontend の task definition のアプリコンテナ
# （containerDefinitions[0]）に TASK_CONFIG_CHECK_VALUE が入る。container definitions は DB endpoint 等の
# computed 値を含み plan では未確定になるため、それらを出すモジュールとリソースの値をこの run だけで与える。
run "task_config_check_value_sets_environment" {
  command = plan

  variables {
    task_config_check_value = "issue-544-check-1"
  }

  override_module {
    target = module.aurora
    outputs = {
      cluster_endpoint        = "mock.cluster.ap-northeast-1.rds.amazonaws.com"
      cluster_reader_endpoint = "mock.cluster-ro.ap-northeast-1.rds.amazonaws.com"
      database_name           = "ticket"
      master_user_secret_arn  = "arn:aws:secretsmanager:ap-northeast-1:111122223333:secret:rds!cluster-mock"
      security_group_id       = "sg-0aurora"
    }
  }
  override_module {
    target = module.ecr
    outputs = {
      repository_url  = "111122223333.dkr.ecr.ap-northeast-1.amazonaws.com/ticket-c2c-staging"
      repository_arn  = "arn:aws:ecr:ap-northeast-1:111122223333:repository/ticket-c2c-staging"
      repository_name = "ticket-c2c-staging"
    }
  }
  override_module {
    target = module.ecr_frontend
    outputs = {
      repository_url  = "111122223333.dkr.ecr.ap-northeast-1.amazonaws.com/ticket-c2c-staging-frontend"
      repository_arn  = "arn:aws:ecr:ap-northeast-1:111122223333:repository/ticket-c2c-staging-frontend"
      repository_name = "ticket-c2c-staging-frontend"
    }
  }
  override_module {
    target = module.eventbridge
    outputs = {
      bus_name = "ticket-c2c-staging"
      bus_arn  = "arn:aws:events:ap-northeast-1:111122223333:event-bus/ticket-c2c-staging"
    }
  }
  override_module {
    target = module.opensearch
    outputs = {
      endpoint          = "vpc-mock.ap-northeast-1.es.amazonaws.com"
      security_group_id = "sg-0opensearch"
    }
  }
  override_module {
    target = module.search_projection_queue
    outputs = {
      queue_url  = "https://sqs.ap-northeast-1.amazonaws.com/111122223333/ticket-c2c-staging-search-projection"
      queue_name = "ticket-c2c-staging-search-projection"
      queue_arn  = "arn:aws:sqs:ap-northeast-1:111122223333:ticket-c2c-staging-search-projection"
      dlq_arn    = "arn:aws:sqs:ap-northeast-1:111122223333:ticket-c2c-staging-search-projection-dlq"
    }
  }
  override_module {
    target = module.valkey
    outputs = {
      primary_endpoint  = "mock.valkey.apne1.cache.amazonaws.com"
      security_group_id = "sg-0valkey"
    }
  }
  override_resource {
    target          = aws_secretsmanager_secret.jwt
    override_during = plan
    values = {
      arn = "arn:aws:secretsmanager:ap-northeast-1:111122223333:secret:ticket-c2c-staging-jwt-mock"
    }
  }

  assert {
    condition     = local.task_config_check_environment["TASK_CONFIG_CHECK_VALUE"] == "issue-544-check-1"
    error_message = "task_config_check_value を TASK_CONFIG_CHECK_VALUE として渡すこと"
  }

  assert {
    condition = alltrue([
      for td in [
        module.api_service.task_definition_container_definitions,
        module.worker_service.task_definition_container_definitions,
        module.frontend_service[0].task_definition_container_definitions,
      ] : contains(jsondecode(td)[0].environment, { name = "TASK_CONFIG_CHECK_VALUE", value = "issue-544-check-1" })
    ])
    error_message = "api / worker / frontend のアプリコンテナ（containerDefinitions[0]）に TASK_CONFIG_CHECK_VALUE が入ること"
  }
}

run "rejects_invalid_task_config_check_value" {
  command = plan

  variables {
    task_config_check_value = "has space"
  }

  expect_failures = [var.task_config_check_value]
}
