output "endpoint" {
  description = "VPC 内エンドポイント（https:// なし）"
  value       = aws_opensearch_domain.this.endpoint
}

output "security_group_id" {
  value = aws_security_group.this.id
}
