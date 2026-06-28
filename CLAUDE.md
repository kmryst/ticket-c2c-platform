# CLAUDE.md — ticket-c2c-platform Claude Code 作業ルール

このファイルは Claude Code が `ticket-c2c-platform` で作業を開始する前に読む入口です。
一般論ではなく、このリポジトリ固有のルールに従って作業してください。

## 位置づけ

- `CLAUDE.md`: Claude Code 向けの作業入口。このファイルを Claude Code の正本とする。
- `AGENTS.md`: Codex 向けの作業入口。Claude Code の正本にはしない。
- `CONTRIBUTING.md`: Issue / Branch / Commit / PR / Label / 軽運用・厳密運用の共通正本。
- `.github/labels.yml`: ラベル一覧の正本。
- `docs/requirements/system-requirements.md`: 課題要件、スコープ、制約の正本。
- `docs/poc/technical-validation-plan.md`: PoC と技術検証計画の正本。
- `database/schema.sql`: ローカル PoC 用 PostgreSQL スキーマ。

内容が衝突する場合は、共通運用は `CONTRIBUTING.md` を優先する。
要件は `docs/requirements/system-requirements.md`、PoC 方針は `docs/poc/technical-validation-plan.md`、DB 定義は `database/schema.sql` を優先する。

## 作業開始前に必ず読むファイル

1. `CONTRIBUTING.md`
2. `README.md`
3. `docs/requirements/system-requirements.md`
4. `docs/poc/technical-validation-plan.md`
5. 対象 Issue がある場合は `gh issue view <issue番号>`
6. 変更対象ファイル

## 作業内容別に追加で読むファイル

| 条件 | 読むファイル |
|---|---|
| Issue 起票 | `docs/issue-templates/feature_request.md` / `.github/ISSUE_TEMPLATE/feature_request.yml` |
| PR 作成 | `.github/pull_request_template.md` |
| ラベル判断 | `.github/labels.yml` |
| 技術スタックや構成判断を変える | `docs/architecture/technology-stack.md` |
| 在庫 PoC の DB スキーマを変える | `docs/poc/inventory-schema.md` と `database/schema.sql` |
| Docker Compose を変える | `docker-compose.yml` と `.env.example` |
| scripts 配下の helper を使う・変える | `CONTRIBUTING.md` と対象スクリプト |

## 開発フロー

PoC 実装段階から Issue / PR 駆動を基本とする。
順序: Issue 確認 → ブランチ作成 → 実装前計画提示 → 実装 → 検証 → コミット前停止 → コミット → push → PR → merge → cleanup。

ユーザーが明示的に `main` への直接 commit / push を許可した場合は、その指示を優先してよい。その場合も、対象差分を確認し、明示的に stage してから commit / push する。

### Issue 作成

Issue は起票前にプランを提示してユーザーに確認してもらう。

Issue 作成前プランには、タイトル案、目的、対象、受け入れ条件、推奨ラベル、軽運用 / 厳密運用の判定と理由、使用ヘルパーを明示する。

```bash
./scripts/github/create-issue-with-labels.sh \
  --title "短い要約" \
  --body-file docs/issue-templates/feature_request.md \
  --type type:feature \
  --area area:poc \
  --risk risk:low \
  --cost cost:none
```

### Issue 着手

新しい Issue に着手する時は、最新の `main` から作業ブランチを切る。

```bash
git switch main
git pull --ff-only origin main
git switch -c <issue番号>-<kebab-case要約>
```

未コミット変更がある場合は、勝手に stash / reset しない。変更内容を確認し、ユーザーの意図に沿って進める。

### PR 作成

PR は作成前にプランを提示してユーザーに確認してもらう。

PR 作成前プランには、タイトル案、目的、変更内容、影響範囲、`Closes/Fixes/Refs #<issue番号>`、推奨ラベル、軽運用 / 厳密運用の判定と理由、厳密運用の場合は `ロールバック` が必須かどうか、使用ヘルパーを明示する。

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

PR は原則 draft で作成する。ユーザーが明示した場合のみ ready for review にする。

### マージ後 cleanup

PR がマージされた後、次の Issue へ進む前に原則として実行する。

```bash
./scripts/github/cleanup-merged-pr-branch.sh <PR番号>
```

## 設計文書の更新と設計判断の記録

実装や PoC によって設計・運用・構成が変わった場合は、まず `docs/` 配下の該当ドキュメントを更新する。

トレードオフを伴う設計判断は、後で ADR として残す候補にする。現時点では ADR ディレクトリは未作成のため、必要になった時点で `docs/adr/` と ADR 運用ルールを追加する。

PoC の検証結果は、可能な限り数値で残す。

- 成功数 / 失敗数
- p50 / p95 / p99 レイテンシ
- エラー率
- PostgreSQL 更新試行数
- Valkey による拒否数
- 在庫超過が 0 であること

## ローカル PoC 環境

Docker Compose で PostgreSQL と Valkey を起動する。

```bash
docker compose up -d
docker compose ps
```

停止する場合:

```bash
docker compose down
```

データボリュームも削除して作り直す場合のみ、次を使う。

```bash
docker compose down -v
```

`docker compose down -v` は DB データを削除するため、実行前にユーザーへ確認する。

## DB スキーマ

ローカル PostgreSQL へスキーマを適用する場合:

```bash
docker compose exec -T postgres psql -U ticket_poc -d ticket_poc < database/schema.sql
```

`database/schema.sql` を変更した場合は、`docs/poc/inventory-schema.md` も合わせて更新する。

## コミットメッセージ

コミットを作成する場合は、必ず `CONTRIBUTING.md` の Conventional Commits ルールに従う。
`wip`、`fix` のみ、`update files` のような曖昧なメッセージを使わない。

## 禁止事項

ユーザーから明示的に指示された場合でも、実行前に必ず確認する。

- `docker compose down -v`
- PostgreSQL / Valkey のデータを削除する操作
- AWS リソースを作成・変更・削除する CLI 操作
- `terraform apply` / `terraform destroy`
- `terraform state rm`
- `git push --force`
- GitHub Issue / PR の無断作成・無断編集
- secret / credential 値の出力
- `.env` ファイルのコミット

## ユーザー確認が必要な操作

以下は必ず事前にプランを提示し、ユーザーの確認を得てから実行する。

| 操作 | 確認のタイミング |
|---|---|
| Issue 起票 | 本文・ラベル案とコマンドを提示してから |
| 実装着手 | 変更対象・変更内容・影響範囲を提示してから |
| コミット | コミット前サマリを提示して停止してから |
| git push | コミット確認後に明示的な許可を得てから |
| PR 作成 | タイトル・本文・ラベル・コマンド案を提示してから |
| ブランチ削除 | cleanup コマンド案を提示してから |
| データ削除 | 削除対象と復旧可否を提示してから |

