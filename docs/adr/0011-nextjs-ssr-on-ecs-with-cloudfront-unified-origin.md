# 0011. フロントエンドを Next.js SSR コンテナとして ECS でホスティングし、CloudFront 統合オリジン + httpOnly Cookie 認証を採用する

## ステータス

Accepted（frontend origin 向け CloudFront `default_cache_behavior` の `allowed_methods` は Issue #236 で `GET/HEAD/OPTIONS` に制限した。詳細は「反対材料・トレードオフ」参照）

## 日付

2026-07-05

## 背景

バックエンド（認証 ADR-0010、イベント、購入、検索）は dev / staging で実環境検証済みだが、フロントエンドが存在せず、ユーザーフロー（signup → login → イベント登録 → 検索 → 購入）をブラウザから通しで検証できない。フロントエンド導入にあたり、次の 3 つの判断が必要になった。

1. **フレームワーク / ホスティング方式**: static export（S3 + CloudFront の静的 SPA）か、SSR コンテナ（ECS）か。
2. **経路設計**: フロントエンドと API を別サブドメイン + CORS で分けるか、CloudFront 前段の統合オリジン（同一ドメインでパスルーティング）にするか。
3. **認証トークンの保管場所**: JS から読める場所（localStorage / 非 httpOnly Cookie）か、httpOnly Cookie か。

## 決定

1. **Next.js（App Router / TypeScript / Tailwind CSS）を SSR モードのコンテナとして ECS Fargate でホスティングする。** static export / S3+CloudFront 静的 SPA は採用しない。イメージは standalone output の multi-stage ビルドとし、既存の ecs-service モジュールを再利用して `ticket-c2c-<env>-frontend` サービスとして稼働させる。
2. **CloudFront を前段に置き、統合オリジンのパスルーティングにする。** 公開名は `ticket-app-<env>.ticket-c2c.click`（ADR-0009 の `ticket-api-<env>` と対になる命名）。CloudFront は同一 ALB を 2 つの origin（api / frontend。frontend origin にのみ識別用 custom header を付与）として登録し、`/api/*` behavior → api origin、default behavior → frontend origin に振り分ける。ALB 側は custom header の listener rule で frontend target group へ転送し、**default action は従来どおり API target group のまま**にする（既存の `https://ticket-api-<env>` 直アクセス・smoke test・k6 は無変更で動く）。API は `/api` プレフィックス付きパスも受理する（起動時の Fastify hook でプレフィックスを除去）。第二 ALB は作らず、既存 ALB に target group と listener rule を追加する。
3. **JWT は httpOnly Cookie（`access_token`、Secure / SameSite=Lax / Path=/ / Max-Age=3600）で保持する。**（注: Max-Age はその後 [ADR-0012](./0012-refresh-token-rotation-and-auth-hardening.md) のアクセストークン 15 分化により 900 へ変更。現行仕様は ADR-0012 を参照。） `POST /auth/login` / `POST /auth/signup` が `Set-Cookie` で発行し、`JwtAuthGuard` は Authorization: Bearer（優先）と Cookie の両方を受け付ける。JSON body の `accessToken` は既存クライアント（k6 / smoke script）互換のため維持する。

## 根拠

- **SSR + ECS の主目的は学習・実践価値である。** このリポジトリは DevOps / SRE / Platform Engineering のポートフォリオであり、静的 SPA では S3 バケット 1 個で終わるフロントエンド配備を、あえて「コンテナとしての Next.js 運用」（イメージビルド、タスク定義、ヘルスチェック、デプロイ・ロールバック、CDN 経路設計）として構築することで、既存の ECS / ALB / CI-CD 資産の上にフロントエンド運用の設計判断を積む。これが第一の採用理由であり、技術的必然性からの選択ではないことを明記する。
- **副次的（かつ弱い）根拠として OGP がある。** イベント詳細・検索結果ページを共有した際の OGP / ソーシャルプレビューはクローラーが JS を実行しないためサーバーレンダリングされた HTML が必要になる。ただし現時点で共有機能は要件化しておらず、OGP だけなら SSG / プリレンダリングでも足りるため、これは単独では SSR+ECS を正当化しない。
- **統合オリジンは ADR-0005 の発展形である。** ADR-0005 は「prod では CloudFront + WAF + ALB へ発展させる」と明記しており、CloudFront を前段に置く本決定はその意図の実装である。別サブドメイン + CORS 案と比べ、(a) CORS 設定（preflight、credentials 付き Cookie の `Access-Control-Allow-Origin` 制約）が不要になり、(b) SameSite=Lax の Cookie が同一オリジンでそのまま機能し、(c) CDN のパスルーティング・キャッシュ分離（`/_next/static/*` は長期キャッシュ、`/api/*` と SSR はキャッシュ無効）というエッジ設計の実践材料になる。
- **ALB default action を API のまま維持する経路設計**により、既存のあらゆる検証資産（smoke test、k6、`gh workflow` の疎通確認）が無変更で動き、フロントエンド導入のブラストラジアスをフロントエンド経路に閉じ込められる。
- **httpOnly Cookie は XSS 耐性で localStorage に優る。** localStorage のトークンは XSS 一発で窃取できるが、httpOnly Cookie は JS から読めない。SameSite=Lax により CSRF の主要経路（クロスサイト POST）も塞がる。統合オリジン（決定 2）を採ることで、クロスサイト Cookie（SameSite=None + CORS credentials）の複雑さを持ち込まずに済む。

## 反対材料・トレードオフ

- **コストと運用対象の増加。** 静的 SPA（S3 ≈ $0）に対し、frontend ECS タスク（0.25 vCPU / 0.5GB、約 $9/月/環境）と CloudFront 従量課金が加わる。エフェメラル運用（ADR-0008）で稼働時間を検証時間に限定して緩和する。
- **CloudFront の destroy が遅い。** distribution の無効化 + 削除で 15〜20 分以上かかり、destroy workflow の所要時間が伸びる。
- **SSR は API 依存の障害面を持つ。** SSR ページのレンダリングが API 障害に巻き込まれ得る（静的 SPA なら殻は返る）。ヘルスチェックは API を触らない `/healthz` に分離して、frontend タスクの再起動ループは防ぐ。
- **Cookie 認証はトークン失効の弱点（ADR-0010 の L-9）をそのまま引き継ぐ。** リフレッシュトークン・即時失効は引き続きバックログ。また Bearer と Cookie の 2 経路を Guard が受けるため、検証ロジックの分岐が 1 つ増える。
- **`/api` プレフィックス除去 hook は暗黙の経路知識になる。** ALB にパス書き換え機能がないための実装であり、API Gateway 系ならルーティング層で解決できた。hook は main.ts に閉じ、単体テストで担保する。
- **同時デプロイの結合。** deploy-app workflow が backend / frontend を同時にデプロイするため、frontend のみの変更でも backend イメージが再ビルドされる。PoC 規模では許容し、頻度が上がったら workflow を分離する。
- **frontend origin の CloudFront `allowed_methods` を `GET/HEAD/OPTIONS` に絞った（Issue #236）。** 現状 frontend は Server Actions（`'use server'`）・form の `action` 属性・POST 等を受ける Route Handler のいずれも実装していないため、最小権限の原則で PUT/POST/PATCH/DELETE を許可しないことにした。`/api/*` behavior（バックエンドAPI向け）はフルメソッド許可のまま維持する。この制限により、将来 frontend に Server Actions や POST を受ける Route Handler を追加する場合、CloudFront 側の `allowed_methods` 拡張（`terraform/modules/cloudfront/main.tf` の `default_cache_behavior`）を実装の一部として必ず行う必要がある「気づきにくい依存」が生まれる。追加実装時はこの ADR を参照し、CloudFront の許可メソッド拡張をセットで行うこと。

## 再検討のトリガー

- 共有・SEO 要件が本格化し、ISR / エッジレンダリング等 Next.js のホスティング最適化（Vercel / Amplify Hosting / Lambda@Edge）が ECS 常駐より合理的になった場合。
- フロントエンドのトラフィック特性が API と大きく乖離し、ALB / CloudFront の分離（別 distribution / 別 ALB）が必要になった場合。
- WAF 導入時（ADR-0005 の prod 構想）。CloudFront への WAF アタッチと合わせてレート制限・認証系保護を再設計する。
- 認証で即時失効・リフレッシュトークンが要件化した場合（ADR-0010 の再検討トリガーと同一）。
- frontend に Server Actions（`'use server'`）または POST/PUT/PATCH/DELETE を受ける Route Handler を追加する場合。CloudFront の `allowed_methods` 拡張をセットで実装する（Issue #236）。
