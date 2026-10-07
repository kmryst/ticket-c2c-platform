# ECR に残っている latest タグを削除する（一度だけ）

Issue #543 / [ADR-0040](../adr/0040-initial-task-definition-uses-unpushed-image-tag.md) で、deploy workflow は `latest` を push しなくなった。
terraform が作る初期 task definition は push しないタグ `pending-deploy` を参照する。

それより前に作られ、destroy せずに使い続ける環境では、ECR に古い `latest` タグが残る。
`latest` は可変で、どの commit かを task definition から特定できない。もう何も参照しないので、一度だけ削除する。

## 対象

- Issue #543 のマージより前に `deploy-backend-<env>.yml` / `deploy-frontend-<env>.yml` を実行し、そのまま残している環境の ECR リポジトリ
  - backend: `ticket-c2c-<env>`
  - frontend: `ticket-c2c-<env>-frontend`
- destroy → apply で作り直す環境は対象外。ECR リポジトリは `force_delete = true` で環境と一緒に削除され、作り直した後は `latest` が push されない。

## 前提

- #542（refresh token cleanup の scheduled task の撤去）と #543 がマージ済みであること。
- Issue #543 のマージ後に、その環境で `deploy-backend-<env>.yml`（frontend があれば `deploy-frontend-<env>.yml` も）を 1 回以上実行していること。サービスの task definition が commit SHA タグを参照している状態にする。
- AWS 認証済みで、ECR と ECS の読み取り、`ecr:BatchDeleteImage` ができること。

## 手順

以下は staging の backend の例。`ENV` と `REPO` を変えて、backend と frontend の両方で行う。

```bash
ENV=staging
REPO="ticket-c2c-${ENV}"            # frontend は "ticket-c2c-${ENV}-frontend"
CLUSTER="ticket-c2c-${ENV}"
SERVICES="ticket-c2c-${ENV}-api ticket-c2c-${ENV}-worker"   # frontend は "ticket-c2c-${ENV}-frontend"
```

1. `latest` が残っているかを確認する。`ImageNotFoundException` なら、このリポジトリは作業不要。

   ```bash
   aws ecr describe-images --repository-name "$REPO" --image-ids imageTag=latest \
     --query 'imageDetails[0].{tags:imageTags,digest:imageDigest,pushedAt:imagePushedAt}'
   ```

   出力の `digest` を控える（削除を戻す場合に使う）。

2. サービスの task definition が `latest` を参照していないことを確認する。すべてのイメージが commit SHA タグであること。
   `latest` または `pending-deploy` のものがあれば、削除せずに先に deploy workflow を実行する。

   ```bash
   for TD in $(aws ecs describe-services --cluster "$CLUSTER" --services $SERVICES \
       --query 'services[].taskDefinition' --output text); do
     aws ecs describe-task-definition --task-definition "$TD" \
       --query 'taskDefinition.containerDefinitions[0].image' --output text
   done
   ```

3. `latest` タグを削除する。同じイメージに commit SHA タグが付いていれば、外れるのは `latest` タグだけで、イメージは残る。
   イメージの最後のタグを外した場合はイメージも削除される（[BatchDeleteImage](https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_BatchDeleteImage.html)）。

   ```bash
   aws ecr batch-delete-image --repository-name "$REPO" --image-ids imageTag=latest
   ```

   出力の `failures` が空であること。

4. 削除を確認する。`ImageNotFoundException` になること。

   ```bash
   aws ecr describe-images --repository-name "$REPO" --image-ids imageTag=latest
   ```

## ECR lifecycle policy との関係

`terraform/modules/ecr` の lifecycle policy は「`tagStatus = any` で直近 `keep_image_count`（既定 10）件を超えたイメージを expire する」1 ルールだけである。
タグで保護するルール（`tagPatternList` など）は無く、`latest` は保護されていない。
deploy workflow が `latest` を push しなくなったので、削除した後に `latest` が作り直されることはない。
削除しなくても、`latest` の付いたイメージは新しいイメージが 10 件 push された時点で expire されるが、それまでの間 `latest` が残る。

## 戻す場合

Issue #543 の変更を revert して `latest` を参照する状態に戻す場合は、手順 1 で控えた digest に `latest` を付け直す。

```bash
MANIFEST=$(aws ecr batch-get-image --repository-name "$REPO" --image-ids imageDigest=<控えた digest> \
  --query 'images[0].imageManifest' --output text)
aws ecr put-image --repository-name "$REPO" --image-tag latest --image-manifest "$MANIFEST"
```

revert した deploy workflow を 1 回実行すれば `latest` は push し直されるので、通常はこの手順は要らない。
