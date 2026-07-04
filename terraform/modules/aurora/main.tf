resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-aurora"
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "this" {
  name_prefix = "${var.name}-aurora-"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = var.allowed_security_group_ids
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name}-aurora" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_rds_cluster" "this" {
  cluster_identifier = "${var.name}-aurora"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = var.engine_version
  database_name      = var.database_name
  master_username    = var.master_username

  # マスターパスワードは Secrets Manager 管理（state に平文で残さない）
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]

  serverlessv2_scaling_configuration {
    min_capacity             = var.min_capacity
    max_capacity             = var.max_capacity
    seconds_until_auto_pause = var.seconds_until_auto_pause
  }

  # dev では destroy 可能にする。staging / prod では必ず true / false を反転させる
  deletion_protection = var.deletion_protection
  skip_final_snapshot = var.skip_final_snapshot

  # バックアップ方針（production-readiness L-7）。dev / staging はエフェメラル環境
  # （ADR-0008）のため最小の 1 日を明示し、prod では 7 日以上へ引き上げる。
  backup_retention_period = var.backup_retention_period
  preferred_backup_window = var.preferred_backup_window

  apply_immediately = true
}

resource "aws_rds_cluster_instance" "this" {
  identifier         = "${var.name}-aurora-1"
  cluster_identifier = aws_rds_cluster.this.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.this.engine
  engine_version     = aws_rds_cluster.this.engine_version

  # マイナーバージョン方針（production-readiness L-7）: 自動適用を明示する。
  # 適用タイミングはメンテナンスウィンドウ。prod で固定運用したくなったら false + 手動更新へ。
  auto_minor_version_upgrade = var.auto_minor_version_upgrade
}

# failover 用 reader（staging 以降。dev は 0 台）。writer 障害時の昇格先になる。
# Serverless v2 の reader は writer と同じ scaling configuration に従う。
resource "aws_rds_cluster_instance" "reader" {
  count = var.reader_instance_count

  identifier         = "${var.name}-aurora-${count.index + 2}"
  cluster_identifier = aws_rds_cluster.this.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.this.engine
  engine_version     = aws_rds_cluster.this.engine_version

  auto_minor_version_upgrade = var.auto_minor_version_upgrade

  # writer 作成完了後に追加する（初回 apply 時のインスタンス作成競合を避ける）
  depends_on = [aws_rds_cluster_instance.this]
}
