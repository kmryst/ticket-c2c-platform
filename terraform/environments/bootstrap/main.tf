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

  # apply ロールの最小権限ポリシーの対象（production-readiness H-1）。
  # write を許可するリソース名プレフィックスは、bootstrap（ticket-c2c-platform-*）と
  # dev / staging（ticket-c2c-dev-* / ticket-c2c-staging-*）を共通に覆う "ticket-c2c-" とする。
  state_bucket_arn             = aws_s3_bucket.tfstate.arn
  managed_resource_name_prefix = "ticket-c2c-"

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

# smoke test が状態を確認する外形監視（CloudWatch Synthetics canary）の ARN（Issue #546 / ADR-0043）。
# canary は us-east-1 に作る（terraform/modules/synthetics-canary）。名前は "<環境の var.name>-synthetic-check"
# （dev: ticket-c2c-dev、staging: ticket-c2c-staging）。どちらかを変えるときはここも同じ PR で変える。
data "aws_caller_identity" "current" {}

locals {
  dev_synthetic_check_canary_arn     = "arn:aws:synthetics:us-east-1:${data.aws_caller_identity.current.account_id}:canary:ticket-c2c-dev-synthetic-check"
  staging_synthetic_check_canary_arn = "arn:aws:synthetics:us-east-1:${data.aws_caller_identity.current.account_id}:canary:ticket-c2c-staging-synthetic-check"
}

# ---------- staging smoke test 用の state 読み取り専用ロール ----------
# staging-smoke-test.yml は apply ロールを流用せず、staging state file の読み取りに限定した
# このロールで `terraform output` を取得する（staging-environment.md）。以降の HTTP 検証は
# AWS credential を使わない。外形監視の状態確認（synthetics:GetCanary）だけは AWS API を読む（Issue #546）。
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
      },
      {
        # staging-smoke-test.yml が外形監視（CloudWatch Synthetics canary）の状態（RUNNING）を確認する
        # （Issue #546 / ADR-0043）。GetCanary は canary の ARN でリソースを絞れる（Service Authorization Reference）。
        Effect   = "Allow"
        Action   = ["synthetics:GetCanary"]
        Resource = [local.staging_synthetic_check_canary_arn]
      }
    ]
  })
}

# ---------- dev smoke test 用の state 読み取り専用ロール ----------
# dev-smoke-test.yml は apply ロールを流用せず、dev state file の読み取りに限定した
# このロールで `terraform output` を取得する（dev-environment.md、staging 版の設計を踏襲。Issue #192）。
# 以降の HTTP 検証は AWS credential を使わない。外形監視の状態確認（synthetics:GetCanary）だけは AWS API を読む（Issue #546）。
data "aws_iam_policy_document" "dev_state_readonly_assume" {
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
      values   = ["repo:${var.github_repository}:environment:dev-readonly"]
    }
  }
}

resource "aws_iam_role" "dev_state_readonly" {
  name                 = "${var.project}-gha-dev-state-readonly"
  assume_role_policy   = data.aws_iam_policy_document.dev_state_readonly_assume.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "dev_state_readonly" {
  name = "read-dev-tfstate"
  role = aws_iam_role.dev_state_readonly.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # terraform init（backend 検証）に必要。バケット一覧はオブジェクト名のみで
        # 状態の中身は含まないため、prefix 条件は付けず GetObject 側で dev に限定する。
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [aws_s3_bucket.tfstate.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = ["${aws_s3_bucket.tfstate.arn}/dev/*"]
      },
      {
        # dev-smoke-test.yml が外形監視（CloudWatch Synthetics canary）の状態（RUNNING）を確認する
        # （Issue #546 / ADR-0043）。GetCanary は canary の ARN でリソースを絞れる（Service Authorization Reference）。
        Effect   = "Allow"
        Action   = ["synthetics:GetCanary"]
        Resource = [local.dev_synthetic_check_canary_arn]
      }
    ]
  })
}
