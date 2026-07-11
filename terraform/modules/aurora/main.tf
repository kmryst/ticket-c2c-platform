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

# ---------- CloudWatch アラーム（Golden Signals: Saturation。Issue #218） ----------
# 既存パターン（sqs モジュールの DLQ アラーム）に倣い、アラームはクラスタを所有する
# このモジュール内に置く。dimension は DBClusterIdentifier（クラスタ集計）を使い、
# reader 台数の増減（dev: 0 / staging: 1+）でアラーム定義が変わらないようにする。
# min_capacity = 0 の auto-pause 中はメトリクスのデータ点が出ないため、
# 全アラームで treat_missing_data = notBreaching にする（pause は正常状態）。
#
# 注: Serverless v2 に CPUCreditBalance は存在しない（バーストクレジットは t 系
# インスタンスクラス専用）。CPU の頭打ちは CPUUtilization と ACU 上限接近で捕捉する。

locals {
  # DatabaseConnections の閾値は Aurora PostgreSQL の max_connections 推定値から導出する。
  # Serverless v2 の max_connections は「max ACU 相当メモリ」で固定評価される:
  #   LEAST({DBInstanceClassMemory/9531392}, 5000)、1 ACU = 2 GiB
  # その 80% を超えたら接続リーク・pool 設定過大を疑う。
  aurora_estimated_max_connections = min(var.max_capacity * 2 * 1073741824 / 9531392, 5000)
  connections_alarm_threshold      = floor(local.aurora_estimated_max_connections * 0.8)
}

resource "aws_cloudwatch_metric_alarm" "cpu_high" {
  count = var.create_alarms ? 1 : 0

  alarm_name          = "${var.name}-aurora-cpu-high"
  alarm_description   = "[Warning] Aurora クラスタ ${aws_rds_cluster.this.cluster_identifier} の CPUUtilization が 80% を超過（クエリ性能劣化・ACU 上限到達を確認する）"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBClusterIdentifier = aws_rds_cluster.this.cluster_identifier
  }

  # ALARM 遷移だけでなく OK 復帰も通知する（DLQ アラームと同じ運用）。
  alarm_actions = var.alarm_actions
  ok_actions    = var.alarm_actions
}

# FreeableMemory の持続的低下はワーキングセット超過（スワップ・OOM リスタート前兆）の兆候。
# Serverless v2 はメモリも ACU に比例してスケールするため、max ACU 到達後の枯渇を検知する。
resource "aws_cloudwatch_metric_alarm" "freeable_memory_low" {
  count = var.create_alarms ? 1 : 0

  alarm_name          = "${var.name}-aurora-freeable-memory-low"
  alarm_description   = "[Critical] Aurora クラスタ ${aws_rds_cluster.this.cluster_identifier} の FreeableMemory が ${var.alarm_freeable_memory_threshold_bytes} bytes を下回った（メモリ枯渇・ACU 上限到達を確認する）"
  namespace           = "AWS/RDS"
  metric_name         = "FreeableMemory"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.alarm_freeable_memory_threshold_bytes
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBClusterIdentifier = aws_rds_cluster.this.cluster_identifier
  }

  alarm_actions = var.alarm_actions
  ok_actions    = var.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "connections_high" {
  count = var.create_alarms ? 1 : 0

  alarm_name          = "${var.name}-aurora-connections-high"
  alarm_description   = "[Warning] Aurora クラスタ ${aws_rds_cluster.this.cluster_identifier} の DatabaseConnections が推定 max_connections の 80%（${local.connections_alarm_threshold}）を超過（接続リーク・pool 設定過大を確認する）"
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = local.connections_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBClusterIdentifier = aws_rds_cluster.this.cluster_identifier
  }

  alarm_actions = var.alarm_actions
  ok_actions    = var.alarm_actions
}

# ACU が max_capacity の 90% に張り付いたら「これ以上スケールできない」saturation として通知する。
# 閾値は max_capacity から導出するため、capacity profile（staging normal: 4 / full: 8）に自動追従する。
resource "aws_cloudwatch_metric_alarm" "acu_near_max" {
  count = var.create_alarms ? 1 : 0

  alarm_name          = "${var.name}-aurora-acu-near-max"
  alarm_description   = "[Warning] Aurora クラスタ ${aws_rds_cluster.this.cluster_identifier} の ServerlessDatabaseCapacity が max_capacity（${var.max_capacity} ACU）の 90% を超過（スケール上限到達。max_capacity 引き上げを検討する）"
  namespace           = "AWS/RDS"
  metric_name         = "ServerlessDatabaseCapacity"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.max_capacity * 0.9
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBClusterIdentifier = aws_rds_cluster.this.cluster_identifier
  }

  alarm_actions = var.alarm_actions
  ok_actions    = var.alarm_actions
}
