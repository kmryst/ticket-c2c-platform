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
| H-1 | IAM / CI-CD | apply IAM ロールが `AdministratorAccess` のまま。write 権限が漏れた場合、任意ブランチに `environment: dev` を書いた workflow を workflow_dispatch するだけで Admin 級クレデンシャルを取得できる。GitHub Environment `dev` / `dev-destroy` の required reviewer・ブランチ制限は対応済み（2026-07-03、Issue #65、PR #66）だが、IAM ロールの `AdministratorAccess` 縮小は未着手のまま残る。 | IAM ロールのスコープ縮小。dev で先に検証。 | 対応済み（2026-07-05、Issue #125、PR #126 + #127。`AdministratorAccess` を撤去し、bootstrap / dev / staging の全管理リソースを洗い出したうえでカスタム最小権限ポリシー 2 本（read 系はサービス単位で広め、write 系はリージョン条件またはプロジェクトプレフィックス ARN で限定。apply ロール自身・tfstate バケット・OIDC provider への自己管理権限を含む）へ置き換え。実地検証: bootstrap apply 1 回目（旧 Admin 権限下）成功 → 縮小後ポリシーで dev apply 実行時に Aurora の管理シークレット作成（`secretsmanager:CreateSecret`）権限漏れで失敗 → 追加コミット（PR #127）で是正 → bootstrap apply 2 回目で反映 → 縮小後ポリシー下で dev apply / deploy-app-dev / terraform-destroy-dev すべて成功し自己ロックアウトなしを確認。staging は `terraform plan` のみ確認（PR #126 / #127 の CI で pass）。検証後 dev は destroy 済み、staging は元々未構築） |
| H-2 | CI-CD | `terraform-destroy.yml` の「三重ゲート」のうち、`confirm` 入力一致チェックは workflow 定義ごと改変されれば回避できる。IAM trust は environment 名しか見ないため、H-1 と同じ対策（reviewer + ブランチ制限）で塞がる。 | H-1 と同一対応で解消。 | 対応済み（2026-07-03、Issue #65、PR #66） |
| H-3 | Reliability / Secrets | Aurora の RDS 管理マスターシークレットは既定で 7 日ごとに自動ローテーションされるが、ECS への注入はタスク起動時 1 回きり。7 日以上連続稼働（例: 長時間の負荷検証）させると、ローテーション後に認証エラーで API/Worker が静かに壊れる。`dev-environment.md` にこの落とし穴の記載がない。 | ローテーション時の運用手順明記、またはアプリ側の再接続実装。 | 対応済み（PR #32） |
| H-4 | Reliability | Aurora reader failover 中、チェックアウト中の `PoolClient`（`DatabaseService`）で予期しない接続切断が起きると、`pool.on('error')` では捕捉できず未捕捉例外で API プロセスがクラッシュする。2026-07-04 の staging full 検証（Issue #93）で実測: AWS 側の failover 完了は約39秒だが、クラッシュ+ECS 再起動により実際のサービス断は約84.2秒に拡大した。 | チェックアウト中 client にも error handler を付与する。 | 対応済み（Issue #108、PR #110 + #111。`DatabaseService.connect()` でチェックアウト中 client に error listener を付与し、`release()` 時に確実に解除。2026-07-04 に staging full で再検証: 同一条件の Aurora reader failover（AWS 側切替 約35〜38秒）で、修正後の API 観測断時間は **0.5〜4.4秒**（2 回とも ECS タスク再起動なし、desired 2 / running 2 を維持）。修正前の約84.2秒から大幅に短縮し、AWS 側の切替時間よりも短い断時間に収まることを確認） |

## Medium

| ID | カテゴリ | 現状の挙動と実害シナリオ | 対応コスト | ステータス |
|---|---|---|---|---|
| M-1 | Data-integrity | `requestId` 付きリクエストは Valkey 前段フィルタを常時バイパスする。悪意あるクライアントがランダムな `requestId` を送れば、売り切れ後もフィルタを素通りして Aurora に直接負荷をかけられる（在庫超過は起きないが、影響隔離が破れる）。 | 前段フィルタの設計見直し。 | 対応済み（2026-07-05、Issue #129、PR #130。requestId の有無にかかわらず前段フィルタ（reserve）を必ず通し、売り切れ時は「DB 確定済み requestId」マーカー（COMMIT 後に Valkey へ記録、buyer/event/requestId scope、TTL 24h）がある場合のみ idempotent replay 候補として DB 判定へ流す方式へ変更。replay が在庫を消費しない場合の reserve 補償（release）も追加。dev 実環境で検証: 売り切れ後のランダム requestId 200 並行が 200/200 `sold_out_precheck`（Aurora 未到達）、正規 replay は元の confirmed row（同一 purchaseId・当時の snapshot）を返却、別 buyer の同一 requestId は前段拒否。既知のトレードオフ: マーカー書き込み失敗・TTL 失効後の売り切れ後再送は前段拒否される（Valkey を正本にしない fail-open 設計の許容範囲）） |
| M-2 | Data-integrity | `syncCounter` は DB の残在庫でカウンタを無条件 SET するため、並行する `reserve`（DECRBY）とのレースで、在庫があるのに `sold_out_precheck` と誤って拒否され得る（超過ではなく機会損失方向）。`release()` の INCRBY もキー不在時に新規キーを作り、誤拒否の温床になる。 | `syncCounter` / `release` の Lua 化。 | 対応済み（2026-07-05、Issue #129、PR #130。カウンタ変更（init/reserve/release/sync）を version キー付き Lua script に統一し、`syncCounter` は「DB 判定前に控えた version」との CAS（不一致なら上書き見送り）へ変更。`release` はカウンタ不在時に no-op（キー捏造防止）。レース再現を含む単体テスト（jest + 実 Valkey、22 tests）を新設し pr-check で常時実行。dev 実環境で検証: 在庫 100 に 200 並行購入で confirmed ちょうど 100・最終 remaining 0（在庫超過 0、誤 sold_out による機会損失 0）。検証後 dev は destroy 済み） |
| M-3 | Network / Secrets | OpenSearch のアクセスポリシーが `Principal: "*"` + `es:*`、クライアントは無署名 HTTPS。VPC 内 SG（app SG からのみ）で dev では成立するが、staging/prod で IAM 認証を有効化するにはアプリ側の SigV4 署名実装が必須になる。 | staging 前に SigV4 署名実装。 | 対応済み（PR #75 でクライアント側 SigV4 署名を実装、PR #95（Issue #88）でアクセスポリシーを API/Worker task role に限定。2026-07-04、Issue #93 の staging full 検証で実地確認済み: `describe-domain-config` で Principal 限定、smoke test の検索アサーション成功で SigV4 疎通を確認） |
| M-4 | Secrets | DB 接続が `rejectUnauthorized: false`（TLS 暗号化はするが証明書検証なし）。 | RDS CA バンドル同梱、数行で解消。 | 対応済み（PR #68） |
| M-5 | Network | ALB が HTTP:80 のみで認証なし。稼働中はインターネット全体から平文で公開 API が叩ける。dev-environment.md のコスト前提（アイドル時 Aurora ≈ $0）が外部トラフィックで崩れ得る。 | 検証時のみ ingress を自分の IP に絞る変数を用意、または HTTPS 化。 | 対応済み（PR #72。HTTPS 化 + `alb_allowed_ingress_cidrs` 変数。判断は [ADR-0007](../adr/0007-alb-https-with-acm-and-ingress-variable.md)） |
| M-6 | Cost | コスト表に Interface VPC Endpoint（ecr.api / ecr.dkr / logs × 2AZ = 6 ENI）の費用（月額約 $60）が未計上。実際は見積り（~$120/月）より高い。 | コスト表への追記。 | 未着手 |
| M-7 | CI-CD | `deploy-app.yml` がリソース名（ECR/クラスタ/サービス名）をハードコード。`var.name` を変えると deploy が壊れる。タスク定義が `:latest`（MUTABLE）参照のため、ロールバック手段がコミット再ビルドしかない。 | イメージタグを commit SHA 固定へ移行。 | 対応済み（PR #70。タスク定義の SHA 固定と `image_tag` 入力によるロールバック経路を実装。リソース名のハードコードは deploy が dev 専用 workflow である間は許容） |
| M-8 | Data-integrity | 購入 API が `buyerId` をクライアント申告の UUID のまま信用して保存しており、購入者のなりすまし・購入履歴の汚染が自由にできる（buyer table も FK も存在しない、M-1 と同時代のパターン）。 | 認証導入と buyer_id のサーバ側決定。 | 対応済み（2026-07-05、ADR-0010、Issue #132〜#135、PR #136〜#139。メール+パスワード認証（bcrypt 12 + JWT HS256 1h + 自作 Guard）を導入し、`POST /events/:eventId/purchases` を認証必須化。`buyer_id` は JWT の sub claim（users.id）由来となり、body の `buyerId` は 400 で拒否。`purchases.buyer_id -> users.id` の FK（NOT VALID）で参照整合性も DB 側で保証。JWT シークレットは Secrets Manager + Terraform で dev / staging へ配備） |

## Low

| ID | カテゴリ | 現状の挙動と実害シナリオ | 対応コスト | ステータス |
|---|---|---|---|---|
| L-1 | CI-CD | GitHub Actions がタグ pin（`@v4` 等）で SHA pin でない。Admin 級ロールを扱う workflow としてはサプライチェーン改竄の影響が大きい。 | commit SHA pin への切り替え。 | 未着手 |
| L-2 | CI-CD | `terraform-plan.yml`（pull_request トリガー）は、同一リポジトリの PR で悪意ある provider/external data source を仕込むと plan ロール（ReadOnlyAccess）で任意コード実行が可能。フォーク PR からは `id-token: write` が付与されないため悪用不可（現状はコラボレータ本人のみのため許容）。 | 将来的な plan ロール sub のスコープ縮小。 | 未着手 |
| L-3 | Reliability | ECS サービスに `deployment_circuit_breaker` 未設定。壊れたイメージを push すると `aws ecs wait services-stable` がタイムアウトまでハングし、タスクが起動ループする。 | circuit breaker 設定の追加。 | 対応済み（Issue #88。ecs-service モジュールで rollback 付き circuit breaker を共通有効化。dev へは次回 apply で反映） |
| L-4 | Reliability | `schema-on-boot` は複数タスク同時起動時に DDL が競合し得る（現状 desired_count=1 のため未発生）。 | staging でマイグレーションツールへ移行。 | 対応済み（Issue #92。起動時 DDL を廃止し TypeORM versioned migrations + ECS run-task の migration workflow へ移行。runner は advisory lock で直列化） |
| L-5 | Reliability | Worker のバッチ処理で、1件でも例外を投げると同バッチ内の正常メッセージの削除もスキップされる。SQS DLQ に CloudWatch アラームがなく、滞留に気づけない。 | DLQ アラーム追加。 | 一部対応済み（Issue #100。DLQ 滞留 1 件以上で ALARM になる CloudWatch アラームを sqs モジュールへ追加。SNS 等の通知配線と、バッチ内の部分削除（正常メッセージのみ削除）は未対応） |
| L-6 | Network | Aurora / Valkey / OpenSearch の各 SG の egress が全開放（`0.0.0.0/0`）。マネージドサービス SG としては定番だが prod では絞る余地がある。 | prod 移行時に見直し。 | 未着手 |
| L-7 | Reliability | Aurora のバックアップ保持期間・マイナーバージョン方針が未指定（既定 1 日）。staging 用の変数化もまだ。 | staging 用変数の追加。 | 対応済み（Issue #101。aurora モジュールに backup_retention_period / preferred_backup_window / auto_minor_version_upgrade を変数化し、dev / staging root が明示値（retention 1 日・自動マイナー適用）を設定。prod では retention 7 日以上へ引き上げる） |
| L-8 | Reliability | 2026-07-04 の staging full 負荷検証（Issue #93）で、spike 高負荷（HOT_RATE=200rps）時に k6 のエラー率が約30%まで悪化した。baseline（20rps）では p95=68.7ms・エラー率 0% だが、spike では p50=4.6〜4.7s、p95=7.4〜7.5s、p99=7.6〜7.9s、エラー率約30%。原因は Postgres 接続プール上限（API タスクあたり 10 接続 × 稼働 2 タスク = 合計 20 接続）で、コード側のバグではない。oversold=0（過剰販売なし）はこの負荷条件下でも維持されていた。 | 対応の選択肢: (1) API タスクあたりのプールサイズ増（無料だがタスク数×プールサイズが Aurora の `max_connections` を超えないよう設計が必要）、(2) Aurora Serverless の ACU 上限引き上げ（コスト増）、(3) RDS Proxy 導入（追加の常駐コストが発生）。対応前に想定同時接続数（実トラフィック見込み）を確定させる必要がある。 | 未着手（Issue #113。想定トラフィックが未確定のため意図的に見送り。Issue #108（Aurora failover クラッシュ修正）と同じ検証サイクルで発見） |

| L-9 | Reliability | 認証（ADR-0010）はアクセストークン（1h）のみで、リフレッシュトークン・トークン失効（強制ログアウト）・レート制限・アカウントロックが未実装。トークン漏洩時は最長 1h 有効なまま無効化できない。JWT シークレットのローテーション運用も未整備（Secrets Manager 上の手動更新 + 再デプロイが必要）。 | リフレッシュトークン導入、認証系レート制限、シークレットローテーション手順の整備。 | 対応済み（2026-07-06、ADR-0012、Issue #163〜#171、PR #164〜#176。opaque リフレッシュトークン（DB へ SHA-256 hash のみ保存、Valkey 不使用）+ rotate-on-use + reuse detection（トークンファミリー全失効）+ logout 失効を導入し、アクセストークンを 1h から 15 分へ短縮。signup/login/refresh に IP + 第2系統（メール／refresh はトークン hash）単位の Valkey 固定ウィンドウレート制限を追加（fail-open）。JWT シークレットは Secrets Manager 上で `{current, previous}` の JSON 構造化し、`JwtAuthGuard` が current 優先・previous フォールバック検証で無停止ローテーションに対応（`docs/runbooks/jwt-secret-rotation.md`）。フロントエンドは 401 時の silent refresh（single-flight）で 15 分 TTL でもログイン状態を透過的に維持。単体テストを新規 45 件超追加。dev 実環境で検証: ① refresh のたびにリフレッシュトークンがローテーションし旧トークンは 401、② 使用済みトークンの再提示で同一ファミリー全体が失効し以降そのファミリーの全トークンが refresh 不可、③ logout で提示トークンのファミリーが失効、④ signup/login のメール・IP 単位レート制限が 11 回目以降 429（Retry-After header 付き）になることを確認（IP 判定は CloudFront 経由の実トラフィック経路 `app_fqdn/api/*` でのみ意図通り機能し、API ドメイン直叩きは CloudFront を経ないため trusted-hops の前提が崩れ IP 判定が効かないことも実測で確認。ADR-0012 記載の既知の制約どおり）、⑤ Secrets Manager 上の JWT シークレットを実際にローテーションし、切替直後は旧シークレット署名トークンが previous フォールバックで有効（200）、`previous` 破棄後は旧トークンが 401・新トークンのみ有効になることを確認、⑥ Playwright E2E（dev、silent refresh ケース含む）7/7 pass。検証後 dev は destroy 済み。既知の残課題: ~~`refresh_tokens` の期限切れ row の定期削除（cleanup job）は未実装~~（→ 2026-07-06 対応済み、Issue #195。EventBridge Scheduler（日次 03:30 JST）→ ECS RunTask（既存 API イメージの command override: `node dist/src/database/cleanup-refresh-tokens.js`、`run-db-migration.sh` と同じ「既存イメージ・別コマンド」パターン）で、ファミリー内の最大 `expires_at` が 30 日超過したトークンファミリーの row を一括削除する。row 単位ではなくファミリー単位なのは、自己参照 FK（`parent_token_id` / `replaced_by_token_id`）を単一 statement で安全に消すためと、reuse detection の系譜を調査猶予期間中は完全な形で残すため。`revoked_at` による早期削除はせず、失効済みファミリーも同じ期限で自然消滅する。Terraform は新規 `terraform/modules/scheduled-task`（`aws_scheduler_schedule` + `ecs:RunTask` / `iam:PassRole` 最小権限ロール）で dev / staging 両方へ適用。rotate-on-use / reuse detection のロジック（`refresh-tokens.service.ts`）は無変更。単体テスト（fake client + 実 PostgreSQL の削除条件検証）追加。）、レート制限の IP 判定は CloudFront 非経由経路（ALB 直叩き）でスプーフィング耐性が限定的（ADR-0012 に記載のトレードオフ）。**staging でも同水準の実地検証を実施済み（2026-07-06、Issue #178）**: `terraform-apply-staging`（`capacity_profile=normal` / `public_endpoint_mode=https-dns`）→ `deploy-app-staging`（`run_migrations=true`）で `refresh_tokens` テーブルのマイグレーションが適用されたことを確認し、dev と同じ ① 〜 ⑥ の検証項目（rotate-on-use、reuse detection によるファミリー全失効、logout 失効、signup/login のメール・IP 単位レート制限 429 + Retry-After、JWT シークレット Secrets Manager 実ローテーション（previous フォールバック→ previous 破棄後 401）、Playwright E2E 7/7 pass）を staging でも実測し、dev と同じ結果（IP 判定は CloudFront 経由 `app_fqdn/api/*` でのみ機能する制約含む）を確認した。詳細は `docs/architecture/staging-environment.md`「L-9 staging 実地検証」節を参照。検証後 staging は destroy 済み。） |
| L-10 | IAM / Data-integrity | `POST /events` が認証不要のまま（ADR-0011 のフロントエンド導入後も未変更）。誰でもイベント登録でき、`events` にオーナー（作成者）概念がない。購入のようなキーの不正利用被害はないが、スパム登録・ゴミデータ投入を防げない。 | イベント登録の認証必須化 + `events.created_by` の導入。 | 対応済み（2026-07-06、Issue #194。購入 API（Issue #135）と同じパターンで `POST /events` へ `JwtAuthGuard` を適用し、作成者はクライアント申告ではなく JWT の sub claim（users.id）を使用。C2C の性質上、主催者ロールのような権限階層は導入せず「JWT 認証済みの一般ユーザーなら誰でも登録可」とした。`events.created_by UUID` カラムと `users(id)` への FK（`NOT VALID` / `ON DELETE RESTRICT`、`purchases_buyer_id_fkey` と同じパターン）を migration で追加し `database/schema.sql` も同期。`GET /events` / `GET /events/search` は未認証のまま（閲覧は誰でも可）。フロントエンドのイベント登録フォームは 401 時にログインページへ誘導（purchase-form と同じ方針）。単体テスト追加（guard 適用・sub 由来の created_by・body 偽装値の無視）。ローカル実 API で 401 / 201 / created_by 偽装無視の 3 ケースを実測確認。dev / staging 実環境検証の結果はこの行に追記する。） |
| L-11 | CI-CD | `deploy-app-<env>.yml`（Issue #147）が backend / frontend を同時デプロイする。frontend のみの変更でも backend イメージが再ビルドされ、ロールバックも両者一体になる。 | デプロイ頻度が上がった時点で workflow を分離する。 | 未着手（ADR-0011 のトレードオフとして許容） |
| L-12 | Network | CloudFront（ADR-0011）に WAF・アクセスログが未設定。また frontend 振り分け用の識別ヘッダー（`x-ticket-dest`）が固定値の平文のため、ALB へ直接同じヘッダーを付けて送れば CloudFront を経由せず frontend target group に到達できる（公開コンテンツのため実害は小さいが、将来 CloudFront にレート制限・WAF を追加した際の迂回経路になる）。 | prod 化時に WAF + アクセスログ + ヘッダー値の秘匿化（Secrets Manager 由来のランダム値）を導入する。 | 一部対応済み（WAF: 2026-07-06、Issue #184。CloudFront に WAFv2 WebACL（scope=CLOUDFRONT、us-east-1）を関連付け。AWS マネージドルールグループ 3 種（CommonRuleSet / KnownBadInputsRuleSet / AmazonIpReputationList）を block mode で有効化。有料アドオン・rate-based rule は不採用（IP レート制限はアプリ層 Valkey で担保。ADR-0012）。コストは WebACL $5/月 + マネージドルール 3 本 $3/月 + リクエスト $0.60/100万 ≈ **$8/月**。アクセスログ・WAF ログ: 2026-07-06、Issue #185 で対応済み。CloudFront アクセスログは standard logging v2（vended log delivery。CloudFront 用 delivery 定義は us-east-1）で `<name>-cf-logs` バケット（通常リージョン）へ、WAF ログは `aws_wafv2_web_acl_logging_configuration` で `aws-waf-logs-<name>` バケット（us-east-1・プレフィックス必須）へ S3 直接配信。両バケットとも public access block + SSE + 30 日ライフサイクル + `force_destroy = true`（ephemeral destroy 運用）。**ヘッダー値の秘匿化（3 要素目）は導入せず、ALB 直叩き経路そのものを CloudFront managed prefix list で遮断する方針の新規 ADR（フェーズ B）で別途対応予定**。→ 2026-07-06、ADR-0013 / Issue #190 で対応済み: ALB SG ingress を CloudFront origin-facing managed prefix list に限定し、直叩きを遮断した。**ヘッダー秘匿化は不要と判断（ALB 直叩き自体を遮断したため、識別ヘッダーを知られても到達できない）**。SSR の API 呼び出しも CloudFront 経由（`app_fqdn/api`）へ変更し、全外部到達が CloudFront + WAF を通るようにした。dev / staging 両方で ALB DNS / API 直 URL への到達不能と CloudFront 経由フロー正常を実測確認） |

## 次の優先順位（推奨）

上記のうちどれから着手すべきかの推奨順位。2026-07-05、ユーザー・CODEX・Claude の議論で合意。

1. **H-1**: IAM apply ロールの `AdministratorAccess` 縮小。prod 化の前提条件となる唯一の残存 High リスクのため最優先。
2. **M-1 / M-2**: Valkey 前段フィルタの設計修正（requestId バイパス、`syncCounter` レース）。
3. **L-8**: 高負荷時の DB 接続/容量設計（Issue #113）。想定トラフィックの確定後に着手。
4. **L-5**: SLO 逸脱時の SNS 通知配線・アラート整備。
5. **L-1**: GitHub Actions の SHA pin 化。

## 監査で「問題なし」と確認済みの観点

- ネットワーク境界: app SG は ALB SG からの ingress のみ、data 層（Aurora/Valkey/OpenSearch）は app SG からの ingress のみ
- 秘密情報の扱い: state に平文パスワードなし、`.env` は未コミット
- **在庫超過防止の最終防衛線**（Aurora 条件付き UPDATE + CHECK 制約 + 行ロック）: 超過につながるレースは確認されなかった
- IAM の plan / apply ロール分離設計
- ADR と実装の整合性（乖離は本ドキュメントに記載の項目のみ）
- Dockerfile（multi-stage、非 root 実行、`.dockerignore` 適切）
