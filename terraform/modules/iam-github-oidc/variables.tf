variable "github_repository" {
  description = "OIDC を許可する GitHub リポジトリ（owner/repo 形式）"
  type        = string
}

variable "plan_role_name" {
  description = "terraform plan 用（読み取り専用）IAM ロール名"
  type        = string
}

variable "apply_role_name" {
  description = "terraform apply / destroy / deploy 用 IAM ロール名"
  type        = string
}

variable "apply_environments" {
  description = "apply ロールの引き受けを許可する GitHub Environment 名"
  type        = list(string)
}

variable "create_oidc_provider" {
  description = "GitHub OIDC provider を新規作成するか。アカウントに既存の provider がある場合は false にして参照する"
  type        = bool
  default     = true
}

variable "oidc_thumbprints" {
  description = "GitHub OIDC provider の証明書 thumbprint"
  type        = list(string)
  default = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}
