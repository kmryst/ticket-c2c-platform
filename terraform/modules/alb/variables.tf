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
  description = <<-EOT
    ALB への ingress を許可する CIDR（ADR-0007）。空リストにすると CIDR ベースの ingress を作らず、
    ingress_prefix_list_ids のみを送信元にする（ADR-0013 の CloudFront 限定構成）。
  EOT
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "ingress_prefix_list_ids" {
  description = <<-EOT
    ALB への ingress を許可する managed prefix list ID（ADR-0013）。
    CloudFront の origin-facing prefix list を渡すと、ALB へは CloudFront 経由でのみ到達でき、
    直叩き（WAF 迂回・レート制限 IP バイパス）を遮断できる。空なら CIDR ベースのみを使う。
  EOT
  type        = list(string)
  default     = []
}

variable "enable_frontend" {
  description = <<-EOT
    フロントエンド用 target group と listener rule を作るか（ADR-0011）。
    CloudFront の frontend origin にだけ付く識別ヘッダー（frontend_header_name）を
    listener rule で判定し、frontend target group へ転送する。
    default action は API のまま維持されるため、既存の直接アクセス経路は変わらない。
  EOT
  type        = bool
  default     = false
}

variable "frontend_container_port" {
  description = "フロントエンドコンテナの待受ポート"
  type        = number
  default     = 3000
}

variable "frontend_header_name" {
  description = "CloudFront frontend origin が付与する識別ヘッダー名（ADR-0011 決定 2）"
  type        = string
  default     = "x-ticket-dest"
}

variable "frontend_header_value" {
  description = "識別ヘッダーの値。CloudFront module 側と一致させる"
  type        = string
  default     = "frontend"
}

variable "create_alarms" {
  description = "ALB の CloudWatch アラーム（5xx / unhealthy hosts）を作成するか（Issue #218）"
  type        = bool
  default     = true
}

variable "alarm_actions" {
  description = "アラームの ALARM / OK 遷移時に通知する ARN のリスト（SNS トピック等。Issue #218）"
  type        = list(string)
  default     = []
}

variable "alarm_5xx_threshold" {
  description = "5xx 合算（ターゲット起因 + ALB 起因）の 5 分あたり許容件数。これ以上が 2 期間続くと ALARM"
  type        = number
  default     = 10
}
