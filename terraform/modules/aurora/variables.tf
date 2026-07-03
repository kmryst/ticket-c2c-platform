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
