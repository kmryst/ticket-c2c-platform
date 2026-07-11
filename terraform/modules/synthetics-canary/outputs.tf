output "canary_name" {
  value = aws_synthetics_canary.this.name
}

output "canary_arn" {
  value = aws_synthetics_canary.this.arn
}

output "alarm_name" {
  value = aws_cloudwatch_metric_alarm.synthetic_check_failure.alarm_name
}
