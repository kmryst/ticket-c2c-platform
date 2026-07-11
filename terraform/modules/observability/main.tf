resource "aws_cloudwatch_log_group" "this" {
  for_each = toset(var.log_group_names)

  name              = each.key
  retention_in_days = var.retention_in_days
}

# 環境共通のアラート通知用 SNS トピック（production-readiness L-5 / Issue #200）。
# CloudWatch アラーム（現状は SQS DLQ 滞留アラームのみ）の action 先として使う。
# alert_email が空の場合はトピック自体を作らない（通知配線なしの従来挙動）。
resource "aws_sns_topic" "alerts" {
  count = var.alert_email != "" ? 1 : 0

  name = "${var.name}-alerts"
}

# メール通知（SNS → email）。ユーザー決定により通知先はメールとする（Issue #200）。
# email subscription は受信者がメール内の Confirm subscription リンクを踏むまで Pending のまま。
# dev は destroy 前提運用のため、apply のたびに confirm が必要になる（既知の運用事項）。
resource "aws_sns_topic_subscription" "alerts_email" {
  count = var.alert_email != "" ? 1 : 0

  topic_arn = aws_sns_topic.alerts[0].arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# X-Ray group（ADR-0014 / Issue #203）。この環境の API / Worker のトレースだけを
# console 上でまとめて絞り込むためのフィルタ。sampling rule は作らない:
# アプリ側の OTel 標準 sampler（OTEL_TRACES_SAMPLER 環境変数）で制御しており、
# X-Ray の centralized sampling rule は OTel 標準 sampler から参照されないため。
resource "aws_xray_group" "this" {
  count = length(var.xray_service_names) > 0 ? 1 : 0

  group_name = var.name
  filter_expression = join(" OR ", [
    for service in var.xray_service_names : "service(\"${service}\")"
  ])
}

# ---------- EMF ビジネスメトリクスのアラーム（Issue #218） ----------
# EMF（ADR-0014）は CloudWatch Logs からメトリクスが自動抽出されるため、
# metric filter は不要でアラーム定義だけでよい。メトリクスの所有 terraform モジュールが
# 存在しない（アプリコードが出す）ため、SNS トピックを持つこのモジュールに置く。
# 通知先はこのモジュール自身のアラート用 SNS トピック（alert_email が空なら actions なし）。

# ValkeyFailOpen: 前段フィルタ（Valkey）障害時の fail-open は設計上の許容だが、
# レート制限・売り切れ前段拒否が無効化されたまま「静かに」進行する状態を放置しないため、
# 1 件でも観測したら即 ALARM にする。dimension は Service のみの集計側 set を使い、
# Operation 別（reserve / getCounterVersion / wasRequestSeen）の内訳はコンソールで確認する。
resource "aws_cloudwatch_metric_alarm" "valkey_fail_open" {
  count = var.metrics_namespace != "" ? 1 : 0

  alarm_name          = "${var.name}-valkey-fail-open"
  alarm_description   = "[Critical] API が Valkey 障害で fail-open した（前段フィルタ・レート制限が無効化されている。Valkey の状態を確認する）"
  namespace           = var.metrics_namespace
  metric_name         = "ValkeyFailOpen"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    Service = "api"
  }

  # ALARM 遷移だけでなく OK 復帰も通知する（DLQ アラームと同じ運用）。
  alarm_actions = aws_sns_topic.alerts[*].arn
  ok_actions    = aws_sns_topic.alerts[*].arn
}

# WorkerProcessingLagMs: SQS 送信から Worker の処理完了（削除）までの経過時間。
# p90 が閾値を超える持続は「検索プロジェクションの鮮度劣化」（Worker のスループット不足・
# 処理詰まり）として通知する。DLQ アラーム（処理失敗）とは別軸の「遅いが失敗していない」検知。
resource "aws_cloudwatch_metric_alarm" "worker_processing_lag" {
  count = var.metrics_namespace != "" ? 1 : 0

  alarm_name          = "${var.name}-worker-processing-lag"
  alarm_description   = "[Warning] Worker の処理遅延（WorkerProcessingLagMs p90）が ${var.worker_lag_alarm_threshold_ms} ms を超過（検索プロジェクションの鮮度劣化。Worker の詰まり・スループット不足を確認する）"
  namespace           = var.metrics_namespace
  metric_name         = "WorkerProcessingLagMs"
  extended_statistic  = "p90"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.worker_lag_alarm_threshold_ms
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    Service = "worker"
  }

  alarm_actions = aws_sns_topic.alerts[*].arn
  ok_actions    = aws_sns_topic.alerts[*].arn
}

# ---------- 購入 API SLO / burn-rate アラート（ADR-0017 / Issue #227） ----------
# Issue #218 の静的閾値アラームとは異なり、SLO 目標値（成功率・レイテンシ）に対する
# error budget 消費速度（burn rate）を CloudWatch metric math で算出する。
# 入力は Issue #225 / ADR-0016 で実装した購入 API 専用メトリクス
# （PurchaseRequestOutcome / PurchaseRequestLatencyMs、いずれも dimension は Service + Outcome）。
#
# 重要: これらのメトリクスは emf.ts の実装により Service 単独と Service+Outcome の
# 2 つの dimension set で記録される（別系列）。metric math で参照する際は必ず
# Service = "api" を明示し、Outcome と組み合わせて指定する（単に Outcome だけでは
# 系列を一意に特定できない）。

locals {
  # error budget（%）。成功率 SLO からの差分。例: SLO 99.5% なら error budget 0.5%。
  purchase_error_budget_percent = 100 - var.purchase_success_slo_percent
}

# --- error burn-rate（成功率 SLO の逸脱検知） ---
# error_rate = IF(eligible_count >= min_requests, technical_failure / eligible_count * 100, 0)
# burn_ratio = error_rate / error_budget_percent
# 「成功率」ではなく「error burn rate（error budget 消費速度）」を正本の式にすることで、
# 比較演算子・しきい値の向きを直感的にする（外部レビュー指摘、ADR-0017）。
resource "aws_cloudwatch_metric_alarm" "purchase_error_burn_rate_fast" {
  count = var.metrics_namespace != "" ? 1 : 0

  alarm_name          = "${var.name}-purchase-error-burn-rate-fast"
  alarm_description   = "[Critical] 購入 API の error burn rate が fast burn しきい値（${var.purchase_error_burn_rate_fast_multiplier}x）を超過（5 分 window。成功率 SLO ${var.purchase_success_slo_percent}% からの急激な逸脱を検知する。ADR-0017）"
  evaluation_periods  = 1
  threshold           = var.purchase_error_burn_rate_fast_multiplier
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "m1"
    return_data = false
    metric {
      namespace   = var.metrics_namespace
      metric_name = "PurchaseRequestOutcome"
      stat        = "Sum"
      period      = 300
      dimensions = {
        Service = "api"
        Outcome = "technical_failure"
      }
    }
  }

  metric_query {
    id          = "m2"
    return_data = false
    metric {
      namespace   = var.metrics_namespace
      metric_name = "PurchaseRequestOutcome"
      stat        = "Sum"
      period      = 300
      dimensions = {
        Service = "api"
        Outcome = "success"
      }
    }
  }

  metric_query {
    id          = "e1"
    expression  = "m1+m2"
    label       = "eligible_count"
    return_data = false
  }

  metric_query {
    id          = "e2"
    expression  = "IF(e1>=${var.purchase_slo_min_requests}, (m1/e1)*100, 0)"
    label       = "error_rate_percent"
    return_data = false
  }

  metric_query {
    id          = "e3"
    expression  = "e2/${local.purchase_error_budget_percent}"
    label       = "error_burn_ratio"
    return_data = true
  }

  alarm_actions = aws_sns_topic.alerts[*].arn
  ok_actions    = aws_sns_topic.alerts[*].arn
}

resource "aws_cloudwatch_metric_alarm" "purchase_error_burn_rate_slow" {
  count = var.metrics_namespace != "" ? 1 : 0

  alarm_name          = "${var.name}-purchase-error-burn-rate-slow"
  alarm_description   = "[Warning] 購入 API の error burn rate が slow burn しきい値（${var.purchase_error_burn_rate_slow_multiplier}x）を超過（30 分 window。成功率 SLO ${var.purchase_success_slo_percent}% からの持続的な逸脱を検知する。ADR-0017）"
  evaluation_periods  = 6
  threshold           = var.purchase_error_burn_rate_slow_multiplier
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "m1"
    return_data = false
    metric {
      namespace   = var.metrics_namespace
      metric_name = "PurchaseRequestOutcome"
      stat        = "Sum"
      period      = 300
      dimensions = {
        Service = "api"
        Outcome = "technical_failure"
      }
    }
  }

  metric_query {
    id          = "m2"
    return_data = false
    metric {
      namespace   = var.metrics_namespace
      metric_name = "PurchaseRequestOutcome"
      stat        = "Sum"
      period      = 300
      dimensions = {
        Service = "api"
        Outcome = "success"
      }
    }
  }

  metric_query {
    id          = "e1"
    expression  = "m1+m2"
    label       = "eligible_count"
    return_data = false
  }

  metric_query {
    id          = "e2"
    expression  = "IF(e1>=${var.purchase_slo_min_requests}, (m1/e1)*100, 0)"
    label       = "error_rate_percent"
    return_data = false
  }

  metric_query {
    id          = "e3"
    expression  = "e2/${local.purchase_error_budget_percent}"
    label       = "error_burn_ratio"
    return_data = true
  }

  alarm_actions = aws_sns_topic.alerts[*].arn
  ok_actions    = aws_sns_topic.alerts[*].arn
}

# --- technical_failure 絶対数アラーム（低頻度時の見逃し防止。外部レビュー指摘で追加） ---
# 購入 API はイベントごとに数回しか呼ばれない性質上、上記 burn-rate アラームの
# 低トラフィックガード（5 件 / 5 分）を割り込む時間帯が多く発生しうる。
# burn-rate だけでは技術的失敗を見逃すリスクがあるため、絶対数の静的閾値アラームを併設する。
# このプロジェクトには重大度別の通知チャネルがないため、「弱め / 通常」は
# アラーム名・説明文で区別するに留め、通知先は同じ SNS トピックを使う（ADR-0017）。
resource "aws_cloudwatch_metric_alarm" "purchase_technical_failure_weak" {
  count = var.metrics_namespace != "" ? 1 : 0

  alarm_name          = "${var.name}-purchase-technical-failure-weak"
  alarm_description   = "[Info] 購入 API で technical_failure を検知（早期・弱め通知。5 分で ${var.purchase_technical_failure_weak_threshold} 件以上。低頻度時の burn-rate ガードを補完する。ADR-0017）"
  namespace           = var.metrics_namespace
  metric_name         = "PurchaseRequestOutcome"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.purchase_technical_failure_weak_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    Service = "api"
    Outcome = "technical_failure"
  }

  alarm_actions = aws_sns_topic.alerts[*].arn
  ok_actions    = aws_sns_topic.alerts[*].arn
}

resource "aws_cloudwatch_metric_alarm" "purchase_technical_failure_normal" {
  count = var.metrics_namespace != "" ? 1 : 0

  alarm_name          = "${var.name}-purchase-technical-failure-normal"
  alarm_description   = "[Warning] 購入 API で technical_failure が持続（通常通知。30 分で ${var.purchase_technical_failure_normal_threshold} 件以上。ADR-0017）"
  namespace           = var.metrics_namespace
  metric_name         = "PurchaseRequestOutcome"
  statistic           = "Sum"
  period              = 1800
  evaluation_periods  = 1
  threshold           = var.purchase_technical_failure_normal_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    Service = "api"
    Outcome = "technical_failure"
  }

  alarm_actions = aws_sns_topic.alerts[*].arn
  ok_actions    = aws_sns_topic.alerts[*].arn
}

# --- latency burn-rate（レイテンシ SLO の逸脱検知） ---
# Outcome=success のみを対象とした p95 を正本にする（外部レビュー指摘、ADR-0017）。
# 全 Outcome を混ぜると、速い invalid_request / rate_limited が薄める、
# 遅い technical_failure を error burn-rate と二重に扱う、平均だけでは尾の遅延を隠す、
# という 3 つの問題があるため。
# サンプル数ガードは PurchaseRequestOutcome{Outcome=success} の件数を代理指標として使う
# （PurchaseRequestLatencyMs 自体の SampleCount は metric math で直接参照できないため）。
resource "aws_cloudwatch_metric_alarm" "purchase_latency_burn_rate_fast" {
  count = var.metrics_namespace != "" ? 1 : 0

  alarm_name          = "${var.name}-purchase-latency-burn-rate-fast"
  alarm_description   = "[Warning] 購入 API の レイテンシ（Outcome=success の p95）が fast burn しきい値（SLO の ${var.purchase_latency_burn_rate_fast_multiplier}x = ${var.purchase_latency_slo_ms * var.purchase_latency_burn_rate_fast_multiplier}ms）を超過（5 分 window。ADR-0017）"
  evaluation_periods  = 1
  threshold           = var.purchase_latency_burn_rate_fast_multiplier
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "m1"
    return_data = false
    metric {
      namespace   = var.metrics_namespace
      metric_name = "PurchaseRequestLatencyMs"
      stat        = "p95"
      period      = 300
      dimensions = {
        Service = "api"
        Outcome = "success"
      }
    }
  }

  metric_query {
    id          = "m2"
    return_data = false
    metric {
      namespace   = var.metrics_namespace
      metric_name = "PurchaseRequestOutcome"
      stat        = "Sum"
      period      = 300
      dimensions = {
        Service = "api"
        Outcome = "success"
      }
    }
  }

  metric_query {
    id          = "e1"
    expression  = "IF(m2>=${var.purchase_slo_min_requests}, m1/${var.purchase_latency_slo_ms}, 0)"
    label       = "latency_burn_ratio"
    return_data = true
  }

  alarm_actions = aws_sns_topic.alerts[*].arn
  ok_actions    = aws_sns_topic.alerts[*].arn
}

resource "aws_cloudwatch_metric_alarm" "purchase_latency_burn_rate_slow" {
  count = var.metrics_namespace != "" ? 1 : 0

  alarm_name          = "${var.name}-purchase-latency-burn-rate-slow"
  alarm_description   = "[Warning] 購入 API の レイテンシ（Outcome=success の p95）が slow burn しきい値（SLO の ${var.purchase_latency_burn_rate_slow_multiplier}x = ${var.purchase_latency_slo_ms * var.purchase_latency_burn_rate_slow_multiplier}ms）を超過（30 分 window。ADR-0017）"
  evaluation_periods  = 6
  threshold           = var.purchase_latency_burn_rate_slow_multiplier
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "m1"
    return_data = false
    metric {
      namespace   = var.metrics_namespace
      metric_name = "PurchaseRequestLatencyMs"
      stat        = "p95"
      period      = 300
      dimensions = {
        Service = "api"
        Outcome = "success"
      }
    }
  }

  metric_query {
    id          = "m2"
    return_data = false
    metric {
      namespace   = var.metrics_namespace
      metric_name = "PurchaseRequestOutcome"
      stat        = "Sum"
      period      = 300
      dimensions = {
        Service = "api"
        Outcome = "success"
      }
    }
  }

  metric_query {
    id          = "e1"
    expression  = "IF(m2>=${var.purchase_slo_min_requests}, m1/${var.purchase_latency_slo_ms}, 0)"
    label       = "latency_burn_ratio"
    return_data = true
  }

  alarm_actions = aws_sns_topic.alerts[*].arn
  ok_actions    = aws_sns_topic.alerts[*].arn
}
