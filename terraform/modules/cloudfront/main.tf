# CloudFront 統合オリジン distribution（ADR-0011 決定 2）。
# 同一 ALB を 2 つの origin（api / frontend）として登録し、パスで振り分ける:
# - /api/*          → api origin（識別ヘッダーなし → ALB default action = API target group）
# - /_next/static/* → frontend origin（immutable アセットのため長期キャッシュ）
# - その他（SSR）   → frontend origin（識別ヘッダー付き → ALB listener rule で frontend へ）
# custom header を per-origin で付けることで、同一 ALB でも behavior 単位の振り分けができる。

locals {
  # AWS managed cache / origin request policy の固定 ID（全アカウント共通）。
  # CachingDisabled: SSR / API はキャッシュしない
  caching_disabled_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  # CachingOptimized: /_next/static/*（ファイル名にハッシュを含む immutable アセット）用
  caching_optimized_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  # AllViewerExceptHostHeader: Cookie / query / header を全転送し、Host だけ origin の FQDN にする。
  # Host を転送しないのは、ALB の証明書 / ルーティングが origin FQDN（API のドメイン）前提のため。
  all_viewer_except_host_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"

  api_origin_id      = "api"
  frontend_origin_id = "frontend"
}

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = var.name
  # 主要視聴者は日本のため、アジアを含む PriceClass_200 にする（All は不要）。
  price_class = "PriceClass_200"
  aliases     = var.aliases

  # api origin: 識別ヘッダーを付けない → ALB default action（API target group）に落ちる。
  origin {
    origin_id   = local.api_origin_id
    domain_name = var.origin_domain_name

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # frontend origin: 同じ ALB だが識別ヘッダーを付け、listener rule で frontend target group へ。
  origin {
    origin_id   = local.frontend_origin_id
    domain_name = var.origin_domain_name

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    custom_header {
      name  = var.frontend_header_name
      value = var.frontend_header_value
    }
  }

  # SSR ページ（default）: キャッシュ無効・Cookie 全転送（認証状態でレンダリングが変わるため）。
  default_cache_behavior {
    target_origin_id       = local.frontend_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = local.caching_disabled_policy_id
    origin_request_policy_id = local.all_viewer_except_host_policy_id
  }

  # ビルドハッシュ付き静的アセットは immutable なので edge で長期キャッシュする。
  ordered_cache_behavior {
    path_pattern           = "/_next/static/*"
    target_origin_id       = local.frontend_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id = local.caching_optimized_policy_id
  }

  # API はキャッシュ無効・Cookie / header 全転送（httpOnly Cookie 認証。ADR-0011 決定 3）。
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = local.api_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = local.caching_disabled_policy_id
    origin_request_policy_id = local.all_viewer_except_host_policy_id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    # CloudFront の証明書は us-east-1 の ACM である必要がある（root 側で provider alias により発行）。
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
