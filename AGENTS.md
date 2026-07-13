# AGENTS.md — ticket-c2c-platform Codex 作業ルール

このファイルは Codex が `ticket-c2c-platform` で作業する時の入口です。
共通運用ルールをこのファイルへ複製しすぎず、正本を参照して作業してください。

## 役割分担

- `AGENTS.md`: Codex 向けの作業入口。このファイルを Codex の正本とする
- `CLAUDE.md`: Claude Code 向けの作業入口。Codex の正本にはしない
- `CONTRIBUTING.md`: Issue / Branch / Commit / PR / Label / 軽運用・厳密運用の共通正本
- `docs/operations/github-flow-guardrails.md`: GitHub フローの設計意図、未採用案、再検討条件
- `.github/labels.yml`: ラベル一覧の正本
- `.github/pull_request_template.md`: PR 本文テンプレート
- `.github/ISSUE_TEMPLATE/feature_request.yml`: Web UI 用 Issue template
- `docs/issue-templates/feature_request.md`: CLI 用 Issue body template
- `docs/requirements/system-requirements.md`: 課題要件、スコープ、制約の正本
- `docs/poc/technical-validation-plan.md`: PoC と技術検証計画の正本
- `docs/architecture/dev-environment.md`: AWS dev 環境構成の正本
- `docs/adr/README.md`: ADR の採番・形式・ステータス運用の正本
- `docs/poc/inventory-schema.md`: 在庫 PoC の DB スキーマ説明
- `database/schema.sql`: ローカル PoC 用 PostgreSQL スキーマ

内容が衝突する場合は、共通運用は `CONTRIBUTING.md` を優先し、設計意図は `docs/operations/github-flow-guardrails.md` を参照します。
要件は `docs/requirements/system-requirements.md`、PoC 方針は `docs/poc/technical-validation-plan.md`、実際の DB 定義は `database/schema.sql` を優先します。

## 作業開始前に読むもの

1. `CONTRIBUTING.md`
2. `docs/operations/github-flow-guardrails.md`
3. `README.md`
4. `docs/requirements/system-requirements.md`
5. `docs/poc/technical-validation-plan.md`
6. 対象 Issue がある場合は `gh issue view <issue番号>`
7. 変更対象ファイル

作業内容に応じて、次の正本も読む。

| 条件 | 読むファイル |
|---|---|
| PR 作成 | `.github/pull_request_template.md` |
| Issue 作成 | `docs/issue-templates/feature_request.md` または `.github/ISSUE_TEMPLATE/feature_request.yml` |
| ラベル判断 | `.github/labels.yml` |
| 技術スタックや構成判断を変える | `docs/architecture/technology-stack.md` |
| 在庫 PoC の DB スキーマを変える | `docs/poc/inventory-schema.md` と `database/schema.sql` |
| Docker Compose を変える | `docker-compose.yml` と `.env.example` |
| scripts 配下の helper を使う・変える | `CONTRIBUTING.md` と対象スクリプト |

## GitHub 運用ヘルパー

Codex は GitHub 操作を手作業で再現せず、既存 helper を正規ルートとして使います。

| 操作 | 正規ヘルパー |
|---|---|
| Issue 作成 | `./scripts/github/create-issue-with-labels.sh` |
| PR 作成 | `./scripts/github/create-pr-with-labels.sh` |
| マージ後 cleanup | `./scripts/github/cleanup-merged-pr-branch.sh <PR番号>` |

Issue 作成と PR 作成は、実行前にユーザーへプランを提示して確認します。
Issue 本文には専用の運用区分欄を追加せず、起票前プランと PR 作成前プランで軽運用 / 厳密運用を判定します。
PR 作成時の `--body-file` には `.github/pull_request_template.md` をそのまま渡さず、テンプレートを埋めたコピーを別ファイルとして作成して渡します。テンプレートをそのまま渡すと、未記入のプレースホルダ本文の末尾に helper が追記する `Closes #<issue番号>` が重複した、壊れた PR になります。

`main` ブランチへの direct push は禁止です。ユーザーから依頼があっても実行せず、必ず PR を経由します。

PR がマージされた後、次の Issue へ進む前に必ず `cleanup-merged-pr-branch.sh` を実行します。
このヘルパーは PR が `MERGED` であることを確認し、base branch を最新化してから作業ブランチを整理します。

## Issue 着手

新しい Issue に着手する時は、最新の `main` から作業ブランチを切ります。

```bash
git switch main
git pull --ff-only origin main
git switch -c <issue番号>-<kebab-case要約>
```

既に未コミット変更がある場合は、勝手に stash / reset しません。変更内容を確認し、ユーザーの意図に沿って branch を切るか、先に commit するかを判断します。

## 設計文書の更新と設計判断の記録

実装や PoC によって仕様・構成・運用手順が変わった場合は、まず該当領域の正本を更新します。
実装時は、仕様・構成・運用手順に加えて、監視・アラート・runbook・CI/CD・セキュリティ・コスト・利用者向け手順への docs 影響を必ず確認します。
影響がある場合は、同じ PR で該当領域の正本を更新します。正本がない場合に限り、最小限の docs を新規作成します。
影響がない場合は、不要な docs を増やしません。

現在の仕様・構成・運用手順は、領域ごとに定められた正本に従います。
ADR はその正本を置き換えるものではなく、重要な設計判断の背景・採択理由・トレードオフ・再検討条件を記録するものです。

トレードオフを伴う設計判断は `docs/adr/` に ADR として記録します。書き方と運用ルールは `docs/adr/README.md` に従います。ADR で判断が変わった場合は、影響する領域の正本も同じ PR で更新します。

PoC の検証結果は、可能な限り数値で残します。

- 成功数 / 失敗数
- p50 / p95 / p99 レイテンシ
- エラー率
- PostgreSQL 更新試行数
- Valkey による拒否数
- 在庫超過が 0 であること

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

## コミットメッセージ

コミットを作成する場合は、必ず `CONTRIBUTING.md` の Conventional Commits ルールに従います。

独自判断で `wip`、`fix` のみ、`update files` のような曖昧なコミットメッセージを使ってはいけません。

## 禁止事項

次は、ユーザーから明示された場合でも実行前に確認します。

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
