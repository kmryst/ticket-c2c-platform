# 0040. terraform が作る初期 task definition は push しないイメージタグを参照し、サービスの起動を deploy の update-service に任せる

## ステータス

Accepted

## 日付

2026-10-07

## 背景

terraform は ECS service（api / worker / frontend）と、その作成時の task definition を作る。
task definition のイメージは `${repository_url}:${var.image_tag}` で、`image_tag` の既定値は `latest` だった。CI の apply は `image_tag` を渡さない。
`ecs-service` モジュールの `ignore_changes = [task_definition]` は更新時にだけ効き、service 作成時の deployment は terraform の task definition で始まる。

`deploy-service.yml` は次の順に進んでいた。

1. `:latest` と commit SHA タグを push する
2. DB migration（`run_migrations=true` の時のみ）
3. search index migration（[ADR-0039](./0039-run-search-index-migration-and-verify-ecs-rollout-in-deploy.md)）
4. update-service（SHA タグの task definition）

ECR が空の間、初期 deployment の task は `CannotPullContainerError` を繰り返し、ECS service throttle logic で再試行の間隔が伸びる。
`:latest` が push されると、次の再試行でそのイメージが起動する。起動の時刻は再試行の間隔次第で、migration との前後関係は決まっていない。

2026-10-07 の staging で次のことを観測した（Issue #543）。時刻は UTC。

- run 37585863375：07:12:56 に `latest` を push した。worker の初期 task が 07:13:16 と 07:14:19 に `EventsIndexMissingError` で exit した。migration の適用は 07:13:35、index の作成は 07:15:04、update-service は 07:15:43 だった。api の初期 task は 07:14:06 に ALB の target に登録された（CloudTrail の RegisterTargets）。
- run 37580820336：api の初期 task の RegisterTargets（06:20:40）は、migration task の実行中（06:20:12〜06:21:37）だった。
- run 37576339877：frontend の初期 deployment が circuit breaker で FAILED（running 0）になったが、後続の deploy の update-service は成功した。

書き込みは起きていない（api は起動時にスキーマを操作せず、worker は index を確認してから SQS を消費する）。
ただし ALB のヘルスチェックは DB に触れない `/healthz` なので、migration 前の api がトラフィックを受け得る。

## 決定

1. dev / staging の `image_tag` の既定値を、どこからも push しない固定のタグ `pending-deploy` にする。variable の validation で他の値を拒否する。
   - terraform apply 直後の初期 deployment はイメージを pull できず（`CannotPullContainerError`）、deployment circuit breaker が FAILED にする。FAILED の deployment はそれ以上 task を起動しない。
   - アプリが起動するのは、deploy workflow が DB migration と search index migration の後に update-service したときだけになる。
2. `deploy-service.yml` は commit SHA タグだけを push する。`latest` は push しない。
   - `PENDING_DEPLOY_IMAGE_TAG`（`pending-deploy`）と `latest` は、build する場合も `image_tag` 入力（rollback）で指定された場合も拒否する。
   - `image_tag` 入力（過去の short SHA への rollback）は残す。
3. API サービスの現行 task definition を使う `run-db-migration.sh`（`db-migrate-<env>.yml` など）は、task definition のイメージが `pending-deploy` なら run-task の前に失敗し、先に backend deploy を実行するよう表示する。
4. destroy せずに使い続ける環境は、ECR に残っている `latest` タグを一度だけ削除する（[runbook](../runbooks/remove-ecr-latest-tag.md)）。

ADR-0039 への追記にはしない。ADR-0039 は「deploy の中で何をどの順に実行し、何を成功とするか」の判断で、この ADR は「terraform が作る初期 deployment で何を起動するか」の判断であり、1 ファイル 1 判断（[README](./README.md)）に従う。

## 根拠

- 初期 deployment を「起動できない」状態にするのが、migration より前にアプリを起動させない最も直接的な方法である。push 順序や再試行間隔に依存しない。
- FAILED の初期 deployment は後続の update-service を妨げない。update-service で新しい deployment が PRIMARY になり、task が 0 の初期 deployment は消える（run 37576339877 で観測）。`wait-ecs-rollout.sh` は今回の task definition の deployment と PRIMARY だけを見るので、ACTIVE 側に残る FAILED の初期 deployment を失敗とみなさない。このケースは `wait-ecs-rollout.spec.sh` に追加した（初期 deployment が FAILED → 今回の deployment が COMPLETED で exit 0、今回も FAILED なら exit 1）。
- `ecs-service` モジュールは `wait_for_steady_state = false` なので、初期 deployment が FAILED になっても terraform apply は待たずに終わる。
- deploy の「Register SHA-pinned task definitions」は service の現行 task definition の `containerDefinitions[0].image` だけを差し替えるので、初期 task definition が `pending-deploy` を参照していても、最初の deploy は今と同じ手順で動く。
- terraform test（mock provider）で、既定値で plan が通ること、`latest` と commit SHA が validation で拒否されることを確認する。`deploy-service-workflow.spec.sh` で workflow の step を AWS CLI / docker のスタブで実行し、`latest` と `pending-deploy` を push しないこと、migration または index 作成が失敗したら update-service を呼ばないことを確認する。いずれも PR の CI で実行する。

## 反対材料・トレードオフ

- **apply から最初の deploy までの間、ECS service のイベントに `CannotPullContainerError` が出て、初期 deployment は FAILED になる。** これは意図した状態だが、知らない人には障害に見える。docs（`staging-environment.md` / `dev-environment.md`）に書いた。circuit breaker が FAILED にした後は task を起動しないので、費用はかからない。
- **`image_tag` は実質的に定数になる。** variable のまま残すのは、`-var image_tag=...` を渡す古い手順や手作業を、黙って無視せずに validation のメッセージで deploy workflow へ案内するため。
- **terraform で task definition を変えたときに作られる新しい revision も `pending-deploy` を参照する。** service は `ignore_changes` で deploy の revision のままなので影響はない。family の最新 ACTIVE revision を直接使うもの（family ARN を target にした EventBridge Scheduler の task など）は起動できなくなる。refresh token cleanup の scheduled task がこれに当たるため、#542 で scheduled task を撤去した後にこの変更を入れる。
- **API サービスが一度も deploy されていない環境では、`db-migrate-<env>.yml` は失敗する。** 新しい環境の初回 migration は `deploy-backend-<env>.yml` の `run_migrations=true` で行う。以前も ECR が空の間は同じ理由で失敗していた。
- **`latest` を参照していた手作業（`latest` を指定した run-task、`image_tag=latest` の deploy）はできなくなる。** `latest` は可変で commit を特定できないため、使えなくすることを選んだ（production-readiness M-7 / M-13）。

不採用にした案:

- **初期 `desired_count=0` と `ignore_changes = [desired_count]`。** staging full では `aws_appautoscaling_target`（RegisterScalableTarget）が現在の desired count を min〜max の範囲に変更するため（[RegisterScalableTarget](https://docs.aws.amazon.com/autoscaling/application/APIReference/API_RegisterScalableTarget.html)）、apply の時点で min=2 まで起動する。避けるには autoscaling の登録を deploy の後に回す必要があり、desired count の正本も terraform の外（deploy workflow）に出る。
- **`:latest` の push を migration の後にずらすだけの案。** ECR に古い `latest` が残っている状態で service を作り直すと（destroy せずに service だけ replace する場合など）、apply の時点で古いイメージが起動する。初期 deployment を起動できない状態にしない限り、前後関係は保証されない。
- **deploy を `terraform apply -var image_tag=<SHA>` で行う案。** root module が 1 つ（[ADR-0003](./0003-terraform-state-and-environment-isolation.md)）なので、deploy のたびに環境全体の apply になる。state 分割の後に検討する（長期の別案。[ADR-0042](./0042-deploy-copies-terraform-registered-task-definition.md)）。

## 再検討のトリガー

- state を分割し（ADR-0042 の再検討のトリガー）、ECS service を deploy と同じ単位で terraform から更新できるようになったとき。
- 本番環境（prod）や、destroy せずに使い続ける環境を作るとき。初期 deployment の FAILED を監視・アラームがどう扱うかを決める。
- blue/green（CodeDeploy）など、ECS の deployment controller を変えるとき。初期 deployment と circuit breaker の扱いが変わる。
- ECS が、イメージを pull できない deployment の扱い（circuit breaker の判定や再試行）を変えたとき。
