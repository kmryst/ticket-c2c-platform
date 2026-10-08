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
    alb-http-only: ALB HTTP リスナーのみ。ACM 証明書・HTTPS リスナー・Route53 alias を作らない。
    ingress は既定で閉（Issue #232）。ローカル apply でデバッグする際の escape hatch として維持する。
    https-dns: <api_subdomain>.<hosted_zone_name> の ACM 証明書（DNS 検証）・HTTPS リスナー・Route53 alias を作る。
    現行の既定運用（terraform-apply-staging.yml の入力既定でもある。Issue #94 / #232）。
  EOT
  type        = string
  default     = "https-dns"

  validation {
    condition     = contains(["alb-http-only", "https-dns"], var.public_endpoint_mode)
    error_message = "public_endpoint_mode は alb-http-only または https-dns を指定してください。"
  }
}

variable "image_tag" {
  description = <<-EOT
    terraform が作る ECS タスク定義（api / worker / frontend）の初期イメージタグ（Issue #543 / ADR-0040）。
    どこからも push しない固定値 pending-deploy だけを許可する。terraform apply 直後の初期 deployment は
    このタグのイメージを pull できず（CannotPullContainerError）アプリを起動しない。初期 deployment は
    deployment circuit breaker が FAILED にする。アプリの起動は deploy workflow（deploy-service.yml）が DB migration と
    search index migration の後に commit SHA タグのタスク定義リビジョンを register し、update-service
    することで始まる（production-readiness M-7）。terraform のリビジョンは設定（環境変数・CPU / メモリ等）の正本で、
    deploy はそのリビジョン（output ecs_task_definition_arns）のイメージだけを差し替えて register する
    （Issue #544 / ADR-0042。ecs-service モジュールは task_definition の差分を ignore_changes で無視する）。
    deploy-service.yml はこの値と latest を push しない。値を変える場合は deploy-service.yml の
    PENDING_DEPLOY_IMAGE_TAG と tests/image_tag.tftest.hcl も同じ PR で変える。
  EOT
  type        = string
  default     = "pending-deploy"

  validation {
    condition     = var.image_tag == "pending-deploy"
    error_message = "image_tag は pending-deploy 以外を指定できない。アプリのイメージは deploy-backend-<env>.yml / deploy-frontend-<env>.yml の update-service で反映する（Issue #543 / ADR-0040）。"
  }
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
    alb-http-only（CloudFront なし）でも既定は空で ingress なし（Issue #232）。
    一時的なデバッグで自分の IP を直接許可したい場合のみ、明示的に CIDR を渡す（escape hatch）。
    CI workflow には CIDR 入力を追加しない。ローカル terraform apply での運用手順は
    staging-environment.md の「alb-http-only をローカル apply で検証する手順」を参照。
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

variable "task_config_check_value" {
  description = <<-EOT
    AWS での確認用に api / worker / frontend の task definition へ入れる環境変数 TASK_CONFIG_CHECK_VALUE の値
    （Issue #544 / ADR-0042）。アプリはこの変数を読まない。空（既定値）なら環境変数を足さない。
    terraform-apply-<env>.yml の同名の入力から TF_VAR_task_config_check_value で渡す。
    既存の環境で「terraform の設定だけを変えて apply → deploy すると、service と migration の task definition に
    反映される」ことを、コードを書き換えずに確認するために使う（docs/runbooks/apply-task-definition-config-change.md）。
  EOT
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]{0,64}$", var.task_config_check_value))
    error_message = "task_config_check_value は英数字と . _ - の 64 文字以内（空なら環境変数を足さない）。"
  }
}

variable "enable_synthetic_check" {
  description = <<-EOT
    外形監視（CloudWatch Synthetics canary）と失敗アラーム synthetic-check-failure を作るか（Issue #546 / ADR-0043）。
    既定は false で、最初の apply では作らない。apply 直後は ECS タスクが起動しておらず（ADR-0040）、
    canary が ALB 503 を記録して Critical 通知が出るためである。
    apply → deploy-backend → deploy-frontend の後、terraform-apply-<env>.yml を入力 enable_synthetic_check=true で
    もう一度実行して作る（TF_VAR_enable_synthetic_check で渡す）。一度作った後は、false で apply すると
    canary を削除する計画になり、apply workflow の検査（scripts/deployment/check-synthetic-check-plan.sh）で失敗する。
    ローカルで apply する場合はこの検査を通らないため、作成済みの環境では -var enable_synthetic_check=true を付ける。
    staging では public_endpoint_mode = https-dns のときだけ作る（alb-http-only では true でも作らない）。
  EOT
  type        = bool
  default     = false
}
