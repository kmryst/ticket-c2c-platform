# Contributing Guide

本プロジェクトへの貢献ガイドです。
このファイルを Issue / Branch / Commit / PR / Label / 軽運用・厳密運用の共通運用ルールの正本とします。

このリポジトリは、C2C チケット販売プラットフォームのシステム設計と PoC を段階的に進めるためのプロジェクトです。

## 開発フロー

PoC 実装段階から Issue / PR 駆動開発を基本とします。

### 正規コマンド

Issue と PR の作成は、原則として以下のヘルパーを使います。

```bash
# Issue
./scripts/github/create-issue-with-labels.sh ...

# PR
./scripts/github/create-pr-with-labels.sh ...
```

PR マージ後のブランチ整理には次を使います。

```bash
./scripts/github/cleanup-merged-pr-branch.sh <PR番号>
```

### 1. Issue 作成

新しい機能追加、PoC、検証、ドキュメント更新は、原則として Issue から始めます。
軽運用でも Issue は必須です。ただし簡潔で構いません。

```bash
./scripts/github/create-issue-with-labels.sh \
  --title "短い要約" \
  --body-file docs/issue-templates/feature_request.md \
  --type type:feature \
  --area area:poc \
  --risk risk:low \
  --cost cost:none
```

Issue テンプレート:

- `.github/ISSUE_TEMPLATE/feature_request.yml`: Web UI 用
- `docs/issue-templates/feature_request.md`: CLI 用 `--body-file`

Issue に必要な最小項目:

- `目的`
- `対象`
- `受け入れ条件`

Issue 必須ラベル:

- `type:*`: ちょうど 1 つ
- `area:*`: 1 つ以上、複数可
- `risk:*`: ちょうど 1 つ
- `cost:*`: ちょうど 1 つ

AI Agent を使う場合は、いきなり起票せずに先に Issue プランを提示し、人間が確認してから起票します。

Issue プランには、少なくとも次を含めてください。

- タイトル案
- 目的
- 対象
- 受け入れ条件
- 推奨ラベル `type / area / risk / cost`
- 軽運用 / 厳密運用の判定と理由
- 使用ヘルパー: `./scripts/github/create-issue-with-labels.sh`

Issue 本文には専用の運用区分欄を追加しません。運用区分は起票前プランと PR 作成前プランで確認します。

### 2. ブランチ作成

Issue に基づいて、最新の `main` からブランチを作成します。

```bash
git switch main
git pull --ff-only origin main
git switch -c <issue番号>-<kebab-case要約>
```

例:

```bash
git switch -c 12-add-inventory-purchase-api
```

AI Agent を使う場合は、ブランチを切った後、実装前に計画を提示し、人間が確認してから実装を開始します。
計画には、変更対象ファイル、追加・変更する内容、既存動作への影響を含めます。

### 3. 実装・コミット

コードやドキュメントを変更し、Conventional Commits 形式でコミットします。

```bash
git add <対象ファイル>
git commit -m "type: 変更内容の説明"
```

許可する type:

- `feat`: 新機能
- `fix`: バグ修正
- `docs`: ドキュメント修正
- `refactor`: リファクタリング
- `test`: テスト追加・修正
- `chore`: その他雑務
- `ci`: CI/CD 変更
- `infra`: インフラ変更

コミットメッセージ形式:

- `<type>: <summary>`
- `<type>(<scope>): <summary>`

`scope` は任意です。`summary` は日本語を許容します。
`wip`、`fix` のみ、`update files` のような曖昧なコミットメッセージは使いません。

### 4. Push

作業ブランチを push します。

```bash
git push -u origin <branch>
```

ユーザーが明示的に `main` への直接 push を許可した場合のみ、`main` へ直接 push してよいです。
その場合も、対象差分を確認し、明示的に stage してから commit / push します。

### 5. Pull Request 作成

PR はテンプレートと helper を使って作成します。

```bash
./scripts/github/create-pr-with-labels.sh \
  --title "feat: add inventory purchase endpoint" \
  --body-file .github/pull_request_template.md \
  --issue <issue番号> \
  --type type:feature \
  --area area:backend \
  --area area:poc \
  --risk risk:low \
  --cost cost:none \
  --base main
```

この helper は PR 本文へ `Closes #<issue番号>` を自動追記します。

PR タイトルも Conventional Commits 形式にします。

AI Agent を使う場合は、PR もいきなり作成せず、先に PR プランを提示して人間が確認してから作成します。

PR プランには、少なくとも次を含めてください。

- タイトル案
- 目的
- 変更内容
- 影響範囲
- `Closes/Fixes/Refs #<issue番号>`
- 推奨ラベル `type / area / risk / cost`
- 軽運用 / 厳密運用の判定と理由
- 厳密運用の場合、`ロールバック` が必須かどうか
- 使用ヘルパー: `./scripts/github/create-pr-with-labels.sh`

PR 本文には、次のいずれかを必ず含めます。

- `Closes #<issue番号>`
- `Fixes #<issue番号>`
- `Refs #<issue番号>`

### 6. マージ後 cleanup

PR がマージされたら、次の Issue へ進む前にブランチを整理します。

```bash
./scripts/github/cleanup-merged-pr-branch.sh <PR番号>
```

この helper は GitHub 上で PR が `MERGED` であることを確認し、base branch を最新化してから作業ブランチを削除します。

## 運用モード

Issue 本文には専用の運用区分欄を追加せず、Issue 起票前プランと PR 作成前プランで、ラベル・変更対象・変更内容から軽運用 / 厳密運用を判定します。
判断に迷う場合は厳密運用として扱います。

### 軽運用

以下のような変更のうち、厳密運用の条件に該当しないものは軽運用で進めます。

- README / docs の軽微な更新
- コメント修正
- 文言修正
- 影響範囲が限定的な軽微修正
- `risk:low`
- `cost:none` / `cost:small`

軽運用でも `Issue -> Branch -> PR` の流れは維持します。

### 厳密運用

以下のいずれかに該当する変更は厳密運用で進めます。

- `risk:medium` / `risk:high`
- `cost:medium` / `cost:large`
- `.github/workflows/**`
- `scripts/github/**`
- `scripts/deployment/**`
- `scripts/validation/**`
- `database/schema.sql`
- `docker-compose.yml`
- `terraform/**`
- AWS リソース、IAM、OIDC、Secrets、Network、Security に関わる変更
- deploy / destroy に関わる変更
- DB データ削除や永続データに影響する変更
- ロールバックを考える必要がある変更

厳密運用では、Issue と PR の記載を丁寧に行い、人間が変更内容を十分に確認します。
厳密運用 PR では、PR 本文の `ロールバック` に実質的な内容を書きます。

## ローカル PoC 環境

Docker Compose で PostgreSQL と Valkey を起動します。

```bash
docker compose up -d
docker compose ps
```

停止する場合:

```bash
docker compose down
```

データボリュームも削除して作り直す場合のみ、次を使います。

```bash
docker compose down -v
```

`docker compose down -v` は DB データを削除するため、実行前にユーザーへ確認します。

## DB スキーマ

ローカル PostgreSQL へスキーマを適用する場合:

```bash
docker compose exec -T postgres psql -U ticket_poc -d ticket_poc < database/schema.sql
```

`database/schema.sql` を変更した場合は、`docs/poc/inventory-schema.md` も合わせて更新します。

## ラベル管理

ラベル定義の正本は `.github/labels.yml` です。

GitHub 側へ反映する場合は、次の helper を使います。

```bash
./scripts/github/sync-labels.sh
```

この helper は `.github/labels.yml` にあるラベルを作成・更新します。
ファイルに無い既存ラベルは削除しません。

### 必須ラベル

- `type:*`: ちょうど 1 つ
- `area:*`: 1 つ以上、複数可
- `risk:*`: ちょうど 1 つ
- `cost:*`: ちょうど 1 つ

## チェックリスト

開発を始める前に確認してください。

- [ ] 最新の `main` を取得したか
- [ ] Issue を作成または確認したか
- [ ] ブランチ名が `<issue番号>-<kebab-case要約>` 形式か
- [ ] 変更対象の正本ドキュメントを読んだか
- [ ] コミットメッセージが Conventional Commits 形式か
- [ ] PR 本文に `Closes #XX` / `Fixes #XX` / `Refs #XX` のいずれかを記載したか
- [ ] 必須ラベル `type / area / risk / cost` を付けたか

## 関連ドキュメント

- [README.md](./README.md)
- [AGENTS.md](./AGENTS.md)
- [CLAUDE.md](./CLAUDE.md)
- [Issue Template](./.github/ISSUE_TEMPLATE/feature_request.yml)
- [PR Template](./.github/pull_request_template.md)
- [Labels](./.github/labels.yml)
