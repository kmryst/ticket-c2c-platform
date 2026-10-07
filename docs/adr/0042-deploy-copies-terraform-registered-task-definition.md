# 0042. deploy は terraform が登録した task definition revision のイメージだけを差し替え、ARN は terraform の state の output から読む

## ステータス

Accepted

## 日付

2026-10-07

## 背景

terraform は ECS service（api / worker / frontend）と task definition を作る。`ecs-service` モジュールの service は `ignore_changes = [task_definition]` で、deploy workflow が register した revision を terraform が巻き戻さないようにしている。

`deploy-service.yml` の「Register SHA-pinned task definitions」は、service が今使っている task definition を `describe-task-definition` し、`containerDefinitions[0].image` だけを commit SHA タグに変えて register していた。
このため、terraform で環境変数・secrets・CPU / メモリ・role・sidecar を変えて apply しても、新しい revision は service に使われず、deploy も service の古い revision をコピーするので、**最初の deploy の後は terraform の設定変更が永久に届かなかった**（Issue #544）。
DB migration / search index migration の run-task も、deploy が register した revision を使うので古い設定で走っていた。
`ecs-service/main.tf` のコメント（「apply 後に deploy を実行して反映する」）と実装が食い違っていた。

新しい環境を作った直後の最初の deploy だけは terraform の revision をコピーするので反映される。staging は destroy 前提で毎回作り直すため、見逃していた。
`deploy-service-workflow.spec.sh`（#547）の AWS CLI スタブも、この「最初の deploy」しかモデル化していなかった。

## 決定

1. **task definition の設定は terraform、イメージは deploy workflow が受け持つ。** deploy は terraform が最後の apply で登録した revision を `describe-task-definition` し、`containerDefinitions[0].image` だけを commit SHA タグに差し替えて register する。register した revision を DB migration / search index migration の run-task と update-service に使う。api / worker / frontend で同じ扱いにする（migration は api の revision を使う）。
2. **ARN は terraform の state の output から読む。** dev / staging の環境 root に output `ecs_task_definition_arns`（ECS service 名 → `aws_ecs_task_definition.this.arn`。revision 番号まで含む）を追加する。`deploy-service.yml` は新しい入力 `terraform_dir` の root で `terraform init` → `terraform output -json ecs_task_definition_arns` を実行する（plan / apply はしない）。
3. **family 名で最新 ACTIVE revision を引かない。service が今使っている revision もコピー元にしない。**
4. **想定外の値なら register の前に失敗する。** output が無い、service のキーが無い、ARN の family が service 名と違う・revision 番号が無い、その revision のアプリコンテナの名前が service 名でない・イメージが `pending-deploy`（[ADR-0040](./0040-initial-task-definition-uses-unpushed-image-tag.md)。terraform が登録した revision は必ずこのタグを参照する）でない場合。イメージの push より前に判定する。
5. **apply / destroy と deploy を並行させない。** dev / staging それぞれで、`terraform-apply-*` / `terraform-destroy-*` / `deploy-backend-*` / `deploy-frontend-*` / `db-migrate-*` / `ticket-type-expand-readiness-*` / `ticket-type-cutover-*` の concurrency group を `mutation-<env>` に揃え、`queue: max` で待機中の run を cancel せず起動順に実行する。
6. **rollback（`image_tag` に過去の short SHA）は「過去のイメージ ＋ 現在の terraform の設定」になる。** 設定まで戻す場合は、terraform の設定を戻して apply してから deploy する（[runbook](../runbooks/apply-task-definition-config-change.md)）。
7. AWS での確認用に、`terraform-apply-<env>.yml` の入力 `task_config_check_value`（terraform 変数 `task_config_check_value`）を追加する。値を入れると api / worker / frontend のアプリコンテナに環境変数 `TASK_CONFIG_CHECK_VALUE` が入る。アプリは読まない。既存の環境で「設定だけを変えて再 apply → deploy で反映される」ことを、コードを書き換えずに確認するため。

## 根拠

- 責務を分けると、terraform の設定変更は「apply → deploy」で必ず届き、deploy が register する revision の設定は常に「terraform が最後に apply した設定」になる。どの revision から作ったかは step summary に `from <revision>` として残る。
- revision 番号まで含む ARN を使うので、deploy が register した revision、失敗した deploy の revision、手作業で register した revision を拾わない。family の最新 ACTIVE revision を使うと、deploy が register するたびに「最新」が deploy 由来の revision になり、terraform の新しい設定は次の apply まで最新にならない。失敗した deploy の revision も ACTIVE のまま最新として残る。family ARN を target にした EventBridge Scheduler で起きた drift（#542 / [ADR-0041](./0041-run-refresh-token-cleanup-in-api-with-advisory-lock.md)）と同種の問題になる。
- ARN の受け渡しに state の output を使う理由:
  - deploy が使う apply ロールは state バケットを既に読める（apply / destroy で使っている）。IAM（bootstrap）の変更も、人による bootstrap apply も要らない。
  - 新しい AWS リソースを作らない。値は terraform が state に記録した ARN そのもので、別の場所にコピーを持たないので、コピーと state が食い違うことがない。
  - `staging-smoke-test.yml` / `dev-smoke-test.yml` が同じ方法（`terraform init` → `terraform output`、wrapper 無効）で state の output を読んでいる。
- `pending-deploy` の検査で、terraform が登録した revision であることを確かめられる。output の値が壊れていたり手で書き換えられていたりしても、deploy 由来の revision（commit SHA タグ）をコピー元にしない。
- `deploy-service-workflow.spec.sh` に、既存の環境のケース（service = 旧設定の revision :42、terraform の output = 新設定の revision :43、失敗した deploy の revision :44 が family の最新）を追加した。register 内容が「:43 から ECS が付ける属性を除き、イメージだけを差し替えたもの」と一致し、migration・index 作成・update-service が register した revision を使うことを確認する。修正前の workflow ではこのケースが失敗する（:42 の旧設定が register される）ことを PR で確認した。

## 反対材料・トレードオフ

- **deploy が terraform の state の場所（backend）と output 名に依存する。** state を分割したり backend を変えたりすると、`terraform_dir` と output の置き場所を合わせて変える必要がある。
- **deploy job で `terraform init`（provider のダウンロードを含む）が走り、数十秒かかる。** state 全体を読む（secret の値を含む）が、apply ロールはもともと state を読み書きでき、deploy は既にそのロールで動いているので、権限は広がらない。
- **rollback で設定は戻らない。** 新しいイメージに合わせて追加した設定（環境変数など）は、過去のイメージにも渡る。過去のイメージは未知の環境変数を無視するので通常は問題にならないが、設定の削除や意味の変更を含む場合は、設定を戻す手順（runbook）を使う。
- **migration が新しい設定を必要とする変更は、`deploy-backend-<env>.yml` の `run_migrations=true` で行う。** `db-migrate-<env>.yml` は API サービスの現行 task definition（最後の deploy の時点の設定）を使うので、apply の後・deploy の前に実行すると古い設定で走る。
- **concurrency group を 1 つにしたため、同じ環境の apply・deploy・DB 操作は 1 件ずつしか実行されない。** `queue: max` で待機中の run は cancel されないが、長い apply の後ろに deploy が並ぶ。ticket-type cutover の session 中の割り込み防止（#419）は別の仕組みが要る。
- **この output を足す前の state しかない環境では、deploy が失敗する。** マージ後に一度 `terraform-apply-<env>.yml` を実行する。

不採用にした案:

- **terraform が SSM パラメータ（例 `/ticket-c2c/<env>/ecs/<service>/task-definition-arn`）に ARN を書き、deploy が読む。** deploy が terraform の state に依存しない利点があるが、apply ロールに SSM の権限が無く、bootstrap の IAM 変更と人による bootstrap apply が先に必要になる。dev / staging の apply が bootstrap apply の前に失敗する順序の制約も生まれる。値を state とパラメータの 2 か所に持つことにもなる。
- **CI がリポジトリ内の task definition テンプレート（JSON）から register する**（`amazon-ecs-render-task-definition` / `amazon-ecs-deploy-task-definition` の構成）。環境変数・secrets の ARN・role・log group など、terraform が作るリソースの値をテンプレートへ移す手間が大きく、設定の正本が terraform とテンプレートに分かれる。
- **deploy を `terraform apply -var image_tag=<SHA>` で行う。** task definition の正本が terraform だけになる定番の方式だが、root module が環境ごとに 1 つ（[ADR-0003](./0003-terraform-state-and-environment-isolation.md)）なので deploy のたびに環境全体の apply になる。`-target` は HashiCorp が日常利用を推奨していない。migration 用の revision をどう用意するかの設計も要る。state 分割の後の長期の別案とする。
- **family の最新 ACTIVE revision を使う。** 根拠に書いた理由で採用しない。

## 再検討のトリガー

- state を分割したとき（ADR-0003 の再検討）。ECS の層を deploy と同じ単位で apply できるなら、`terraform apply -var image_tag=<SHA>` 方式を再検討する。分割しない場合も、output の置き場所が変わるなら SSM パラメータ方式と比べ直す。
- deploy に apply ロール以外の、state を読めない専用ロールを使うことにしたとき（SSM パラメータ方式が有利になる）。
- deploy の所要時間で `terraform init` が問題になったとき。
- ECS の deployment controller を変える（CodeDeploy の blue/green など）とき。task definition の受け渡し方が変わる。
