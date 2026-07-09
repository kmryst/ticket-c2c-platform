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

# ---------- 購入 API SLO / burn-rate アラート（ADR-0017 / Issue #227） ----------

variable "purchase_success_slo_percent" {
  description = "購入 API 成功率の SLO 目標値（%）。error budget = 100 - この値（ADR-0017）"
  type        = number
  default     = 99.5
}

variable "purchase_latency_slo_ms" {
  description = "購入 API レイテンシ（Outcome=success の p95）の SLO 目標値（ms、ADR-0017）"
  type        = number
  default     = 800
}

variable "purchase_slo_min_requests" {
  description = "SLO burn-rate アラート（error / latency 共通）の低トラフィックガード。5 分あたりのリクエスト数がこれ未満の期間は non-breaching として扱う（ADR-0017）"
  type        = number
  default     = 5
}

variable "purchase_error_burn_rate_fast_multiplier" {
  description = "error burn-rate fast burn（5 分 window）のしきい値倍率。Google SRE を参考にした heuristic な初期値（ADR-0017）"
  type        = number
  default     = 14.4
}

variable "purchase_error_burn_rate_slow_multiplier" {
  description = "error burn-rate slow burn（30 分 window）のしきい値倍率。Google SRE を参考にした heuristic な初期値（ADR-0017）"
  type        = number
  default     = 3
}

variable "purchase_latency_burn_rate_fast_multiplier" {
  description = "latency burn-rate fast burn（5 分 window）のしきい値倍率（p95 が SLO 目標の何倍で発報するか。ADR-0017）"
  type        = number
  default     = 2.0
}

variable "purchase_latency_burn_rate_slow_multiplier" {
  description = "latency burn-rate slow burn（30 分 window）のしきい値倍率（ADR-0017）"
  type        = number
  default     = 1.2
}

variable "purchase_technical_failure_weak_threshold" {
  description = "technical_failure 絶対数アラーム（弱め通知、早期検知）の 5 分あたり件数しきい値（ADR-0017）"
  type        = number
  default     = 1
}

variable "purchase_technical_failure_normal_threshold" {
  description = "technical_failure 絶対数アラーム（通常通知、持続検知）の 30 分あたり件数しきい値（ADR-0017）"
  type        = number
  default     = 3
}
