variable "name" {
  description = "スケジュール・IAM ロールの名前（例: ticket-c2c-dev-refresh-token-cleanup）"
  type        = string
}

variable "schedule_expression" {
  description = "EventBridge Scheduler のスケジュール式（既定: 毎日 18:30 UTC = 03:30 JST。トラフィックの少ない深夜帯）"
  type        = string
  default     = "cron(30 18 * * ? *)"
}

variable "cluster_arn" {
  description = "RunTask 先の ECS クラスタ ARN"
  type        = string
}

variable "task_definition_arn" {
  description = "起動するタスク定義 ARN（リビジョン付きでよい。モジュール内で family ARN に変換し、最新 ACTIVE リビジョンを起動する）"
  type        = string
}

variable "container_name" {
  description = "command override 対象のコンテナ名（タスク定義内のコンテナ名）"
  type        = string
}

variable "command" {
  description = "コンテナで実行するコマンド（command override）"
  type        = list(string)
}

variable "subnet_ids" {
  description = "タスクを起動する private subnet の ID 一覧"
  type        = list(string)
}

variable "security_group_ids" {
  description = "タスクへ付与する security group の ID 一覧"
  type        = list(string)
}

variable "execution_role_arn" {
  description = "タスク定義の実行ロール ARN（Scheduler ロールの iam:PassRole 対象）"
  type        = string
}

variable "task_role_arn" {
  description = "タスク定義のタスクロール ARN（Scheduler ロールの iam:PassRole 対象）"
  type        = string
}
