locals {
  # FIFO キューは名前が .fifo で終わる必要がある（ADR-0004: 初期は Standard のみ使用）
  queue_name = var.fifo ? "${var.name}.fifo" : var.name
  dlq_name   = var.fifo ? "${var.name}-dlq.fifo" : "${var.name}-dlq"
}

resource "aws_sqs_queue" "dlq" {
  name       = local.dlq_name
  fifo_queue = var.fifo

  message_retention_seconds = 1209600 # 14 日
}

resource "aws_sqs_queue" "this" {
  name       = local.queue_name
  fifo_queue = var.fifo

  visibility_timeout_seconds = var.visibility_timeout_seconds
  receive_wait_time_seconds  = 20 # ロングポーリング

  content_based_deduplication = var.fifo ? true : null

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

# DLQ 滞留の検知（production-readiness L-5）。
# Worker の処理失敗で DLQ に移ったメッセージに気づけるよう、1 件以上の滞留で ALARM にする。
# 通知先は root module から dlq_alarm_actions（SNS トピック ARN 等）で受け取る（Issue #200）。
# 空リストの場合はアラーム状態の可視化のみ（actions なし）。
resource "aws_cloudwatch_metric_alarm" "dlq_messages" {
  count = var.create_dlq_alarm ? 1 : 0

  alarm_name          = "${local.dlq_name}-messages-visible"
  alarm_description   = "DLQ ${local.dlq_name} に滞留メッセージがある（Worker の処理失敗を確認する）"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }

  # ALARM 遷移だけでなく OK 復帰も通知し、滞留解消（redrive / purge 後）を追跡できるようにする。
  alarm_actions = var.dlq_alarm_actions
  ok_actions    = var.dlq_alarm_actions
}
