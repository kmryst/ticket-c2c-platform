variable "log_group_names" {
  description = "作成する CloudWatch Log Group 名の一覧"
  type        = list(string)
}

variable "retention_in_days" {
  description = "ログ保持日数"
  type        = number
  default     = 30
}
