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
