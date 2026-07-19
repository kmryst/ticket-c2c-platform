# Runbook: JWT 署名シークレットのローテーション

対象: dev / staging の API（ECS Fargate）。ADR-0012 / Issue #168。

## 前提知識

- Secrets Manager の `<env名>-jwt-secret` は `{"current": "...", "previous": "..."}` の JSON。
- **署名（発行）は常に `current` のみ**。検証は `current` → `previous` の順でフォールバックする（`JwtAuthGuard`）。
- ECS タスクはシークレットを**起動時に静的注入**する（`JWT_SECRET` 環境変数）。値の変更はタスクの再起動（新デプロイ / force-new-deployment）まで反映されない。
- Terraform はこの secret_version に `lifecycle.ignore_changes = [secret_string]` を設定済みのため、本手順の手動更新が後続の `terraform apply` で巻き戻されることはない。

## ローテーション手順

この手順は Secrets Manager と ECS サービスを変更する。対象環境、現在の ECS task definition、ローテーション開始時刻を記録し、実行承認を得てから開始する。シークレット値を標準出力、shell trace、チケット、チャットへ出さない。

以下を同じ shell session で実行する。`<env>` は `dev` または `staging` へ置き換える。named profile を使う場合は、開始前に `AWS_PROFILE` も設定する。

```bash
export AWS_REGION=ap-northeast-1
SECRET_ID="ticket-c2c-<env>-jwt-secret"
CLUSTER="ticket-c2c-<env>"
SERVICE="ticket-c2c-<env>-api"

aws sts get-caller-identity --query Account --output text
set +x
umask 077
SECRET_FILE="$(mktemp)"
trap 'rm -f "$SECRET_FILE"' EXIT
```

`get-caller-identity` の結果が対象アカウントであることを確認してから次へ進む。以降は `set -x` を有効にしない。

### 1. 更新 payload の安全な作成

現在の `current` を `previous` へ移し、新しい `current` を生成する。値は権限 `0600` の一時ファイルにだけ保存し、画面へ出力しない。

```bash
aws secretsmanager get-secret-value --secret-id "$SECRET_ID" \
  --query SecretString --output text \
  | python3 -c 'import json,secrets,sys; old=json.load(sys.stdin); print(json.dumps({"current":secrets.token_urlsafe(48),"previous":old["current"]}))' \
  > "$SECRET_FILE"
chmod 600 "$SECRET_FILE"
python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["current"] and d["previous"] and d["current"] != d["previous"]' \
  < "$SECRET_FILE"
```

### 2. 「新 current + 旧 previous」への切替

現 `current` を `previous` へ退避し、`current` を新値にする。

```bash
aws secretsmanager put-secret-value --secret-id "$SECRET_ID" \
  --secret-string "file://$SECRET_FILE" \
  --query VersionId --output text
```

出力されるのは secret value ではなく Version ID のみ。値そのものを確認する目的で `get-secret-value --query SecretString` を単独実行しない。

### 3. API タスクの再起動（新シークレットの反映）

```bash
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
  --force-new-deployment --query 'service.serviceArn' --output text
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
```

この時点での状態:

- 新タスクは新 `current` で署名を開始する。
- 旧 `current`（= 新 `previous`）で署名済みの発行済みアクセストークンは、フォールバック検証により**引き続き有効**（各トークンの exp まで）。
- ローリング中の旧タスク（旧 `current` で署名）が発行するトークンも、新タスクでは `previous` として検証できる。

新タスクが安定しない場合は `previous` を `current` へ戻して旧鍵へ rollback し、API を再デプロイする。

```bash
python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"current":d["previous"],"previous":""}))' \
  < "$SECRET_FILE" > "${SECRET_FILE}.rollback"
mv "${SECRET_FILE}.rollback" "$SECRET_FILE"
chmod 600 "$SECRET_FILE"
aws secretsmanager put-secret-value --secret-id "$SECRET_ID" \
  --secret-string "file://$SECRET_FILE" --query VersionId --output text
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
  --force-new-deployment --query 'service.serviceArn' --output text
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
```

rollback した場合はここで中止し、原因を調査する。正常に安定した場合だけ次へ進む。

### 4. previous の破棄（ローテーション完了）

**`previous` を外してよいのは、手順 3 の完了（全タスクが新シークレットで稼働）から最大アクセストークン TTL（15 分）が経過した後。**
それより早く外すと、旧シークレットで署名された有効期限内のトークンが強制失効する（全ユーザー強制ログアウト相当）。

```bash
aws secretsmanager get-secret-value --secret-id "$SECRET_ID" \
  --query SecretString --output text \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"current":d["current"],"previous":""}))' \
  > "$SECRET_FILE"
chmod 600 "$SECRET_FILE"
aws secretsmanager put-secret-value --secret-id "$SECRET_ID" \
  --secret-string "file://$SECRET_FILE" --query VersionId --output text
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
  --force-new-deployment --query 'service.serviceArn' --output text
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
rm -f "$SECRET_FILE"
trap - EXIT
```

（`previous` を残したままでも安全性は「鍵 2 本が有効」という点を除き変わらないため、緊急でなければ次回ローテーション時にまとめて上書きしてもよい。）

## 漏洩時の緊急ローテーション

シークレット漏洩が疑われる場合は、手順 1 の payload 作成時から **`previous` に旧値を入れず**（`previous: ""`）、直ちに手順 2・3 を実行する。新 payload は次のコマンドで作る。

```bash
python3 -c 'import json,secrets; print(json.dumps({"current":secrets.token_urlsafe(48),"previous":""}))' \
  > "$SECRET_FILE"
chmod 600 "$SECRET_FILE"
```

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
