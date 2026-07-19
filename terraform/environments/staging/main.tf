# staging root module
# レイヤごとにブロックを分けて記述する（将来の state 分割線。ADR-0003）。
# 1. network レイヤ
# 2. data / messaging レイヤ（Aurora / Valkey / OpenSearch / EventBridge / SQS）
# 3. app レイヤ（ALB / ECS）
# 4. observability レイヤ

locals {
  environment      = "staging"
  capacity_profile = var.capacity_profile

  capacity_profiles = {
    # normal: 本番相当トポロジーを最小サイズで検証する profile（staging-environment.md capacity profile 表）。
    # schema migration は boot path から分離済み（Issue #92）のため、API の scale out 制約は解消。
    # autoscaling target（min/max）は撤去する（Issue #234）。target-tracking policy を実装していない
    # 環境に min/max だけ置いても実際にはスケールしないため、動かない設定は残さない。
    # スケールアウト検証（rolling deploy との組み合わせ含む）は full 専任にする。
    normal = {
      nat_gateway_mode = "single"

      api_desired_count         = 1
      worker_desired_count      = 1
      api_autoscaling_min       = null
      api_autoscaling_max       = null
      worker_autoscaling_min    = null
      worker_autoscaling_max    = null
      autoscaling_cpu_target    = null
      frontend_desired_count    = 1
      scheduled_scaling_actions = []

      aurora_min_capacity          = 0
      aurora_max_capacity          = 4
      aurora_reader_instance_count = 1
      aurora_deletion_protection   = false
      aurora_skip_final_snapshot   = true

      valkey_num_cache_clusters = 2
      valkey_automatic_failover = true
      valkey_transit_encryption = true
      valkey_at_rest_encryption = true

      opensearch_instance_count         = 1
      opensearch_zone_awareness_enabled = false
      opensearch_availability_zones     = 2
    }

    # full: 負荷試験・failover 検証用の一時的な強化 profile。
    # schema migration 分離済み（Issue #92）のため API 2+ のブロッカーは解消済み。
    # autoscaling は full のみ有効化する（Issue #234）。負荷をかけて実際に検証できる
    # profile でのみ policy を持たせる。api/worker とも実測データがまだないため、
    # まず素直な対称値（現状の 2 倍 = min 2 / max 4）から始め、必要なら full での検証結果を見て調整する。
    # frontend は「スケールする層」ではなく「落ちない層」という位置づけのため autoscaling は入れず、
    # full が failover 検証用 profile である以上 AZ 跨ぎの failover 検証ができるよう desired_count のみ 2 にする。
    full = {
      nat_gateway_mode = "per_az"

      api_desired_count         = 2
      worker_desired_count      = 2
      api_autoscaling_min       = 2
      api_autoscaling_max       = 4
      worker_autoscaling_min    = 2
      worker_autoscaling_max    = 4
      autoscaling_cpu_target    = 60
      frontend_desired_count    = 2
      scheduled_scaling_actions = []

      aurora_min_capacity          = 0.5
      aurora_max_capacity          = 8
      aurora_reader_instance_count = 1
      aurora_deletion_protection   = false
      aurora_skip_final_snapshot   = true

      valkey_num_cache_clusters = 2
      valkey_automatic_failover = true
      valkey_transit_encryption = true
      valkey_at_rest_encryption = true

      opensearch_instance_count         = 2
      opensearch_zone_awareness_enabled = true
      opensearch_availability_zones     = 2
    }
  }

  capacity_profile_settings = local.capacity_profiles[local.capacity_profile]

  # endpoint mode（staging-environment.md / ADR-0008）:
  # 初回 staging は alb-http-only（ACM 証明書なし・HTTPS リスナーなし・Route53 alias なし）。
  # https-dns は ACM / Route53 / HTTPS を staging で検証する後続 step で有効化する。
  https_enabled = var.public_endpoint_mode == "https-dns"
}

# ---------- network ----------

module "network" {
  source = "../../modules/network"

  name             = var.name
  region           = var.region
  vpc_cidr         = var.vpc_cidr
  nat_gateway_mode = local.capacity_profile_settings.nat_gateway_mode
}

# ---------- app（コンテナレジストリ・共通 SG） ----------

module "ecr" {
  source = "../../modules/ecr"

  name = var.name
  # destroy 前提運用のためイメージ残存時も削除可にする
  force_delete = true
}

# ECS タスク（API / Worker / Frontend）が共用する SG。
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

  # ACU / reader / 削除保護は capacity_profile で切り替える。
  min_capacity             = local.capacity_profile_settings.aurora_min_capacity
  max_capacity             = local.capacity_profile_settings.aurora_max_capacity
  seconds_until_auto_pause = 1800
  deletion_protection      = local.capacity_profile_settings.aurora_deletion_protection
  skip_final_snapshot      = local.capacity_profile_settings.aurora_skip_final_snapshot
  reader_instance_count    = local.capacity_profile_settings.aurora_reader_instance_count

  # バックアップ・マイナーバージョン方針（production-readiness L-7）。
  # staging は検証後毎回 destroy するエフェメラル環境（ADR-0008）のため保持 1 日。prod では 7 日以上へ。
  backup_retention_period    = 1
  auto_minor_version_upgrade = true

  # Golden Signal アラーム（Issue #218）の通知先。DLQ アラームと同じ SNS トピックへ配線する。
  alarm_actions = module.observability.alarm_action_arns
}

module "valkey" {
  source = "../../modules/valkey"

  name                       = var.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = [aws_security_group.app.id]
  num_cache_clusters         = local.capacity_profile_settings.valkey_num_cache_clusters
  automatic_failover_enabled = local.capacity_profile_settings.valkey_automatic_failover
  transit_encryption_enabled = local.capacity_profile_settings.valkey_transit_encryption
  at_rest_encryption_enabled = local.capacity_profile_settings.valkey_at_rest_encryption
}

module "opensearch" {
  source = "../../modules/opensearch"

  name                       = var.name
  region                     = var.region
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = [aws_security_group.app.id]
  instance_count             = local.capacity_profile_settings.opensearch_instance_count
  zone_awareness_enabled     = local.capacity_profile_settings.opensearch_zone_awareness_enabled
  availability_zone_count    = local.capacity_profile_settings.opensearch_availability_zones

  # staging からはアクセスポリシーの principal を API / Worker task role に限定する
  # （production-readiness M-3 の残件。SigV4 署名クライアントは PR #75 で実装済み）。
  allowed_principal_arns = [
    aws_iam_role.api_task.arn,
    aws_iam_role.worker_task.arn,
  ]
}

module "search_projection_queue" {
  source = "../../modules/sqs"

  name = "${var.name}-search-projection"
  # ADR-0004: FIFO は測定データが必要と示すまで使わない
  fifo = false

  # DLQ 滞留アラームの通知先（production-readiness L-5 / Issue #200）。
  # observability モジュールのアラート用 SNS トピック（email subscription）へ配線する。
  dlq_alarm_actions = module.observability.alarm_action_arns
}

module "eventbridge" {
  source = "../../modules/eventbridge"

  name             = "${var.name}-bus"
  target_queue_arn = module.search_projection_queue.queue_arn
  target_queue_url = module.search_projection_queue.queue_url
}

# ---------- auth（JWT 署名シークレット。ADR-0010 / Issue #134） ----------

# JWT（HS256）の署名シークレットを Terraform で生成する。
# 値は tfstate に入るが、state バケットは非公開・SSE 有効（bootstrap 管理）のため許容する。
# ECS タスクへは既存の DB_PASSWORD と同じく secrets 注入で渡し、
# タスク定義・environment・リポジトリに平文を置かない。
resource "random_password" "jwt_secret" {
  # HS256 の鍵素材として十分な 64 文字（384 bit 超のエントロピー）にする。
  length = 64
  # 記号は含めない。長さで強度を確保し、環境変数経由の受け渡しでの引用符事故を避ける。
  special = false
}

resource "aws_secretsmanager_secret" "jwt" {
  name        = "${var.name}-jwt-secret"
  description = "JWT signing secret for the API (ADR-0010). Injected into ECS tasks as JWT_SECRET."

  # staging はエフェメラル環境（ADR-0008。検証後 destroy）のため、削除保留期間なしで即時削除できるようにする。
  # 保留中シークレットが残ると、次回 apply の CreateSecret が名前衝突で失敗するため。
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "jwt" {
  secret_id = aws_secretsmanager_secret.jwt.id
  # current/previous の JSON 構造（ADR-0012 / Issue #168）。
  # 署名は常に current、検証は current → previous の順でフォールバックする。
  # previous は初期状態では空（コード側は空文字を「無し」として扱う）。
  secret_string = jsonencode({
    current  = random_password.jwt_secret.result
    previous = ""
  })

  # ローテーション（docs/runbooks/jwt-secret-rotation.md）は Secrets Manager 上の値を
  # CLI で直接更新するため、Terraform が手動ローテーション後の値を初期値へ巻き戻さないようにする。
  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---------- app（実行層: ALB / ECS） ----------

# ADR-0007 / ADR-0008: HTTPS 化（ACM 証明書・DNS 検証・Route53 alias）は
# public_endpoint_mode = "https-dns" のときだけ作成する。初回 staging は alb-http-only。
data "aws_route53_zone" "public" {
  count = local.https_enabled ? 1 : 0

  name         = var.hosted_zone_name
  private_zone = false
}

locals {
  api_fqdn = "${var.api_subdomain}.${var.hosted_zone_name}"
}

resource "aws_acm_certificate" "api" {
  count = local.https_enabled ? 1 : 0

  domain_name       = local.api_fqdn
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "api_cert_validation" {
  for_each = local.https_enabled ? {
    for dvo in aws_acm_certificate.api[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  } : {}

  zone_id         = data.aws_route53_zone.public[0].zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "api" {
  count = local.https_enabled ? 1 : 0

  certificate_arn         = aws_acm_certificate.api[0].arn
  validation_record_fqdns = [for r in aws_route53_record.api_cert_validation : r.fqdn]
}

# CloudFront origin-facing の managed prefix list（ADR-0013）。
# https-dns モードで ALB の ingress をこの prefix list に限定し、直叩きを遮断する。
# data source は常に読めるが（コスト無し）、実際に使うのは https_enabled のときだけ。
data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

module "alb" {
  source = "../../modules/alb"

  name              = var.name
  vpc_id            = module.network.vpc_id
  public_subnet_ids = module.network.public_subnet_ids

  # 検証済み証明書の ARN を渡す（validation リソース経由にして、検証完了前にリスナーが作られないようにする）。
  # リスナー等の有無は plan 時に確定する enable_https で切り替える（unknown 値を count に使わない）。
  enable_https    = local.https_enabled
  certificate_arn = local.https_enabled ? aws_acm_certificate_validation.api[0].certificate_arn : null

  # ADR-0013: https-dns（CloudFront あり）では ALB 直叩きを CloudFront prefix list で遮断する。
  # alb-http-only（CloudFront なし・escape hatch）では既定で ingress なし。dev（environments/dev/main.tf）と
  # 同じく var.alb_allowed_ingress_cidrs を明示的に渡した場合のみ CIDR ベースで許可する
  #（Issue #232。0.0.0.0/0 全開放の既定は廃止）。
  allowed_ingress_cidrs   = var.alb_allowed_ingress_cidrs
  ingress_prefix_list_ids = local.https_enabled ? [data.aws_ec2_managed_prefix_list.cloudfront.id] : []

  # フロントエンド（ADR-0011）は CloudFront + 独自ドメインが前提のため https-dns モード限定。
  # alb-http-only（初回構築 fallback）では frontend の入口ごと作らない。
  enable_frontend = local.https_enabled

  # Golden Signal アラーム（Issue #218）の通知先。DLQ アラームと同じ SNS トピックへ配線する。
  alarm_actions = module.observability.alarm_action_arns
}

# API の公開 FQDN を ALB へ向ける（https-dns のみ）
resource "aws_route53_record" "api_alias" {
  count = local.https_enabled ? 1 : 0

  zone_id = data.aws_route53_zone.public[0].zone_id
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
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        # タスク起動時の secrets 注入対象: Aurora 管理シークレットと JWT 署名シークレット（ADR-0010）。
        Resource = [
          module.aurora.master_user_secret_arn,
          aws_secretsmanager_secret.jwt.arn,
        ]
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

# X-Ray トレース書き込み（ADR-0014 / Issue #203）。
# 同一タスク内の ADOT collector sidecar が task role の資格情報で
# PutTraceSegments / PutTelemetryRecords を呼ぶ。X-Ray の書き込み API は
# リソースレベル制限をサポートしないため Resource は * とする（それでも actions は最小の 2 つ）。
resource "aws_iam_role_policy" "api_task_xray" {
  name = "write-xray-traces"
  role = aws_iam_role.api_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
        ]
        Resource = ["*"]
      }
    ]
  })
}

resource "aws_iam_role_policy" "worker_task_xray" {
  name = "write-xray-traces"
  role = aws_iam_role.worker_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
        ]
        Resource = ["*"]
      }
    ]
  })
}

# ADOT collector sidecar の ECS 用既定設定は、collector 自身の内部メトリクス（自己監視）を
# awsemf exporter 経由で固定のロググループ /aws/ecs/application/metrics へ書き込む
# パイプラインを含む（アプリのビジネスメトリクスとは別。あちらは awslogs ドライバ経由で
# 既に届いている）。この権限が無いと収集は失敗するが、影響は collector 自己監視データの
# 欠落のみで機能には影響しない（Issue #212。staging 実地検証で発見）。
resource "aws_iam_role_policy" "api_task_adot_self_monitoring_logs" {
  name = "write-adot-self-monitoring-logs"
  role = aws_iam_role.api_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = [
          "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/ecs/application/metrics:*",
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy" "worker_task_adot_self_monitoring_logs" {
  name = "write-adot-self-monitoring-logs"
  role = aws_iam_role.worker_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = [
          "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/ecs/application/metrics:*",
        ]
      }
    ]
  })
}

# ADOT collector sidecar のイメージ（ADR-0014 / Issue #203）。挙動を再現可能にするためタグを固定する。
locals {
  otel_collector_image = "public.ecr.aws/aws-observability/aws-otel-collector:v0.48.0"

  # EMF ビジネスメトリクスの名前空間（ADR-0014）。ECS タスクの METRICS_NAMESPACE と
  # observability モジュールの EMF アラーム（Issue #218）で同じ値を使う。
  metrics_namespace = "TicketC2C/staging"
}

module "api_service" {
  source = "../../modules/ecs-service"

  name                      = "${var.name}-api"
  region                    = var.region
  cluster_arn               = aws_ecs_cluster.this.arn
  cluster_name              = aws_ecs_cluster.this.name
  image                     = "${module.ecr.repository_url}:${var.image_tag}"
  subnet_ids                = module.network.private_subnet_ids
  security_group_ids        = [aws_security_group.app.id]
  execution_role_arn        = aws_iam_role.execution.arn
  task_role_arn             = aws_iam_role.api_task.arn
  container_port            = 3000
  target_group_arn          = module.alb.target_group_arn
  log_group_name            = "/ecs/${var.name}-api"
  desired_count             = local.capacity_profile_settings.api_desired_count
  autoscaling_min_capacity  = local.capacity_profile_settings.api_autoscaling_min
  autoscaling_max_capacity  = local.capacity_profile_settings.api_autoscaling_max
  autoscaling_cpu_target    = local.capacity_profile_settings.autoscaling_cpu_target
  scheduled_scaling_actions = local.capacity_profile_settings.scheduled_scaling_actions

  # CPU / Memory アラーム（Issue #218）の通知先。DLQ アラームと同じ SNS トピックへ配線する。
  alarm_actions = module.observability.alarm_action_arns

  # X-Ray 分散トレーシング用 ADOT collector sidecar（ADR-0014 / Issue #203）。
  otel_collector_image = local.otel_collector_image

  environment = {
    PORT                = "3000"
    DB_HOST             = module.aurora.cluster_endpoint
    DB_PORT             = "5432"
    DB_NAME             = module.aurora.database_name
    DB_USERNAME         = "ticket_admin"
    DB_SSL              = "true"
    VALKEY_URL          = "${local.capacity_profile_settings.valkey_transit_encryption ? "rediss" : "redis"}://${module.valkey.primary_endpoint}:6379"
    EVENT_BUS_NAME      = module.eventbridge.bus_name
    OPENSEARCH_ENDPOINT = module.opensearch.endpoint
    # 長寿命 DB 接続 pool がローテーション後も追従できるよう、secret の ARN 自体を渡す。
    # ARN は機密情報ではないため environment（非 secret）でよい。
    DB_PASSWORD_SECRET_ARN = module.aurora.master_user_secret_arn
    # 認証系レート制限のクライアント IP 解決（ADR-0012 / Issue #167）。
    # CloudFront → ALB 構成のため、X-Forwarded-For の末尾 1 段（ALB が追記した CloudFront edge IP）を
    # 飛ばした位置＝CloudFront が観測した viewer IP を採用する。
    RATE_LIMIT_TRUSTED_PROXY_HOPS = "1"
    # X-Ray 分散トレーシング（ADR-0014 / Issue #203）。opt-in フラグ + サービスマップ上の表示名。
    OTEL_TRACING_ENABLED = "true"
    OTEL_SERVICE_NAME    = "${var.name}-api"
    # staging は本番相当の負荷試験を行うため、サンプリングは 10% に抑える（dev は全量）。
    OTEL_TRACES_SAMPLER     = "parentbased_traceidratio"
    OTEL_TRACES_SAMPLER_ARG = "0.1"
    # ビジネスメトリクス（EMF）の名前空間と Service dimension（ADR-0014）。
    METRICS_NAMESPACE = local.metrics_namespace
    METRICS_SERVICE   = "api"
  }

  secrets = {
    # migration runner（db-migrate workflow の ECS run-task）用。短命接続のためローテーション影響を受けず、静的注入のままでよい（Issue #92）。
    DB_PASSWORD = "${module.aurora.master_user_secret_arn}:password::"
    # JWT 署名シークレット（ADR-0010 / Issue #134）。プレーン文字列シークレットのため key 指定は不要。
    # 自動ローテーションは設定していないため、タスク起動時の静的注入で十分。
    JWT_SECRET = aws_secretsmanager_secret.jwt.arn
  }
}

module "worker_service" {
  source = "../../modules/ecs-service"

  name                      = "${var.name}-worker"
  region                    = var.region
  cluster_arn               = aws_ecs_cluster.this.arn
  cluster_name              = aws_ecs_cluster.this.name
  image                     = "${module.ecr.repository_url}:${var.image_tag}"
  command                   = ["node", "dist/src/worker.js"]
  subnet_ids                = module.network.private_subnet_ids
  security_group_ids        = [aws_security_group.app.id]
  execution_role_arn        = aws_iam_role.execution.arn
  task_role_arn             = aws_iam_role.worker_task.arn
  log_group_name            = "/ecs/${var.name}-worker"
  desired_count             = local.capacity_profile_settings.worker_desired_count
  autoscaling_min_capacity  = local.capacity_profile_settings.worker_autoscaling_min
  autoscaling_max_capacity  = local.capacity_profile_settings.worker_autoscaling_max
  autoscaling_cpu_target    = local.capacity_profile_settings.autoscaling_cpu_target
  scheduled_scaling_actions = local.capacity_profile_settings.scheduled_scaling_actions

  # CPU / Memory アラーム（Issue #218）の通知先。DLQ アラームと同じ SNS トピックへ配線する。
  alarm_actions = module.observability.alarm_action_arns

  # X-Ray 分散トレーシング用 ADOT collector sidecar（ADR-0014 / Issue #203）。
  otel_collector_image = local.otel_collector_image

  environment = {
    SQS_QUEUE_URL       = module.search_projection_queue.queue_url
    OPENSEARCH_ENDPOINT = module.opensearch.endpoint
    # X-Ray 分散トレーシング（ADR-0014 / Issue #203）。Worker 側は API から
    # EventBridge detail 経由で届く trace context を継続する（consumer span）。
    OTEL_TRACING_ENABLED = "true"
    OTEL_SERVICE_NAME    = "${var.name}-worker"
    # Worker の span は親（API 側）の sampling 判定に追従させる。親なしイベントは 10%。
    OTEL_TRACES_SAMPLER     = "parentbased_traceidratio"
    OTEL_TRACES_SAMPLER_ARG = "0.1"
    METRICS_NAMESPACE       = local.metrics_namespace
    METRICS_SERVICE         = "worker"
  }
}

# refresh_tokens 期限切れクリーンアップの日次バッチ（L-9 残課題 / Issue #195）。
# EventBridge Scheduler が API タスク定義（最新 ACTIVE リビジョン）を command override で
# RunTask し、猶予（30 日）超過ファミリーの row を削除する。ログは API のロググループへ出る。
module "refresh_token_cleanup" {
  source = "../../modules/scheduled-task"

  name                = "${var.name}-refresh-token-cleanup"
  cluster_arn         = aws_ecs_cluster.this.arn
  task_definition_arn = module.api_service.task_definition_arn
  container_name      = "${var.name}-api"
  command             = ["node", "dist/src/database/cleanup-refresh-tokens.js"]
  subnet_ids          = module.network.private_subnet_ids
  security_group_ids  = [aws_security_group.app.id]
  execution_role_arn  = aws_iam_role.execution.arn
  task_role_arn       = aws_iam_role.api_task.arn
}

# ---------- observability ----------

module "observability" {
  source = "../../modules/observability"

  name = var.name

  log_group_names = [
    "/ecs/${var.name}-api",
    "/ecs/${var.name}-worker",
    "/ecs/${var.name}-frontend",
  ]
  retention_in_days = 30

  # アラート通知用 SNS トピック + email subscription（production-readiness L-5 / Issue #200）。
  alert_email = var.alert_email

  # X-Ray group（ADR-0014 / Issue #203）。この環境の API / Worker のトレースを console で絞り込む。
  xray_service_names = ["${var.name}-api", "${var.name}-worker"]

  # EMF ビジネスメトリクスのアラーム（ValkeyFailOpen / WorkerProcessingLagMs。Issue #218）。
  # ECS タスクの METRICS_NAMESPACE と同じ名前空間を渡す。
  metrics_namespace = local.metrics_namespace
}

# ---------- frontend（Next.js SSR。ADR-0011 / Issue #146） ----------
# CloudFront + 独自ドメインが前提のため、https-dns モードのときだけ作成する
# （ECR リポジトリのみ、deploy workflow の push 先として常時作成する）。

module "ecr_frontend" {
  source = "../../modules/ecr"

  name = "${var.name}-frontend"
  # destroy 前提運用のためイメージ残存時も削除可にする
  force_delete = true
}

locals {
  app_fqdn = "${var.app_subdomain}.${var.hosted_zone_name}"
}

# CloudFront viewer certificate 用の ACM 証明書。us-east-1 でしか使えないため provider alias で発行する。
resource "aws_acm_certificate" "app" {
  count    = local.https_enabled ? 1 : 0
  provider = aws.us_east_1

  domain_name       = local.app_fqdn
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "app_cert_validation" {
  for_each = local.https_enabled ? {
    for dvo in aws_acm_certificate.app[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  } : {}

  zone_id         = data.aws_route53_zone.public[0].zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "app" {
  count    = local.https_enabled ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.app[0].arn
  validation_record_fqdns = [for r in aws_route53_record.app_cert_validation : r.fqdn]
}

# frontend task role: AWS API を呼ばないため権限なしのロールを割り当てる（最小権限）。
resource "aws_iam_role" "frontend_task" {
  name               = "${var.name}-frontend-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

module "frontend_service" {
  count  = local.https_enabled ? 1 : 0
  source = "../../modules/ecs-service"

  name               = "${var.name}-frontend"
  region             = var.region
  cluster_arn        = aws_ecs_cluster.this.arn
  cluster_name       = aws_ecs_cluster.this.name
  image              = "${module.ecr_frontend.repository_url}:${var.image_tag}"
  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [aws_security_group.app.id]
  execution_role_arn = aws_iam_role.execution.arn
  task_role_arn      = aws_iam_role.frontend_task.arn
  container_port     = 3000
  target_group_arn   = module.alb.frontend_target_group_arn
  log_group_name     = "/ecs/${var.name}-frontend"
  # フロントエンドは負荷検証の対象外のため autoscaling は入れない（Issue #234）。
  # desired_count のみ capacity profile に連動させる。full は failover 検証用 profile であり、
  # frontend が 1 task 固定のままだと AZ 跨ぎの failover 検証ができず profile の目的と矛盾するため、
  # full では 2（スケールする層ではなく落ちない層、という位置づけ）にする。
  desired_count             = local.capacity_profile_settings.frontend_desired_count
  autoscaling_min_capacity  = null
  autoscaling_max_capacity  = null
  scheduled_scaling_actions = []

  # CPU / Memory アラーム（Issue #218）の通知先。DLQ アラームと同じ SNS トピックへ配線する。
  alarm_actions = module.observability.alarm_action_arns

  environment = {
    PORT     = "3000"
    HOSTNAME = "0.0.0.0"
    # SSR のサーバー側 fetch は CloudFront 経由の /api を使う（ADR-0013）。
    # ALB 直叩きは prefix list 制限で遮断されるため、SSR も CloudFront + WAF を通す。
    API_BASE_URL = "https://${local.app_fqdn}/api"
  }
}

# ---------- WAF（L-12 / Issue #184） ----------

# CloudFront distribution に関連付ける WAFv2 WebACL（https-dns モードのみ。CloudFront 自体が
# https-dns 限定のため）。scope=CLOUDFRONT の WebACL は us-east-1 でのみ作成できるため、
# CloudFront 用 ACM 証明書と同じく provider alias で作成する。
# 無料の AWS マネージドルールグループ 3 種のみ使う（有料アドオンは使わない）。
# rate-based rule は導入しない（IP レート制限はアプリ層 Valkey で担保する方針。ADR-0012）。
resource "aws_wafv2_web_acl" "app" {
  count    = local.https_enabled ? 1 : 0
  provider = aws.us_east_1

  name        = "${var.name}-app-waf"
  description = "CloudFront WebACL for ${var.name}-app - AWS managed rule groups in block mode"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # マネージドルールグループはグループ内ルールのアクション（block）をそのまま使う
  # （override_action = none。count に落とすと検知のみになりブロックされない）。
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-waf-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-waf-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesAmazonIpReputationList"
    priority = 30

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-waf-ip-reputation"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-app-waf"
    sampled_requests_enabled   = true
  }
}

# CloudFront 統合オリジン distribution（/api/* → API、その他 → frontend）。
module "cloudfront" {
  count  = local.https_enabled ? 1 : 0
  source = "../../modules/cloudfront"

  name                = "${var.name}-app"
  aliases             = [local.app_fqdn]
  acm_certificate_arn = aws_acm_certificate_validation.app[0].certificate_arn
  # origin は ALB の生 DNS 名ではなく API の FQDN を使う（ALB 証明書と一致させるため）。
  origin_domain_name = local.api_fqdn
  # WAFv2 WebACL の関連付け（L-12 / Issue #184）。
  web_acl_id = aws_wafv2_web_acl.app[0].arn
}

# ---------- アクセスログ / WAF ログの S3 配信（L-12 / Issue #185） ----------
# CloudFront / WAF が https-dns モード限定のため、ログ配信一式も同じゲートで作成する。

data "aws_caller_identity" "current" {}

# CloudFront アクセスログ（standard logging v2）の配信先バケット。
# legacy logging_config（S3 ACL 必須）は使わず、CloudWatch Logs の vended log delivery を使う。
# アクセスログ用バケットは通常リージョンでよい（WAF ログ用バケットは us-east-1 必須。下記）。
# 両バケットとも ephemeral destroy 運用のため force_destroy = true
# （ECR の force_delete = true と同じ流儀。ログ残存で destroy が失敗しないようにする）。
resource "aws_s3_bucket" "cf_logs" {
  count = local.https_enabled ? 1 : 0

  bucket        = "${var.name}-cf-logs"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "cf_logs" {
  count = local.https_enabled ? 1 : 0

  bucket = aws_s3_bucket.cf_logs[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cf_logs" {
  count = local.https_enabled ? 1 : 0

  bucket = aws_s3_bucket.cf_logs[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# 調査用途のログのため 30 日で自動削除する（CloudWatch Logs の保持 30 日と同じ方針）。
resource "aws_s3_bucket_lifecycle_configuration" "cf_logs" {
  count = local.https_enabled ? 1 : 0

  bucket = aws_s3_bucket.cf_logs[0].id

  rule {
    id     = "expire-30d"
    status = "Enabled"

    filter {}

    expiration {
      days = 30
    }
  }
}

# vended log delivery（delivery.logs.amazonaws.com）からの書き込みを許可する。
# CloudFront の delivery source は us-east-1 に定義されるため、SourceArn は us-east-1 の
# delivery-source に限定する。
data "aws_iam_policy_document" "cf_logs_delivery" {
  count = local.https_enabled ? 1 : 0

  statement {
    sid       = "AWSLogDeliveryWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.cf_logs[0].arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:logs:us-east-1:${data.aws_caller_identity.current.account_id}:delivery-source:*"]
    }
  }

  statement {
    sid       = "AWSLogDeliveryAclCheck"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.cf_logs[0].arn]

    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_s3_bucket_policy" "cf_logs" {
  count = local.https_enabled ? 1 : 0

  bucket = aws_s3_bucket.cf_logs[0].id
  policy = data.aws_iam_policy_document.cf_logs_delivery[0].json
}

# CloudFront 用の delivery source / destination / delivery は us-east-1 で定義する必要がある
# （配信先の S3 バケット自体は通常リージョンでよい）。
resource "aws_cloudwatch_log_delivery_source" "cf_access" {
  count    = local.https_enabled ? 1 : 0
  provider = aws.us_east_1

  name         = "${var.name}-cf-access"
  log_type     = "ACCESS_LOGS"
  resource_arn = module.cloudfront[0].arn
}

resource "aws_cloudwatch_log_delivery_destination" "cf_logs_s3" {
  count    = local.https_enabled ? 1 : 0
  provider = aws.us_east_1

  name          = "${var.name}-cf-logs-s3"
  output_format = "json"

  delivery_destination_configuration {
    destination_resource_arn = aws_s3_bucket.cf_logs[0].arn
  }
}

resource "aws_cloudwatch_log_delivery" "cf_access" {
  count    = local.https_enabled ? 1 : 0
  provider = aws.us_east_1

  delivery_source_name     = aws_cloudwatch_log_delivery_source.cf_access[0].name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.cf_logs_s3[0].arn

  # バケットポリシーが先に無いと delivery 作成時の配信検証で失敗する。
  depends_on = [aws_s3_bucket_policy.cf_logs]
}

# WAF ログの配信先バケット。WAFv2 の S3 直接配信は
# 「aws-waf-logs- プレフィックス必須」「WebACL と同リージョン（CLOUDFRONT scope は us-east-1）」
# の 2 制約があるため、cf_logs バケットとは別に us-east-1 へ作成する。
resource "aws_s3_bucket" "waf_logs" {
  count    = local.https_enabled ? 1 : 0
  provider = aws.us_east_1

  bucket        = "aws-waf-logs-${var.name}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "waf_logs" {
  count    = local.https_enabled ? 1 : 0
  provider = aws.us_east_1

  bucket = aws_s3_bucket.waf_logs[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "waf_logs" {
  count    = local.https_enabled ? 1 : 0
  provider = aws.us_east_1

  bucket = aws_s3_bucket.waf_logs[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "waf_logs" {
  count    = local.https_enabled ? 1 : 0
  provider = aws.us_east_1

  bucket = aws_s3_bucket.waf_logs[0].id

  rule {
    id     = "expire-30d"
    status = "Enabled"

    filter {}

    expiration {
      days = 30
    }
  }
}

# WAF の S3 配信も delivery.logs.amazonaws.com 経由（vended logs）のため同型のポリシーを付ける。
data "aws_iam_policy_document" "waf_logs_delivery" {
  count = local.https_enabled ? 1 : 0

  statement {
    sid       = "AWSLogDeliveryWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.waf_logs[0].arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:logs:us-east-1:${data.aws_caller_identity.current.account_id}:*"]
    }
  }

  statement {
    sid       = "AWSLogDeliveryAclCheck"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.waf_logs[0].arn]

    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_s3_bucket_policy" "waf_logs" {
  count    = local.https_enabled ? 1 : 0
  provider = aws.us_east_1

  bucket = aws_s3_bucket.waf_logs[0].id
  policy = data.aws_iam_policy_document.waf_logs_delivery[0].json
}

resource "aws_wafv2_web_acl_logging_configuration" "app" {
  count    = local.https_enabled ? 1 : 0
  provider = aws.us_east_1

  log_destination_configs = [aws_s3_bucket.waf_logs[0].arn]
  resource_arn            = aws_wafv2_web_acl.app[0].arn

  # バケットポリシーが先に無いと logging configuration 作成時の配信検証で失敗する。
  depends_on = [aws_s3_bucket_policy.waf_logs]
}

# フロントエンドの公開 FQDN を CloudFront へ向ける
resource "aws_route53_record" "app_alias" {
  count = local.https_enabled ? 1 : 0

  zone_id = data.aws_route53_zone.public[0].zone_id
  name    = local.app_fqdn
  type    = "A"

  alias {
    name                   = module.cloudfront[0].domain_name
    zone_id                = module.cloudfront[0].hosted_zone_id
    evaluate_target_health = false
  }
}

# ---------- エッジ監視（CloudFront / WAF の CloudWatch アラーム。L-16 / Issue #252） ----------
# CloudFront / WAF が https-dns モード限定のため、アラーム一式も同じゲートで作成する。

# CloudFront / WAF（scope=CLOUDFRONT）のメトリクスは us-east-1 にのみ発行され、
# CloudWatch alarm の alarm_actions は同一リージョンの SNS トピックしか指定できないため、
# 既存 Tokyo 側（observability モジュール）の SNS トピックは再利用できず us-east-1 に新設する。
# EventBridge cross-region 集約は 3 アラームのみで構成過剰のため見送り
# （production-readiness L-16 の設計判断。Issue #250 / #251）。
resource "aws_sns_topic" "edge_alerts" {
  count    = local.https_enabled && var.alert_email != "" ? 1 : 0
  provider = aws.us_east_1

  name = "${var.name}-edge-alerts"
}

# 既存 Tokyo 側と同じ email subscription パターン（受信者が Confirm するまで Pending）。
# 同一アドレスへ 2 通目の確認メールが届くのは受容済みの運用（L-16 設計判断）。
resource "aws_sns_topic_subscription" "edge_alerts_email" {
  count    = local.https_enabled && var.alert_email != "" ? 1 : 0
  provider = aws.us_east_1

  topic_arn = aws_sns_topic.edge_alerts[0].arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# CloudFront additional metrics（OriginLatency 等）を有効化する有料アドオン。
# 既存レイテンシ監視が購入 API の p95（ADR-0017）のみで、検索・イベント一覧・SSR ページロード
# 等の経路が未カバーだった穴を埋めるために採用する（L-16 設計判断。destroy 運用のため実費は僅少）。
resource "aws_cloudfront_monitoring_subscription" "app" {
  count = local.https_enabled ? 1 : 0

  distribution_id = module.cloudfront[0].distribution_id

  monitoring_subscription {
    realtime_metrics_subscription_config {
      realtime_metrics_subscription_status = "Enabled"
    }
  }
}

# CloudFront 5xx 率。ADR-0017 の purchase_error_burn_rate と同じ「低トラフィックガード付き割合」
# パターンを踏襲: Requests < 10 の期間は 0 とみなし、極小トラフィック時の単発失敗による誤検知を防ぐ。
resource "aws_cloudwatch_metric_alarm" "cloudfront_5xx_rate" {
  count    = local.https_enabled ? 1 : 0
  provider = aws.us_east_1

  alarm_name          = "${var.name}-cloudfront-5xx-rate"
  alarm_description   = "[Critical] CloudFront の 5xx 率が 5% を超過（10 分継続。Requests >= 10 の低トラフィックガード付き。ユーザー入口の広範な障害を示す。L-16 / Issue #252）"
  evaluation_periods  = 2
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "m1"
    return_data = false
    metric {
      namespace   = "AWS/CloudFront"
      metric_name = "Requests"
      stat        = "Sum"
      period      = 300
      dimensions = {
        DistributionId = module.cloudfront[0].distribution_id
        Region         = "Global"
      }
    }
  }

  metric_query {
    id          = "m2"
    return_data = false
    metric {
      namespace   = "AWS/CloudFront"
      metric_name = "5xxErrorRate"
      stat        = "Average"
      period      = 300
      dimensions = {
        DistributionId = module.cloudfront[0].distribution_id
        Region         = "Global"
      }
    }
  }

  metric_query {
    id          = "e1"
    expression  = "IF(m1>=10, m2, 0)"
    label       = "guarded_5xx_error_rate"
    return_data = true
  }

  alarm_actions = aws_sns_topic.edge_alerts[*].arn
  ok_actions    = aws_sns_topic.edge_alerts[*].arn
}

# Origin latency p90。additional metrics（上記 monitoring subscription）が前提。
resource "aws_cloudwatch_metric_alarm" "cloudfront_origin_latency" {
  count    = local.https_enabled ? 1 : 0
  provider = aws.us_east_1

  alarm_name          = "${var.name}-cloudfront-origin-latency"
  alarm_description   = "[Warning] CloudFront の origin latency p90 が 2000 ms を超過（15 分継続。購入 API 以外も含む全経路のバックエンド遅延。L-16 / Issue #252）"
  namespace           = "AWS/CloudFront"
  metric_name         = "OriginLatency"
  extended_statistic  = "p90"
  period              = 300
  evaluation_periods  = 3
  threshold           = 2000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    DistributionId = module.cloudfront[0].distribution_id
    Region         = "Global"
  }

  alarm_actions = aws_sns_topic.edge_alerts[*].arn
  ok_actions    = aws_sns_topic.edge_alerts[*].arn
}

# WAF block 急増。セキュリティシグナルは割合ガードをかけると初動検知が遅れるため、
# 絶対数・1 期間の即時検知とする（L-16 設計判断）。
# scope=CLOUDFRONT の WAF メトリクスに Region dimension は付かない（WebACL + Rule=ALL で集計）。
resource "aws_cloudwatch_metric_alarm" "waf_block" {
  count    = local.https_enabled ? 1 : 0
  provider = aws.us_east_1

  alarm_name          = "${var.name}-waf-block"
  alarm_description   = "[Warning] WAF のブロック数が 50 件 / 5 分以上（攻撃兆候。WAF は防御に成功しているシグナルのため、当日中に攻撃パターンを確認する。L-16 / Issue #252）"
  namespace           = "AWS/WAFV2"
  metric_name         = "BlockedRequests"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 50
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    WebACL = "${var.name}-app-waf"
    Rule   = "ALL"
  }

  alarm_actions = aws_sns_topic.edge_alerts[*].arn
  ok_actions    = aws_sns_topic.edge_alerts[*].arn
}

# ---------- CloudWatch Dashboard（初動確認用。Issue #253） ----------
# 入口（CloudFront / WAF）→ ALB → ECS（API / Worker / Frontend）→ Aurora →
# Valkey fail-open / Worker lag / SQS DLQ → 購入 API SLO を 1 画面で横断確認する。
# staging は public_endpoint_mode（alb-http-only）次第で frontend / CloudFront / WAF が
# 存在しないことがあるため、該当 output を null 許容にして edge / frontend widget を
# ダッシュボード側で自動的に省略する（dashboard モジュールの has_edge / has_frontend）。
module "dashboard" {
  source = "../../modules/dashboard"

  name              = var.name
  region            = var.region
  metrics_namespace = local.metrics_namespace

  alb_arn_suffix                       = module.alb.arn_suffix
  alb_api_target_group_arn_suffix      = module.alb.target_group_arn_suffix
  alb_frontend_target_group_arn_suffix = module.alb.frontend_target_group_arn_suffix

  ecs_cluster_name          = aws_ecs_cluster.this.name
  ecs_api_service_name      = module.api_service.service_name
  ecs_worker_service_name   = module.worker_service.service_name
  ecs_frontend_service_name = local.https_enabled ? module.frontend_service[0].service_name : null

  aurora_cluster_identifier = "${var.name}-aurora"

  sqs_dlq_name = "${var.name}-search-projection-dlq"

  cloudfront_distribution_id = local.https_enabled ? module.cloudfront[0].distribution_id : null
  waf_web_acl_name           = local.https_enabled ? "${var.name}-app-waf" : null

  # purchase_success_slo_percent / purchase_latency_slo_ms は明示的に渡さず、
  # モジュール既定値（99.5% / 800ms）を使う。module.observability も同じ既定値を使用しており
  # （ADR-0017）、root ではどちらも override していないため実質的な値は一致する。
}

# ---------- CloudFront 経由の外形監視（synthetic monitoring。Issue #256） ----------
# CloudWatch Synthetics canary の組み込みマルチステップ機能（executeHttpStep）で、
# read-only の代表 3 endpoint（healthz 相当・frontend HTML・API 代表 read endpoint）を
# 定期的に外形監視する。severity は Critical（docs/architecture/observability.md 参照）。
# canary 自体・失敗アラームは us-east-1 に作成する（edge_alerts SNS トピックと同一リージョンに
# 揃える理由は L-16 / Issue #252 と同じ）。staging は public_endpoint_mode（alb-http-only）次第で
# CloudFront / app_fqdn が存在しないことがあるため、その場合は canary ごと作成しない。
module "synthetic_check" {
  count  = local.https_enabled ? 1 : 0
  source = "../../modules/synthetics-canary"
  providers = {
    aws = aws.us_east_1
  }

  name          = var.name
  app_fqdn      = local.app_fqdn
  alarm_actions = aws_sns_topic.edge_alerts[*].arn
}
