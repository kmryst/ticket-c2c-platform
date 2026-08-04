output "queue_url" {
  value = aws_sqs_queue.this.url
}

output "queue_name" {
  description = "source queue の名前（AWS/SQS メトリクスの QueueName dimension。dashboard で backlog / oldest age を表示するために使う。Issue #377）"
  value       = aws_sqs_queue.this.name
}

output "queue_arn" {
  value = aws_sqs_queue.this.arn
}

output "dlq_arn" {
  value = aws_sqs_queue.dlq.arn
}
