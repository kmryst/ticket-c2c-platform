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

variable "enable_https" {
  description = <<-EOT
    HTTPS リスナーと 80→443 リダイレクトを有効にするか（ADR-0007）。
    certificate_arn は apply 時まで確定しない値（ACM validation の出力）を受けるため、
    リスナーの有無は plan 時に確定するこのフラグで切り替える。
  EOT
  type        = bool
  default     = false
}

variable "certificate_arn" {
  description = "HTTPS リスナーに使う ACM 証明書 ARN（enable_https = true のとき必須）"
  type        = string
  default     = null
}

variable "allowed_ingress_cidrs" {
  description = "ALB への ingress を許可する CIDR（長時間の負荷検証時などに自分の IP へ絞る。ADR-0007）"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
