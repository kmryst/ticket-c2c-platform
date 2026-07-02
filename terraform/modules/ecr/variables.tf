variable "name" {
  description = "ECR リポジトリ名"
  type        = string
}

variable "keep_image_count" {
  description = "保持するイメージ数"
  type        = number
  default     = 10
}

variable "force_delete" {
  description = "イメージが残っていてもリポジトリを削除するか（destroy 前提運用の dev では true）"
  type        = bool
  default     = false
}
