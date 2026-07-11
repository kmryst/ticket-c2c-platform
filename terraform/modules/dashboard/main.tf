# Observability 用 CloudWatch Dashboard（Issue #253）。
#
# 障害発報時に、入口（CloudFront / WAF）→ ALB → ECS（API / Worker / Frontend）→
# データ層（Aurora）→ 非同期処理（Valkey fail-open / Worker lag / SQS DLQ）→
# 購入 API SLO までを 1 画面で横断確認できる「初動確認用」ダッシュボード。
# 詳細分析用の大量 widget は意図的に追加しない（Issue #253 の受け入れ条件）。
#
# CloudWatch dashboard は widget ごとに properties.region を個別指定できるため、
# Dashboard リソース自体は東京リージョン（デフォルト provider）に 1 つ作成し、
# CloudFront / WAF（us-east-1 のみでメトリクスが発行される。L-16 / Issue #252）の
# widget だけ region を us-east-1 に切り替える。これにより us-east-1 provider や
# cross-region 集約なしで 1 画面にまとめられる。
#
# dashboard_body は HCL のオブジェクト/tuple リテラル + jsonencode() ではなく、
# JSON テンプレート（templates/dashboard.json.tftpl）+ templatefile() で組み立てる。
# widget ごとに properties の attribute 集合が異なる（yAxis の有無、annotations の有無等）ため、
# HCL 側で `has_edge ? [...] : []` のような条件分岐を書くと、tuple 型統一の際に
# 「異なる属性を持つオブジェクトの unify に失敗する」（Inconsistent conditional result types）
# エラーになる。text template なら文字列結合の問題に単純化でき、この制約を回避できる。
locals {
  # CloudFront / WAF が未構築（staging の alb-http-only モード等）の場合は edge widget を省略する。
  has_edge = var.cloudfront_distribution_id != null && var.waf_web_acl_name != null
  has_frontend = (
    var.alb_frontend_target_group_arn_suffix != null &&
    var.ecs_frontend_service_name != null
  )

  # edge widget の有無で以降の y 座標を詰める（widget なしの帯を残さないため）。
  base_y = local.has_edge ? 8 : 2

  dashboard_body = templatefile("${path.module}/templates/dashboard.json.tftpl", {
    name        = var.name
    region      = var.region
    edge_region = var.edge_region

    metrics_namespace = var.metrics_namespace

    alb_arn_suffix                       = var.alb_arn_suffix
    alb_api_target_group_arn_suffix      = var.alb_api_target_group_arn_suffix
    alb_frontend_target_group_arn_suffix = coalesce(var.alb_frontend_target_group_arn_suffix, "")

    ecs_cluster_name          = var.ecs_cluster_name
    ecs_api_service_name      = var.ecs_api_service_name
    ecs_worker_service_name   = var.ecs_worker_service_name
    ecs_frontend_service_name = coalesce(var.ecs_frontend_service_name, "")

    aurora_cluster_identifier = var.aurora_cluster_identifier

    sqs_dlq_name = var.sqs_dlq_name

    cloudfront_distribution_id = coalesce(var.cloudfront_distribution_id, "")
    waf_web_acl_name           = coalesce(var.waf_web_acl_name, "")

    purchase_success_slo_percent = var.purchase_success_slo_percent
    purchase_latency_slo_ms      = var.purchase_latency_slo_ms

    has_edge     = local.has_edge
    has_frontend = local.has_frontend
    base_y       = local.base_y
  })
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${var.name}-overview"
  dashboard_body = local.dashboard_body
}
