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
  description = <<-EOT
    smoke test 等が使う API の base URL。
    https-dns では CloudFront 経由の app FQDN + /api（ADR-0013 で ALB 直叩きを遮断したため、
    外部からの API アクセスは CloudFront の /api/* 経路に限られる）。
    alb-http-only では従来どおり ALB DNS 名（CloudFront なし）。
  EOT
  value       = var.public_endpoint_mode == "https-dns" ? "https://${var.app_subdomain}.${var.hosted_zone_name}/api" : "http://${module.alb.dns_name}"
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
