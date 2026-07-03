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
  description = "ACM 証明書の DNS 検証と API レコード作成に使う Route53 public hosted zone 名（ADR-0007）"
  type        = string
  default     = "hamilcar-hannibal.click"
}

variable "api_subdomain" {
  description = "API の公開サブドメイン。<api_subdomain>.<hosted_zone_name> が FQDN になる"
  type        = string
  default     = "ticket-api-dev"
}

variable "alb_allowed_ingress_cidrs" {
  description = "ALB への ingress を許可する CIDR。長時間の負荷検証時などに自分の IP へ絞る（ADR-0007）"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
