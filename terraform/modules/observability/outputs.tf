output "log_group_names" {
  value = { for k, v in aws_cloudwatch_log_group.this : k => v.name }
}

# アラーム action 配線用（production-readiness L-5 / Issue #200）。
# alert_email が空でトピックを作らない場合は空リストになり、そのままアラーム actions へ渡せる。
output "alarm_action_arns" {
  value = aws_sns_topic.alerts[*].arn
}
