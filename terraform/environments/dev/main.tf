# dev root module
# レイヤごとにブロックを分けて記述する（将来の state 分割線。ADR-0003）。
# 1. network レイヤ
# 2. data / messaging レイヤ（Aurora / Valkey / OpenSearch / EventBridge / SQS）
# 3. app レイヤ（ALB / ECS）
# 4. observability レイヤ

# ---------- network ----------

module "network" {
  source = "../../modules/network"

  name     = var.name
  region   = var.region
  vpc_cidr = var.vpc_cidr
}

# ---------- app（コンテナレジストリ・共通 SG） ----------

module "ecr" {
  source = "../../modules/ecr"

  name = var.name
  # destroy 前提運用のためイメージ残存時も削除可にする
  force_delete = true
}

# ECS タスク（API / Worker）が共用する SG。
# データ層の ingress はこの SG からのみ許可する
resource "aws_security_group" "app" {
  name_prefix = "${var.name}-app-"
  vpc_id      = module.network.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name}-app" }

  lifecycle {
    create_before_destroy = true
  }
}

# ---------- data / messaging ----------

module "aurora" {
  source = "../../modules/aurora"

  name                       = var.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = [aws_security_group.app.id]

  # dev: auto-pause 有効・削除保護なし（staging / prod では反転させる）
  min_capacity             = 0
  max_capacity             = 2
  seconds_until_auto_pause = 1800
  deletion_protection      = false
  skip_final_snapshot      = true
}

module "valkey" {
  source = "../../modules/valkey"

  name                       = var.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = [aws_security_group.app.id]
}

module "opensearch" {
  source = "../../modules/opensearch"

  name                       = var.name
  region                     = var.region
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = [aws_security_group.app.id]
}

module "search_projection_queue" {
  source = "../../modules/sqs"

  name = "${var.name}-search-projection"
  # ADR-0004: FIFO は測定データが必要と示すまで使わない
  fifo = false
}

module "eventbridge" {
  source = "../../modules/eventbridge"

  name             = "${var.name}-bus"
  target_queue_arn = module.search_projection_queue.queue_arn
  target_queue_url = module.search_projection_queue.queue_url
}

# ---------- observability ----------

module "observability" {
  source = "../../modules/observability"

  log_group_names = [
    "/ecs/${var.name}-api",
    "/ecs/${var.name}-worker",
  ]
  retention_in_days = 30
}
