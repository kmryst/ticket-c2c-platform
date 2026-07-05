output "domain_name" {
  description = "distribution のドメイン名（Route53 alias 用）"
  value       = aws_cloudfront_distribution.this.domain_name
}

output "hosted_zone_id" {
  description = "Route53 alias 用の CloudFront hosted zone ID"
  value       = aws_cloudfront_distribution.this.hosted_zone_id
}

output "distribution_id" {
  description = "cache invalidation 等の運用操作に使う distribution ID"
  value       = aws_cloudfront_distribution.this.id
}
