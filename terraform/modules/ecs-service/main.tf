# API / Worker 共用の ECS Fargate サービスモジュール（ADR-0006）。
# 同一イメージを command 差し替えで使い分け、ALB 接続はオプション。

locals {
  autoscaling_enabled = var.autoscaling_min_capacity != null && var.autoscaling_max_capacity != null
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  container_definitions = jsonencode([
    {
      name      = var.name
      image     = var.image
      command   = var.command
      essential = true

      portMappings = var.container_port != null ? [
        {
          containerPort = var.container_port
          protocol      = "tcp"
        }
      ] : []

      environment = [
        for k, v in var.environment : { name = k, value = v }
      ]

      secrets = [
        for k, v in var.secrets : { name = k, valueFrom = v }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = var.log_group_name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = var.name
        }
      }
    }
  ])
}

resource "aws_ecs_service" "this" {
  name            = var.name
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = var.target_group_arn != null ? [1] : []
    content {
      target_group_arn = var.target_group_arn
      container_name   = var.name
      container_port   = var.container_port
    }
  }

  # deploy workflow がタスク定義を更新した直後の再デプロイ完了を Terraform では待たない
  wait_for_steady_state = false

  # deploy workflow は commit SHA タグへ差し替えた新しいタスク定義リビジョンを register して
  # サービスを更新する（production-readiness M-7）。Terraform がそのリビジョンを
  # 自身のリビジョン（ブートストラップ用イメージタグ）へ巻き戻さないよう、差分を無視する。
  # 注意: Terraform 側でタスク定義（環境変数・リソースサイズ等）を変更した場合、
  # 新リビジョンは作られるがサービスには自動反映されない。apply 後に deploy-app workflow を
  # 実行して反映する。
  lifecycle {
    ignore_changes = [task_definition]
  }
}

resource "aws_appautoscaling_target" "this" {
  count = local.autoscaling_enabled ? 1 : 0

  max_capacity       = var.autoscaling_max_capacity
  min_capacity       = var.autoscaling_min_capacity
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.this.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_scheduled_action" "this" {
  for_each = local.autoscaling_enabled ? {
    for action in var.scheduled_scaling_actions : action.name => action
  } : {}

  name               = each.value.name
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace
  resource_id        = aws_appautoscaling_target.this[0].resource_id
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension
  schedule           = each.value.schedule

  scalable_target_action {
    min_capacity = each.value.min_capacity
    max_capacity = each.value.max_capacity
  }
}
