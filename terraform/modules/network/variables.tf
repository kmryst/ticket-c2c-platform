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

variable "nat_gateway_mode" {
  description = "NAT Gateway の配置。single は 1 台共有、per_az は AZ ごとに 1 台"
  type        = string
  default     = "single"

  validation {
    condition     = contains(["single", "per_az"], var.nat_gateway_mode)
    error_message = "nat_gateway_mode は single または per_az を指定してください。"
  }
}
