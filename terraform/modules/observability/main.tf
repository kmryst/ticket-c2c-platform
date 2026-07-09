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
  alarm_description   = "API が Valkey 障害で fail-open した（前段フィルタ・レート制限が無効化されている。Valkey の状態を確認する）"
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
  alarm_description   = "Worker の処理遅延（WorkerProcessingLagMs p90）が ${var.worker_lag_alarm_threshold_ms} ms を超過（検索プロジェクションの鮮度劣化。Worker の詰まり・スループット不足を確認する）"
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
