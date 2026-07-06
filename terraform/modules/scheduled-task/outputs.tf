output "schedule_arn" {
  value = aws_scheduler_schedule.this.arn
}

output "schedule_name" {
  value = aws_scheduler_schedule.this.name
}

output "scheduler_role_arn" {
  value = aws_iam_role.scheduler.arn
}
