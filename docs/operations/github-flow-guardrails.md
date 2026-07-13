# GitHub Flow Guardrails

`ticket-c2c-platform` の GitHub フローを、PoC の軽さを保ちながら、クラウド環境・DB・CI/CD・AI Agent 作業で必要な安全性を担保するための設計意図をまとめた文書です。

運用ルールの正本は [CONTRIBUTING.md](../../CONTRIBUTING.md) です。この文書では、採用方針の理由、未採用案、将来の再検討条件を補足します。

## 3 リポジトリ間の位置づけ

時系列では、`ticket-c2c-platform` は `idp-golden-path` より先に作られた実証リポジトリです。
ただし現在の方針としては、`terraform-hannibal` / `ticket-c2c-platform` で実証した Issue / PR 駆動、AI Agent 運用、CI ガードレール、ADR 運用を `idp-golden-path` が golden path として抽象化し、3 リポジトリをその型へ収束させていきます。

そのため、このリポジトリの GitHub Flow も、単独のローカルルールではなく、`idp-golden-path` が配布・標準化するリポジトリ運用ガードレールへ収束させる対象として扱います。
実装済みの業務・PoC 固有の判断はこのリポジトリに残し、横断的な運用ルールは golden path 側へ寄せます。

## 現時点の技術的な未収束点

2026-07-13 時点では、方針と docs は `idp-golden-path` の型へ寄せています。CI ガードレール本体（PR Policy Check / Commitlint / Gitleaks / Sync Labels）の reusable workflow 化と、CodeQL / Dependency Audit / Markdown Lint / Issue Template Check の新規導入がすべて完了しました（Issue #294 / #295 / #296 / #297 / #305 / #307）。

- PR Policy Check / Commitlint / Gitleaks / Sync Labels は、`idp-golden-path` の reusable workflow を `@v1` で消費する薄い caller workflow に置き換え済み。ローカルのチェックロジック実装は削除した。
- required status check 名は、caller/callee 合成名（`commitlint / Commitlint`、`pr-policy-check / PR Policy Check`、`gitleaks / Gitleaks Secret Scan`）に更新済み。ただし `idp-golden-path` の service baseline skeleton が例示する「caller/callee 同名」パターン（例: `Commitlint / Commitlint`）はそのまま採用していない。caller/callee で同一 job 名を使うと required check 名の文字列がそのまま重複し可読性を損なうと判明したため（Commitlint 移行 #294 で実測、idp-golden-path#106 に記録）、caller 側 job には `name:` を付けず job id にフォールバックさせている。
- Sync Labels は本リポジトリの `scripts/github/sync-labels.sh` が `lib/common.sh` に依存しない自己完結実装だったため、前提条件の追加作業なしで移行できた。
- CodeQL / Dependency Audit / Markdown Lint / Issue Template Check は、`idp-golden-path` の reusable workflow を `@v1` で呼ぶ caller workflow として新規導入した（Issue #305 / #307、PR #306 / #308）。いずれも本リポジトリに存在しなかった新しいガードレールであり、branch protection の required status checks には追加していない。導入や required 化は、運用負荷を見て別 Issue で判断する。
  - CodeQL: 導入直後、GitHub Code Scanning の自動差分比較チェックが「1 configuration not found」を出す不整合が判明した。原因は `security-scan.yml` 内の `sast-scan` job（週次のみ実行、PR 非トリガー）が、新規追加した `codeql.yml`（PR ごとに実行）と javascript-typescript の CodeQL 解析で重複していたこと。`sast-scan` job を削除し `codeql.yml` に一本化した（`dependency-scan` = Trivy はそのまま残す）。`sast-scan` の job 名は branch protection に登録されていなかったため影響はなかった
  - Dependency Audit: 本リポジトリは root（`package-lock.json`）と `frontend/`（`frontend/package-lock.json`）が独立した 2 つの npm プロジェクトのため、`working-directory` を変えて 2 job 呼び出す構成にした
  - Markdown Lint: 前提となる `lint:md` npm script・`markdownlint-cli2` 設定が本リポジトリになかったため新規追加した。既存 Markdown ファイル 31 件の書式修正（テーブル区切り記法・コードブロック言語タグ・空行）を伴うが、内容変更は `staging-environment.md` の未エスケープ pipe 文字修正（`capacity_profile=normal | full` が列区切りとして誤解釈されていた点）のみ
  - Issue Template Check: 本リポジトリの旧ローカル実装が `idp-golden-path` 側 reusable workflow の移植元だったため、ロジック自体に変更はない
- helper scripts の共通化（`idp-golden-path` の `scripts/github/lib/common.sh` 形式への統一）は未着手（今回のスコープ外）。
- backend / frontend build、DB migration、smoke test、deploy、Terraform apply / destroy などの業務・PoC 固有 workflow は、このリポジトリ固有の責務として残す。

## 目的

- `Issue -> Branch -> PR -> Merge -> cleanup` を推奨ではなく作業の基本線として定着させる
- AI Agent / CLI / API を使っても、Issue / PR の品質と変更追跡が崩れないようにする
- docs / PoC の軽微な変更は軽く進め、Terraform / AWS / DB / Security 変更は厳密に扱う
- `main` の履歴を、PR と CI を通った変更だけで構成する

## 設計原則

- 手順と必須項目は `CONTRIBUTING.md` を正本とする
- この文書は正本を置き換えず、理由・未採用案・再検討条件を記録する
- 軽運用でも Issue / Branch / PR は省略しない
- 厳密運用の判定はラベルだけで楽観せず、変更パスと変更内容で判断する
- AI Agent は下書きと整理を補助し、人間は起票判断・実装着手判断・PR 作成判断を担う

## 採用方針

### 共通ガードレール

- `main` への direct push は禁止し、作業ブランチから PR を経由する
- Issue と PR は `type / area / risk / cost` の必須ラベルを持つ
- PR 本文には `Closes / Fixes / Refs #<issue番号>` のいずれかを含める
- Issue 本文の最小項目は `目的 / 対象 / 受け入れ条件` とする
- Issue / PR 作成は helper を正規ルートとする
- PR は通常 PR として作成し、draft PR にはしない
- PR マージ後、次の Issue へ進む前に cleanup helper で作業ブランチを整理する

### 軽運用 / 厳密運用

軽運用は、README / docs の軽微な更新、コメントや文言修正、影響範囲が限定的な低リスク変更を想定します。
軽運用でも `Issue -> Branch -> PR` は維持し、最低限の追跡性を残します。

厳密運用は、次のような変更を想定します。

- `risk:medium/high`
- `cost:medium/large`
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

厳密運用 PR では、`ロールバック` に実質的な内容を書きます。見出しだけではなく、何を戻すか、どう戻すかが分かる最低限の説明を求めます。

### AI Agent 運用

- AI Agent は Issue 起票前に Issue プランを提示する
- ブランチを切った後、実装前に変更対象・変更内容・影響範囲を含む計画を提示する
- PR 作成前に PR プランを提示する
- ユーザーから依頼されても `main` へ direct push しない
- PR helper には埋めた PR body のコピーを渡し、テンプレート原本をそのまま渡さない
- 作業ブランチは push してよいが、PR は作成前プランを提示してから作成する

この流れは、AI Agent の速度を殺すためではなく、コードやインフラを変更する前に意図・影響範囲・リスク認識を合わせるためのものです。

### PR 品質ゲート

PR では次の観点を GitHub Actions で検査します。

- `PR Policy Check`: Issue link、必須ラベル、厳密運用時の rollback 欄
- `Commitlint`: PR title と PR 内コミットメッセージ
- `Backend Build`
- `Frontend Build`
- `Terraform Format & Validate`
- `Playwright E2E`
- `Gitleaks Secret Scan`

required status check として扱う check 名は、workflow の job `name` と揃えます。workflow 名や job 名を変える場合は、GitHub 側の branch protection / ruleset 設定との整合を確認します。

## 未採用案と理由

### `main` への直接 push

採用しません。

理由:

- Issue / PR による変更意図の追跡が消える
- AI Agent の変更がレビュー境界なしに `main` へ入る
- branch protection と required checks の価値がなくなる

### approval 常時必須

現時点では採用しません。

理由:

- ひとり開発では形式的な承認になりやすい
- PR 必須、必須 CI、Issue link、ラベル、事前計画確認で最低限の品質を担保できる
- 将来の複数人運用に移った時点で再検討できる

### draft PR を標準にする

採用しません。

理由:

- ひとり開発では `gh pr ready` の追加操作が運用負担になりやすい
- PR 作成前にプラン確認を挟むため、作成後に draft で止める価値が小さい
- 作りかけの共有が必要な場合だけ、個別に draft を選べばよい

### 全 PR で重い本文チェック

現時点では採用しません。

理由:

- 軽微な docs / CI 修正まで過剰に重くなる
- 全 PR で必須にするのは Issue link、必須ラベル、CI、Conventional Commits に絞る
- 厳密運用では rollback 欄を必須にして、リスクのある変更だけ説明を厚くする

### CODEOWNERS 即導入

現時点では採用しません。

理由:

- 現状は領域オーナーを分ける実益が薄い
- 少人数運用では、CODEOWNERS よりも PR plan と required checks の方が効く

## 将来の再検討条件

### approval 必須化

- 常時レビュー担当が 2 名以上いる
- 本番相当環境を継続運用する
- Terraform / DB / Security 変更を相互レビューできる体制になる

### CODEOWNERS

- `terraform/**`、`.github/workflows/**`、DB、Security などの領域責任者が分かれる
- レビュー責任を GitHub 上で明示する価値が運用コストを上回る

### Environment 承認の強化

- dev / staging ではなく、誤実行コストの高い prod 相当環境へ移行する
- deploy / destroy の実行者と確認者を分けられる体制になる
- 常設運用で夜間・障害時対応を含む変更管理が必要になる

### PR 品質ゲートの変更

- workflow job 名を変える
- required status check に新しい check を追加する
- paths filter 付き workflow を required 化する
- GitHub branch protection / ruleset の設定を変える

これらは PR がマージ不能になるリスクがあるため、変更時は docs と GitHub 設定の両方を同じ Issue / PR で扱います。
