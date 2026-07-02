resource "aws_cloudwatch_log_group" "this" {
  for_each = toset(var.log_group_names)

  name              = each.key
  retention_in_days = var.retention_in_days
}
