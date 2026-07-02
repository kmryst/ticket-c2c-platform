variable "name" {
  description = "イベントバス名"
  type        = string
}

variable "event_source" {
  description = "ドメインイベントの source 値"
  type        = string
  default     = "ticket-c2c.api"
}

variable "detail_types" {
  description = "ルーティング対象の detail-type 一覧"
  type        = list(string)
  default     = ["EventListed", "EventUpdated", "InventoryChanged", "TicketPurchased"]
}

variable "target_queue_arn" {
  description = "ルーティング先 SQS キューの ARN"
  type        = string
}

variable "target_queue_url" {
  description = "ルーティング先 SQS キューの URL（キューポリシー設定用）"
  type        = string
}
