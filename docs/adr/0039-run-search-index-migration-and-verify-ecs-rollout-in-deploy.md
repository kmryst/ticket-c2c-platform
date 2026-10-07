# 0039. backend deploy で search index migration を毎回実行し、成功判定を全サービスの rollout 完了で行う

## ステータス

Accepted

## 日付

2026-10-07

## 背景

Issue #396 で、worker は起動時に OpenSearch の `events` index を作らず、存在だけを確認するようになった（[ADR-0031](./0031-versioned-ticket-type-search-projection.md)）。
index が無いと `EventsIndexMissingError` で exit 1 する。index を作る `search-index-migrate` CLI は runbook から手動で実行する操作で、どの workflow からも実行されなかった。
ADR-0031 は deploy pipeline への組み込みを別 Issue に送っていた。

2026-10-07 の staging（OpenSearch が空の新しい環境）では次のことが起きた（Issue #538）。

- worker が毎回起動に失敗し、ECS の deployment circuit breaker が deployment を FAILED にした（05:19:43Z）。
- `deploy-backend-staging`（run 37575172137）は、その前の 05:17 台に `aws ecs wait services-stable` が成功し、success で終わっていた。

`services-stable` の成功条件は「deployments が 1 件」かつ「runningCount == desiredCount」で、その時点の 1 回の観測で判定する。
`rolloutState` も circuit breaker の結果も見ない。起動直後に落ちる task は一瞬 RUNNING になるので、その瞬間を観測すると success になる。

## 決定

1. `deploy-service.yml` に `run_search_index_migration` input を追加し、`deploy-backend-dev.yml` / `deploy-backend-staging.yml` は常に `true` を渡す。frontend の deploy では実行しない。
   - 実行位置は DB migration（`run_migrations=true` の時のみ）の後・サービス更新の前とする。
   - 実行方法は DB migration と同じにする。新イメージの API task definition を command override で使う ECS run-task で、`scripts/deployment/run-db-migration.sh` に `search-index-migration` mode を追加して実行する。
   - container の exit code が 0 以外なら step が失敗し、サービスは更新しない。
2. deploy の成功判定を `aws ecs wait services-stable` から `scripts/deployment/wait-ecs-rollout.sh` に置き換える。
   対象サービスすべて（backend は api と worker）について、次がすべて成り立つ状態が連続 3 回の poll（15 秒間隔）で続いたら成功とする。
   - deployments が 1 件で、PRIMARY deployment の task definition が今回 register した ARN
   - PRIMARY deployment の `rolloutState=COMPLETED`、`failedTasks=0`
   - サービスと PRIMARY deployment の running が desired と一致

   今回の ARN の deployment が `rolloutState=FAILED` になった時点、または PRIMARY が別の task definition に変わった時点（circuit breaker の rollback など）で失敗とする。80 回（約 20 分）で完了しなければタイムアウトで失敗とする。

   追記（Issue #540）: ECS の API は結果整合で、update-service 直後の describe-services が更新前の deployment だけを返すことがある。1 回の応答では古い読み取りと rollback の完了を区別できないため、今回の ARN の deployment をまだ一度も観測していない間は失敗にせず待つ。8 回（約 2 分）観測できなければ失敗とする。一度観測した後にその deployment が消えた場合は、rollback の完了として即失敗とする。

## 根拠

- `search-index-migrate` は冪等である。`ensureEventsIndex` は index が無ければ完全な mapping で作成し、あれば `putMapping` で additive に適用する。実 OpenSearch 2.19 に 2 回続けて実行し、2 回目も exit 0 で mapping と document が変わらないことを確認した（`scripts/deployment/search-index-migrate.integration.sh`。PR の CI でも実行する）。毎回実行しても副作用はない。
- 毎回実行すると、ADR-0031 の「mapping は新 Worker 起動前に適用する」という順序を deploy が機械的に守る。Gate B runbook にあった「Worker の desiredCount を 0 にして deploy し、手動で migrate してから戻す」手順も不要になる。
- DB migration と同じ run-task 経路を使うので、apply ロールに新しい権限は要らない。使う API（`ecs:DescribeServices` / `ecs:DescribeTaskDefinition` / `ecs:RunTask` / `ecs:DescribeTasks` / `ecs:StopTask` / `iam:PassRole`（`ecs-tasks.amazonaws.com`）/ `logs:GetLogEvents`）は、すでに `terraform/modules/iam-github-oidc` の apply ロールに許可されている。bootstrap apply も要らない。
- 成功判定で rolloutState と task definition を見るので、起動直後に落ちる task で success になることがなくなる。circuit breaker の rollback が完了して旧 task definition で COMPLETED になった場合も成功にしない。

## 反対材料・トレードオフ

- **backend deploy のたびに Fargate task を 1 回余分に起動する。** 1 回あたり 1 分前後で、コストと時間の増加は小さい。
- **`run-db-migration.sh` に OpenSearch の mode を入れたので、script 名と中身が一部ずれる。** 新しい run-task script を作ると、exit code 取得・ログ取得・中断時の stop-task を重複して持つことになるため、こちらを選んだ。
- **mapping が壊れている環境（`ticket_types` が `object`）では backend deploy ができなくなる。** 修正版の deploy も止まる。壊れた mapping のまま新しい Worker を動かすより安全なので受け入れる。復旧は index の作り直し（[projection runbook](../runbooks/search-projection-reconciliation-rebuild.md)）。
- **#396 より前のイメージ（b4e6826 より前）へ `image_tag` で戻すと、CLI が無いため search index migration の step で失敗する。** そのイメージの worker は起動時に自分で index を作るので migrate は要らないが、step を飛ばす input は置かなかった。置くと、index が無いまま worker を起動する経路が戻るため。dev / staging は使い捨てで、#396 より前のイメージまで戻すことは想定しない。
- **成功判定が以前より長くなる。** COMPLETED を連続 3 回確認するので、最短でも 30 秒程度は待つ。上限は約 20 分で、`services-stable` の既定（40 回 × 15 秒 = 10 分）より長くした。COMPLETED は IN_PROGRESS より後に来るので、余裕を持たせた。

不採用にした案:

- **`run_migrations=true` の時だけ search index migration を実行する案。** 新しい環境で `run_migrations` を付け忘れると今回と同じことが起きる。DB migration と違い、毎回実行しても副作用が無い。
- **worker の起動時に index を作る（#396 の前に戻す）案。** ADR-0031 が退けた案である。OpenSearch の一時的な不調で worker の起動全体が失敗するようになる。
- **Terraform で index を作る案。** OpenSearch は VPC 内で SigV4 署名が必要で、apply を実行する runner から届かない。mapping の正本がコード（`EVENTS_INDEX_PROPERTIES`）と Terraform に分かれる。
- **`services-stable` の後に `rolloutState` を 1 回確認する案。** 確認する時点で、まだ circuit breaker が判定していない（IN_PROGRESS）ことがある。完了するまで poll する必要がある。
- **`aws ecs wait services-stable` を残して、後続の smoke test で検出する案。** smoke test は別 workflow で、deploy の success と worker の失敗が食い違ったままになる。

## 再検討のトリガー

- 本番環境（prod）を作るとき。index の作り直しが要る mapping 変更や、blue/green（CodeDeploy）を導入するときは、migration の実行位置と成功判定を見直す。
- AWS CLI の waiter が rolloutState と circuit breaker の結果を判定するようになったとき。
- `search-index-migrate` が冪等でなくなる変更（index の作り直しや reindex を伴う変更）を入れるとき。
- Gate B の退役（ADR-0033 決定 3）で `run-cutover-task.sh` を削除するとき。手動の `search-index-migrate` の経路を `run-db-migration.sh` に寄せる。
