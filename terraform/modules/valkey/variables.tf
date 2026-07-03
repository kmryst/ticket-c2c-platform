variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "allowed_security_group_ids" {
  description = "6379 への接続を許可する SG"
  type        = list(string)
}

variable "engine_version" {
  type    = string
  default = "8.0"
}

variable "node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "num_cache_clusters" {
  description = "primary を含む Valkey ノード数。2 以上で replica を持つ"
  type        = number
  default     = 1
}

variable "automatic_failover_enabled" {
  description = "Valkey replication group の automatic failover を有効にするか"
  type        = bool
  default     = false
}

variable "transit_encryption_enabled" {
  description = "Valkey の transit encryption を有効にするか"
  type        = bool
  default     = false
}

variable "at_rest_encryption_enabled" {
  description = "Valkey の at-rest encryption を有効にするか"
  type        = bool
  default     = false
}
