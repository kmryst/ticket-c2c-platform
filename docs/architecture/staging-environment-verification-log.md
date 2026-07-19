# staging 環境検証記録

このドキュメントは、AWS staging 環境の初回構築、実装順序、負荷試験、failover、機能・可観測性の実地検証結果を保存する。現行の構成値と操作手順の正本は [staging 環境設計](./staging-environment.md)、未対応課題の正本は [Production Readiness バックログ](./production-readiness.md) とする。

## 初回 staging の境界

初回 staging は「ALB と、それより内部」を作り、DNS / ACM / HTTPS / フロントエンド公開は同時に実装しなかった。

理由:

- staging の最初の目的は、ECS、Aurora、Valkey、OpenSearch、EventBridge、SQS、Worker の配線と運用手順を検証すること。
- DNS / ACM / HTTPS は重要だが、初回構築の失敗要因を増やすため、ネットワーク・データ層の確認と分けること。
- ALB DNS name に対する HTTP smoke test で、アプリケーション経路の大半を先に検証できること。

初回は [ADR-0008](../adr/0008-staging-ephemeral-prod-like-environment.md) に従って `alb-http-only` で構築・検証した（Issue #91）。その後 Issue #94 で `https-dns` を追加し、Issue #232 で Terraform 変数の既定値も `https-dns` に統一した。

フロントエンド方式は [ADR-0011](../adr/0011-nextjs-ssr-on-ecs-with-cloudfront-unified-origin.md) で確定した。

| フロント方式 | 配置 | 判断 |
| --- | --- | --- |
| Static SPA / SSG | S3 + CloudFront | 不採用（コンテナ運用の学習・実践価値と OGP 用サーバーレンダリングを優先） |
| **Next.js SSR（採用）** | ECS Fargate（private subnet）+ CloudFront 統合オリジン | `ticket-app-<env>.ticket-c2c.click` → CloudFront →（`/api/*` は API target group、その他は frontend target group）→ 既存 ALB |

## 実装履歴

staging は次の順に Issue を分割して実装・検証した。現在は全 step 完了済み。

1. `capacity_profile` と endpoint mode をこのドキュメントの target に合わせる。対応済み（Issue #80 / #88）。
2. dev / staging の apply / destroy / deploy workflow を分ける。対応済み（Issue #89）。
3. staging smoke test script と `staging-smoke-test.yml` を追加する。対応済み（Issue #90）。
4. `capacity_profile=normal` で apply -> deploy -> smoke -> destroy を実行し、結果を検証記録へ残す。対応済み（Issue #91）。
5. schema migration を boot path から分離する。対応済み（Issue #92）。
6. `capacity_profile=full` で failover / 負荷検証を実施する。対応済み（Issue #93。結果は「full profile 検証結果」節を参照）。
7. 必要になった時点で `https-dns` endpoint mode を追加し、ACM / Route53 / HTTPS を staging で検証する。対応済み（Issue #94。`https-dns` を staging apply workflow の既定にし、HTTPS 応答・HTTP 301 リダイレクト・smoke green を実地確認済み）。

## full profile 検証結果（Issue #93 / #94、2026-07-04）

`capacity_profile=full` + `public_endpoint_mode=https-dns` で apply → deploy（`run_migrations=true`）→ 独立 migration 実行 → HTTPS smoke → k6 負荷試験 → failover 3 種 → destroy のフルサイクルを実施した。full 稼働時間は約 75 分（04:00 apply 開始 〜 05:1x destroy 完了、詳細は下記）。

### 構築・デプロイ

- `terraform-apply-staging.yml`（`capacity_profile=full` / `public_endpoint_mode=https-dns`）: success。NAT ×2、API/Worker desired 2、Aurora writer + reader（min 0.5 / max 8 ACU）、Valkey primary + replica、OpenSearch 2 node Multi-AZ、ACM + Route53 alias（`ticket-api-staging.ticket-c2c.click`）、DLQ アラーム（L-5）、Aurora backup retention 1 日 + auto minor version upgrade（L-7）を確認。
- `deploy-app-staging.yml`（`run_migrations=true`）: success。migration 成功後に API/Worker とも rolling deploy で **desired 2 / running 2** に到達（#92 の受け入れ条件「API を 2 タスク以上で同時起動しても DDL 競合が起きない」を実地確認）。
- `db-migrate-staging.yml`（deploy 非依存の単独実行）: success。`no pending migrations` を確認（#92 のもう一つの受け入れ条件を確認）。
- `staging-smoke-test.yml`（`https://ticket-api-staging.ticket-c2c.click`）: success。HTTP `/healthz` が `301` で HTTPS へリダイレクトされることを含め全アサーション green（#94 の受け入れ条件を確認）。
- OpenSearch アクセスポリシー: `describe-domain-config` で Principal が API/Worker task role に限定されていることを確認。smoke test の検索アサーションが成功しており、SigV4 署名クライアントでの疎通も実地確認済み（production-readiness M-3）。

### k6 負荷試験

対象: `https://ticket-api-staging.ticket-c2c.click`（seed: hot event 容量 6000、background 4 event 容量各 5000）。

| シナリオ | 設定 | p50 | p95 | p99 | エラー率 | 備考 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| baseline | BG_RATE=20, 60s | 41.9ms | 68.7ms | 178.4ms | 0% | 通常負荷の基準値 |
| spike（高負荷） | HOT_RATE=200 / BG_RATE=20, 60s | 4.6〜4.7s | 7.4〜7.5s | 7.6〜7.9s | 約 29〜30% | 下記「発見した問題」参照。DB pool 枯渇によるタイムアウト |
| spike（中負荷、hot 残数 330 消化） | HOT_RATE=50 / BG_RATE=10, 30s | 10〜41ms | 179〜249ms | 647〜785ms | 0% | Valkey 前段拒否が正常動作（`purchase_rejected_precheck` 1171 件、`purchase_rejected_db` 0 件、`purchase_http_error` 0 件） |
| soak（短縮、15分） | BG_RATE=8、failover 2 種と時間帯が重複 | 41.9ms | 9.01s | 12.21s | 9.42% | p95/p99・エラー率は failover 断時間の混入により悪化（下記参照） |

**oversold（在庫超過）検証**: 全 6 event で `remainingQuantity` が負値にならないことを確認（0 件）。hot event は 2 回の spike で在庫 6000 を使い切り、最終 `remainingQuantity=0`。

**発見した問題（spike 高負荷時）**: `HOT_RATE=200`（hot 1 event への集中）で、API 側 pg pool（`max: 10`、1 task あたり）が 2 task 合計 20 接続で飽和し、`Error: timeout exceeded when trying to connect`（pool の 5 秒待ちタイムアウト）が多発した。これは新規バグではなく、既存の pool sizing（technical-validation-plan / ADR-0004 で言及済みの制約）が今回の Fargate タスクサイズ・staging full の Aurora ACU 上限（8 ACU）でも同様に効くことを実地確認したもの。対応は将来の容量計画課題として `production-readiness.md` に残す（本検証では修正しない）。

### failover 検証

| 対象 | トリガー | AWS 側の切替完了 | アプリ観測の断時間 | 回復挙動 |
| --- | ---: | ---: | ---: | --- |
| Aurora reader failover | `aws rds failover-db-cluster`（04:32:22 UTC） | 04:33:01 UTC（約 39 秒、writer 昇格） | **約 84.2 秒**（04:32:39〜04:34:03 UTC） | **API プロセスがクラッシュ**（借用中 `PoolClient` の未捕捉 `error` event → exit code 1）。ECS が API 2 タスクとも再起動して復旧。AWS 側の failover 自体より断時間が長引いた。新規 Issue #108 として記録し、修正は別途実施する |
| Valkey automatic failover | `aws elasticache test-failover`（04:34:54 UTC） | 04:35:24 UTC（約 30 秒、primary 昇格） | 断続的に**約 18.2 秒**（2 つの短いブリップ、04:35:06〜04:35:27 UTC） | プロセスクラッシュなし。通常の例外処理でリクエスト単位のエラーとして吸収され、昇格後は自動的に復旧 |
| OpenSearch Multi-AZ | （明示的な node kill API がないため、構成確認 + 検索継続性で代替検証） | - | 検索リクエスト 30/30 成功（soak 期間中含む） | `instance_count=2`、`zone_awareness_enabled=true`（AZ count 2）を `describe-domain` で確認。index は既定の `number_of_replicas=1` で作成されており（`search-projection.worker.ts` で未指定のため OpenSearch 既定値）、単一ノード喪失時もデータ的には耐えられる構成であることを確認した |

Aurora と Valkey の断時間の非対称性（84.2秒 vs 18.2秒）は、アプリ側の DB クライアントエラーハンドリングの差（`pg.Pool` はチェックアウト中 client のエラーを未捕捉のままプロセスを落とす一方、`ioredis` 側は同種の切断を例外として通常のリクエスト処理内で吸収する）に起因する。

#### Aurora failover クラッシュ修正の再検証（Issue #108、2026-07-04）

上記で発見した Aurora failover クラッシュ（H-4）を `DatabaseService.connect()` の修正（PR #110 + リーク修正 #111）で解消し、同一構成（staging full）で再度 Aurora reader failover を実施して効果を確認した。

| 実施回 | トリガー | AWS 側の切替完了 | アプリ観測の断時間 | ECS タスク再起動 |
| --- | ---: | ---: | ---: | --- |
| 修正前（Issue #93） | 04:32:22 UTC | 04:33:01 UTC（約39秒） | 約84.2秒 | あり（desired 2 / running 0 まで低下） |
| 修正後・1回目 | 05:57:32 UTC | 05:58:10 UTC（約38秒） | 約4.4秒 + 単発0.5秒ブリップ | **なし**（desired 2 / running 2 を維持） |
| 修正後・2回目（BG_RATE=10の負荷を掛けながら） | 06:10:16 UTC | 06:10:51 UTC（約35秒） | **単発0.5秒ブリップのみ** | **なし** |

修正後は 2 回とも ECS タスクの再起動が発生せず、断時間は AWS 側の failover 切替時間（約35〜39秒）よりも短く収まった（ALB 配下の 2 タスクのうち影響を受けなかった側が readyz に応答し続けたため）。API ログでは `Error: Connection terminated unexpectedly` が通常の例外として `ExceptionsHandler` に捕捉され、プロセスは継続した。`MaxListenersExceededWarning` の再発もないことを確認済み（PR #111 のリーク修正）。

### destroy

`terraform-destroy-staging.yml` success。destroy 後確認（`terraform state list` 空、`terraform plan -destroy` no-op、`scripts/deployment/check-residual-resources.sh` 全項目 ok）に加え、AWS CLI で Aurora（`DBClusterNotFoundFault`）・OpenSearch（`ResourceNotFoundException`）・ECS（`INACTIVE`）・ALB/NAT/EIP/VPC/ElastiCache（空）を独立に再確認した。

## 初回構築時の Readiness checklist（完了済み）

staging normal の初回 apply 前に使用したチェックリスト。現在は全項目完了済みで、現行運用手順は [staging 環境設計](./staging-environment.md) を参照する。

- [x] GitHub Environment `staging` / `staging-destroy` に required reviewer と branch restriction を設定する。Environment は先に手動作成して保護設定を入れてから workflow で参照する。対応済み（2026-07-03、Issue #65、PR #66。`staging` / `staging-destroy` は required reviewer あり、`dev` / `dev-destroy` / `staging` / `staging-destroy` の全 4 環境は custom branch policy で `main` 固定）。
- [x] bootstrap の `apply_environments` に `staging` / `staging-destroy` を追加し、bootstrap を再 apply する。対応済み（Issue #89、PR #97 で `bootstrap` / `staging` / `staging-destroy` を trust へ追加し、staging state 読み取り専用ロールも作成。2026-07-04 に bootstrap を再 apply 済み。`terraform-apply-staging.yml` が Environment `staging` の OIDC trust 経由で成功した実績あり（Issue #91 の検証サイクル））。
- [x] apply IAM ロールを `AdministratorAccess` から縮小する。対応済み（Issue #125、PR #126 / #127。カスタム最小権限ポリシー 2 本へ置換し、dev apply / deploy / destroy と staging plan を検証）。
- [x] staging 用 Terraform backend key を dev / prod と分離する。対応済み（Issue #78。`terraform/environments/staging/` を `staging/app/terraform.tfstate` で追加）。
- [x] Terraform root / state は `dev` / `staging` の環境単位にし、staging の通常構成 / 本番寄せ構成は `capacity_profile=normal|full` で切り替える。対応済み（Issue #78、Issue #80）。
- [x] staging の VPC CIDR を `10.10.0.0/16` にする。対応済み（Issue #88）。
- [x] staging の初回 endpoint を `alb-http-only` にする。対応済み（Issue #88）。その後 Issue #94 / #232 で通常運用と Terraform 変数の既定を `https-dns` に変更し、`alb-http-only` はローカル検証用 escape hatch として維持している（[ADR-0008](../adr/0008-staging-ephemeral-prod-like-environment.md)）。
- [x] staging normal の API / Worker desired count を各 1 にする。対応済み（Issue #88）。normal は autoscaling なし、full は API / Worker とも min 2 / max 4・CPU 60% target tracking を有効化済み（Issue #234、[ADR-0018](../adr/0018-ecs-autoscaling-scoped-to-staging-full.md)）。
- [x] seed data と smoke test を自動実行できる。対応済み（Issue #90、PR #98。smoke test が API 経由で test event を seed し、`staging-smoke-test.yml` が green で完走した実績あり（Issue #91 の検証サイクル））。
- [x] destroy workflow に `confirm=destroy-staging`、Environment protection、destroy 後確認を設定する。対応済み（Issue #89。`terraform-destroy-staging.yml` + `scripts/deployment/check-residual-resources.sh`）。
- [x] API / Worker の desired count を 2 以上にする前に、`schema-on-boot` を migration workflow / script へ移行する。対応済み（Issue #92。TypeORM versioned migrations + db-migrate workflow / deploy-app の run_migrations 入力）。
- [x] OpenSearch のアクセスポリシーを IAM 認証（SigV4 署名）に切り替える。署名クライアント実装は dev で先行検証済み（[production-readiness.md](./production-readiness.md) M-3、PR #75）。staging のアクセスポリシー Principal を API / Worker task role に限定（Issue #88）。**full 検証（Issue #93）で実地確認済み**: `describe-domain-config` で Principal 限定を確認、smoke test の検索アサーション成功により SigV4 署名クライアントでの疎通も確認（dev は `Principal:"*"` のまま互換維持）。
- [x] 未対応の Production Readiness 課題は `production-readiness.md` に集約する。初回構築時から継続運用中で、対応済み項目の詳細ログは `production-readiness-log.md` に分離している。

## フロントエンド実地検証（ADR-0011、Issue #146〜#148、2026-07-05〜06）

`public_endpoint_mode=https-dns` で staging normal を apply し、frontend service（Next.js SSR）と CloudFront 統合オリジンを含めて実地検証した。

- **apply / deploy**: `terraform-apply-staging`（`capacity_profile=normal` / `public_endpoint_mode=https-dns`）成功 → `deploy-app-staging`（`run_migrations=true`）成功。frontend ECR push + SHA 固定タスク定義 + `services-stable` 待ちも成功。
- **CloudFront ルーティング分割**: `https://ticket-app-staging.ticket-c2c.click/` が SSR トップ（`イベント一覧` を含む HTML）、`https://ticket-app-staging.ticket-c2c.click/api/events` が JSON（`[]`）、`.../events/new` が SSR HTML を返すことを確認。既存 `https://ticket-api-staging.ticket-c2c.click` への直接アクセスは無変更。
- **認証（httpOnly Cookie）**: `POST /api/auth/signup` が 201 + `Set-Cookie: access_token=...; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax`（dev/staging とも `Secure` 付与を確認。ローカルは `COOKIE_SECURE=false` で無効化）。※ Max-Age=3600 は本検証時点（2026-07-06、ADR-0011）の観測値。現行仕様はアクセストークン 15 分（Max-Age=900。ADR-0012、Issue #166）。
- **購入フロー**: 在庫 2 に対し `quantity=2` の購入が `status: confirmed`（`remainingQuantity: 0`）、続く `quantity=1` が `status: rejected` / `rejectionReason: sold_out_precheck`。トークンなし購入は 401。
- **Playwright E2E**（`E2E_BASE_URL=https://ticket-app-staging.ticket-c2c.click npx playwright test`）: signup→login→イベント登録→検索→購入 confirmed/sold_out→未ログイン誘導の 6 テストが **6/6 pass（11.3秒）**。
- dev（`https://ticket-app-dev.ticket-c2c.click`）でも同一検証を実施し、6/6 pass（16.4秒）。スクリーンショットは `docs/architecture/screenshots/frontend-dev/`（トップ / signup / login / 検索結果 / 購入確定 / 売り切れ）。
- 検証後、dev / staging とも destroy 済み（ADR-0008 のエフェメラル運用を継続）。

## L-9 staging 実地検証（ADR-0012、Issue #178、2026-07-06）

dev で実装・検証済みの L-9（リフレッシュトークン rotation / reuse detection / レート制限 / JWT シークレット current/previous、Issue #163〜#171、PR #164〜#176）を staging 環境の実体（terraform state・稼働中 ECS タスク）へ反映し、dev と同水準の実地検証を行った。

- **apply / deploy**: `terraform-apply-staging`（`capacity_profile=normal` / `public_endpoint_mode=https-dns`）成功 → `deploy-app-staging`（`run_migrations=true`）成功。migration ログで `AddRefreshTokens1783307740648` の適用を確認。
- **rotate-on-use**: `POST /auth/refresh` を実行するたびにリフレッシュトークンが新しい値へローテーションすることを確認（旧トークンと新トークンが異なる）。
- **reuse detection**: 使用済み（ローテーション済み）リフレッシュトークンを再提示すると 401 になり、同一トークンファミリーの他の（まだ有効なはずだった）ローテーション後トークンでの refresh も以降すべて 401 になることを確認（ファミリー全失効）。
- **logout 失効**: signup 直後のリフレッシュトークンで logout し、同トークンでの refresh が 401 になることを確認。
- **レート制限**: signup/login/refresh のレート制限を実測した。
  - login は同一メールへの誤パスワードログインを 11 回送ると 11 回目が 429（メール単位の第 2 系統が機能）。
  - signup の IP 単位レート制限は、CloudFront 経由の実トラフィック経路（`https://ticket-app-staging.ticket-c2c.click/api/auth/signup`）に対しては 11 回目で 429 + `Retry-After` header を確認できたが、API ドメイン直叩き（`https://ticket-api-staging.ticket-c2c.click/auth/signup`、CloudFront を経ない）では 11 回連続 201 となり IP 判定が効かなかった。これは `RATE_LIMIT_TRUSTED_PROXY_HOPS=1` が CloudFront → ALB の 1 hop を前提にしているためで、ADR-0012 に記載済みの既知の制約どおりであり dev の実測結果とも一致する。
- **JWT シークレット current/previous ローテーション**: `docs/runbooks/jwt-secret-rotation.md` の手順で Secrets Manager 上の `ticket-c2c-staging-jwt-secret` を実際にローテーションした（値は asm-exec 経由で agent に露出させずに操作）。ローテーション直後（`force-new-deployment` で API 再起動後）は、旧シークレット署名のアクセストークンが `previous` フォールバックで `GET /auth/me` 200、新規ログインのトークンも `current` 署名で 200。続けて `previous` を破棄して再起動すると、旧トークンは 401、新トークンは 200 のままとなり、無停止ローテーションの想定どおりの挙動を確認した。
- **Playwright E2E**（`E2E_BASE_URL=https://ticket-app-staging.ticket-c2c.click npx playwright test e2e/user-flow.spec.ts`）: signup→logout/login→イベント登録→検索→購入 confirmed/sold_out→silent refresh→未ログイン誘導の 7 テストが **7/7 pass（11.7秒）**。
- **staging-smoke-test.yml**: `deploy-app-staging` のローリング更新が steady state に達する前に実行した初回は、`GET /events/search` の projection 反映待ちがタイムアウトして失敗した。worker ログを確認したところ、新旧 worker タスクが一時的に併存し、同一イベントへの購入プロジェクション更新の処理順が入れ替わったことが原因（DB 側の在庫・oversold 防止は正常。他の smoke test アサーションは全部 PASS）。これは ADR-0004（SQS Standard を採用し順序を保証しない設計判断）で許容しているトレードオフの顕在化であり、L-9 のリグレッションではない。ECS サービスが steady state に達したことを確認してから再実行し、成功した。**今後の運用上の教訓**: デプロイ直後にテストを実行する場合は `aws ecs describe-services` で `running == desired` かつ最新イベントが `has reached a steady state` になっていることを確認してから smoke test / E2E を実行する。検索 projection の巻き戻り防止は [Production Readiness M-10](./production-readiness.md) に記録した。
- 検証後、staging は destroy 済み（destroy 後確認は「destroy 後確認」節のとおり実施）。

## L-13 / L-14 staging 実地検証（ADR-0014 / ADR-0015、Issue #203 / #205、2026-07-07）

dev で実装・検証済みの L-13（X-Ray 分散トレーシング + EMF ビジネスメトリクス）と L-14（購入 dual-key レート制限）を staging 環境へ反映し、dev と同水準の実地検証を行った。

- **apply / deploy**: `terraform-apply-staging` 成功 → `deploy-backend-staging`（`run_migrations=true`）成功。
- **X-Ray トレース連続性**: `POST /events` の trace を確認し、API root segment（`ticket-c2c-staging-api`）を親に Worker 側の `search-projection EventListed` span、Aurora / Valkey span、OpenSearch span までが単一 trace 内で継続することを確認（dev と同一構造）。staging はサンプリング率 0.1（`OTEL_TRACES_SAMPLER_ARG`）のため、購入リクエストの trace は一部しか残らなかったが、trace 構造自体は sampling 率と無関係に dev と同一だった。
- **EMF ビジネスメトリクス**: CloudWatch へ PurchaseConfirmed（Sum 13）・PurchaseRejected（Sum 1）・WorkerProcessingLagMs（Average 478〜1594ms）の自動抽出を確認（ValkeyFailOpen は未発生）。
- **購入レート制限（dual-key）**: user_id 系統は 10 回まで確定、11 回目で 429（`retryAfterSeconds=899`）。同一 IP の別ユーザー（NAT 相乗り想定）は user_id 超過後も 200 で通り、巻き込まれないことを確認（dev と同じ結果）。
- **smoke test 実行中に観測した既知事象**: `GET /events/search` の projection 最終反映値が期待値（`remainingQuantity=0`）ではなく `1` になった。worker ログを確認したところ、`deploy-backend-staging` によるローリング更新直後で worker タスクが再起動しており、2 件の `InventoryChanged` メッセージの処理順序が入れ替わったことが原因（DB 側の在庫確定・oversold 防止は正常）。L-9 staging 実地検証（上記節）で既に観測した ADR-0004（SQS Standard、順序非保証）のトレードオフが再度顕在化したもので、今回の X-Ray / レート制限変更によるリグレッションではない。恒久対応は [Production Readiness M-10](./production-readiness.md) に記録した。
- **新規発見（今回の変更に起因）**: ADOT collector 自身の内部メトリクス（自己監視、awsemf exporter）が `logs:PutLogEvents on /aws/ecs/application/metrics` の権限不足で送信できず、worker ログに `AccessDeniedException` が出続けている。dev では発生しなかった（原因未調査）。アプリのビジネスメトリクス（EMF、awslogs 経由）自体には影響なし。ユーザー判断により本 Issue の範囲では対応せず、Issue #212 として別途切り出した（→ 2026-07-08 対応済み。task role へ `logs:CreateLogGroup` / `CreateLogStream` / `PutLogEvents` を `/aws/ecs/application/metrics` ロググループに限定して追加。PR #216）。
- **destroy しない**: dev と異なり、ユーザー判断により今回は staging を destroy せず稼働状態のまま維持する。
