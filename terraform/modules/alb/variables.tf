variable "name" {
  description = "リソース名プレフィックス（target group 名の制約により 26 文字以内）"
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "container_port" {
  type    = number
  default = 3000
}
