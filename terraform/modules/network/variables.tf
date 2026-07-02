variable "name" {
  description = "リソース名プレフィックス（例: ticket-c2c-dev）"
  type        = string
}

variable "region" {
  description = "AWS リージョン（VPC endpoint のサービス名に使用）"
  type        = string
}

variable "vpc_cidr" {
  description = "VPC の CIDR"
  type        = string
  default     = "10.0.0.0/16"
}

variable "az_count" {
  description = "使用する AZ 数"
  type        = number
  default     = 2
}
