output "vpc_id" {
  value = module.network.vpc_id
}

output "ecr_repository_url" {
  value = module.ecr.repository_url
}

output "aurora_endpoint" {
  value = module.aurora.cluster_endpoint
}

output "aurora_master_user_secret_arn" {
  value = module.aurora.master_user_secret_arn
}

output "valkey_endpoint" {
  value = module.valkey.primary_endpoint
}

output "opensearch_endpoint" {
  value = module.opensearch.endpoint
}

output "event_bus_name" {
  value = module.eventbridge.bus_name
}

output "search_projection_queue_url" {
  value = module.search_projection_queue.queue_url
}

output "alb_dns_name" {
  value = module.alb.dns_name
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "api_service_name" {
  value = module.api_service.service_name
}

output "worker_service_name" {
  value = module.worker_service.service_name
}

output "api_url" {
  description = "API の公開 HTTPS エンドポイント（ADR-0007）"
  value       = "https://${var.api_subdomain}.${var.hosted_zone_name}"
}

output "frontend_ecr_repository_url" {
  value = module.ecr_frontend.repository_url
}

output "frontend_service_name" {
  value = module.frontend_service.service_name
}

output "cloudfront_distribution_id" {
  value = module.cloudfront.distribution_id
}

output "app_url" {
  description = "フロントエンドの公開 HTTPS エンドポイント（ADR-0011）"
  value       = "https://${var.app_subdomain}.${var.hosted_zone_name}"
}
