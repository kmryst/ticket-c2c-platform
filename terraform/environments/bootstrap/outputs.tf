output "state_bucket_name" {
  description = "tfstate 用 S3 バケット名"
  value       = aws_s3_bucket.tfstate.bucket
}

output "plan_role_arn" {
  description = "GitHub Actions の terraform plan 用ロール ARN（AWS_PLAN_ROLE_ARN に設定する）"
  value       = module.github_oidc.plan_role_arn
}

output "apply_role_arn" {
  description = "GitHub Actions の apply / destroy / deploy 用ロール ARN（AWS_APPLY_ROLE_ARN に設定する）"
  value       = module.github_oidc.apply_role_arn
}

output "staging_state_readonly_role_arn" {
  description = "staging-smoke-test.yml 用の staging state 読み取り専用ロール ARN（AWS_STAGING_READONLY_ROLE_ARN に設定する）"
  value       = aws_iam_role.staging_state_readonly.arn
}
