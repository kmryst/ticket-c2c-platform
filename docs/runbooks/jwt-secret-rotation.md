# Runbook: JWT 署名シークレットのローテーション

対象: dev / staging の API（ECS Fargate）。ADR-0012 / Issue #168。

## 前提知識

- Secrets Manager の `<env名>-jwt-secret` は `{"current": "...", "previous": "..."}` の JSON。
- **署名（発行）は常に `current` のみ**。検証は `current` → `previous` の順でフォールバックする（`JwtAuthGuard`）。
- ECS タスクはシークレットを**起動時に静的注入**する（`JWT_SECRET` 環境変数）。値の変更はタスクの再起動（新デプロイ / force-new-deployment）まで反映されない。
- Terraform はこの secret_version に `lifecycle.ignore_changes = [secret_string]` を設定済みのため、本手順の手動更新が後続の `terraform apply` で巻き戻されることはない。

## ローテーション手順

以下、`<NAME>` は環境のシークレット名（例: `ticket-c2c-dev-jwt-secret`）。

### 1. 現在値の取得と新シークレットの生成

```bash
CURRENT=$(aws secretsmanager get-secret-value --secret-id <NAME> \
  --query SecretString --output text | python3 -c 'import sys,json;print(json.load(sys.stdin)["current"])')
NEW=$(python3 -c 'import secrets,string;print("".join(secrets.choice(string.ascii_letters+string.digits) for _ in range(64)))')
```

### 2. 「新 current + 旧 previous」への切替

現 `current` を `previous` へ退避し、`current` を新値にする。

```bash
aws secretsmanager put-secret-value --secret-id <NAME> \
  --secret-string "$(python3 -c "import json;print(json.dumps({'current':'$NEW','previous':'$CURRENT'}))")"
```

### 3. API タスクの再起動（新シークレットの反映）

```bash
aws ecs update-service --cluster <cluster> --service <api-service> --force-new-deployment
aws ecs wait services-stable --cluster <cluster> --services <api-service>
```

この時点での状態:

- 新タスクは新 `current` で署名を開始する。
- 旧 `current`（= 新 `previous`）で署名済みの発行済みアクセストークンは、フォールバック検証により**引き続き有効**（各トークンの exp まで）。
- ローリング中の旧タスク（旧 `current` で署名）が発行するトークンも、新タスクでは `previous` として検証できる。

### 4. previous の破棄（ローテーション完了）

**`previous` を外してよいのは、手順 3 の完了（全タスクが新シークレットで稼働）から最大アクセストークン TTL（15 分）が経過した後。**
それより早く外すと、旧シークレットで署名された有効期限内のトークンが強制失効する（全ユーザー強制ログアウト相当）。

```bash
aws secretsmanager put-secret-value --secret-id <NAME> \
  --secret-string "$(python3 -c "import json;print(json.dumps({'current':'$NEW','previous':''}))")"
aws ecs update-service --cluster <cluster> --service <api-service> --force-new-deployment
```

（`previous` を残したままでも安全性は「鍵 2 本が有効」という点を除き変わらないため、緊急でなければ次回ローテーション時にまとめて上書きしてもよい。）

## 漏洩時の緊急ローテーション

シークレット漏洩が疑われる場合は、手順 2 で **`previous` に旧値を入れず**（`previous: ""`）、直ちに手順 3 を実行する。
発行済みの全アクセストークンが即時無効になる（全ユーザー再ログイン）が、漏洩鍵での署名を止めることを優先する。
リフレッシュトークンは opaque + DB hash 保存（ADR-0012）のため JWT シークレットの影響を受けず、silent refresh により再ログインは自動化される（アクセストークンのみの失効なら refresh で回復する）。

## 検証方法

1. ローテーション前に取得したアクセストークンで `GET /auth/me` → 200（previous フォールバックが効いている）。
2. 新規ログインで取得したトークンで `GET /auth/me` → 200（current 署名）。
3. previous 破棄 + 再起動後、旧トークンで `GET /auth/me` → 401、新トークン → 200。

## 関連

- ADR-0012（設計判断）
- `src/config.ts` `getJwtSecrets()` / `src/auth/jwt-auth.guard.ts`（実装）
- `terraform/environments/{dev,staging}/main.tf` の `aws_secretsmanager_secret_version.jwt`
