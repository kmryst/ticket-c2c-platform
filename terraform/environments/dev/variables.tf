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
  default     = "ticket-api-dev"
}

variable "alb_allowed_ingress_cidrs" {
  description = <<-EOT
    ALB への ingress を CIDR ベースで追加許可する（ADR-0007）。
    ADR-0013 で ALB は CloudFront origin-facing prefix list に限定したため、既定は空にする。
    一時的なデバッグで自分の IP を直接許可したい場合のみ CIDR を渡す（escape hatch）。
  EOT
  type        = list(string)
  default     = []
}

variable "app_subdomain" {
  description = "フロントエンドの公開サブドメイン（ADR-0011）。<app_subdomain>.<hosted_zone_name> が CloudFront の alias になる"
  type        = string
  default     = "ticket-app-dev"
}

variable "alert_email" {
  description = <<-EOT
    CloudWatch アラーム通知（SNS email subscription）の宛先メールアドレス（production-readiness L-5 / Issue #200）。
    apply は GitHub Actions（terraform-apply-dev.yml）が変数入力なしで実行するため、既定値で運用者宛先を固定する。
    空文字を渡すと SNS トピック・subscription を作らず、アラームは可視化のみになる。
  EOT
  type        = string
  default     = "komurayoshitodesu@gmail.com"
}
