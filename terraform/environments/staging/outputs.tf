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

output "api_base_url" {
  description = "smoke test 等が使う API の base URL。https-dns では公開 FQDN、alb-http-only では ALB DNS 名"
  value       = var.public_endpoint_mode == "https-dns" ? "https://${var.api_subdomain}.${var.hosted_zone_name}" : "http://${module.alb.dns_name}"
}

output "frontend_ecr_repository_url" {
  value = module.ecr_frontend.repository_url
}

output "frontend_service_name" {
  value = local.https_enabled ? module.frontend_service[0].service_name : null
}

output "cloudfront_distribution_id" {
  value = local.https_enabled ? module.cloudfront[0].distribution_id : null
}

output "app_url" {
  description = "フロントエンドの公開 HTTPS エンドポイント（https-dns のみ。ADR-0011）"
  value       = local.https_enabled ? "https://${var.app_subdomain}.${var.hosted_zone_name}" : null
}
