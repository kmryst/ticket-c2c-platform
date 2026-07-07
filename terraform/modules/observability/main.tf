resource "aws_cloudwatch_log_group" "this" {
  for_each = toset(var.log_group_names)

  name              = each.key
  retention_in_days = var.retention_in_days
}

# 環境共通のアラート通知用 SNS トピック（production-readiness L-5 / Issue #200）。
# CloudWatch アラーム（現状は SQS DLQ 滞留アラームのみ）の action 先として使う。
# alert_email が空の場合はトピック自体を作らない（通知配線なしの従来挙動）。
resource "aws_sns_topic" "alerts" {
  count = var.alert_email != "" ? 1 : 0

  name = "${var.name}-alerts"
}

# メール通知（SNS → email）。ユーザー決定により通知先はメールとする（Issue #200）。
# email subscription は受信者がメール内の Confirm subscription リンクを踏むまで Pending のまま。
# dev は destroy 前提運用のため、apply のたびに confirm が必要になる（既知の運用事項）。
resource "aws_sns_topic_subscription" "alerts_email" {
  count = var.alert_email != "" ? 1 : 0

  topic_arn = aws_sns_topic.alerts[0].arn
  protocol  = "email"
  endpoint  = var.alert_email
}
