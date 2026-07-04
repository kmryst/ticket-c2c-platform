# dev 環境 本番化ギャップ一覧

## ステータス

2026-07-02、dev 環境（[dev 環境設計](dev-environment.md)）に対する全体監査（Fable、xhigh相当エフォート、コード差分ではなくリポジトリ全体を対象とした静的監査）で見つかった未対応課題を記録する。

ここに記載する項目は、dev 環境として意図的に許容している暫定措置、または staging / prod 展開前に対応が必要な既知のギャップである。トレードオフを伴う設計判断そのものは `docs/adr/` に ADR として記録し、このドキュメントは「まだ決めていない・直していない」項目のバックログとして運用する。

対応が完了した項目は削除せず、ステータス欄を更新する。

## 凡例

- **重大度**: High / Medium / Low
- **カテゴリ**: IAM / Network / Secrets / Reliability / Cost / CI-CD / Data-integrity
- **ステータス**: 未着手 / Issue化済み（#番号） / 対応済み

## High

| ID | カテゴリ | 現状の挙動と実害シナリオ | 対応コスト | ステータス |
|---|---|---|---|---|
| H-1 | IAM / CI-CD | apply IAM ロールが `AdministratorAccess` のまま。write 権限が漏れた場合、任意ブランチに `environment: dev` を書いた workflow を workflow_dispatch するだけで Admin 級クレデンシャルを取得できる。GitHub Environment `dev` / `dev-destroy` の required reviewer・ブランチ制限は対応済み（2026-07-03、Issue #65、PR #66）だが、IAM ロールの `AdministratorAccess` 縮小は未着手のまま残る。 | IAM ロールのスコープ縮小。dev で先に検証。 | 一部対応済み（reviewer/branch restriction: PR #66） |
| H-2 | CI-CD | `terraform-destroy.yml` の「三重ゲート」のうち、`confirm` 入力一致チェックは workflow 定義ごと改変されれば回避できる。IAM trust は environment 名しか見ないため、H-1 と同じ対策（reviewer + ブランチ制限）で塞がる。 | H-1 と同一対応で解消。 | 対応済み（2026-07-03、Issue #65、PR #66） |
| H-3 | Reliability / Secrets | Aurora の RDS 管理マスターシークレットは既定で 7 日ごとに自動ローテーションされるが、ECS への注入はタスク起動時 1 回きり。7 日以上連続稼働（例: 長時間の負荷検証）させると、ローテーション後に認証エラーで API/Worker が静かに壊れる。`dev-environment.md` にこの落とし穴の記載がない。 | ローテーション時の運用手順明記、またはアプリ側の再接続実装。 | 対応済み（PR #32） |

## Medium

| ID | カテゴリ | 現状の挙動と実害シナリオ | 対応コスト | ステータス |
|---|---|---|---|---|
| M-1 | Data-integrity | `requestId` 付きリクエストは Valkey 前段フィルタを常時バイパスする。悪意あるクライアントがランダムな `requestId` を送れば、売り切れ後もフィルタを素通りして Aurora に直接負荷をかけられる（在庫超過は起きないが、影響隔離が破れる）。 | 前段フィルタの設計見直し。 | 未着手 |
| M-2 | Data-integrity | `syncCounter` は DB の残在庫でカウンタを無条件 SET するため、並行する `reserve`（DECRBY）とのレースで、在庫があるのに `sold_out_precheck` と誤って拒否され得る（超過ではなく機会損失方向）。`release()` の INCRBY もキー不在時に新規キーを作り、誤拒否の温床になる。 | `syncCounter` / `release` の Lua 化。 | 未着手 |
| M-3 | Network / Secrets | OpenSearch のアクセスポリシーが `Principal: "*"` + `es:*`、クライアントは無署名 HTTPS。VPC 内 SG（app SG からのみ）で dev では成立するが、staging/prod で IAM 認証を有効化するにはアプリ側の SigV4 署名実装が必須になる。 | staging 前に SigV4 署名実装。 | 対応済み（PR #75。クライアント側 SigV4 署名を実装し dev で検証済み。アクセスポリシーの IAM 認証必須化は staging で実施） |
| M-4 | Secrets | DB 接続が `rejectUnauthorized: false`（TLS 暗号化はするが証明書検証なし）。 | RDS CA バンドル同梱、数行で解消。 | 対応済み（PR #68） |
| M-5 | Network | ALB が HTTP:80 のみで認証なし。稼働中はインターネット全体から平文で公開 API が叩ける。dev-environment.md のコスト前提（アイドル時 Aurora ≈ $0）が外部トラフィックで崩れ得る。 | 検証時のみ ingress を自分の IP に絞る変数を用意、または HTTPS 化。 | 対応済み（PR #72。HTTPS 化 + `alb_allowed_ingress_cidrs` 変数。判断は [ADR-0007](../adr/0007-alb-https-with-acm-and-ingress-variable.md)） |
| M-6 | Cost | コスト表に Interface VPC Endpoint（ecr.api / ecr.dkr / logs × 2AZ = 6 ENI）の費用（月額約 $60）が未計上。実際は見積り（~$120/月）より高い。 | コスト表への追記。 | 未着手 |
| M-7 | CI-CD | `deploy-app.yml` がリソース名（ECR/クラスタ/サービス名）をハードコード。`var.name` を変えると deploy が壊れる。タスク定義が `:latest`（MUTABLE）参照のため、ロールバック手段がコミット再ビルドしかない。 | イメージタグを commit SHA 固定へ移行。 | 対応済み（PR #70。タスク定義の SHA 固定と `image_tag` 入力によるロールバック経路を実装。リソース名のハードコードは deploy が dev 専用 workflow である間は許容） |

## Low

| ID | カテゴリ | 現状の挙動と実害シナリオ | 対応コスト | ステータス |
|---|---|---|---|---|
| L-1 | CI-CD | GitHub Actions がタグ pin（`@v4` 等）で SHA pin でない。Admin 級ロールを扱う workflow としてはサプライチェーン改竄の影響が大きい。 | commit SHA pin への切り替え。 | 未着手 |
| L-2 | CI-CD | `terraform-plan.yml`（pull_request トリガー）は、同一リポジトリの PR で悪意ある provider/external data source を仕込むと plan ロール（ReadOnlyAccess）で任意コード実行が可能。フォーク PR からは `id-token: write` が付与されないため悪用不可（現状はコラボレータ本人のみのため許容）。 | 将来的な plan ロール sub のスコープ縮小。 | 未着手 |
| L-3 | Reliability | ECS サービスに `deployment_circuit_breaker` 未設定。壊れたイメージを push すると `aws ecs wait services-stable` がタイムアウトまでハングし、タスクが起動ループする。 | circuit breaker 設定の追加。 | 対応済み（Issue #88。ecs-service モジュールで rollback 付き circuit breaker を共通有効化。dev へは次回 apply で反映） |
| L-4 | Reliability | `schema-on-boot` は複数タスク同時起動時に DDL が競合し得る（現状 desired_count=1 のため未発生）。 | staging でマイグレーションツールへ移行。 | 未着手 |
| L-5 | Reliability | Worker のバッチ処理で、1件でも例外を投げると同バッチ内の正常メッセージの削除もスキップされる。SQS DLQ に CloudWatch アラームがなく、滞留に気づけない。 | DLQ アラーム追加。 | 未着手 |
| L-6 | Network | Aurora / Valkey / OpenSearch の各 SG の egress が全開放（`0.0.0.0/0`）。マネージドサービス SG としては定番だが prod では絞る余地がある。 | prod 移行時に見直し。 | 未着手 |
| L-7 | Reliability | Aurora のバックアップ保持期間・マイナーバージョン方針が未指定（既定 1 日）。staging 用の変数化もまだ。 | staging 用変数の追加。 | 未着手 |

## 監査で「問題なし」と確認済みの観点

- ネットワーク境界: app SG は ALB SG からの ingress のみ、data 層（Aurora/Valkey/OpenSearch）は app SG からの ingress のみ
- 秘密情報の扱い: state に平文パスワードなし、`.env` は未コミット
- **在庫超過防止の最終防衛線**（Aurora 条件付き UPDATE + CHECK 制約 + 行ロック）: 超過につながるレースは確認されなかった
- IAM の plan / apply ロール分離設計
- ADR と実装の整合性（乖離は本ドキュメントに記載の項目のみ）
- Dockerfile（multi-stage、非 root 実行、`.dockerignore` 適切）
