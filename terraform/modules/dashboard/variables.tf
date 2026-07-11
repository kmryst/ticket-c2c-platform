variable "name" {
  description = "リソース名プレフィックス（Dashboard 名 <name>-overview に使う。既存リソースの命名規則を踏襲。Issue #253）"
  type        = string
}

variable "region" {
  description = "ALB / ECS / Aurora / SQS / EMF メトリクスのリージョン（東京）"
  type        = string
}

variable "edge_region" {
  description = "CloudFront / WAF（scope=CLOUDFRONT）メトリクスのリージョン。CloudWatch dashboard の各 widget は region を個別指定できるため、Dashboard 自体は東京リージョンに作成しつつこのリージョンの metrics も同じ画面に表示できる"
  type        = string
  default     = "us-east-1"
}

variable "metrics_namespace" {
  description = "EMF ビジネスメトリクス（ValkeyFailOpen / WorkerProcessingLagMs / PurchaseRequestOutcome / PurchaseRequestLatencyMs）の CloudWatch 名前空間"
  type        = string
}

# ---------- ALB ----------

variable "alb_arn_suffix" {
  description = "ALB の arn_suffix（AWS/ApplicationELB メトリクスの LoadBalancer dimension）"
  type        = string
}

variable "alb_api_target_group_arn_suffix" {
  description = "API target group の arn_suffix"
  type        = string
}

variable "alb_frontend_target_group_arn_suffix" {
  description = "フロントエンド target group の arn_suffix。frontend 未構築（staging の alb-http-only モード等）の場合は null"
  type        = string
  default     = null
}

# ---------- ECS ----------

variable "ecs_cluster_name" {
  description = "ECS クラスタ名（AWS/ECS メトリクスの ClusterName dimension）"
  type        = string
}

variable "ecs_api_service_name" {
  description = "API ECS サービス名"
  type        = string
}

variable "ecs_worker_service_name" {
  description = "Worker ECS サービス名"
  type        = string
}

variable "ecs_frontend_service_name" {
  description = "Frontend ECS サービス名。frontend 未構築の場合は null"
  type        = string
  default     = null
}

# ---------- Aurora ----------

variable "aurora_cluster_identifier" {
  description = "Aurora クラスタ識別子（AWS/RDS メトリクスの DBClusterIdentifier dimension）"
  type        = string
}

# ---------- SQS ----------

variable "sqs_dlq_name" {
  description = "search-projection DLQ のキュー名（AWS/SQS メトリクスの QueueName dimension）"
  type        = string
}

# ---------- CloudFront / WAF（L-16 / Issue #252。未構築の場合は null で edge widget を省略） ----------

variable "cloudfront_distribution_id" {
  description = "CloudFront distribution ID。CloudFront 未構築（staging の alb-http-only モード等）の場合は null"
  type        = string
  default     = null
}

variable "waf_web_acl_name" {
  description = "WAFv2 WebACL の名前（CloudWatch メトリクス名。visibility_config.metric_name と一致させる）。未構築の場合は null"
  type        = string
  default     = null
}

# ---------- 購入 API SLO（ADR-0017 / Issue #227。annotation 表示用） ----------

variable "purchase_success_slo_percent" {
  description = "購入 API 成功率の SLO 目標値（%）。ダッシュボード上に閾値 annotation として表示する"
  type        = number
  default     = 99.5
}

variable "purchase_latency_slo_ms" {
  description = "購入 API レイテンシ（p95）の SLO 目標値（ms）。ダッシュボード上に閾値 annotation として表示する"
  type        = number
  default     = 800
}
