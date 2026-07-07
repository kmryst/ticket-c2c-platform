variable "name" {
  description = "キュー名（fifo = true の場合 .fifo が自動付与される）"
  type        = string
}

variable "fifo" {
  description = "FIFO キューにするか（ADR-0004 により初期は false）"
  type        = bool
  default     = false
}

variable "visibility_timeout_seconds" {
  type    = number
  default = 60
}

variable "max_receive_count" {
  description = "DLQ へ移すまでの受信回数"
  type        = number
  default     = 5
}

variable "create_dlq_alarm" {
  description = "DLQ 滞留を検知する CloudWatch アラームを作成するか（production-readiness L-5）"
  type        = bool
  default     = true
}

variable "dlq_alarm_actions" {
  description = "DLQ アラームの ALARM / OK 遷移時に通知する ARN のリスト（SNS トピック等。production-readiness L-5 / Issue #200）"
  type        = list(string)
  default     = []
}
