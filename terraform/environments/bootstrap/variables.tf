variable "region" {
  description = "AWS リージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "project" {
  description = "プロジェクト名（タグ・リソース名のプレフィックス）"
  type        = string
  default     = "ticket-c2c-platform"
}

variable "state_bucket_name" {
  description = "tfstate 用 S3 バケット名（グローバル一意）"
  type        = string
  default     = "ticket-c2c-platform-tfstate-258632448142"
}

variable "github_repository" {
  description = "OIDC を許可する GitHub リポジトリ"
  type        = string
  default     = "kmryst/ticket-c2c-platform"
}
