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

# ---------- app（実行層: ALB / ECS） ----------

# ADR-0007: ALB を HTTPS 化する。証明書はこのリポジトリ専用サブドメインで発行し、
# hosted zone（兄弟リポジトリ terraform-hannibal が取得したドメイン）は data source 参照に留める。
data "aws_route53_zone" "public" {
  name         = var.hosted_zone_name
  private_zone = false
}

locals {
  api_fqdn = "${var.api_subdomain}.${var.hosted_zone_name}"
}

resource "aws_acm_certificate" "api" {
  domain_name       = local.api_fqdn
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "api_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.api.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id         = data.aws_route53_zone.public.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "api" {
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = [for r in aws_route53_record.api_cert_validation : r.fqdn]
}

module "alb" {
  source = "../../modules/alb"

  name              = var.name
  vpc_id            = module.network.vpc_id
  public_subnet_ids = module.network.public_subnet_ids

  # 検証済み証明書の ARN を渡す（validation リソース経由にして、検証完了前にリスナーが作られないようにする）
  certificate_arn       = aws_acm_certificate_validation.api.certificate_arn
  allowed_ingress_cidrs = var.alb_allowed_ingress_cidrs
}

# API の公開 FQDN を ALB へ向ける
resource "aws_route53_record" "api_alias" {
  zone_id = data.aws_route53_zone.public.zone_id
  name    = local.api_fqdn
  type    = "A"

  alias {
    name                   = module.alb.dns_name
    zone_id                = module.alb.zone_id
    evaluate_target_health = false
  }
}

# ALB からの ingress を app SG に許可する
resource "aws_security_group_rule" "app_from_alb" {
  type                     = "ingress"
  from_port                = 3000
  to_port                  = 3000
  protocol                 = "tcp"
  security_group_id        = aws_security_group.app.id
  source_security_group_id = module.alb.security_group_id
}

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

# 実行ロール: イメージ pull・ログ出力・Aurora secret の取得
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_base" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "read-db-secret"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [module.aurora.master_user_secret_arn]
      }
    ]
  })
}

# API task role: EventBridge へのドメインイベント発行のみ
resource "aws_iam_role" "api_task" {
  name               = "${var.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "api_task_events" {
  name = "put-domain-events"
  role = aws_iam_role.api_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["events:PutEvents"]
        Resource = [module.eventbridge.bus_arn]
      }
    ]
  })
}

# Aurora の RDS 管理 secret は 7 日ごとに自動ローテーションされる。
# API の長寿命 DB 接続 pool が追従できるよう、アプリ自身が実行時に読み直せるようにする。
resource "aws_iam_role_policy" "api_task_db_secret" {
  name = "read-db-secret"
  role = aws_iam_role.api_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [module.aurora.master_user_secret_arn]
      }
    ]
  })
}

# Worker task role: プロジェクションキューの消費のみ
resource "aws_iam_role" "worker_task" {
  name               = "${var.name}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "worker_task_sqs" {
  name = "consume-projection-queue"
  role = aws_iam_role.worker_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
        ]
        Resource = [module.search_projection_queue.queue_arn]
      }
    ]
  })
}

module "api_service" {
  source = "../../modules/ecs-service"

  name               = "${var.name}-api"
  region             = var.region
  cluster_arn        = aws_ecs_cluster.this.arn
  image              = "${module.ecr.repository_url}:${var.image_tag}"
  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [aws_security_group.app.id]
  execution_role_arn = aws_iam_role.execution.arn
  task_role_arn      = aws_iam_role.api_task.arn
  container_port     = 3000
  target_group_arn   = module.alb.target_group_arn
  log_group_name     = "/ecs/${var.name}-api"

  environment = {
    PORT                = "3000"
    DB_HOST             = module.aurora.cluster_endpoint
    DB_PORT             = "5432"
    DB_NAME             = module.aurora.database_name
    DB_USERNAME         = "ticket_admin"
    DB_SSL              = "true"
    RUN_SCHEMA_ON_BOOT  = "true"
    VALKEY_URL          = "redis://${module.valkey.primary_endpoint}:6379"
    EVENT_BUS_NAME      = module.eventbridge.bus_name
    OPENSEARCH_ENDPOINT = module.opensearch.endpoint
    # 長寿命 DB 接続 pool がローテーション後も追従できるよう、secret の ARN 自体を渡す。
    # ARN は機密情報ではないため environment（非 secret）でよい。
    DB_PASSWORD_SECRET_ARN = module.aurora.master_user_secret_arn
  }

  secrets = {
    # 起動時 1 回きりの schema-on-boot 用。ローテーション影響を受けない短命接続なので静的注入のままでよい。
    DB_PASSWORD = "${module.aurora.master_user_secret_arn}:password::"
  }
}

module "worker_service" {
  source = "../../modules/ecs-service"

  name               = "${var.name}-worker"
  region             = var.region
  cluster_arn        = aws_ecs_cluster.this.arn
  image              = "${module.ecr.repository_url}:${var.image_tag}"
  command            = ["node", "dist/src/worker.js"]
  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [aws_security_group.app.id]
  execution_role_arn = aws_iam_role.execution.arn
  task_role_arn      = aws_iam_role.worker_task.arn
  log_group_name     = "/ecs/${var.name}-worker"

  environment = {
    SQS_QUEUE_URL       = module.search_projection_queue.queue_url
    OPENSEARCH_ENDPOINT = module.opensearch.endpoint
  }
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
