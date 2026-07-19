data "aws_caller_identity" "current" {}

resource "aws_security_group" "this" {
  name_prefix = "${var.name}-opensearch-"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = var.allowed_security_group_ids
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name}-opensearch" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_opensearch_domain" "this" {
  domain_name    = var.name
  engine_version = var.engine_version

  cluster_config {
    instance_type          = var.instance_type
    instance_count         = var.instance_count
    zone_awareness_enabled = var.zone_awareness_enabled

    dynamic "zone_awareness_config" {
      for_each = var.zone_awareness_enabled ? [1] : []
      content {
        availability_zone_count = var.availability_zone_count
      }
    }
  }

  ebs_options {
    ebs_enabled = true
    volume_type = "gp3"
    volume_size = var.volume_size
  }

  vpc_options {
    subnet_ids         = var.zone_awareness_enabled ? slice(var.subnet_ids, 0, var.availability_zone_count) : [var.subnet_ids[0]]
    security_group_ids = [aws_security_group.this.id]
  }

  encrypt_at_rest {
    enabled = true
  }

  node_to_node_encryption {
    enabled = true
  }

  domain_endpoint_options {
    enforce_https       = true
    tls_security_policy = "Policy-Min-TLS-1-2-2019-07"
  }

  # アクセスポリシー（production-readiness M-3）:
  # - allowed_principal_arns 指定時は、SigV4 署名済みリクエストの principal を task role 等に限定する（staging 以降）。
  # - null の場合は VPC 内ドメイン + SG 制限だけを認可境界とし、到達可能な workload の IAM principal は制限しない（dev 互換、production-readiness L-23）。
  access_policies = var.allowed_principal_arns == null ? jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { AWS = "*" }
        Action    = "es:*"
        Resource  = "arn:aws:es:${var.region}:${data.aws_caller_identity.current.account_id}:domain/${var.name}/*"
      }
    ]
    }) : jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { AWS = var.allowed_principal_arns }
        Action    = "es:*"
        Resource  = "arn:aws:es:${var.region}:${data.aws_caller_identity.current.account_id}:domain/${var.name}/*"
      }
    ]
  })
}
