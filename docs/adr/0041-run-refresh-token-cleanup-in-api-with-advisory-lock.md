# 0041. refresh token cleanup を api 内の定期実行に移し、PostgreSQL の advisory lock で多重実行を防ぐ

## ステータス

Accepted

## 日付

2026-10-07

## 背景

Issue #195 で、`refresh_tokens` の期限切れ cleanup（猶予 30 日を過ぎたトークンファミリーの削除）を次の構成で実装した。

- EventBridge Scheduler（日次 18:30 UTC = 03:30 JST）が ECS RunTask を呼ぶ。
- target は api の task definition family（revision 番号なし）で、command override で `node dist/src/database/cleanup-refresh-tokens.js` を実行する。
- Terraform は `terraform/modules/scheduled-task`（schedule、Scheduler 用 IAM role、`ecs:RunTask` / `iam:PassRole` の inline policy）。

revision 番号を外した target では、RunTask は起動時点の最新 ACTIVE revision を使う。api の service は `lifecycle { ignore_changes = [task_definition] }` で Terraform の revision に追従しないため、cleanup だけが別の revision で動くことがある（Issue #542）。

- Terraform を再 apply すると、`:latest` を参照する revision が最新 ACTIVE になる。`:latest` は deploy workflow の migration より前に push されるので、migration が失敗した deploy の後や、`image_tag` で rollback した後は、稼働中の api と違うコードで cleanup が動く。
- runbook の直接 rollback（`aws ecs update-service --task-definition <旧 ARN>`）の後も、cleanup は新しい（問題のある）revision を使い続ける。
- Issue #543 で `:latest` の push をやめると、再 apply の後は cleanup が毎回 `CannotPullContainerError` で失敗する。

## 決定

1. cleanup を api プロセス内の定期実行にする。`@nestjs/schedule` の `@Cron` で毎日 18:30 UTC（03:30 JST）に実行する（`src/database/refresh-token-cleanup.service.ts`）。時刻は #195 と同じ。worker には入れない。
2. api は複数タスクで動く（staging full で 2〜4）ため、PostgreSQL の session-level advisory lock（`pg_try_advisory_lock`）で同時刻の実行を 1 タスクに絞る。lock を取れなかったタスクは何もしない。
   - 実行のたびに専用の接続（pg `Client`）を作り、lock・削除・unlock を同じ接続で行い、最後に必ず接続を閉じる。pool（リクエスト処理用、max 10）の接続は使わない。unlock に失敗しても、接続を閉じれば session が終わって lock は解放される。
   - 削除が早く終わっても lock を 5 分保持してから unlock する（ShedLock の `lockAtLeastFor` と同じ考え方）。各タスクの発火時刻は接続確立や Aurora の auto-pause からの再開待ちでずれるため、先に終わったタスクの unlock 後に遅れたタスクが lock を取り、同じ日に 2 回目を実行するのを防ぐ。
   - 専用接続の session に `statement_timeout = 5min` と `lock_timeout = 10s` を設定する。
3. 削除はバッチに分ける。1 statement で削除するファミリーは 1,000 まで、1 回の実行で 100 statement まで。各 statement は autocommit で、ファミリー単位の削除が statement 内で完結するので自己参照 FK は常に整合する。上限に達したら残りは翌日に回す。
4. `refresh_tokens.parent_token_id` / `replaced_by_token_id`（自己参照 FK の参照する側の列）に部分 index を追加する（migration `AddRefreshTokensLineageIndexes1791365426295`、`CREATE INDEX CONCURRENTLY`）。
5. 例外はログに出すだけで外へ投げない。接続の error event にも listener を付け、接続の切断で api プロセスが落ちないようにする。
6. staging / dev から `module "refresh_token_cleanup"` を外し、`terraform/modules/scheduled-task` を削除する。
7. 手動実行の入口 `cleanup-refresh-tokens.ts` は残し、同じ advisory lock を取るようにする。`scripts/deployment/run-db-migration.sh` に `refresh-token-cleanup` mode を追加し、稼働中の api と同じ task definition で 1 回だけ実行できるようにする。
8. apply role の Scheduler 関連権限（`scheduler:*`、`iam:PassRole`（`scheduler.amazonaws.com`）、Issue #198）は、この変更では外さない。

## 根拠

- cleanup が api と同じプロセスで動くので、コード・環境変数・revision は常に稼働中の api と同じになる。deploy・rollback・直接の `update-service`・Terraform の再 apply のどれでもずれない。Issue #543 の前提がそろう。
- session-level lock を選んだのは、バッチごとに commit するためである。transaction-level lock（`pg_try_advisory_xact_lock`）は transaction の終了で解放されるので、全バッチを 1 transaction に入れる必要があり、バッチに分けて row lock の保持時間を短くする意味がなくなる。session-level lock の注意点（lock と unlock を同じ接続で行う、解放を忘れない）は、専用接続を使い最後に必ず閉じることで満たす。
- Aurora のフェイルオーバーでは接続が切れ、その session の advisory lock も消える（advisory lock はメモリ上の lock で、新しい writer には引き継がれない）。切れた側の DELETE は失敗し、次の実行は新しい writer で lock を取り直す。lock が残り続けて cleanup が止まることはない。フェイルオーバーの直後に別のタスクが同じ日に実行しても、DELETE は冪等なので 0 件になるだけである。
- index が無いと、DELETE のたびに PostgreSQL が FK の確認として `refresh_tokens` 全体を走査する。ローカルの計測（25 万 row、削除対象 2,000 row）で 1 statement が約 55 秒かかり、その大半（54.7 秒）が 2 つの FK の確認だった。index を追加した後は、19.6 万 row（9.8 万ファミリー）の削除が 99 statement・約 20 秒で終わった。
- api のリクエスト処理への影響はローカルで確認した。上記の削除中も `/readyz` は全件 200 で、p99 は 2.1 ms（削除前 2.4 ms）だった。api の起動時間（`/readyz` が 200 になるまで）は main 1.52〜1.54 秒、この変更 1.48〜1.51 秒で差は無かった。
- docker compose で api を 2 つ起動し、15 秒間隔の実行を 12 回繰り返して、毎回 1 タスクだけが削除し、もう 1 タスクが skip したことを確認した。統合テスト（実 PostgreSQL）でも 2 つの service を同時に 20 回実行し、毎回 1 回だけ削除することを CI で確認する。
- Scheduler 関連の権限を残すのは、この変更より前に作った環境の state に schedule と Scheduler 用 IAM role が残っているからである。その環境の apply / destroy は schedule の読み取りと削除が要る。全環境の state から消えたことを確認してから、bootstrap の変更として外す。

## 反対材料・トレードオフ

- **api が 1 タスクも動いていない時間帯は cleanup が実行されない。** dev / staging は使い捨てで、夜間に destroy した環境では #195 の構成でも Scheduler が無いので同じである。実行を逃しても削除が翌日以降にずれるだけで、30 日の猶予に対して影響は小さい。
- **cleanup の失敗は api のログにしか出ない。** #195 と同じく専用のアラームは持たない（Production Readiness L-29）。RunTask の失敗という形が無くなったので、成功ログ（`refresh token cleanup completed`）が出ていないことを検知する仕組みが要る。
- **`image_tag` で Issue #542 より前のイメージに戻すと、その間は cleanup が実行されない。** Scheduler も撤去しているためである。戻した期間だけ削除が遅れる。
- **lock を 5 分保持する間、専用接続を 1 本使う。** 日次で 1 タスクだけなので、Aurora の接続数への影響は小さい。Aurora の auto-pause は、この接続が閉じてから数え始める。
- **削除はリクエストと同じ Aurora の writer で動く。** index とバッチで 1 statement を短くしたが、溜まった量が多い日は数十秒 DB の CPU を使う。時刻はトラフィックの少ない 03:30 JST にしている。
- **`@nestjs/schedule`（と依存の `cron`）が本番依存に増える。** NestJS 公式の package で、NestJS 12 系に対応している（peerDependencies `^11 || ^12`）。

不採用にした案:

- **Scheduler の target と state を deploy workflow が更新する案（Terraform と workflow で共有する）。** target だけを `ignore_changes` にしても、再 apply で `state` が戻る。apply と deploy は concurrency group が別（`terraform-staging` と `backend-database-operation-staging`）で、provider は update のときに Target と State を送るため、並行実行すると巻き戻る。UpdateSchedule は指定しなかった項目を既定値に戻す API なので、command override（`input`）や network 設定を失う危険がある。runbook の直接 rollback では Scheduler が取り残される。
- **cleanup 専用の task definition family を作る案。** どのイメージで動かすかの問題が残り、サービスの revision との依存が消えない。
- **Aurora の pg_cron を使う案。** クラスタパラメータグループの `shared_preload_libraries` の変更と再起動が必要で、変更範囲が大きい。dev / staging は使い捨てなので、作り直すたびに extension の作成と job の登録が要る。
- **`pg_try_advisory_xact_lock`（transaction-level lock）を使う案。** 上記の根拠のとおり、バッチごとの commit と両立しない。
- **lock を保持する最短時間を置かない案。** 削除がすぐ終わる日は、発火の遅れたタスクが同じ日に 2 回目を実行する。DELETE は冪等なので害は無いが、実行を 1 回に揃えられない。
- **api の起動時にも実行する案。** deploy やスケールアウトのたびに DB へ削除をかけることになり、起動時間と `/readyz` に影響し得る。日次の実行で足りる。

## 再検討のトリガー

- 本番環境（prod）を作るとき。cleanup の成功を監視する仕組み（L-29）と合わせて見直す。
- `refresh_tokens` の量が増え、1 回の実行で 100 statement の上限に達する日が続くとき。
- api 以外に、全タスクで 1 回だけ実行したい定期処理が増えるとき。同じ仕組みを共通化するか、専用の実行基盤を検討する。
- Aurora の pg_cron を別の用途で導入するとき。
