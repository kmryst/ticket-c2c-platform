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

# ---------- app（コンテナレジストリ） ----------

module "ecr" {
  source = "../../modules/ecr"

  name = var.name
  # destroy 前提運用のためイメージ残存時も削除可にする
  force_delete = true
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
