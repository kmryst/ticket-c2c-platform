variable "region" {
  description = "AWS リージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "project" {
  description = "プロジェクト名"
  type        = string
  default     = "ticket-c2c-platform"
}

variable "name" {
  description = "リソース名プレフィックス"
  type        = string
  default     = "ticket-c2c-dev"
}

variable "vpc_cidr" {
  description = "VPC の CIDR"
  type        = string
  default     = "10.0.0.0/16"
}
variable   "dummy_bad_fmt" {
      type = string
  default="x"
}
