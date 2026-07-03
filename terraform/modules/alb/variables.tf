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

variable "certificate_arn" {
  description = "HTTPS リスナーに使う ACM 証明書 ARN（null なら従来どおり HTTP:80 のみ）"
  type        = string
  default     = null
}

variable "allowed_ingress_cidrs" {
  description = "ALB への ingress を許可する CIDR（長時間の負荷検証時などに自分の IP へ絞る。ADR-0007）"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
