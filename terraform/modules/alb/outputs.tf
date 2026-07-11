output "dns_name" {
  value = aws_lb.this.dns_name
}

output "target_group_arn" {
  value = aws_lb_target_group.api.arn
}

output "security_group_id" {
  value = aws_security_group.alb.id
}

output "listener_arn" {
  value = aws_lb_listener.http.arn
}

output "zone_id" {
  description = "Route53 alias レコード用の ALB hosted zone ID"
  value       = aws_lb.this.zone_id
}

output "frontend_target_group_arn" {
  description = "フロントエンド用 target group（enable_frontend = false のときは null）"
  value       = var.enable_frontend ? aws_lb_target_group.frontend[0].arn : null
}

# ---------- Dashboard 用（Issue #253）----------
# CloudWatch メトリクスの dimension は ARN ではなく arn_suffix（末尾の識別子）を使うため、
# 既存のアラーム定義（このモジュール内）と同じ値を Dashboard 用に output する。

output "arn_suffix" {
  description = "ALB の arn_suffix（AWS/ApplicationELB メトリクスの LoadBalancer dimension 用。Issue #253）"
  value       = aws_lb.this.arn_suffix
}

output "target_group_arn_suffix" {
  description = "API target group の arn_suffix（AWS/ApplicationELB メトリクスの TargetGroup dimension 用。Issue #253）"
  value       = aws_lb_target_group.api.arn_suffix
}

output "frontend_target_group_arn_suffix" {
  description = "フロントエンド用 target group の arn_suffix（enable_frontend = false のときは null。Issue #253）"
  value       = var.enable_frontend ? aws_lb_target_group.frontend[0].arn_suffix : null
}
