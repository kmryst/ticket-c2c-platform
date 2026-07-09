variable "log_group_names" {
  description = "作成する CloudWatch Log Group 名の一覧"
  type        = list(string)
}

variable "retention_in_days" {
  description = "ログ保持日数"
  type        = number
  default     = 30
}

variable "name" {
  description = "リソース名プレフィックス（SNS アラートトピック名 <name>-alerts に使う）"
  type        = string
}

variable "alert_email" {
  description = "CloudWatch アラーム通知（SNS email subscription）の宛先メールアドレス（production-readiness L-5 / Issue #200）。空文字の場合は SNS トピックを作成しない"
  type        = string
  default     = ""
}

variable "xray_service_names" {
  description = "X-Ray group のフィルタ対象サービス名一覧（ADR-0014 / Issue #203）。空の場合は X-Ray group を作らない"
  type        = list(string)
  default     = []
}

variable "metrics_namespace" {
  description = "EMF ビジネスメトリクスの CloudWatch 名前空間（ADR-0014、例: TicketC2C/dev）。ECS タスクの METRICS_NAMESPACE と一致させる。空文字の場合は EMF メトリクスのアラーム（Issue #218）を作成しない"
  type        = string
  default     = ""
}

variable "worker_lag_alarm_threshold_ms" {
  description = "WorkerProcessingLagMs（p90）のアラーム閾値（ms）。5 分 p90 がこれを超える状態が 2 期間続くと ALARM（Issue #218）"
  type        = number
  default     = 30000
}
