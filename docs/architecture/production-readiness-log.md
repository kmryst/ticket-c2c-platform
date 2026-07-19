# Production Readiness 対応ログ

[production-readiness.md](production-readiness.md) の対応完了項目から、検証手順・実測値・教訓・複数段階の追記履歴を持つ記録だけを ID ごとに分離したもの。要約だけで完結する項目はこのファイルへ重複させない。各項目の現在のステータスと要約は production-readiness.md 側のテーブルを正本とする。

各 ID の記載は次の構成とする。

- **現状の挙動と実害シナリオ**: 対応前の状態
- **対応コスト**: 当時想定した対応内容
- **対応記録**: 移設前のテーブル「ステータス」列の全文

## High

### H-1

**現状の挙動と実害シナリオ**: apply IAM ロールが `AdministratorAccess` のまま。write 権限が漏れた場合、任意ブランチに `environment: dev` を書いた workflow を workflow_dispatch するだけで Admin 級クレデンシャルを取得できる。GitHub Environment `dev` / `dev-destroy` の required reviewer・ブランチ制限は対応済み（2026-07-03、Issue #65、PR #66）だが、IAM ロールの `AdministratorAccess` 縮小は未着手のまま残る。

**対応コスト**: IAM ロールのスコープ縮小。dev で先に検証。

**対応記録**: 対応済み（2026-07-05、Issue #125、PR #126 + #127。`AdministratorAccess` を撤去し、bootstrap / dev / staging の全管理リソースを洗い出したうえでカスタム最小権限ポリシー 2 本（read 系はサービス単位で広め、write 系はリージョン条件またはプロジェクトプレフィックス ARN で限定。apply ロール自身・tfstate バケット・OIDC provider への自己管理権限を含む）へ置き換え。実地検証: bootstrap apply 1 回目（旧 Admin 権限下）成功 → 縮小後ポリシーで dev apply 実行時に Aurora の管理シークレット作成（`secretsmanager:CreateSecret`）権限漏れで失敗 → 追加コミット（PR #127）で是正 → bootstrap apply 2 回目で反映 → 縮小後ポリシー下で dev apply / deploy-app-dev / terraform-destroy-dev すべて成功し自己ロックアウトなしを確認。staging は `terraform plan` のみ確認（PR #126 / #127 の CI で pass）。検証後 dev は destroy 済み、staging は元々未構築）

### H-4

**現状の挙動と実害シナリオ**: Aurora reader failover 中、チェックアウト中の `PoolClient`（`DatabaseService`）で予期しない接続切断が起きると、`pool.on('error')` では捕捉できず未捕捉例外で API プロセスがクラッシュする。2026-07-04 の staging full 検証（Issue #93）で実測: AWS 側の failover 完了は約39秒だが、クラッシュ+ECS 再起動により実際のサービス断は約84.2秒に拡大した。

**対応コスト**: チェックアウト中 client にも error handler を付与する。

**対応記録**: 対応済み（Issue #108、PR #110 + #111。`DatabaseService.connect()` でチェックアウト中 client に error listener を付与し、`release()` 時に確実に解除。2026-07-04 に staging full で再検証: 同一条件の Aurora reader failover（AWS 側切替 約35〜38秒）で、修正後の API 観測断時間は **0.5〜4.4秒**（2 回とも ECS タスク再起動なし、desired 2 / running 2 を維持）。修正前の約84.2秒から大幅に短縮し、AWS 側の切替時間よりも短い断時間に収まることを確認）

## Medium

### M-1

**現状の挙動と実害シナリオ**: `requestId` 付きリクエストは Valkey 前段フィルタを常時バイパスする。悪意あるクライアントがランダムな `requestId` を送れば、売り切れ後もフィルタを素通りして Aurora に直接負荷をかけられる（在庫超過は起きないが、影響隔離が破れる）。

**対応コスト**: 前段フィルタの設計見直し。

**対応記録**: 対応済み（2026-07-05、Issue #129、PR #130。requestId の有無にかかわらず前段フィルタ（reserve）を必ず通し、売り切れ時は「DB 確定済み requestId」マーカー（COMMIT 後に Valkey へ記録、buyer/event/requestId scope、TTL 24h）がある場合のみ idempotent replay 候補として DB 判定へ流す方式へ変更。replay が在庫を消費しない場合の reserve 補償（release）も追加。dev 実環境で検証: 売り切れ後のランダム requestId 200 並行が 200/200 `sold_out_precheck`（Aurora 未到達）、正規 replay は元の confirmed row（同一 purchaseId・当時の snapshot）を返却、別 buyer の同一 requestId は前段拒否。既知のトレードオフ: マーカー書き込み失敗・TTL 失効後の売り切れ後再送は前段拒否される（Valkey を正本にしない fail-open 設計の許容範囲））

### M-2

**現状の挙動と実害シナリオ**: `syncCounter` は DB の残在庫でカウンタを無条件 SET するため、並行する `reserve`（DECRBY）とのレースで、在庫があるのに `sold_out_precheck` と誤って拒否され得る（超過ではなく機会損失方向）。`release()` の INCRBY もキー不在時に新規キーを作り、誤拒否の温床になる。

**対応コスト**: `syncCounter` / `release` の Lua 化。

**対応記録**: 対応済み（2026-07-05、Issue #129、PR #130。カウンタ変更（init/reserve/release/sync）を version キー付き Lua script に統一し、`syncCounter` は「DB 判定前に控えた version」との CAS（不一致なら上書き見送り）へ変更。`release` はカウンタ不在時に no-op（キー捏造防止）。レース再現を含む単体テスト（jest + 実 Valkey、22 tests）を新設し pr-check で常時実行。dev 実環境で検証: 在庫 100 に 200 並行購入で confirmed ちょうど 100・最終 remaining 0（在庫超過 0、誤 sold_out による機会損失 0）。検証後 dev は destroy 済み）

### M-3

**現状の挙動と実害シナリオ**: OpenSearch のアクセスポリシーが `Principal: "*"` + `es:*`、クライアントは無署名 HTTPS。VPC 内 SG（app SG からのみ）で dev では成立するが、staging/prod で IAM 認証を有効化するにはアプリ側の SigV4 署名実装が必須になる。

**対応コスト**: staging 前に SigV4 署名実装。

**対応記録**: 対応済み（PR #75 でクライアント側 SigV4 署名を実装、PR #95（Issue #88）でアクセスポリシーを API/Worker task role に限定。2026-07-04、Issue #93 の staging full 検証で実地確認済み: `describe-domain-config` で Principal 限定、smoke test の検索アサーション成功で SigV4 疎通を確認）

### M-6

**現状の挙動と実害シナリオ**: コスト表に Interface VPC Endpoint（ecr.api / ecr.dkr / logs × 2AZ = 6 ENI）の費用（月額約 $60）が未計上。実際は見積り（~$120/月）より高い。

**対応コスト**: コスト表への追記（単価 $0.014/ENI-hour × 6 ENI = $0.084/時間、730時間換算で約$61.32/月相当。dev/staging はエフェメラル運用のため実際の月額は稼働時間に比例）。`dev-environment.md`（38行目）には「ECR / S3 / CloudWatch Logs は VPC endpoint 経由にして NAT 転送量を抑える」という既存の設計判断が明文化されているが、実際のデータ転送量と NAT 課金額（$0.062/GB）を比較した試算は見当たらず、コスト最適化の前提として未検証のまま。VPC Endpoint 固定費と NAT 経由の実データ量ベースコストを比較試算し、現行構成の妥当性を検証する必要がある。

**対応記録**: 対応済み（2026-07-15、Issue #313 / #315。コスト表是正は対応済み: `dev-environment.md` のコスト表へ Interface VPC Endpoint ~$61/月（$0.014/ENI-hour × 6 ENI × 730h ≒ $61.32）を計上し、常時稼働時合計を ~$200/月 へ是正。比較試算は損益分岐点分析として実施（dev/staging は低トラフィック・エフェメラル運用のため確定額の比較は誤差の範囲に留まり、構成判断の本質的な妥当性を評価する土台にならないため）。**損益分岐点**: Interface Endpoint 固定費 $0.084/時間（6 ENI × $0.014/ENI-hour）÷ NAT 転送単価 $0.062/GB ≒ **1.355 GB/稼働時間**（常時稼働換算では 730h × 1.355 ≒ **989 GB/月**）。稼働時間あたりの転送量がこれを上回れば Endpoint 維持が有利、下回れば NAT 一本化が有利。**dev/staging での実測**: Cost Explorer 請求実績（ap-northeast-1、2026-07-01〜07-15、dev/staging 合算）で、3 Interface Endpoint（ecr.api/ecr.dkr/logs、計 6 ENI）が 116 ENI-hour 稼働（＝環境稼働 116 ÷ 6 ≒ **19.3 稼働時間**相当）し、その間に実際に通過した合計データ量は 0.261 GB。稼働時間あたりに換算すると 0.261 GB ÷ 19.3 稼働時間 ≒ **約 0.0135 GB/稼働時間**で、損益分岐点 1.355 GB/稼働時間の約 **1/100**（この比率は 38 行目・147 行目に記載の期間合計コスト比「Endpoint 固定費 $1.624 が NAT 換算転送費 $0.0162 の約 100 倍」と整合する）。**独立したクロスチェック（ECR pull 頻度からの下限試算）**: 同期間の deploy workflow 実行回数はバックエンド 16 回（dev 10 + staging 6）+ フロントエンド 8 回（dev 5 + staging 3）= 24 回（2026-07-06〜07-12 の集中開発期間、定常運用の頻度ではない点に注意）、環境稼働 19.3 時間に対し 1.24 回/稼働時間。イメージ 1 回あたりの転送量は実測不能（destroy 時に `force_delete` で ECR リポジトリごと削除されるため過去イメージのサイズを取得できない）ため、NestJS/Next.js 本番用 Docker イメージの一般的なサイズ帯（**未検証の前提**: 300MB/pull、レイヤーキャッシュを無視した最悪ケース）を仮定すると 1.24 × 0.3GB ≒ 0.373 GB/稼働時間で、これも損益分岐点の約 1/3.6。クロスチェックは意図的に最悪ケースの仮定（毎回フルサイズ再取得）を置いているため実測（約 1/100）より高めに出るのは想定どおりであり、実測値・デプロイ頻度からの下限試算のいずれも独立に損益分岐点を大きく下回ることが確認できた。**本番規模での位置づけ（定性的）**: `capacity-planning.md` が明記するとおり、本番想定トラフィック自体が未確定（baseline RPS の逆算は同ドキュメントで「要検証」のまま未着手、`technology-stack.md` の「500万人ユーザー」「人気イベントは通常の約100倍」等の数字も出典不明の設計時想定）であり、本番で実際に月何 GB の ECR/Logs トラフィックが発生するかを確定額として試算することは現時点ではできない。条件文として示すと、**「本番でこの損益分岐点（1.355 GB/稼働時間、常時稼働なら月 989 GB 相当）を超える ECR/Logs 制御プレーン転送が発生するなら Endpoint 撤去は不利、下回るなら撤去が有利」**。この条件をどちらの側で満たすかは `capacity-planning.md` の baseline RPS 確定（①baseline の「要検証」項目）が前提条件であり、本 Issue では判断しない。**結論**: 現時点の dev/staging 運用では、実測・クロスチェックの両方が損益分岐点を大きく下回るため NAT 経由への一本化（ecr.api/ecr.dkr/logs の Interface Endpoint 3 種撤去、無料の S3 Gateway Endpoint は維持）が妥当と判断する。本番規模での要否判断は `capacity-planning.md` の baseline RPS 確定後に改めて評価する。撤去の Terraform 変更（`aws_vpc_endpoint.interface` と専用 SG の削除、S3 Gateway Endpoint は維持）と ADR 記録は [ADR-0019](../adr/0019-remove-ecr-logs-interface-endpoints.md) として完了（Issue #315）。この撤去に伴い `dev-environment.md` のコスト表は Interface VPC Endpoint 行を削除し、常時稼働時合計を ~$200/月 から **~$140/月** へ戻した（Endpoint 計上前と同額だが、今回は損益分岐点分析で検証済みという違いがある）。dev/staging への apply・実地検証はユーザー確認後に実施）

**後続項目**: dev / staging への apply と実地検証は、移設後の一覧で M-9 として分離した。

### M-8

**現状の挙動と実害シナリオ**: 購入 API が `buyerId` をクライアント申告の UUID のまま信用して保存しており、購入者のなりすまし・購入履歴の汚染が自由にできる（buyer table も FK も存在しない、M-1 と同時代のパターン）。

**対応コスト**: 認証導入と buyer_id のサーバ側決定。

**対応記録**: 対応済み（2026-07-05、ADR-0010、Issue #132〜#135、PR #136〜#139。メール+パスワード認証（bcrypt 12 + JWT HS256 1h + 自作 Guard）を導入し、`POST /events/:eventId/purchases` を認証必須化。`buyer_id` は JWT の sub claim（users.id）由来となり、body の `buyerId` は 400 で拒否。`purchases.buyer_id -> users.id` の FK（NOT VALID）で参照整合性も DB 側で保証。JWT シークレットは Secrets Manager + Terraform で dev / staging へ配備）

## Low

### L-5

**現状の挙動と実害シナリオ**: Worker のバッチ処理で、1件でも例外を投げると同バッチ内の正常メッセージの削除もスキップされる。SQS DLQ に CloudWatch アラームがなく、滞留に気づけない。

**対応コスト**: DLQ アラーム追加。

**対応記録**: 対応済み（2026-07-07、Issue #200。DLQ アラーム自体は Issue #100 で導入済み。①通知配線: 環境共通のアラート用 SNS トピック（observability モジュール、`<name>-alerts`）+ email subscription（通知先はメール。ユーザー決定）を新設し、DLQ アラームの `alarm_actions` / `ok_actions` へ配線（dev / staging 両 root。`alert_email` 変数、空文字で無効化可）。apply ロールへ SNS の read / write（プロジェクトプレフィックス ARN 限定）を追加（要 bootstrap apply）。email subscription は受信者の Confirm が必要で、destroy 前提運用の dev では apply のたびに confirm が発生する（既知の運用事項）。②「バッチ内で 1 件でも例外を投げると同バッチ内の正常メッセージの削除もスキップされる」という本行の旧記載は実装と乖離していた: `pollOnce()` は初期実装（PR #22）の時点から「1 件処理 → 直後にその 1 件だけ DeleteMessage」の逐次処理で、途中で例外が出ても処理済み分は削除済みのまま巻き戻らず、失敗分・未処理分は visibility timeout（60s）後に再配信され `max_receive_count`（5）超過で DLQ へ移る（意図どおり）。`handleMessage` の副作用はメッセージ 1 件につき eventId を doc ID とする OpenSearch upsert 系操作 1 回のみで冪等のため、再配信による二重処理も収束する。よってコード修正は不要（ドキュメントの記述ズレ）と判断し、この挙動（部分失敗時に処理済み分のみ削除・再配信の冪等性）を固定する単体テスト 3 件を `src/worker/search-projection.worker.spec.ts` へ追加（pr-check で常時実行）。dev 実地検証（2026-07-07、PR #201 マージ後に bootstrap apply → dev apply で実施）: SNS トピック `ticket-c2c-dev-alerts` + email subscription が作成され、DLQ アラームの alarm/ok actions に配線されたことを確認 → DLQ へテストメッセージ 1 件を送信し約 1 分で ALARM 遷移、アラーム履歴に SNS action の Successfully executed を記録 → DLQ purge で OK 復帰し、OK 側の SNS action も Successfully executed（apply 直後の初期 OK 遷移を含め計 3 回の action 実行成功。SNS `NumberOfMessagesPublished` メトリクスでも publish を確認）。**メールの実受信のみ未確認**: email subscription が検証時間内（約 50 分）に Confirm されず PendingConfirmation のままだったため（SNS は Confirm 前の publish をメール配信しない）。SNS への publish までは全経路検証済みのため配線としては完成しており、次回 dev / staging apply 時に届く確認メールを Confirm すれば、以降の ALARM / OK 遷移がメール配信される。検証後 dev は destroy 済み（destroy workflow の state 空検査・残存リソース検査 pass に加え、SNS トピック・SQS キューの残存なしを CLI で確認））

### L-9

**現状の挙動と実害シナリオ**: 認証（ADR-0010）はアクセストークン（1h）のみで、リフレッシュトークン・トークン失効（強制ログアウト）・レート制限・アカウントロックが未実装。トークン漏洩時は最長 1h 有効なまま無効化できない。JWT シークレットのローテーション運用も未整備（Secrets Manager 上の手動更新 + 再デプロイが必要）。

**対応コスト**: リフレッシュトークン導入、認証系レート制限、シークレットローテーション手順の整備。

**対応記録**: 対応済み（2026-07-06、ADR-0012、Issue #163〜#171、PR #164〜#176。opaque リフレッシュトークン（DB へ SHA-256 hash のみ保存、Valkey 不使用）+ rotate-on-use + reuse detection（トークンファミリー全失効）+ logout 失効を導入し、アクセストークンを 1h から 15 分へ短縮。signup/login/refresh に IP + 第2系統（メール／refresh はトークン hash）単位の Valkey 固定ウィンドウレート制限を追加（fail-open）。JWT シークレットは Secrets Manager 上で `{current, previous}` の JSON 構造化し、`JwtAuthGuard` が current 優先・previous フォールバック検証で無停止ローテーションに対応（`docs/runbooks/jwt-secret-rotation.md`）。フロントエンドは 401 時の silent refresh（single-flight）で 15 分 TTL でもログイン状態を透過的に維持。単体テストを新規 45 件超追加。dev 実環境で検証: ① refresh のたびにリフレッシュトークンがローテーションし旧トークンは 401、② 使用済みトークンの再提示で同一ファミリー全体が失効し以降そのファミリーの全トークンが refresh 不可、③ logout で提示トークンのファミリーが失効、④ signup/login のメール・IP 単位レート制限が 11 回目以降 429（Retry-After header 付き）になることを確認（IP 判定は CloudFront 経由の実トラフィック経路 `app_fqdn/api/*` でのみ意図通り機能し、API ドメイン直叩きは CloudFront を経ないため trusted-hops の前提が崩れ IP 判定が効かないことも実測で確認。ADR-0012 記載の既知の制約どおり）、⑤ Secrets Manager 上の JWT シークレットを実際にローテーションし、切替直後は旧シークレット署名トークンが previous フォールバックで有効（200）、`previous` 破棄後は旧トークンが 401・新トークンのみ有効になることを確認、⑥ Playwright E2E（dev、silent refresh ケース含む）7/7 pass。検証後 dev は destroy 済み。既知の残課題: ~~`refresh_tokens` の期限切れ row の定期削除（cleanup job）は未実装~~（→ 2026-07-06 対応済み、Issue #195。EventBridge Scheduler（日次 03:30 JST）→ ECS RunTask（既存 API イメージの command override: `node dist/src/database/cleanup-refresh-tokens.js`、`run-db-migration.sh` と同じ「既存イメージ・別コマンド」パターン）で、ファミリー内の最大 `expires_at` が 30 日超過したトークンファミリーの row を一括削除する。row 単位ではなくファミリー単位なのは、自己参照 FK（`parent_token_id` / `replaced_by_token_id`）を単一 statement で安全に消すためと、reuse detection の系譜を調査猶予期間中は完全な形で残すため。`revoked_at` による早期削除はせず、失効済みファミリーも同じ期限で自然消滅する。Terraform は新規 `terraform/modules/scheduled-task`（`aws_scheduler_schedule` + `ecs:RunTask` / `iam:PassRole` 最小権限ロール）で dev / staging 両方へ適用。rotate-on-use / reuse detection のロジック（`refresh-tokens.service.ts`）は無変更。単体テスト（fake client + 実 PostgreSQL の削除条件検証）追加。）、レート制限の IP 判定は CloudFront 非経由経路（ALB 直叩き）でスプーフィング耐性が限定的（ADR-0012 に記載のトレードオフ）。**staging でも同水準の実地検証を実施済み（2026-07-06、Issue #178）**: `terraform-apply-staging`（`capacity_profile=normal` / `public_endpoint_mode=https-dns`）→ `deploy-app-staging`（`run_migrations=true`）で `refresh_tokens` テーブルのマイグレーションが適用されたことを確認し、dev と同じ ① 〜 ⑥ の検証項目（rotate-on-use、reuse detection によるファミリー全失効、logout 失効、signup/login のメール・IP 単位レート制限 429 + Retry-After、JWT シークレット Secrets Manager 実ローテーション（previous フォールバック→ previous 破棄後 401）、Playwright E2E 7/7 pass）を staging でも実測し、dev と同じ結果（IP 判定は CloudFront 経由 `app_fqdn/api/*` でのみ機能する制約含む）を確認した。詳細は [staging 環境検証記録](./staging-environment-verification-log.md#l-9-staging-実地検証adr-0012issue-1782026-07-06)を参照。検証後 staging は destroy 済み。）

### L-10

**現状の挙動と実害シナリオ**: `POST /events` が認証不要のまま（ADR-0011 のフロントエンド導入後も未変更）。誰でもイベント登録でき、`events` にオーナー（作成者）概念がない。購入のようなキーの不正利用被害はないが、スパム登録・ゴミデータ投入を防げない。

**対応コスト**: イベント登録の認証必須化 + `events.created_by` の導入。

**対応記録**: 対応済み（2026-07-06、Issue #194。購入 API（Issue #135）と同じパターンで `POST /events` へ `JwtAuthGuard` を適用し、作成者はクライアント申告ではなく JWT の sub claim（users.id）を使用。C2C の性質上、主催者ロールのような権限階層は導入せず「JWT 認証済みの一般ユーザーなら誰でも登録可」とした。`events.created_by UUID` カラムと `users(id)` への FK（`NOT VALID` / `ON DELETE RESTRICT`、`purchases_buyer_id_fkey` と同じパターン）を migration で追加し `database/schema.sql` も同期。`GET /events` / `GET /events/search` は未認証のまま（閲覧は誰でも可）。フロントエンドのイベント登録フォームは 401 時にログインページへ誘導（purchase-form と同じ方針）。単体テスト追加（guard 適用・sub 由来の created_by・body 偽装値の無視）。ローカル実 API で 401 / 201 / created_by 偽装無視の 3 ケースを実測確認。dev / staging 実環境検証の結果はこの行に追記する。）

### L-11

**現状の挙動と実害シナリオ**: `deploy-app-<env>.yml`（Issue #147）が backend / frontend を同時デプロイする。frontend のみの変更でも backend イメージが再ビルドされ、ロールバックも両者一体になる。

**対応コスト**: デプロイ頻度が上がった時点で workflow を分離する。

**対応記録**: 対応済み（2026-07-06、Issue #180 / #182、PR #181 / #183。deploy-app workflow の共通部分を reusable workflow `deploy-service.yml` へ抽出したうえで、backend / frontend のデプロイ workflow を `deploy-backend-<env>.yml` / `deploy-frontend-<env>.yml` へ分離。frontend のみの変更で backend イメージが再ビルドされることはなくなり、ロールバックも系統別に可能。※ 本行のステータス反映が漏れていたため 2026-07-07（Issue #200 の PR）で訂正）

### L-12

**現状の挙動と実害シナリオ**: CloudFront（ADR-0011）に WAF・アクセスログが未設定。また frontend 振り分け用の識別ヘッダー（`x-ticket-dest`）が固定値の平文のため、ALB へ直接同じヘッダーを付けて送れば CloudFront を経由せず frontend target group に到達できる（公開コンテンツのため実害は小さいが、将来 CloudFront にレート制限・WAF を追加した際の迂回経路になる）。

**対応コスト**: prod 化時に WAF + アクセスログ + ヘッダー値の秘匿化（Secrets Manager 由来のランダム値）を導入する。

**対応記録**: 一部対応済み（WAF: 2026-07-06、Issue #184。CloudFront に WAFv2 WebACL（scope=CLOUDFRONT、us-east-1）を関連付け。AWS マネージドルールグループ 3 種（CommonRuleSet / KnownBadInputsRuleSet / AmazonIpReputationList）を block mode で有効化。有料アドオン・rate-based rule は不採用（IP レート制限はアプリ層 Valkey で担保。ADR-0012）。コストは WebACL $5/月 + マネージドルール 3 本 $3/月 + リクエスト $0.60/100万 ≈ **$8/月**。アクセスログ・WAF ログ: 2026-07-06、Issue #185 で対応済み。CloudFront アクセスログは standard logging v2（vended log delivery。CloudFront 用 delivery 定義は us-east-1）で `<name>-cf-logs` バケット（通常リージョン）へ、WAF ログは `aws_wafv2_web_acl_logging_configuration` で `aws-waf-logs-<name>` バケット（us-east-1・プレフィックス必須）へ S3 直接配信。両バケットとも public access block + SSE + 30 日ライフサイクル + `force_destroy = true`（ephemeral destroy 運用）。**ヘッダー値の秘匿化（3 要素目）は導入せず、ALB 直叩き経路そのものを CloudFront managed prefix list で遮断する方針の新規 ADR（フェーズ B）で別途対応予定**。→ 2026-07-06、ADR-0013 / Issue #190 で対応済み: ALB SG ingress を CloudFront origin-facing managed prefix list に限定し、直叩きを遮断した。**ヘッダー秘匿化は不要と判断（ALB 直叩き自体を遮断したため、識別ヘッダーを知られても到達できない）**。SSR の API 呼び出しも CloudFront 経由（`app_fqdn/api`）へ変更し、全外部到達が CloudFront + WAF を通るようにした。dev / staging 両方で ALB DNS / API 直 URL への到達不能と CloudFront 経由フロー正常を実測確認）

### L-13

**現状の挙動と実害シナリオ**: 購入フロー（HTTP → API → Postgres/Valkey → EventBridge → SQS → Worker → OpenSearch）を横断する分散トレーシングがなく、障害・遅延の切り分けがログの目視突き合わせに依存していた。購入判定・Valkey fail-open・Worker 処理遅延もログにしか残らずメトリクスとして時系列で追えなかった。

**対応コスト**: AWS X-Ray による分散トレーシング + CloudWatch EMF ビジネスメトリクスの導入。

**対応記録**: 対応済み（2026-07-07、ADR-0014、Issue #203、PR #206 / #209 / #210。OpenTelemetry SDK（opt-in、`OTEL_TRACING_ENABLED`）で API / Worker を計装し、ADOT collector sidecar（`essential=false`、OTLP → X-Ray）経由でトレースを送信。EventBridge detail の `_traceContext` フィールドで API → Worker の trace context を継続し、Worker 側は CONSUMER span として同一 trace に接続する。ビジネスメトリクス（PurchaseConfirmed / PurchaseRejected / ValkeyFailOpen / WorkerProcessingLagMs）は CloudWatch EMF（stdout 構造化ログ）で出力し、PutMetricData の API 呼び出し・追加 IAM を不要にした。task role へ `xray:PutTraceSegments` / `PutTelemetryRecords` のみ追加、X-Ray group（`service("<name>-api") OR service("<name>-worker")`）を dev / staging に作成。サンプリングは dev 1.0 / staging 0.1（`parentbased_traceidratio`）。**dev 実地検証**: 購入 1 リクエスト（`POST /events/:eventId/purchases`）の X-Ray trace を `get-trace-summaries` / `batch-get-traces` で確認し、Worker 側の `search-projection TicketPurchased` span の parent が API root segment（`ticket-c2c-dev-api`）と一致すること、その配下に OpenSearch（`vpc-...es.amazonaws.com`）span も含まれることを確認（API → Worker → OpenSearch が 1 trace で継続）。CloudWatch Logs Insights と `get-metric-statistics` で PurchaseConfirmed（Sum 13 前後）・PurchaseRejected（sold_out_precheck 1 件）・WorkerProcessingLagMs（Average 89〜156ms）が `TicketC2C/dev` 名前空間へ自動抽出されることを確認（ValkeyFailOpen は本検証中は未発生だが単体テストで動作確認済み）。apply role に `xray:CreateGroup` 等の権限が不足していたため bootstrap apply で追加（PR #209）。**staging 実地検証**（2026-07-07）: `terraform-apply-staging` → `deploy-backend-staging`（`run_migrations=true`）実施後、`POST /events` の X-Ray trace を確認し、API root segment（`ticket-c2c-staging-api`）を親に Worker 側の `search-projection EventListed` span、Aurora / Valkey span、OpenSearch（`vpc-...es.amazonaws.com`）span までが単一 trace で継続することを確認（サンプリング率 0.1 のため確定購入 3 件中トレースが残ったのは一部のみだったが、trace 構造自体は dev と同一）。CloudWatch へ PurchaseConfirmed（Sum 13）・PurchaseRejected（Sum 1）・WorkerProcessingLagMs（Average 478〜1594ms）の自動抽出も確認（ValkeyFailOpen は未発生）。**staging 実地検証で新規発見**: ADOT collector 自身の内部メトリクス（自己監視、awsemf exporter）が `logs:PutLogEvents on /aws/ecs/application/metrics` の権限不足で送信できず `AccessDeniedException` が worker ログに出続けている（dev では未発生、原因未調査）。アプリのビジネスメトリクス（EMF、awslogs 経由）自体は影響を受けず正常に届いている。ユーザー判断により今回のタスクでは対応せず、**Issue #212** として別途切り出した（→ 2026-07-08 対応済み。task role へ `logs:CreateLogGroup` / `CreateLogStream` / `PutLogEvents` を `/aws/ecs/application/metrics` ロググループに限定して追加。PR #216）。dev は検証後 destroy 済み。**staging は今回 destroy せず稼働状態のまま維持**（ユーザー判断）。既知のトレードオフは ADR-0014 参照。）

### L-14

**現状の挙動と実害シナリオ**: 購入エンドポイント（`POST /events/:eventId/purchases`）にアプリ層のレート制限がなく、認証済みボットによる購入リクエストの物量攻撃を直接抑える層がなかった。チケット C2C の性質上、最も攻撃価値が高いエンドポイント。

**対応コスト**: 認証系レート制限（ADR-0012）と同じ Valkey 固定ウィンドウ機構を再利用した dual-key レート制限の導入。

**対応記録**: 対応済み（2026-07-07、ADR-0015、Issue #205、PR #208。既存 `AuthRateLimitService`（ADR-0012）へ endpoint `purchase` を追加し、新しいレート制限機構は導入していない。dual-key 方式: user_id（JWT sub。secondary）10 回 / 15 分をプライマリゲート、IP 300 回 / 15 分を緩いバックストップとした。学校・オフィス NAT / 大手キャリア CGNAT 経由で相乗りする正規ユーザーを、IP を主キーにすると誤ブロックしてしまうため、認証必須エンドポイントの特性を活かし user_id を主体にした。超過時は 429 + `Retry-After`（既存パターン踏襲）。単体テスト（実 Valkey）で「同一 IP の別ユーザーは user_id 超過に巻き込まれない」「user_id を使い捨てても IP バックストップで止まる」の 2 ケースを追加。**dev 実地検証**: user_id 系統は 10 回まで確定（うち 1 回は在庫都合で reject だが試行自体はカウント）、11 回目で 429（`retryAfterSeconds=896`）を確認。同一 IP の別ユーザー（NAT 相乗り想定）は user_id 超過後も 200 で通り、巻き込まれないことを確認。検証後 dev は destroy 済み。**staging 実地検証**（2026-07-07）: 同様に user_id 系統 10 回まで確定、11 回目で 429（`retryAfterSeconds=899`）、同一 IP の別ユーザーは巻き込まれず 200 を確認（dev と同じ結果）。staging は今回 destroy せず稼働状態のまま維持（ユーザー判断）。既知のトレードオフ（固定ウィンドウの境界バースト、fail-open 時は制限が消える等）は ADR-0015 参照。**Issue #204 は本行と実質同一スコープの重複 issue と判断しクローズ**。ただし #204 が要求していた「超過時の構造化セキュリティログ + EMF メトリクス（PurchaseRateLimited）」は当初未実装だったため、差分として追加した（`rate-limit.service.ts`。超過時に `console.warn` で `{ event: 'rate_limit_exceeded', endpoint, ip, secondary, retryAfterSeconds }` を出力し、`emitMetric` で `<Endpoint>RateLimited` を記録。単体テストで JSON 構造と `PurchaseRateLimited` メトリクスの出力を確認）。）

### L-15

**現状の挙動と実害シナリオ**: （2026-07-10 追記）CloudFront response headers policy / Next.js側で `Strict-Transport-Security` / `X-Content-Type-Options` / `Referrer-Policy` / `frame-ancestors`（CSP）などの security headers が明示されていない。ブラウザ側の既定挙動に依存しており、クリックジャッキングや MIME スニッフィング等への防御層が薄い。（2026-07-11 追記）対応スコープは最小セット（HSTS / X-Content-Type-Options / Referrer-Policy / `frame-ancestors 'none'` + 旧ブラウザ向け `X-Frame-Options: DENY`）に限定する。フルCSP（`script-src` 等を含む本格的な CSP）は見送る: Next.js App Router は hydration 用の inline script を常に注入するため、意味のある `script-src` にはnonceベースCSP（middleware実装）が必須だが、CloudFront response headers policy はリクエストごとのnonceを注入できず静的ヘッダーの付与に留まる。nonce対応はNext.js側のコード変更を伴い、「既存のNext.jsコードには手を入れない」という制約に反するため、Low項目の対応としては過大と判断し、フルCSPはprod化時の別課題として残す。

**対応コスト**: CloudFront response headers policy でまとめて付与する。

**対応記録**: Terraform 定義済み・plan 検証済み、実地確認は未実施（2026-07-12、Issue #274。`terraform/modules/cloudfront` で response headers policy を新設し、default / `/_next/static/*` / `/api/*` の全 behavior へ関連付け。付与するヘッダーは HSTS（`max-age=31536000`、`includeSubDomains=false`、`preload=false`）/ `X-Content-Type-Options: nosniff` / `Referrer-Policy: strict-origin-when-cross-origin` / `Content-Security-Policy: frame-ancestors 'none'` / `X-Frame-Options: DENY`。CloudFront 境界で origin 側ヘッダーを override する。bootstrap apply role には response headers policy の create / update / delete 権限を追加。検証: `terraform fmt -check -recursive terraform` / dev・staging・bootstrap の `terraform validate` / dev・staging の `terraform plan -target=module.cloudfront` / bootstrap の `terraform plan -target=module.github_oidc`。bootstrap plan には未 apply の Synthetics 権限差分（Issue #256）も併発する。**実環境 apply 後の HTTP response header 確認は未実施**（次回 dev / staging apply の一回通し実地検証で確認する））（2026-07-12 追記、Issue #276。dev で実地確認完了: `curl -sD - https://ticket-app-dev.ticket-c2c.click/`（および `/api/healthz`）で `strict-transport-security` / `x-content-type-options` / `referrer-policy` / `content-security-policy: frame-ancestors 'none'` / `x-frame-options: DENY` の全ヘッダーを確認した。教訓: この dev apply の過程で apply role（`ticket-c2c-platform-gha-apply`）の IAM ポリシーに複数の権限漏れが判明し、PR #278・#280（`chore(infra): apply role のIAM権限を整理する` / `...追加で整理する`）で修正した。CloudFront response headers policy 自体は `cloudfront:CreateResponseHeadersPolicy` 権限追加（PR #278）で解消。（2026-07-12 追記。staging（https-dns）でも実地確認完了: `curl -sD - https://ticket-app-staging.ticket-c2c.click/` で dev と同一の全ヘッダーを確認した。これで dev / staging 両方の実地確認が完了）

### L-16

**現状の挙動と実害シナリオ**: （2026-07-10 追記）ALB / ECS のアラームは整備済みだが、CloudFront の 5xx 率・origin latency・WAF block 急増などエッジ側の CloudWatch アラームが未整備。アクセスログ・WAF ログ（L-12）自体は導入済みのため、次はログからのアラーム化が課題。（2026-07-11 追記）通知先 SNS トピックは us-east-1 に新設する: 新規 CloudWatch alarm（CloudFront / WAF）は us-east-1 リージョンのメトリクス（`Region = "Global"`）が対象で、CloudWatch alarm の `alarm_actions` は同一リージョンの SNS トピックしか指定できないという AWS 側の制約があるため、既存 Tokyo 側の SNS トピックは再利用できない。EventBridge による cross-region 集約も選択肢だが、対象が 3 アラームのみで構成過剰と判断し見送る。新規 SNS トピックは `terraform/environments/staging/main.tf` 側（`aws.us_east_1` provider。既存の ACM 証明書・WAFv2 WebACL・CloudFront ログ配信と同じ配置パターン）に新設し、既存の `alert_email` 変数を再利用して subscribe する。同一メールアドレスへ 2 つ目の SNS 購読確認メールが発生するが、既存 Tokyo 側と同じ受容済みの運用である。新規 CloudWatch alarm リソース自体も同じ理由で observability モジュールには入れず、staging/main.tf 側に us-east-1 provider で直接定義する。（2026-07-11 追記）3 アラームの閾値・評価期間: **5xx 率**は `IF(Requests>=10, 5xxErrorRate, 0) > 5%` を 2 期間（10 分継続）で評価する。ADR-0017 の `purchase_error_burn_rate` と同じ「低トラフィックガード付き割合」パターンを踏襲した。**Origin latency**は p90 2000ms を 3 期間（15 分継続）で評価する。`aws_cloudfront_monitoring_subscription`（有料アドオン）が別途必要になるが、既存のレイテンシ監視が購入 API の p95（ADR-0017）のみで購入以外の経路（検索・イベント一覧・SSR ページロード）を未カバーだったため、その穴を埋める目的で採用する。staging は destroy 運用のため実費は僅少。**WAF block**は絶対数 50 件 / 5 分を 1 期間（即時）で評価する。セキュリティシグナルは割合ガードをかけると初動検知が遅れるため、絶対数・即時検知とした。3 アラームとも `treat_missing_data = notBreaching`（ADR-0017 パターン踏襲）とする。

**対応コスト**: エッジ側メトリクスの CloudWatch アラーム追加。

**対応記録**: Terraform 定義済み・plan 検証済み、実地確認は未実施（2026-07-11、Issue #252、PR #261。dev / staging 両 root に us-east-1 の SNS トピック（`<name>-edge-alerts` + email subscription、`alert_email` 再利用）・`aws_cloudfront_monitoring_subscription`・3 アラーム（`cloudfront-5xx-rate` / `cloudfront-origin-latency` / `waf-block`、severity プレフィックス付き。詳細は `observability.md`「エッジ監視アラーム」節）を追加。staging は https-dns モード限定ゲート（`local.https_enabled`）付き。検証: `terraform fmt -check` / dev・staging の `terraform validate` / dev の実 backend `terraform plan` で、新規 6 リソースの作成・アラームの us-east-1 リージョン配置・`alarm_actions` の edge_alerts トピック配線・WAF dimension（`WebACL` + `Rule=ALL`、CLOUDFRONT scope は Region dimension なし）を確認。**実環境 apply 後の SNS action 配線確認・`set-alarm-state` による実発火確認は「AWS リソースを実際に作らない」方針（2026-07-11）により未実施**（次回環境構築を伴う実地検証時に確認する）（2026-07-12 追記、Issue #276。dev で実地確認完了: 3 アラームすべてを `aws cloudwatch set-alarm-state` で ALARM へ強制遷移し、describe-alarms で ALARM 状態・強制遷移から約 1 分以内の OK 自動復帰（次回メトリクス評価での上書き）を確認した。合わせて synthetic-check-failure alarm（Issue #256）も同一 us-east-1 SNS トピックへ正しく配線されていることを確認。教訓: edge alarm 3 本 + synthetic-check-failure alarm の Resource ARN が Tokyo リージョン固定になっており us-east-1 に非マッチという IAM ポリシー不備が dev apply で判明し、PR #280（`chore(infra): apply role のIAM権限を追加で整理する`）で修正した。（2026-07-12 追記。staging（https-dns）でも実地確認完了: edge 3 本を `set-alarm-state` で強制発火し ALARM 状態・約 1〜1.5 分での OK 自動復帰を確認した。PR #278・#280 適用後の staging apply では追加の IAM 権限漏れは発生しなかった。これで dev / staging 両方の実地確認が完了）（2026-07-13 追記、Issue #285。エッジアラームの ALARM 状態スクリーンショットを [`screenshots/observability-dev/03`](screenshots/observability-dev/03-alarms-useast1-edge-alarm-state.png) / [`screenshots/observability-staging/03`](screenshots/observability-staging/03-alarms-useast1-edge-alarm-state.png) に追加）

### L-18

**現状の挙動と実害シナリオ**: CloudWatch アラームは SNS email 1 系統に通知が集約されており、弱め通知・通常通知・即時対応が必要な通知の扱いがアラーム名や説明文に依存していた。prod 化前にどのアラームをどの緊急度で扱うかが明文化されていなかった。

**対応コスト**: severity 分類・通知先・エスカレーション条件の定義。

**対応記録**: 対応済み（2026-07-11、Issue #257。既存 22 本 + edge alarms 3 本（#252）+ synthetic alarm 1 本（#256、後日実装・本節へ反映済み）を Critical / Warning / Info の 3 段階に分類し、severity ごとの通知先・初動目標・確認タイミング・エスカレーション条件を [`docs/architecture/observability.md`](observability.md) の「アラームの severity と escalation 方針（Issue #257）」節に記録した。通知先 email は 1 アドレスを維持し、実装上はリージョン制約により東京の `<name>-alerts` と us-east-1 の `<name>-edge-alerts` の 2 SNS topic を使用する。severity 別 topic 分割は、対応者 1 名・destroy 運用主体という前提ではオーバーヘッドに見合わないため採用せず、prod 化時の再検討条件（常設運用化・対応者複数化・見逃し発生・ノイズ増）を明記。Slack / PagerDuty / severity 別 SNS routing の判断基準も記録（PagerDuty はオンコール輪番発生までは不採用、ADR-0011 のポートフォリオ主目的とも不整合と判断）。`purchase-technical-failure-weak` は Info tier の命名規約として正式化し、`-normal` / burn-rate 系との段階的エスカレーション関係を明文化。`unhealthy-hosts` 系（staging の `capacity_profile=full` による 2 タスク構成での縮退ケースを考慮）・Aurora 容量系は Composite Alarm を追加せず（ADR-0017 の composite alarm 不採用判断を踏襲）、`alb-5xx` 等との同時 ALARM 時に Critical へ格上げする併発エスカレーション運用をドキュメントのみで定義。Terraform 通知経路の変更（`alarm_description` への severity プレフィックス付与、severity 別 SNS routing）は後続 TODO として `observability.md` に記録し、本 Issue のスコープ外とした。→ 後続 TODO のうち severity プレフィックス付与は 2026-07-11 対応済み（Issue #272。既存 22 本の `alarm_description` へ `[Critical]`×4 / `[Warning]`×17 / `[Info]`×1 を付与。edge 3 本・synthetic 1 本は実装時に付与済み。あわせて `synthetic-check-failure` 用 runbook（`docs/runbooks/alarm-synthetic-check-failure.md`）を追加し、`observability.md` の runbook 表・該当 TODO を更新した。plan 差分が description のみであることは dev / staging / bootstrap の `terraform plan` で確認済みだが、**実環境への apply・実発火・メール件名での判別確認は未実施**で、次回 dev / staging apply の一回通し実地検証（別 Issue 扱い）で確認する））（2026-07-12 追記、Issue #276。dev で実地確認完了: severity 代表 3 本（Critical: `valkey-fail-open` / Warning: `worker-processing-lag` / Info: `purchase-technical-failure-weak`）+ edge 3 本を `set-alarm-state` で強制発火し、`describe-alarms` の `AlarmDescription` に設計どおりの `[Critical]` / `[Warning]` / `[Info]` プレフィックスが付与されていることを確認した。また、CloudWatch Dashboard（`<name>-overview`）の表示、synthetic canary（Issue #256 / #279）の成功 run（`PASSED`）も確認した。（2026-07-12 追記。staging（https-dns）でも実地確認完了: severity 代表 3 本 + edge 3 本すべてで `[Critical]` / `[Warning]` / `[Info]` プレフィックスを確認し、Dashboard 表示・synthetic canary の複数回連続 `PASSED`（`deploy-backend-staging.yml` の `run_migrations=true` でデプロイ直後から安定して成功）も確認した。これで dev / staging 両方の実地確認が完了）（2026-07-13 追記、Issue #285。Dashboard 表示・アラーム severity プレフィックス・synthetic canary 成功 run のスクリーンショットを [`screenshots/observability-dev/`](screenshots/observability-dev/) / [`screenshots/observability-staging/`](screenshots/observability-staging/) に追加。AWS アカウント ID 等はレダクト済み）

### L-19

**現状の挙動と実害シナリオ**: ALB / ECS / Aurora / EMF / 購入 API SLO 等の内部メトリクスは整備済みだが、実ユーザーに近い入口（CloudFront）から代表 read-only 経路が実際に到達可能かを継続確認する外形監視（synthetic monitoring）がなかった。

**対応コスト**: CloudWatch Synthetics canary によるユーザー入口の外形監視の追加。

**対応記録**: Terraform 定義済み・plan 検証済み、実地確認は未実施（2026-07-11、Issue #256。EventBridge + Lambda の自前実装ではなく、CloudWatch Synthetics canary の組み込みマルチステップ機能（`executeHttpStep`）を採用（設計判断確定済み）。単一の multi-step API canary（`terraform/modules/synthetics-canary`）が CloudFront 経由で `/api/healthz`（healthz 相当）・`/`（frontend HTML）・`/api/events`（API 代表 read endpoint。認証不要・L-10）の 3 step を順に GET し、いずれか 1 つでも失敗すると canary 全体が失敗として記録される。認証・secret を要する操作、副作用のある操作は対象外（read-only 限定）。canary 本体・失敗アラーム（`<name>-synthetic-check-failure`。severity: Critical）は us-east-1 に作成し、L-16 / Issue #252 で新設した `<name>-edge-alerts` SNS トピックへ ALARM / OK 両遷移を通知する（cloudfront-5xx-rate と同じ「2 期間（10 分）継続」パターン）。実行頻度は 5 分間隔（コスト影響は `observability.md` に記録。dev/staging は destroy 前提運用のため実費は僅少）。アーティファクト S3 バケットは `force_destroy = true` + 30 日ライフサイクルで、canary destroy 時に残存しない設計にしている（**Terraform コード上の設計であり、apply → destroy による実地確認は未実施**）。staging は `public_endpoint_mode=alb-http-only` の場合 CloudFront 自体が存在しないため canary モジュール呼び出しごと条件化（作成しない）。bootstrap 側の apply ロール IAM ポリシーへ `synthetics:*` 系アクション・対象 `iam:PassRole`（`lambda.amazonaws.com` / `synthetics.amazonaws.com`）をプロジェクトプレフィックス限定で追加。**AWS リソースは実際に作らない方針のため apply はせず**、`terraform fmt` / dev・staging・bootstrap 全 root の `terraform validate` / 実バックエンドに対する `terraform plan -target`（dev・staging の canary 一式 9 リソースと bootstrap の IAM ポリシー差分がエラーなく計画されることを確認）までとした。受け入れ条件にある「dev/staging での synthetic check 成功と alarm action 配線確認結果」は今回スキップし、次回 dev / staging apply の機会に確認する。（2026-07-11 追記）第三者レビュー（Codex）指摘により 3 点修正: ①`delete_lambda`（既定 `false`）を明示的に `true` にし、canary destroy 時に AWS 側の補助 Lambda・レイヤーが残存するバグを修正、②canary 実行ロールへ AWS 推奨の標準権限セットのうち不足していた `s3:GetObject`（artifacts バケットのオブジェクト ARN 限定）・`xray:PutTraceSegments`（`Resource="*"`）を追加、③本行・`observability.md` の「destroy で残存しない」という断定的な記述を「Terraform 定義済み、実地未検証」という正確な表現に修正）

**実地検証追記**: 2026-07-12、Issue #276。dev / staging の両環境で canary の成功 run（`PASSED`）を確認し、`synthetic-check-failure` alarm が us-east-1 の `<name>-edge-alerts` SNS トピックへ配線されていることを確認した。2026-07-13、Issue #285 で両環境の成功 run のスクリーンショットを追加した。

**destroy 後確認**: 2026-07-19、両環境が destroy 済みの状態で AWS を読み取り確認した。dev / staging ともに Synthetics canary、`cwsyn-*` Lambda 関数・Layer、artifact S3 bucket、canary IAM role、`synthetic-check-failure` alarm、関連 CloudWatch Logs log group は 0 件だった。あわせて `check-residual-resources.sh` を両環境へ実行し、東京リージョン側にも ALB / NAT Gateway / Aurora / ElastiCache / OpenSearch / ECS / VPC 等の残存がないことを確認した。
