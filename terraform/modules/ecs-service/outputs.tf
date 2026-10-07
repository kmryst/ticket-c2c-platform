output "service_name" {
  value = aws_ecs_service.this.name
}

output "task_definition_arn" {
  value = aws_ecs_task_definition.this.arn
}

# task definition の container definitions（JSON 文字列）。環境 root の terraform test が、環境変数が
# アプリコンテナ（containerDefinitions[0]）に入ることを確認するために使う（Issue #544）。
output "task_definition_container_definitions" {
  value = aws_ecs_task_definition.this.container_definitions
}
