data "aws_caller_identity" "current" {}

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = var.oidc_thumbprints
}

data "aws_iam_policy_document" "plan_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:*"]
    }
  }
}

data "aws_iam_policy_document" "apply_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        for env in var.apply_environments :
        "repo:${var.github_repository}:environment:${env}"
      ]
    }
  }
}

resource "aws_iam_role" "plan" {
  name                 = var.plan_role_name
  assume_role_policy   = data.aws_iam_policy_document.plan_assume.json
  max_session_duration = 3600
}

resource "aws_iam_role" "apply" {
  name                 = var.apply_role_name
  assume_role_policy   = data.aws_iam_policy_document.apply_assume.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "plan_readonly" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# dev 構築期間中は AdministratorAccess を許容する。
# staging 追加前に最小権限ポリシーへ絞る（ADR-0003 再検討トリガー参照）。
resource "aws_iam_role_policy_attachment" "apply_admin" {
  role       = aws_iam_role.apply.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

# plan ロールは ReadOnlyAccess に加えて state ロックファイルの読み取りが必要。
# ReadOnlyAccess に s3:GetObject が含まれるため追加ポリシーは不要。
