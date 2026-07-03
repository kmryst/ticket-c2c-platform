resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name}-valkey"
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "this" {
  name_prefix = "${var.name}-valkey-"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = var.allowed_security_group_ids
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name}-valkey" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = "${var.name}-valkey"
  # ElastiCache の description は ASCII のみ許容（日本語だと InvalidParameterValue になる）
  description = "${var.name} inventory pre-filter"

  engine         = "valkey"
  engine_version = var.engine_version
  node_type      = var.node_type
  port           = 6379

  num_cache_clusters = var.num_cache_clusters

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.this.id]

  # dev はアプリ実装を単純化するため TLS なし（VPC 内 + SG 制限）。
  # staging 以降は profile から encryption を有効化する。
  transit_encryption_enabled = var.transit_encryption_enabled
  at_rest_encryption_enabled = var.at_rest_encryption_enabled

  automatic_failover_enabled = var.automatic_failover_enabled
  snapshot_retention_limit   = 0

  apply_immediately = true
}
