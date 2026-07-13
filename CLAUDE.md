# CLAUDE.md — ticket-c2c-platform Claude Code 作業ルール

このファイルは Claude Code が `ticket-c2c-platform` で作業を開始する前に読む入口です。
一般論ではなく、このリポジトリ固有のルールに従って作業してください。

## 位置づけ

- `CLAUDE.md`: Claude Code 向けの作業入口。このファイルを Claude Code の正本とする。
- `AGENTS.md`: Codex 向けの作業入口。Claude Code の正本にはしない。
- `CONTRIBUTING.md`: Issue / Branch / Commit / PR / Label / 軽運用・厳密運用の共通正本。
- `docs/operations/github-flow-guardrails.md`: GitHub フローの設計意図、未採用案、再検討条件。
- `.github/labels.yml`: ラベル一覧の正本。
- `docs/requirements/system-requirements.md`: 課題要件、スコープ、制約の正本。
- `docs/poc/technical-validation-plan.md`: PoC と技術検証計画の正本。
- `docs/architecture/dev-environment.md`: AWS dev 環境構成の正本。
- `docs/adr/README.md`: ADR の採番・形式・ステータス運用の正本。
- `database/schema.sql`: ローカル PoC 用 PostgreSQL スキーマ。

内容が衝突する場合は、共通運用は `CONTRIBUTING.md` を優先し、設計意図は `docs/operations/github-flow-guardrails.md` を参照する。
要件は `docs/requirements/system-requirements.md`、PoC 方針は `docs/poc/technical-validation-plan.md`、DB 定義は `database/schema.sql` を優先する。

## 作業開始前に必ず読むファイル

1. `CONTRIBUTING.md`
2. `docs/operations/github-flow-guardrails.md`
3. `README.md`
4. `docs/requirements/system-requirements.md`
5. `docs/poc/technical-validation-plan.md`
6. 対象 Issue がある場合は `gh issue view <issue番号>`
7. 変更対象ファイル

## 作業内容別に追加で読むファイル

| 条件 | 読むファイル |
| --- | --- |
| Issue 起票 | `docs/issue-templates/feature_request.md` / `.github/ISSUE_TEMPLATE/feature_request.yml` |
| PR 作成 | `.github/pull_request_template.md` |
| ラベル判断 | `.github/labels.yml` |
| 技術スタックや構成判断を変える | `docs/architecture/technology-stack.md` と関連 ADR |
| `terraform/**` を変える | `docs/architecture/dev-environment.md` と `docs/adr/0003-terraform-state-and-environment-isolation.md` |
| 在庫 PoC の DB スキーマを変える | `docs/poc/inventory-schema.md` と `database/schema.sql` |
| Docker Compose を変える | `docker-compose.yml` と `.env.example` |
| scripts 配下の helper を使う・変える | `CONTRIBUTING.md` と対象スクリプト |

## 開発フロー

PoC 実装段階から Issue / PR 駆動を基本とする。
順序: Issue 確認 → ブランチ作成 → 実装前計画提示 → 実装 → 検証 → コミット前停止 → コミット → 作業ブランチ push → PR → merge → cleanup。

`main` ブランチへの direct push は禁止する。ユーザーから依頼があっても実行せず、必ず PR を経由する。

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

`--body-file` には `.github/pull_request_template.md` をそのまま渡さず、テンプレートを埋めたコピーを別ファイルとして作成して渡す。
テンプレートをそのまま渡すと、未記入のプレースホルダ本文の末尾に helper が追記する `Closes #<issue番号>` が重複した壊れた PR になる。

```bash
./scripts/github/create-pr-with-labels.sh \
  --title "feat: add inventory purchase endpoint" \
  --body-file /path/to/filled-pr-body.md \
  --issue <issue番号> \
  --type type:feature \
  --area area:backend \
  --area area:poc \
  --risk risk:low \
  --cost cost:none \
  --base main
```

PR は通常 PR として作成する。draft PR にはしない。

### マージ後 cleanup

PR がマージされた後、次の Issue へ進む前に必ず実行する。
このヘルパーは PR が `MERGED` であることを確認し、base branch を最新化してから作業ブランチを整理する。

```bash
./scripts/github/cleanup-merged-pr-branch.sh <PR番号>
```

## 設計文書の更新と設計判断の記録

実装や PoC によって仕様・構成・運用手順が変わった場合は、まず該当領域の正本を更新する。
実装時は、仕様・構成・運用手順に加えて、監視・アラート・runbook・CI/CD・セキュリティ・コスト・利用者向け手順への docs 影響を必ず確認する。
影響がある場合は、同じ PR で該当領域の正本を更新する。正本がない場合に限り、最小限の docs を新規作成する。
影響がない場合は、不要な docs を増やさない。

現在の仕様・構成・運用手順は、領域ごとに定められた正本に従う。
ADR はその正本を置き換えるものではなく、重要な設計判断の背景・採択理由・トレードオフ・再検討条件を記録するものである。

トレードオフを伴う設計判断は `docs/adr/` に ADR として記録する。書き方と運用ルールは `docs/adr/README.md` に従う。ADR で判断が変わった場合は、影響する領域の正本も同じ PR で更新する。

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

### スキーマ変更フロー（AWS 環境 / Issue #92）

AWS 環境（dev / staging）の DDL は起動時適用ではなく TypeORM versioned migrations で管理する。

1. `npm run migration:create -- src/database/migrations/<変更内容のPascalCase名>` で雛形を作成し、SQL を手書きする（entity は定義していないため `migration:generate` は使えない。raw SQL を `queryRunner.query` で書く）。
2. 作成した migration class を `src/database/data-source.ts` の `migrations` 配列へ追加する。
3. ローカル PoC の正本 `database/schema.sql` も同じ PR で同期更新する。
4. ローカル検証: `npm run migration:run:local`（Docker Compose の PostgreSQL に適用）。
5. AWS への適用: スキーマ変更を含むリリースは `deploy-backend-<env>.yml` の `run_migrations=true` で実行する（migration 成功後にサービス更新）。単発適用は `db-migrate-<env>.yml`。
6. migration は後方互換（expand-contract）で書く。旧タスクが新スキーマ上で動く時間帯があるため。
7. baseline（`1751594400000-baseline.ts`）は凍結されており編集しない。

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
- `main` ブランチへの direct push
- GitHub Issue / PR の無断作成・無断編集
- secret / credential 値の出力
- `.env` ファイルのコミット

## ユーザー確認が必要な操作

以下は必ず事前にプランを提示し、ユーザーの確認を得てから実行する。

| 操作 | 確認のタイミング |
| --- | --- |
| Issue 起票 | 本文・ラベル案とコマンドを提示してから |
| 実装着手 | 変更対象・変更内容・影響範囲を提示してから |
| コミット | コミット前サマリを提示して停止してから |
| 作業ブランチ push | コミット確認後に明示的な許可を得てから |
| PR 作成 | タイトル・本文・ラベル・コマンド案を提示してから |
| ブランチ削除 | cleanup コマンド案を提示してから |
| データ削除 | 削除対象と復旧可否を提示してから |
