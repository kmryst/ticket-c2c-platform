variable "name" {
  description = "サービス名（タスク定義 family / コンテナ名を兼ねる）"
  type        = string
}

variable "region" {
  type = string
}

variable "cluster_arn" {
  type = string
}

variable "image" {
  description = "コンテナイメージ URI"
  type        = string
}

variable "command" {
  description = "コンテナ起動 command（null ならイメージの CMD を使う）"
  type        = list(string)
  default     = null
}

variable "cpu" {
  type    = string
  default = "256"
}

variable "memory" {
  type    = string
  default = "512"
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group_ids" {
  type = list(string)
}

variable "execution_role_arn" {
  description = "イメージ pull・ログ出力・secrets 取得を行う実行ロール"
  type        = string
}

variable "task_role_arn" {
  description = "アプリが AWS API を呼ぶための task role"
  type        = string
}

variable "container_port" {
  description = "公開ポート（Worker のように公開しない場合は null）"
  type        = number
  default     = null
}

variable "target_group_arn" {
  description = "ALB target group（接続しない場合は null）"
  type        = string
  default     = null
}

variable "environment" {
  description = "環境変数の map"
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Secrets Manager / SSM から注入する環境変数（name => valueFrom ARN）"
  type        = map(string)
  default     = {}
}

variable "log_group_name" {
  type = string
}
