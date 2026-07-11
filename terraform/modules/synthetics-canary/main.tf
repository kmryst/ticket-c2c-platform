# CloudWatch Synthetics canary によるユーザー入口の外形監視（Issue #256）。
#
# EventBridge + Lambda の自前実装ではなく、CloudWatch Synthetics canary の
# 組み込みマルチステップ機能（executeHttpStep）を使う（設計判断確定済み）。
# read-only の代表 3 endpoint（healthz 相当・frontend HTML・API 代表 read endpoint）を
# 順に GET し、いずれかが 2xx 以外を返すと canary 全体が失敗として記録される。
# 認証・secret を要する操作、副作用のある操作（POST 等）は対象外（read-only に限定）。
#
# このモジュールは呼び出し元から us-east-1 provider を渡されることを前提とする
# （root 側で `providers = { aws = aws.us_east_1 }` を指定する）。理由は L-16 / Issue #252 と同じ:
# canary はテスト対象（CloudFront）と異なるリージョンでも実行できるが、
# メトリクス・アラームは canary が作成されたリージョンに乗る。CloudWatch alarm の
# alarm_actions は同一リージョンの SNS トピックしか指定できないため、
# 既存の us-east-1 側 SNS トピック（<name>-edge-alerts）と同じリージョンに揃える。

data "aws_caller_identity" "current" {}

locals {
  canary_name = "${var.name}-synthetic-check"
  bucket_name = "${var.name}-synthetics-artifacts"
}

# ---------- canary script（zip 化） ----------
# Node.js canary の zip は `nodejs/node_modules/<ファイル名>.js` という固定のフォルダ構成が
# 必須（AWS の仕様）。ただしリポジトリの .gitignore は `node_modules/` を一括で無視するため、
# 実ファイルは files/syntheticCheck.js（node_modules を含まないパス）に置き、
# archive_file の source ブロックで zip 内のパスだけを `nodejs/node_modules/...` に写像する
# （source_dir は使わない。source_dir だとリポジトリ上のディレクトリ構成そのものが
# node_modules を含む必要があり、.gitignore に阻まれてコミットできない）。
data "archive_file" "canary" {
  type        = "zip"
  output_path = "${path.module}/build/${var.name}-canary.zip"

  source {
    content  = file("${path.module}/files/syntheticCheck.js")
    filename = "nodejs/node_modules/syntheticCheck.js"
  }
}

# ---------- アーティファクト用 S3 バケット ----------
# canary の実行結果（ログ・HAR ファイル等）の格納先。destroy 前提運用のため
# force_destroy = true（ECR / cf_logs / waf_logs と同じ流儀）。
resource "aws_s3_bucket" "artifacts" {
  bucket        = local.bucket_name
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# 30 日で自動失効（cf_logs / waf_logs と同じ保持期間）。destroy 運用のため実質的には
# 環境が生きている間の運用コストの目安にしかならないが、常設 prod 化した場合の
# ストレージコスト増を防ぐ。
resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "expire-30d"
    status = "Enabled"

    filter {}

    expiration {
      days = 30
    }
  }
}

# ---------- IAM ロール（canary の実行ロール） ----------
# canary の Lambda 実体（cwsyn-<name>-*）が引き受けるロール。AWS 公式ドキュメント
# （Required roles and permissions for canaries）が求める最小権限セットを、
# このプロジェクトの他モジュール（scheduled-task 等）と同じ最小権限方針で
# リソース限定する。
data "aws_iam_policy_document" "canary_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "canary" {
  name               = "${var.name}-synthetic-check"
  assume_role_policy = data.aws_iam_policy_document.canary_assume.json
}

resource "aws_iam_role_policy" "canary" {
  name = "synthetic-check-execution"
  role = aws_iam_role.canary.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ArtifactsWrite"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = ["${aws_s3_bucket.artifacts.arn}/*"]
      },
      {
        Sid      = "ArtifactsBucketLocation"
        Effect   = "Allow"
        Action   = ["s3:GetBucketLocation"]
        Resource = [aws_s3_bucket.artifacts.arn]
      },
      {
        # AWS 公式ドキュメントが要求する権限（リソースレベル制限非対応）。
        Sid      = "ListBuckets"
        Effect   = "Allow"
        Action   = ["s3:ListAllMyBuckets"]
        Resource = ["*"]
      },
      {
        Sid      = "Metrics"
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = ["*"] # PutMetricData はリソースレベル制限非対応。namespace で絞る。
        Condition = {
          StringEquals = {
            "cloudwatch:namespace" = "CloudWatchSynthetics"
          }
        }
      },
      {
        Sid    = "Logs"
        Effect = "Allow"
        Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = [
          "arn:aws:logs:us-east-1:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/cwsyn-${local.canary_name}-*",
          "arn:aws:logs:us-east-1:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/cwsyn-${local.canary_name}-*:*",
        ]
      },
    ]
  })
}

# ---------- canary 本体 ----------
resource "aws_synthetics_canary" "this" {
  name                 = local.canary_name
  artifact_s3_location = "s3://${aws_s3_bucket.artifacts.bucket}/"
  execution_role_arn   = aws_iam_role.canary.arn
  handler              = "syntheticCheck.handler"
  zip_file             = data.archive_file.canary.output_path
  runtime_version      = var.runtime_version
  start_canary         = true

  schedule {
    expression = var.schedule_expression
  }

  run_config {
    timeout_in_seconds = var.timeout_in_seconds

    environment_variables = {
      APP_FQDN = var.app_fqdn
    }
  }

  depends_on = [
    aws_iam_role_policy.canary,
    aws_s3_bucket_public_access_block.artifacts,
  ]
}

# ---------- 失敗アラーム ----------
# severity: Critical（docs/architecture/observability.md「アラームの severity と
# escalation 方針」参照）。CloudFront 経由の代表 read-only 経路が失敗する場合は
# ユーザー入口そのものが死んでいるシグナルのため。
# SuccessPercent は canary run ごとに 0 or 100 が記録される（1 回の失敗 = 0%）。
# 5 分間隔の canary に対し 2 期間（10 分）連続で 100 未満なら通知する
# （cloudfront-5xx-rate と同じ「2 期間継続」パターンを踏襲し、単発の一時的な
# ネットワーク瞬断による誤発火を避ける）。
resource "aws_cloudwatch_metric_alarm" "synthetic_check_failure" {
  alarm_name          = "${var.name}-synthetic-check-failure"
  alarm_description   = "[Critical] CloudFront 経由の外形監視（healthz / frontend HTML / API 代表 read endpoint）が失敗（2 期間連続。ユーザー入口そのものの到達性喪失を示す。Issue #256）"
  namespace           = "CloudWatchSynthetics"
  metric_name         = "SuccessPercent"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 100
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    CanaryName = aws_synthetics_canary.this.name
  }

  alarm_actions = var.alarm_actions
  ok_actions    = var.alarm_actions
}
