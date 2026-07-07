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
  default     = "ticket-c2c-staging"
}

variable "capacity_profile" {
  description = "staging の構成サイズ・冗長化 profile。normal は通常 staging、full は負荷試験・failover 検証用"
  type        = string
  default     = "normal"

  validation {
    condition     = contains(["normal", "full"], var.capacity_profile)
    error_message = "capacity_profile は normal または full を指定してください。"
  }
}

variable "vpc_cidr" {
  description = "VPC の CIDR。環境ごとに重複させない（dev: 10.0.0.0/16 / staging: 10.10.0.0/16 / prod candidate: 10.20.0.0/16）"
  type        = string
  default     = "10.10.0.0/16"
}

variable "public_endpoint_mode" {
  description = <<-EOT
    公開エンドポイントのモード（staging-environment.md / ADR-0008）。
    alb-http-only: ALB HTTP リスナーのみ。ACM 証明書・HTTPS リスナー・Route53 alias を作らない（初回 staging）。
    https-dns: <api_subdomain>.<hosted_zone_name> の ACM 証明書（DNS 検証）・HTTPS リスナー・Route53 alias を作る。
  EOT
  type        = string
  default     = "alb-http-only"

  validation {
    condition     = contains(["alb-http-only", "https-dns"], var.public_endpoint_mode)
    error_message = "public_endpoint_mode は alb-http-only または https-dns を指定してください。"
  }
}

variable "image_tag" {
  description = <<-EOT
    ECS タスク定義の初期イメージタグ。
    通常のデプロイは deploy-app workflow が commit SHA タグのタスク定義リビジョンを register して
    サービスを更新する（production-readiness M-7）。この変数は環境の初回構築時に参照する
    ブートストラップ用で、初回 deploy-app 実行後はサービス側のリビジョンが正になる
    （ecs-service モジュールは task_definition の差分を ignore_changes で無視する）。
  EOT
  type        = string
  default     = "latest"
}

variable "hosted_zone_name" {
  description = "ACM 証明書の DNS 検証と API レコード作成に使う Route53 public hosted zone 名（ADR-0007 / ADR-0009）"
  type        = string
  default     = "ticket-c2c.click"
}

variable "api_subdomain" {
  description = "API の公開サブドメイン。<api_subdomain>.<hosted_zone_name> が FQDN になる"
  type        = string
  default     = "ticket-api-staging"
}

variable "alb_allowed_ingress_cidrs" {
  description = <<-EOT
    ALB への ingress を CIDR ベースで追加許可する（ADR-0007）。
    ADR-0013 で https-dns の ALB は CloudFront origin-facing prefix list に限定したため、既定は空。
    alb-http-only モードでは root が 0.0.0.0/0 を明示的に渡す（CloudFront なしのため）。
    一時的なデバッグで自分の IP を直接許可したい場合のみ CIDR を渡す（escape hatch）。
  EOT
  type        = list(string)
  default     = []
}

variable "app_subdomain" {
  description = "フロントエンドの公開サブドメイン（ADR-0011）。<app_subdomain>.<hosted_zone_name> が CloudFront の alias になる"
  type        = string
  default     = "ticket-app-staging"
}

variable "alert_email" {
  description = <<-EOT
    CloudWatch アラーム通知（SNS email subscription）の宛先メールアドレス（production-readiness L-5 / Issue #200）。
    apply は GitHub Actions（terraform-apply-staging.yml）が変数入力なしで実行するため、既定値で運用者宛先を固定する。
    空文字を渡すと SNS トピック・subscription を作らず、アラームは可視化のみになる。
  EOT
  type        = string
  default     = "komurayoshitodesu@gmail.com"
}
