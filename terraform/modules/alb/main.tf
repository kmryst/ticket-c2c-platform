resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  vpc_id      = var.vpc_id

  # ingress の送信元は 2 系統をサポートする（ADR-0007 / ADR-0013）。
  #
  # 1. CIDR ベース（allowed_ingress_cidrs）: 検証時に自分の IP へ絞る等。alb-http-only の既定。
  #    HTTPS 有効時は 80（リダイレクト用）と 443 の両方を開ける。
  dynamic "ingress" {
    for_each = length(var.allowed_ingress_cidrs) > 0 ? (var.enable_https ? [80, 443] : [80]) : []
    content {
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = var.allowed_ingress_cidrs
    }
  }

  # 2. managed prefix list ベース（ingress_prefix_list_ids）: CloudFront origin-facing に限定し
  #    ALB 直叩きを遮断する（ADR-0013）。CloudFront の origin 接続は https-only（cloudfront モジュール
  #    の origin_protocol_policy）のため 443 のみ開ければよく、80 は開けない。
  #    prefix list 参照はその max-entries 分だけ SG のルール上限（既定 60）を消費するため、
  #    80/443 の両方に付けると上限超過（RulesPerSecurityGroupLimitExceeded）になる。443 のみに絞る。
  dynamic "ingress" {
    for_each = length(var.ingress_prefix_list_ids) > 0 ? [443] : []
    content {
      from_port       = ingress.value
      to_port         = ingress.value
      protocol        = "tcp"
      prefix_list_ids = var.ingress_prefix_list_ids
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name}-alb" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb" "this" {
  name               = var.name
  load_balancer_type = "application"
  internal           = false
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb.id]

  # dev は destroy 前提運用のため削除保護を付けない
  enable_deletion_protection = false
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name}-api"
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    # /readyz は DB を触り Aurora の auto-pause を妨げるため、liveness の /healthz を使う
    path                = "/healthz"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }

  deregistration_delay = 30
}

# HTTP:80 は HTTPS 有効時は 443 への 301 リダイレクト専用にする（ADR-0007）。
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  dynamic "default_action" {
    for_each = var.enable_https ? [] : [1]
    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.api.arn
    }
  }

  dynamic "default_action" {
    for_each = var.enable_https ? [1] : []
    content {
      type = "redirect"
      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count = var.enable_https ? 1 : 0

  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# ---------- フロントエンド（ADR-0011） ----------

# フロントエンド（Next.js SSR コンテナ）用 target group。
# ヘルスチェックは API 非依存の /healthz（frontend 側の liveness 専用ルート）を使い、
# API 障害時に frontend タスクまで再起動ループしないようにする。
resource "aws_lb_target_group" "frontend" {
  count = var.enable_frontend ? 1 : 0

  name        = "${var.name}-frontend"
  port        = var.frontend_container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/healthz"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }

  deregistration_delay = 30
}

# CloudFront の frontend origin にだけ付く識別ヘッダーで frontend へ振り分ける。
# パスではなくヘッダーで判定するのは、CloudFront からの SSR リクエスト（Host は API の FQDN、
# パスは任意）と既存の API 直接アクセスを、default action を変えずに区別するため（ADR-0011）。
resource "aws_lb_listener_rule" "frontend" {
  count = var.enable_frontend ? 1 : 0

  # HTTPS 有効時は 443 リスナー（80 は 301 リダイレクト専用）、無効時は 80 リスナーに付ける。
  listener_arn = var.enable_https ? aws_lb_listener.https[0].arn : aws_lb_listener.http.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend[0].arn
  }

  condition {
    http_header {
      http_header_name = var.frontend_header_name
      values           = [var.frontend_header_value]
    }
  }
}

# ---------- CloudWatch アラーム（Golden Signals: Errors / Availability。Issue #218） ----------
# 既存パターン（sqs モジュールの DLQ アラーム）に倣い、アラームはリソースを所有する
# このモジュール内に置く。通知先は root module から alarm_actions（SNS トピック ARN 等）で受け取る。

# ALB 経由の 5xx 応答数（Errors）。ターゲット起因（HTTPCode_Target_5XX_Count）と
# ALB 自身起因（HTTPCode_ELB_5XX_Count: ターゲット未接続・タイムアウト等）は別メトリクスのため、
# metric math で合算して 1 本のアラームにする。どちらも「エラーが 0 の期間はデータ点自体が出ない」
# ため、FILL で 0 埋めし、treat_missing_data = notBreaching とあわせて無トラフィック時の誤発火を防ぐ。
resource "aws_cloudwatch_metric_alarm" "http_5xx" {
  count = var.create_alarms ? 1 : 0

  alarm_name          = "${var.name}-alb-5xx"
  alarm_description   = "ALB ${var.name} の 5xx 応答（ターゲット起因 + ALB 起因の合算）が閾値を超過（API / frontend のエラー急増を確認する）"
  evaluation_periods  = 2
  threshold           = var.alarm_5xx_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "e1"
    expression  = "FILL(m1, 0) + FILL(m2, 0)"
    label       = "5xx total (target + elb)"
    return_data = true
  }

  metric_query {
    id = "m1"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      stat        = "Sum"
      period      = 300
      dimensions = {
        LoadBalancer = aws_lb.this.arn_suffix
      }
    }
  }

  metric_query {
    id = "m2"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_ELB_5XX_Count"
      stat        = "Sum"
      period      = 300
      dimensions = {
        LoadBalancer = aws_lb.this.arn_suffix
      }
    }
  }

  # ALARM 遷移だけでなく OK 復帰も通知する（DLQ アラームと同じ運用）。
  alarm_actions = var.alarm_actions
  ok_actions    = var.alarm_actions
}

# target group ごとの unhealthy ターゲット数（Availability）。
# API / frontend の両 target group を対象にする（frontend は enable_frontend = true のときのみ）。
# ヘルスチェックは 30s 間隔 x unhealthy_threshold 3 回（約 90 秒）で unhealthy 判定されるため、
# 5 分 x 2 期間の継続で「一時的な入れ替わり」ではなく「回復しない障害」を通知する。
locals {
  unhealthy_host_targets = var.create_alarms ? merge(
    { api = aws_lb_target_group.api },
    var.enable_frontend ? { frontend = aws_lb_target_group.frontend[0] } : {},
  ) : {}
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  for_each = local.unhealthy_host_targets

  alarm_name          = "${var.name}-alb-${each.key}-unhealthy-hosts"
  alarm_description   = "ALB ${var.name} の ${each.key} target group に unhealthy ターゲットが継続して存在する（タスクのヘルスチェック失敗を確認する）"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.this.arn_suffix
    TargetGroup  = each.value.arn_suffix
  }

  alarm_actions = var.alarm_actions
  ok_actions    = var.alarm_actions
}
