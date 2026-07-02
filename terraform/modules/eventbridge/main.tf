resource "aws_cloudwatch_event_bus" "this" {
  name = var.name
}

# ドメインイベントを SQS へルーティングする
resource "aws_cloudwatch_event_rule" "domain_events" {
  name           = "${var.name}-domain-events"
  event_bus_name = aws_cloudwatch_event_bus.this.name

  event_pattern = jsonencode({
    source      = [var.event_source]
    detail-type = var.detail_types
  })
}

resource "aws_cloudwatch_event_target" "to_sqs" {
  rule           = aws_cloudwatch_event_rule.domain_events.name
  event_bus_name = aws_cloudwatch_event_bus.this.name
  arn            = var.target_queue_arn
}

resource "aws_sqs_queue_policy" "allow_eventbridge" {
  queue_url = var.target_queue_url

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = var.target_queue_arn
        Condition = {
          ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.domain_events.arn }
        }
      }
    ]
  })
}
