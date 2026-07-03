variable "name" {
  description = "ドメイン名（28 文字以内・小文字）"
  type        = string
}

variable "region" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "allowed_security_group_ids" {
  description = "443 への接続を許可する SG"
  type        = list(string)
}

variable "engine_version" {
  type    = string
  default = "OpenSearch_2.19"
}

variable "instance_type" {
  type    = string
  default = "t3.small.search"
}

variable "instance_count" {
  description = "OpenSearch data node 数"
  type        = number
  default     = 1
}

variable "zone_awareness_enabled" {
  description = "OpenSearch の Multi-AZ / zone awareness を有効にするか"
  type        = bool
  default     = false
}

variable "availability_zone_count" {
  description = "zone awareness 有効時に使う AZ 数"
  type        = number
  default     = 2
}

variable "volume_size" {
  type    = number
  default = 10
}
