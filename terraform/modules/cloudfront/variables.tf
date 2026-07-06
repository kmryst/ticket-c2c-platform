variable "name" {
  description = "distribution の comment に使う識別名"
  type        = string
}

variable "aliases" {
  description = "distribution の alternate domain name（例: ticket-app-dev.ticket-c2c.click）"
  type        = list(string)
}

variable "acm_certificate_arn" {
  description = "aliases 用の ACM 証明書 ARN（us-east-1 で発行済み・検証済みであること）"
  type        = string
}

variable "origin_domain_name" {
  description = "統合オリジン（ALB）の FQDN。ALB 証明書と一致する API のドメインを使う"
  type        = string
}

variable "web_acl_id" {
  description = "distribution に関連付ける WAFv2 WebACL の ARN（scope=CLOUDFRONT、us-east-1。L-12）。null なら関連付けない"
  type        = string
  default     = null
}

variable "frontend_header_name" {
  description = "frontend origin に付与する識別ヘッダー名（alb モジュールの listener rule と一致させる）"
  type        = string
  default     = "x-ticket-dest"
}

variable "frontend_header_value" {
  description = "識別ヘッダーの値"
  type        = string
  default     = "frontend"
}
