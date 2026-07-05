data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

# OIDC provider はアカウントに 1 つしか作れない共有リソース。
# 別プロジェクトが作成済みのアカウントでは create_oidc_provider = false で既存を参照する。
resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = var.oidc_thumbprints
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 0 : 1

  url = "https://token.actions.githubusercontent.com"
}

locals {
  oidc_provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

data "aws_iam_policy_document" "plan_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
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
      identifiers = [local.oidc_provider_arn]
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

# ---------- apply ロールの最小権限ポリシー（production-readiness H-1） ----------
# AdministratorAccess を廃止し、bootstrap / dev / staging root module が管理するリソースと、
# 同ロールを共用する deploy-app / db-migrate / terraform-destroy workflow が使うアクションへ限定する。
# 方針:
# - read 系（Describe / Get / List 等）はサービス単位で Resource "*" に広めに許可する。
# - write 系はアクションを動詞プレフィックスで列挙し、名前パターンで ARN を絞れるサービス
#   （ECR / SQS / EventBridge / Logs / CloudWatch alarm / IAM / S3）はプロジェクトプレフィックスへ限定、
#   ARN 指定が実用的でない API が多いサービス（EC2 / ECS / ELB / RDS 等）は
#   aws:RequestedRegion 条件でリージョンへ限定する。
# - EC2 の write はインスタンス起動系（RunInstances 等）を含まない動詞のみ許可する。
# - IAM / tfstate S3 バケット / OIDC provider はリソース ARN で限定する。自己ロックアウト防止のため、
#   apply ロール自身・このポリシー自体・state バケットへの管理権限を必ず含める。
# - IAM をプレフィックスで限定しても、apply ロールが自身のポリシーを書き換えられる権限は
#   Terraform の自己管理上不可避。昇格経路のゲートは GitHub Environment protection が担う（Issue #65）。

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  managed_role_arn   = "arn:aws:iam::${local.account_id}:role/${var.managed_resource_name_prefix}*"
  managed_policy_arn = "arn:aws:iam::${local.account_id}:policy/${var.managed_resource_name_prefix}*"
}

# インフラ系サービス: dev / staging root module の管理リソース
# （VPC / ECS / ECR / ALB / Aurora / Valkey / OpenSearch / SQS / EventBridge /
#   CloudWatch / Logs / Application Auto Scaling / ACM / Route53 レコード）と、
# deploy-app（ECR push・ECS デプロイ）/ db-migrate（run-task・ログ取得）が使うアクション。
resource "aws_iam_policy" "apply_infra" {
  name        = "${var.apply_role_name}-infra"
  description = "Terraform apply / destroy / deploy が使うインフラ系サービスへの許可（read 広め・write 限定）"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # read 系はリソースを絞らず許可する（terraform refresh / destroy 後の残存リソース検査を含む）。
        # ecr:BatchGetImage / BatchCheckLayerAvailability は docker pull に必要な read 系アクション。
        # secretsmanager は Describe / List のみ（GetSecretValue は含めない。
        # 例外はプロジェクトプレフィックスのアプリ用シークレットに限定した ProjectAppSecrets 参照）。
        Sid    = "ReadInfraServices"
        Effect = "Allow"
        Action = [
          "acm:Describe*",
          "acm:Get*",
          "acm:List*",
          "application-autoscaling:Describe*",
          "application-autoscaling:List*",
          "cloudwatch:Describe*",
          "cloudwatch:Get*",
          "cloudwatch:List*",
          "ec2:Describe*",
          "ec2:Get*",
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:Describe*",
          "ecr:Get*",
          "ecr:List*",
          "ecs:Describe*",
          "ecs:List*",
          "elasticache:Describe*",
          "elasticache:List*",
          "elasticloadbalancing:Describe*",
          "es:Describe*",
          "es:Get*",
          "es:List*",
          "events:Describe*",
          "events:List*",
          "kms:Describe*",
          "kms:Get*",
          "kms:List*",
          "logs:Describe*",
          "logs:FilterLogEvents",
          "logs:Get*",
          "logs:List*",
          "rds:Describe*",
          "rds:List*",
          "route53:Get*",
          "route53:List*",
          "secretsmanager:Describe*",
          "secretsmanager:List*",
          "sqs:Get*",
          "sqs:List*",
          "sts:DecodeAuthorizationMessage",
          "tag:Get*",
        ]
        Resource = "*"
      },
      {
        # VPC / subnet / IGW / NAT / EIP / route table / SG / VPC endpoint の CRUD。
        # EC2 の write はリソース ARN 指定が実用的でないため、リージョン条件 + 動詞列挙で限定する
        # （インスタンス起動系 Run/Start/Import 等は含まない）。
        Sid    = "NetworkWrite"
        Effect = "Allow"
        Action = [
          "ec2:AllocateAddress",
          "ec2:Associate*",
          "ec2:Attach*",
          "ec2:Authorize*",
          "ec2:Create*",
          "ec2:Delete*",
          "ec2:Detach*",
          "ec2:Disassociate*",
          "ec2:Modify*",
          "ec2:Release*",
          "ec2:Replace*",
          "ec2:Revoke*",
        ]
        Resource = "*"
        Condition = {
          StringEquals = { "aws:RequestedRegion" = local.region }
        }
      },
      {
        # ECS / ALB / Aurora / Valkey / OpenSearch / Application Auto Scaling / ACM の CRUD と
        # deploy-app の RegisterTaskDefinition・UpdateService、db-migrate の RunTask。
        Sid    = "RegionalServiceWrite"
        Effect = "Allow"
        Action = [
          "acm:AddTagsToCertificate",
          "acm:DeleteCertificate",
          "acm:RemoveTagsFromCertificate",
          "acm:RenewCertificate",
          "acm:RequestCertificate",
          "acm:UpdateCertificateOptions",
          "application-autoscaling:Delete*",
          "application-autoscaling:Deregister*",
          "application-autoscaling:Put*",
          "application-autoscaling:Register*",
          "application-autoscaling:Tag*",
          "application-autoscaling:Untag*",
          "ecs:Create*",
          "ecs:Delete*",
          "ecs:Deregister*",
          "ecs:Register*",
          "ecs:RunTask",
          "ecs:StopTask",
          "ecs:Tag*",
          "ecs:Untag*",
          "ecs:Update*",
          "elasticache:Add*",
          "elasticache:Create*",
          "elasticache:Decrease*",
          "elasticache:Delete*",
          "elasticache:Increase*",
          "elasticache:Modify*",
          "elasticache:Remove*",
          "elasticloadbalancing:Add*",
          "elasticloadbalancing:Create*",
          "elasticloadbalancing:Delete*",
          "elasticloadbalancing:Deregister*",
          "elasticloadbalancing:Modify*",
          "elasticloadbalancing:Register*",
          "elasticloadbalancing:Remove*",
          "elasticloadbalancing:Set*",
          "es:Add*",
          "es:Create*",
          "es:Delete*",
          "es:Remove*",
          "es:Update*",
          "rds:Add*",
          "rds:Create*",
          "rds:Delete*",
          "rds:Modify*",
          "rds:Remove*",
        ]
        Resource = "*"
        Condition = {
          StringEquals = { "aws:RequestedRegion" = local.region }
        }
      },
      {
        # 名前パターンで ARN を絞れるサービスはプロジェクトプレフィックスへ限定する。
        # アクションと無関係な ARN の組はそのまま無効になるだけなので 1 ステートメントにまとめる。
        Sid    = "PrefixedResourceWrite"
        Effect = "Allow"
        Action = [
          "cloudwatch:DeleteAlarms",
          "cloudwatch:PutMetricAlarm",
          "cloudwatch:TagResource",
          "cloudwatch:UntagResource",
          "ecr:BatchDeleteImage",
          "ecr:CompleteLayerUpload",
          "ecr:Create*",
          "ecr:Delete*",
          "ecr:InitiateLayerUpload",
          "ecr:Put*",
          "ecr:Set*",
          "ecr:Tag*",
          "ecr:Untag*",
          "ecr:UploadLayerPart",
          "events:Create*",
          "events:Delete*",
          "events:Put*",
          "events:Remove*",
          "events:Tag*",
          "events:Untag*",
          "logs:Create*",
          "logs:Delete*",
          "logs:Put*",
          "logs:Tag*",
          "logs:Untag*",
          "sqs:Add*",
          "sqs:Create*",
          "sqs:Delete*",
          "sqs:Remove*",
          "sqs:Set*",
          "sqs:Tag*",
          "sqs:Untag*",
        ]
        Resource = [
          "arn:aws:cloudwatch:${local.region}:${local.account_id}:alarm:${var.managed_resource_name_prefix}*",
          "arn:aws:ecr:${local.region}:${local.account_id}:repository/${var.managed_resource_name_prefix}*",
          "arn:aws:events:${local.region}:${local.account_id}:event-bus/${var.managed_resource_name_prefix}*",
          "arn:aws:events:${local.region}:${local.account_id}:rule/${var.managed_resource_name_prefix}*",
          "arn:aws:logs:${local.region}:${local.account_id}:log-group:/ecs/${var.managed_resource_name_prefix}*",
          "arn:aws:sqs:${local.region}:${local.account_id}:${var.managed_resource_name_prefix}*",
        ]
      },
      {
        # ECR ログイン（docker login）。GetAuthorizationToken はリソース指定不可。
        Sid      = "EcrAuthToken"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        # Route53 はグローバルサービス。write は ACM 検証レコードと ALB alias レコードの
        # 変更に使う ChangeResourceRecordSets のみ許可する（zone ID は data source 参照のため ARN 固定不可）。
        Sid      = "Route53RecordWrite"
        Effect   = "Allow"
        Action   = "route53:ChangeResourceRecordSets"
        Resource = "*"
      },
      {
        # Aurora の manage_master_user_password（RDS 管理マスターシークレット）が
        # DB クラスタ作成時に自動生成するシークレットの CRUD。
        # AWS 公式ドキュメント（Aurora User Guide「Permissions required for Secrets Manager
        # integration」）が明記する create/modify/restore 時の必須権限は
        # kms:DescribeKey（ReadInfraServices の kms:Describe* で充足済み）、
        # secretsmanager:CreateSecret、secretsmanager:TagResource の 3 つ
        # （カスタム KMS キーを指定していないため kms:Decrypt 等は不要）。
        # RDS が自動生成するシークレット名は "rds!cluster-<id>" 固定プレフィックスのため、
        # そのパターンへ限定できる。DB クラスタ削除時のシークレット削除は RDS が
        # 自身の権限で行うため、このロールに secretsmanager:DeleteSecret は不要。
        Sid    = "RdsManagedSecret"
        Effect = "Allow"
        Action = [
          "secretsmanager:CreateSecret",
          "secretsmanager:TagResource",
        ]
        Resource = "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:rds!*"
      },
      {
        # dev / staging root module が Terraform で管理するアプリ用シークレット
        # （JWT 署名シークレット等。ADR-0010 / Issue #134）の CRUD。
        # H-1 の方針どおり、write はプロジェクトプレフィックス（ticket-c2c-）の ARN へ限定する。
        # GetSecretValue はシークレット version リソースの refresh（値の読み戻し）に必須のため
        # ここへ含めるが、対象はこのプレフィックスのみで、RDS 管理マスターシークレット（rds!*）へは
        # 引き続き許可しない。
        Sid    = "ProjectAppSecrets"
        Effect = "Allow"
        Action = [
          "secretsmanager:CreateSecret",
          "secretsmanager:DeleteSecret",
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue",
          "secretsmanager:TagResource",
          "secretsmanager:UntagResource",
          "secretsmanager:UpdateSecret",
        ]
        Resource = "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:${var.managed_resource_name_prefix}*"
      },
    ]
  })
}

# tfstate バケットと IAM: bootstrap root module の管理リソースと Terraform backend 操作。
resource "aws_iam_policy" "apply_state_iam" {
  name        = "${var.apply_role_name}-state-iam"
  description = "tfstate バケットとプロジェクト IAM リソースへの許可（リソース ARN 限定）"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # backend の state / lock オブジェクト操作（use_lockfile = true）と、bootstrap が管理する
        # バケット設定（versioning / SSE / public access block）の write。read は ReadStateBucket 参照。
        # バケット削除系は含めない（bootstrap root は prevent_destroy で保護しており destroy しない）。
        Sid    = "StateBucketWrite"
        Effect = "Allow"
        Action = [
          "s3:CreateBucket",
          "s3:DeleteObject",
          "s3:PutBucketPublicAccessBlock",
          "s3:PutBucketTagging",
          "s3:PutBucketVersioning",
          "s3:PutEncryptionConfiguration",
          "s3:PutObject",
        ]
        Resource = [var.state_bucket_arn, "${var.state_bucket_arn}/*"]
      },
      {
        # terraform init（backend 検証）と state / バケット設定の refresh。
        Sid      = "ReadStateBucket"
        Effect   = "Allow"
        Action   = ["s3:Get*", "s3:List*"]
        Resource = [var.state_bucket_arn, "${var.state_bucket_arn}/*"]
      },
      {
        # IAM の read は Terraform refresh に必要（Resource "*" で広めに許可）。
        Sid      = "ReadIam"
        Effect   = "Allow"
        Action   = ["iam:Get*", "iam:List*"]
        Resource = "*"
      },
      {
        # write はプロジェクトプレフィックスのロールのみ（gha-plan / gha-apply 自身 /
        # staging-state-readonly / 各環境の ECS execution・task ロール）。
        Sid    = "ProjectIamRoleWrite"
        Effect = "Allow"
        Action = [
          "iam:AttachRolePolicy",
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:DeleteRolePolicy",
          "iam:DetachRolePolicy",
          "iam:PutRolePolicy",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:UpdateAssumeRolePolicy",
          "iam:UpdateRole",
          "iam:UpdateRoleDescription",
        ]
        Resource = local.managed_role_arn
      },
      {
        # このポリシー自身を含む、プロジェクトプレフィックスの customer managed policy の write
        # （自己ロックアウト防止の核心。次回以降の apply がこのポリシー自体を更新できる必要がある）。
        Sid    = "ProjectIamPolicyWrite"
        Effect = "Allow"
        Action = [
          "iam:CreatePolicy",
          "iam:CreatePolicyVersion",
          "iam:DeletePolicy",
          "iam:DeletePolicyVersion",
          "iam:TagPolicy",
          "iam:UntagPolicy",
        ]
        Resource = local.managed_policy_arn
      },
      {
        # ECS タスク定義への execution / task ロールの受け渡しのみ許可する。
        Sid      = "PassRolesToEcsTasks"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = local.managed_role_arn
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      },
      {
        # OIDC provider は現状 data source 参照（create_oidc_provider = false）だが、
        # create_oidc_provider = true のアカウントでも自己管理できるよう write を許可する。
        Sid    = "GithubOidcProviderWrite"
        Effect = "Allow"
        Action = [
          "iam:CreateOpenIDConnectProvider",
          "iam:DeleteOpenIDConnectProvider",
          "iam:TagOpenIDConnectProvider",
          "iam:UntagOpenIDConnectProvider",
          "iam:UpdateOpenIDConnectProviderThumbprint",
        ]
        Resource = "arn:aws:iam::${local.account_id}:oidc-provider/token.actions.githubusercontent.com"
      },
      {
        # ECS / ELB / RDS / ElastiCache / OpenSearch / Application Auto Scaling の
        # service-linked role 初回作成（destroy 後の再構築で必要になり得る）。
        Sid      = "ServiceLinkedRoles"
        Effect   = "Allow"
        Action   = "iam:CreateServiceLinkedRole"
        Resource = "arn:aws:iam::${local.account_id}:role/aws-service-role/*"
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "apply_infra" {
  role       = aws_iam_role.apply.name
  policy_arn = aws_iam_policy.apply_infra.arn
}

resource "aws_iam_role_policy_attachment" "apply_state_iam" {
  role       = aws_iam_role.apply.name
  policy_arn = aws_iam_policy.apply_state_iam.arn
}

# plan ロールは ReadOnlyAccess に加えて state ロックファイルの読み取りが必要。
# ReadOnlyAccess に s3:GetObject が含まれるため追加ポリシーは不要。
