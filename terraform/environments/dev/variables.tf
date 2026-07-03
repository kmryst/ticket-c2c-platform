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
