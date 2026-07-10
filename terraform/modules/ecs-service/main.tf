# API / Worker 共用の ECS Fargate サービスモジュール（ADR-0006）。
# 同一イメージを command 差し替えで使い分け、ALB 接続はオプション。

locals {
  autoscaling_enabled = var.autoscaling_min_capacity != null && var.autoscaling_max_capacity != null
  # target-tracking policy は Auto Scaling target（min/max）が有効な場合のみ意味を持つ。
  # target なしで policy だけ作ると、実際にはスケールしない設定を残すことになる（Issue #234）。
  autoscaling_policy_enabled = local.autoscaling_enabled && var.autoscaling_cpu_target != null
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  # アプリコンテナは必ず containerDefinitions[0] に置く。
  # deploy workflow（deploy-service.yml）が .containerDefinitions[0].image だけを
  # commit SHA タグへ差し替えて新リビジョンを register するため、
  # sidecar（index 1 以降）はデプロイをまたいで維持される。
  container_definitions = jsonencode(concat(
    [
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
    ],
    # ADOT collector sidecar（ADR-0014 / Issue #203）。
    # イメージ同梱の ECS 用既定設定（OTLP 受信 → X-Ray へ転送）をそのまま使う。
    # essential = false: collector 停止時はトレースが失われるだけで、
    # アプリ本体（購入 API / Worker）を巻き込んで落とさない。
    var.otel_collector_image != null ? [
      {
        name      = "otel-collector"
        image     = var.otel_collector_image
        command   = ["--config=/etc/ecs/ecs-default-config.yaml"]
        essential = false

        portMappings = []
        environment  = []
        secrets      = []

        logConfiguration = {
          logDriver = "awslogs"
          options = {
            "awslogs-group"         = var.log_group_name
            "awslogs-region"        = var.region
            "awslogs-stream-prefix" = "otel-collector"
          }
        }
      }
    ] : []
  ))
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

  # 壊れたイメージを push した際に、デプロイ失敗のまま `aws ecs wait services-stable` が
  # タイムアウトまでハングし続けるのを防ぐ（production-readiness L-3）。
  # rollback = true で直前の安定リビジョンへ自動で戻す。
  deployment_circuit_breaker {
    enable   = true
    rollback = true
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

# CPU 使用率ベースの target-tracking policy（Issue #234）。
# min/max（aws_appautoscaling_target）だけでは実際にはスケールしないため、
# 負荷をかけて検証する環境（staging-full）でのみ min/max と policy をセットで有効化する。
resource "aws_appautoscaling_policy" "cpu" {
  count = local.autoscaling_policy_enabled ? 1 : 0

  name               = "${var.name}-cpu-target-tracking"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace
  resource_id        = aws_appautoscaling_target.this[0].resource_id
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value = var.autoscaling_cpu_target
  }
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

# ---------- CloudWatch アラーム（Golden Signals: Saturation。Issue #218） ----------
# 既存パターン（sqs モジュールの DLQ アラーム）に倣い、アラームはサービスを所有する
# このモジュール内に置く。CPU / Memory の持続的な高騰は、スケール不足または
# リソースリーク（メモリ）の兆候として通知する。Fargate はタスク単位の上限が固定のため、
# Memory 85% 超の持続は OOM kill（コンテナ強制終了）の前兆になる。
# タスク 0 台（scale in / 停止中）ではデータ点が出ないため notBreaching にする。
resource "aws_cloudwatch_metric_alarm" "cpu_high" {
  count = var.create_alarms ? 1 : 0

  alarm_name          = "${var.name}-cpu-high"
  alarm_description   = "ECS サービス ${var.name} の CPUUtilization が ${var.alarm_cpu_threshold}% を超過（スケール不足・処理詰まりを確認する）"
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.alarm_cpu_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = var.cluster_name
    ServiceName = aws_ecs_service.this.name
  }

  # ALARM 遷移だけでなく OK 復帰も通知する（DLQ アラームと同じ運用）。
  alarm_actions = var.alarm_actions
  ok_actions    = var.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "memory_high" {
  count = var.create_alarms ? 1 : 0

  alarm_name          = "${var.name}-memory-high"
  alarm_description   = "ECS サービス ${var.name} の MemoryUtilization が ${var.alarm_memory_threshold}% を超過（OOM kill 前兆・メモリリークを確認する）"
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.alarm_memory_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = var.cluster_name
    ServiceName = aws_ecs_service.this.name
  }

  alarm_actions = var.alarm_actions
  ok_actions    = var.alarm_actions
}
