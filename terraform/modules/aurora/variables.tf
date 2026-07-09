variable "name" {
  description = "リソース名プレフィックス"
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "DB subnet group に使う private subnet"
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "5432 への接続を許可する SG（ECS タスクなど）"
  type        = list(string)
}

variable "engine_version" {
  description = "Aurora PostgreSQL エンジンバージョン（min 0 ACU は 16.3+ が必要）"
  type        = string
  default     = "16.6"
}

variable "database_name" {
  type    = string
  default = "ticket"
}

variable "master_username" {
  type    = string
  default = "ticket_admin"
}

variable "min_capacity" {
  description = "最小 ACU。0 で auto-pause 有効"
  type        = number
  default     = 0
}

variable "max_capacity" {
  description = "最大 ACU"
  type        = number
  default     = 2
}

variable "seconds_until_auto_pause" {
  description = "auto-pause までの秒数（min_capacity = 0 のときのみ有効）"
  type        = number
  default     = 1800
}

variable "deletion_protection" {
  type    = bool
  default = false
}

variable "skip_final_snapshot" {
  type    = bool
  default = true
}

variable "reader_instance_count" {
  description = "failover 用 reader インスタンス数（dev: 0 / staging 以降: 1+）"
  type        = number
  default     = 0
}

variable "backup_retention_period" {
  description = "自動バックアップの保持日数（production-readiness L-7）。dev / staging はエフェメラル環境のため 1、prod は 7 以上を想定"
  type        = number
  default     = 1
}

variable "preferred_backup_window" {
  description = "自動バックアップの時間帯（UTC、例: 17:00-18:00 = JST 深夜）。null は AWS 任せ"
  type        = string
  default     = null
}

variable "auto_minor_version_upgrade" {
  description = "マイナーバージョンをメンテナンスウィンドウで自動適用するか（production-readiness L-7）"
  type        = bool
  default     = true
}

variable "create_alarms" {
  description = "Aurora の CloudWatch アラーム（CPU / メモリ / 接続数 / ACU 上限接近）を作成するか（Issue #218）"
  type        = bool
  default     = true
}

variable "alarm_actions" {
  description = "アラームの ALARM / OK 遷移時に通知する ARN のリスト（SNS トピック等。Issue #218）"
  type        = list(string)
  default     = []
}

variable "alarm_freeable_memory_threshold_bytes" {
  description = "FreeableMemory（bytes）のアラーム閾値。5 分平均がこれを下回る状態が 3 期間続くと ALARM。既定 256 MiB"
  type        = number
  default     = 268435456
}
