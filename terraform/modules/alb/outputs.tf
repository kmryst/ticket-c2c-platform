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
