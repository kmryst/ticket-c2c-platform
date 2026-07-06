# 定期実行タスクモジュール（L-9 残課題 / Issue #195）。
# EventBridge Scheduler から既存 ECS タスク定義を command override で RunTask する。
# 新規 Lambda・新規イメージは作らず、run-db-migration.sh と同じ
# 「既存 API イメージ・別コマンド」パターンをスケジュール実行に転用する。
# ログは対象タスク定義の awslogs 設定（API のロググループ）へそのまま出る。

data "aws_caller_identity" "current" {}

locals {
  # deploy workflow は Terraform 外で新しいタスク定義リビジョンを register する（ecs-service の
  # lifecycle ignore_changes と同じ前提）。リビジョン番号を外した family ARN を渡すと、
  # Scheduler は起動時点の最新 ACTIVE リビジョンを使うため、デプロイのたびに
  # スケジュールを更新する必要がない（run-db-migration.sh が現行タスク定義を使うのと同じ方針）。
  task_definition_family_arn = replace(var.task_definition_arn, "/:\\d+$/", "")
}

# Scheduler がこのロールを引き受けて ecs:RunTask を呼ぶ。
data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    # confused deputy 対策: 自アカウントのスケジュールからの引き受けだけを許可する。
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

# 最小権限: 対象タスク定義 family の RunTask（対象クラスタ限定）と、
# そのタスク定義が使う実行ロール・タスクロールの PassRole（ecs-tasks 向け限定）のみ。
resource "aws_iam_role_policy" "scheduler_run_task" {
  name = "run-scheduled-task"
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["ecs:RunTask"]
        Resource = [
          local.task_definition_family_arn,
          "${local.task_definition_family_arn}:*",
        ]
        Condition = {
          ArnEquals = {
            "ecs:cluster" = var.cluster_arn
          }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [var.execution_role_arn, var.task_role_arn]
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      }
    ]
  })
}

resource "aws_scheduler_schedule" "this" {
  name = var.name

  # バッチの起動時刻に精度は不要だが、構成を単純に保つため時刻どおりに起動する。
  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression = var.schedule_expression

  target {
    # ECS RunTask ターゲットではクラスタ ARN を指定する。
    arn      = var.cluster_arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      task_definition_arn = local.task_definition_family_arn
      launch_type         = "FARGATE"
      task_count          = 1

      # ECS console / describe-tasks で起動元を判別できるようにする。
      group = var.name

      network_configuration {
        subnets          = var.subnet_ids
        security_groups  = var.security_group_ids
        assign_public_ip = false
      }
    }

    # command override で既存イメージの別エントリポイントを起動する。
    input = jsonencode({
      containerOverrides = [
        {
          name    = var.container_name
          command = var.command
        }
      ]
    })

    # 一時的な起動失敗（ENI 枯渇等）に備えて 1 回だけ再試行する。
    # ジョブ本体（DELETE）は冪等なので再試行しても安全。
    retry_policy {
      maximum_retry_attempts       = 1
      maximum_event_age_in_seconds = 3600
    }
  }
}
