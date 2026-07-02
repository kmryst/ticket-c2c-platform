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
