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

# L-15: CloudFront 境界で付与する最小 security headers。
# Next.js App Router の inline script と衝突するため、script-src 等を含むフル CSP はここでは扱わない。
resource "aws_cloudfront_response_headers_policy" "security_headers" {
  name    = "${var.name}-security-headers"
  comment = "Minimal browser security headers for ${var.name}"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = false
      override                   = true
      preload                    = false
    }

    content_type_options {
      override = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    content_security_policy {
      content_security_policy = "frame-ancestors 'none'"
      override                = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }
  }
}

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = var.name
  # 主要視聴者は日本のため、アジアを含む PriceClass_200 にする（All は不要）。
  price_class = "PriceClass_200"
  aliases     = var.aliases

  # WAFv2 WebACL の関連付け（L-12 / Issue #184）。scope=CLOUDFRONT の WebACL は ARN を渡す。
  web_acl_id = var.web_acl_id

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
  # allowed_methods は GET/HEAD/OPTIONS のみにする（Issue #236）。frontend（Next.js SSR）は
  # Server Actions（'use server'）・form の action 属性・POST 等を受ける Route Handler の
  # いずれも実装しておらず、PUT/POST/PATCH/DELETE を必要としない。最小権限の原則で絞る。
  # 将来 Server Actions を追加する場合はここを拡張する必要がある（ADR-0011 参照）。
  default_cache_behavior {
    target_origin_id       = local.frontend_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = local.caching_disabled_policy_id
    origin_request_policy_id   = local.all_viewer_except_host_policy_id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id
  }

  # ビルドハッシュ付き静的アセットは immutable なので edge で長期キャッシュする。
  ordered_cache_behavior {
    path_pattern           = "/_next/static/*"
    target_origin_id       = local.frontend_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = local.caching_optimized_policy_id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id
  }

  # API はキャッシュ無効・Cookie / header 全転送（httpOnly Cookie 認証。ADR-0011 決定 3）。
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = local.api_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = local.caching_disabled_policy_id
    origin_request_policy_id   = local.all_viewer_except_host_policy_id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id
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
