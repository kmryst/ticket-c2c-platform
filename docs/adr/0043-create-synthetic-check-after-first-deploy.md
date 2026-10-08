# 0043. 外形監視（CloudWatch Synthetics canary）は最初の deploy の後、2 回目の terraform apply で作る

## ステータス

Accepted

## 日付

2026-10-08

## 背景

dev / staging の外形監視（CloudWatch Synthetics canary、Issue #256）は、`terraform apply` で作られた時点で開始する（`terraform/modules/synthetics-canary/main.tf` の `start_canary = true`、5 分間隔）。
canary は CloudFront 経由で `/api/healthz`、`/`、`/api/events` を順に GET し、2xx 以外を失敗とする。

apply 直後のタスク定義は push しないイメージタグ `pending-deploy` を参照し、api / worker / frontend は最初の deploy の update-service まで起動しない（[ADR-0040](./0040-initial-task-definition-uses-unpushed-image-tag.md)）。
その間、ALB に target が無いので canary は ALB 503 を受け、`SuccessPercent=0` を記録する。
`synthetic-check-failure` は `SuccessPercent < 100` が 2 期間（10 分）続くと ALARM になる。0 という実データが出るので `treat_missing_data = "notBreaching"` は効かない。

2026-10-07 の staging で、apply から deploy の完了までに `synthetic-check-failure`（Critical）の ALARM と通知を 3 回観測した（Issue #546。04:57、06:08、07:00 UTC）。
staging を作るたびに意味のない Critical 通知が出て、本物の障害通知と区別しにくくなる（アラート疲れ）。

制約は次のとおり。

- apply / deploy / smoke / destroy は個別の workflow として実行し、どこで失敗したかを追いやすくする（`docs/architecture/staging-environment.md`「GitHub Actions」）。
- [ADR-0033](./0033-ticket-type-migration-irreversible-boundaries.md) §6 は、fresh 構築では canary を第1段の apply で作らず、第2段の apply でのみ作ると決めている（具体的な方式は #445 で決める）。
- dev の `module "synthetic_check"` には `count` が無い。staging は `count = local.https_enabled ? 1 : 0` が付いている。

## 決定

1. dev / staging に変数 `enable_synthetic_check`（bool、既定 `false`）を追加し、`module "synthetic_check"` の `count` をこの変数で決める（staging は `local.https_enabled && var.enable_synthetic_check`）。
   - 最初の apply では外形監視を作らない。apply → deploy-backend → deploy-frontend の後、`terraform-apply-<env>.yml` を入力 `enable_synthetic_check=true` で実行して作る。
   - モジュールの `start_canary = true` は変えない。作られる時点で deploy が終わっているため。
2. dev は `count` を付けると state のアドレスが `module.synthetic_check` から `module.synthetic_check[0]` に変わるので、`moved` ブロックで移す。staging は以前から `count` があり、アドレスは変わらない。
3. `terraform-apply-<env>.yml` は plan の後、`terraform show -json` の結果を `scripts/deployment/check-synthetic-check-plan.sh` で検査する。`module.synthetic_check` 配下のリソースの `change.actions` に `delete` があれば（replace の `["delete","create"]` / `["create","delete"]` を含む）、入力の値に関係なく apply の前に失敗する。上書き用の入力は置かない。外形監視を外す手段は `terraform-destroy-<env>.yml` での環境ごとの削除だけとする。
4. apply / deploy / smoke は 1 本の workflow にまとめない。代わりに `<env>-smoke-test.yml` が、外形監視が state にあり（output `synthetic_check_canary_name`）、`synthetics:GetCanary` で `Status.State == RUNNING` であることを確認し、満たさなければ失敗する。staging は https-dns のときだけ確認する。
   - smoke test の読み取り専用ロール（bootstrap の `<project>-gha-{dev,staging}-state-readonly`）に、各環境の canary 1 つの ARN に絞った `synthetics:GetCanary` を追加する。GetCanary は resource type `canary`（`arn:${Partition}:synthetics:${Region}:${Account}:canary:${CanaryName}`）で絞れる（[Service Authorization Reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_synthetics.html)）。
   - HTTP 検証の step には、これまでどおり AWS credential を渡さない。
5. apply 直後の `cloudfront-5xx-rate` の発火は、この ADR の範囲に入れない（Issue #550）。評価条件 `IF(m1>=10, m2, 0)` のため canary の GET（1 run あたり最大 3 件）だけでは発火に届かないと考えられ、発火源が未特定のため。

## 根拠

- 外形監視を「deploy が終わるまで存在しない」状態にするのが、apply 直後の失敗 run と通知を止める最も直接的な方法である。通知だけを止める案と違い、意味のない失敗 run も記録されない。
- 既定値 `false` は安全側である。初回の apply とローカルの apply では作られない。
- ADR-0033 §6 の「第1段では canary を作成せず、第2段でのみ作成」のうち canary の部分を、そのまま表せる。#445 で phase の変数を入れるときは、`enable_synthetic_check` をその変数から導くか置き換えればよい。
- 削除検査を入力の値に関係なく fail closed にしたのは、次の事故を同じ仕組みで止めるためである。
  - 作成済みの環境を `false` のまま apply して、外形監視が消える。
  - `moved` の書き忘れなどで state のアドレスが変わり、canary・IAM ロール・S3 バケット（`force_destroy = true`）が delete と create になる。入力が `true` でも canary は一度消え、アーティファクトも失われる。
  - `moved` で移ったリソースは `previous_address` 付きの `no-op` / `update` になり、`delete` を含まないので止まらない。
- dev / staging は平常時 destroy 済みで、空の state からの apply では delete が出ない。検査が止めるのは「環境が生きている間の apply」だけになる。
- Terraform 1.14.8 の `terraform_data` で最小構成を作り、次を確認した（AWS 不要）。
  - `count` なしで作った state に `count` と `moved` を付けた構成を `true` で plan すると、`has moved to` の 2 件だけで `0 to add, 0 to change, 0 to destroy`（検査 exit 0）。
  - `moved` なしでは `2 to add, 0 to change, 2 to destroy`（検査 exit 1）。
  - `moved` ありで `false` にすると `[0]` の 2 件が delete（検査 exit 1）。
  - `[0]` の state に対し、`count` を外して逆向きの `moved` を付けると `0 to destroy`。`moved` なしの revert では `2 to add, 2 to destroy`。
  - 作成済みの canary の replace（`["delete","create"]`）は、入力が `true` でも検査 exit 1。
- `terraform test`（mock provider）で、既定値では作らないこと、`true` なら作ること、staging の `alb-http-only` では `true` でも作らないことを確認する。検査スクリプトは `check-synthetic-check-plan.spec.sh` の fixture（delete / replace 2 種 / アドレス変更 / moved の no-op / create のみ / 範囲外 / 似た名前のモジュール / 空の plan / 不正な入力）で確認する。いずれも PR の CI で実行する。

### 採らなかった案

- **`start_canary = false` で作り、deploy の後に workflow から `StartCanary` を呼ぶ。** provider の Read は `start_canary` を API の状態から読み込まず、canary の他の属性が変わる apply では停止したまま戻らないことがある（実装計画時に provider v6.67.0 の `internal/service/synthetics/canary.go` を読んで確認）。ADR-0033 §6 の「作成しない」ともずれる。
- **`actions_enabled` で通知だけを止め、最初の deploy の後に有効にする。** canary は失敗 run を記録し続け、アラームも ALARM になる。有効にする手順を別に持つ必要がある。
- **docs に「apply 直後の ALARM は想定内」と書くだけにする。** Critical 通知が残り、アラート疲れが解消しない。
- **apply → deploy → apply を 1 本の workflow にまとめる。** `staging-environment.md` の「個別の workflow として実行し、どこで失敗したかを追いやすくする」判断と衝突する。
- **state に canary があれば workflow が自動で `true` を渡す。** 入力を忘れても事故にはならないが、入力と実際の動作が食い違う暗黙の動作が増える。
- **smoke test では terraform output だけで canary の有無を見る（IAM を変えない）。** `RUNNING` かどうかは確認できない。

## 反対材料・トレードオフ

- **apply が 1 回増える。** 手順書（`dev-environment.md` / `staging-environment.md` / runbook）に 2 回目の apply を書いた。
- **2 回目の apply を最初から `true` で実行すると、今回の ALARM 通知が再発する。** 防ぐ仕組みは無く、手順で防ぐ。
- **smoke test を 2 回目の apply より前に流すと失敗する。** 意図した動作で、2 回目の apply を忘れたことを検知するためのもの。
- **ローカルの `terraform apply` は削除検査を通らない。** 外形監視を作った環境では `-var enable_synthetic_check=true` を付けると docs に書いた。
- **smoke test のロールが AWS API を 1 つ読むようになる。** 読み取り専用で、各環境の canary 1 つに絞った。bootstrap の変更なので、マージ後に `terraform-apply-bootstrap.yml`（required reviewer あり）の実行が必要で、それより前に smoke test を流すと AccessDenied で失敗する。
- **bootstrap は canary 名（`ticket-c2c-{dev,staging}-synthetic-check`）を固定で持つ。** 環境の `var.name` か canary の命名を変えるときは、bootstrap も同じ PR で変える。
- **単純な revert では戻せない。** revert すると dev の module が `count` なしに戻り、state 上の `module.synthetic_check[0]` との間で逆向きの delete と create が起きる。ロールバックの PR では dev に逆向きの `moved`（`from = module.synthetic_check[0]`、`to = module.synthetic_check`）を入れる。revert で削除検査も消えるので、ロールバックの apply は止まらない。staging は revert 後も `count`（`local.https_enabled`）が残るので `moved` は要らない。bootstrap の `synthetics:GetCanary` は revert 後に bootstrap apply で外す。dev / staging が destroy 済みなら state が空なので、環境側の戻し作業は要らない。

## 再検討のトリガー

- #445 で fresh 構築の phase 変数を入れるとき（`enable_synthetic_check` をその変数から導くか置き換える。smoke test の canary 確認と activation 順序の関係も決める）。
- prod 環境を作るとき（常設環境で apply の頻度が上がり、削除検査や 2 回目の apply の運用負荷が変わる）。
- apply から smoke test までを自動で連鎖させる workflow を作るとき（2 回目の apply を手順ではなく workflow で保証できる）。
- Issue #550 の結果、`cloudfront-5xx-rate` も「最初の deploy の後に有効にする」形に揃えるとき。
