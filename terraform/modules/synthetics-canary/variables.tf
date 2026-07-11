variable "name" {
  description = "リソース名プレフィックス（canary 名・S3 バケット名・IAM ロール名等に使う。既存リソースの命名規則を踏襲。Issue #256）"
  type        = string
}

variable "app_fqdn" {
  description = "CloudFront distribution の alias ドメイン（テスト対象。例: ticket-app-dev.ticket-c2c.click）"
  type        = string
}

variable "alarm_actions" {
  description = "canary 失敗アラームの通知先（SNS トピック ARN のリスト）。空リストの場合は通知配線なし"
  type        = list(string)
  default     = []
}

variable "schedule_expression" {
  description = "canary の実行頻度（rate または cron 式）。既定は 5 分間隔"
  type        = string
  default     = "rate(5 minutes)"
}

variable "timeout_in_seconds" {
  description = "canary 1 回の実行タイムアウト（秒）。3 step の HTTP GET のみのため短めでよい"
  type        = number
  default     = 30
}

variable "runtime_version" {
  description = "CloudWatch Synthetics のランタイムバージョン（Node.js + Puppeteer 系。executeHttpStep を使う multi-step API canary）"
  type        = string
  default     = "syn-nodejs-puppeteer-16.1"
}
