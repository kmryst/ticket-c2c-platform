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
