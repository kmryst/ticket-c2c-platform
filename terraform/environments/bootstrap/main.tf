resource "aws_s3_bucket" "tfstate" {
  bucket = var.state_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

module "github_oidc" {
  source = "../../modules/iam-github-oidc"

  github_repository = var.github_repository
  plan_role_name    = "${var.project}-gha-plan"
  apply_role_name   = "${var.project}-gha-apply"

  # apply ロールを引き受けられる GitHub Environment（staging-environment.md「Environment protection」）。
  # bootstrap は terraform-apply-bootstrap.yml が bootstrap root を自己更新するために追加する。
  apply_environments = [
    "bootstrap",
    "dev",
    "dev-destroy",
    "staging",
    "staging-destroy",
  ]

  # このアカウントには別プロジェクト作成の OIDC provider が既に存在するため参照のみ
  create_oidc_provider = false
}

# ---------- staging smoke test 用の state 読み取り専用ロール ----------
# staging-smoke-test.yml は apply ロールを流用せず、staging state file の読み取りに限定した
# このロールで `terraform output` を取得する（staging-environment.md）。以降の HTTP 検証は
# AWS credential を使わない。
data "aws_iam_policy_document" "staging_state_readonly_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [module.github_oidc.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:staging-readonly"]
    }
  }
}

resource "aws_iam_role" "staging_state_readonly" {
  name                 = "${var.project}-gha-staging-state-readonly"
  assume_role_policy   = data.aws_iam_policy_document.staging_state_readonly_assume.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "staging_state_readonly" {
  name = "read-staging-tfstate"
  role = aws_iam_role.staging_state_readonly.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # terraform init（backend 検証）に必要。バケット一覧はオブジェクト名のみで
        # 状態の中身は含まないため、prefix 条件は付けず GetObject 側で staging に限定する。
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [aws_s3_bucket.tfstate.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = ["${aws_s3_bucket.tfstate.arn}/staging/*"]
      }
    ]
  })
}
