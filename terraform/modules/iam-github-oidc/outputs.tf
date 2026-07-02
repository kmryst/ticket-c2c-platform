output "oidc_provider_arn" {
  description = "GitHub OIDC provider の ARN"
  value       = local.oidc_provider_arn
}

output "plan_role_arn" {
  description = "terraform plan 用ロールの ARN"
  value       = aws_iam_role.plan.arn
}

output "apply_role_arn" {
  description = "terraform apply / destroy / deploy 用ロールの ARN"
  value       = aws_iam_role.apply.arn
}
