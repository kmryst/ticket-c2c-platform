# 0013. ALB の ingress を CloudFront managed prefix list に限定し、直叩きを遮断する

## ステータス

Accepted

## 日付

2026-07-06

## 背景

ADR-0011 でフロントエンドを Next.js SSR コンテナ + CloudFront 統合オリジン構成にし、`ticket-app-<env>.ticket-c2c.click`（CloudFront）→ 同一 ALB を 2 origin（api / frontend）として振り分ける形にした。この時点で ALB のセキュリティグループ ingress は 80/443 を `0.0.0.0/0`（`alb_allowed_ingress_cidrs` の既定値）で開けており、`ticket-api-<env>.ticket-c2c.click`（ALB の Route53 alias）へインターネットから直接到達できる。

フェーズ A（L-12）で CloudFront に WAFv2 WebACL（AWS マネージドルール 3 種）を関連付けたが、WAF は CloudFront に対してのみ評価される。ALB へ直接アクセスする経路は CloudFront を経由しないため、**WAF を丸ごと迂回できる**。frontend 振り分け用の識別ヘッダー（`x-ticket-dest`）も固定値の平文のため、ALB へ同じヘッダーを付けて直接送れば frontend target group にも到達できる（L-12 の 3 要素目として「ヘッダー値の秘匿化」が挙げられていた）。

同じ「ALB へ直接到達できる」ことが、ADR-0012 のレート制限にも影響する。認証系レート制限は `X-Forwarded-For` の末尾から `RATE_LIMIT_TRUSTED_PROXY_HOPS`（CloudFront→ALB 構成で 1）段を信頼してクライアント IP を決めるが、CloudFront を経由せず ALB を直接叩くと trusted-hops の前提が崩れ、偽装 `X-Forwarded-For` で IP 判定をバイパスできる（ADR-0012 に既知の制約として記載済み）。

これら 2 つの問題（WAF 迂回・レート制限 IP バイパス）は、いずれも根本原因が「ALB にインターネットから直接到達できる」ことにある。

## 決定

ALB のセキュリティグループ ingress（80/443）を、**CloudFront の origin-facing managed prefix list**（`com.amazonaws.global.cloudfront.origin-facing`、リージョンごとに prefix list ID が異なる。ap-northeast-1: `pl-58a04531` / us-east-1: `pl-3b927c52`。値は AWS 管理で自動更新される）に限定し、`0.0.0.0/0` を撤去する。prefix list ID は `aws_ec2_managed_prefix_list` data source で名前引きし、ハードコードしない。

これに伴う経路依存を修正する:

- フロントエンド SSR のサーバー側 fetch（`API_BASE_URL`）を、ALB の API FQDN 直参照（`https://ticket-api-<env>...`）から **CloudFront 経由の FQDN（`https://ticket-app-<env>.../api`）** へ変更する。SSR は private subnet から NAT 経由で外に出るため、ALB を直接叩くと prefix list 制限で拒否される。CloudFront 経由にすることで SSR の API 呼び出しも WAF の評価対象になる。
- staging の smoke test が使う base URL（Terraform output `api_base_url`）を、https-dns モードでは CloudFront 経由の `https://ticket-app-staging.../api` にする。
- k6 / seed スクリプトの BASE_URL 例も CloudFront 経由の `/api` に揃える。

CloudFront は origin として `ticket-api-<env>...`（ALB の alias）へ接続するが、その接続元は CloudFront の origin-facing IP レンジ（= prefix list）であるため許可される。ALB の Route53 alias（`ticket-api-<env>`）自体は CloudFront origin の名前解決に必要なため残す。

適用範囲: dev は CloudFront が常に存在するため常に prefix list 制限。staging は CloudFront が `public_endpoint_mode = https-dns` のときだけ存在するため、https-dns のときのみ prefix list 制限とし、初回構築 fallback の alb-http-only（CloudFront なし・保護対象なし）では従来どおり `alb_allowed_ingress_cidrs` を使う。

## 根拠

- **単一の遮断点で 2 つの問題を同時解消する**: WAF 迂回とレート制限 IP バイパスの根本原因（ALB 直到達）を、ネットワーク層 1 か所（SG ingress）で塞ぐ。アプリ層の追加実装が要らない。
- **prefix list は AWS が維持する**: CloudFront の origin-facing IP レンジは AWS 側で managed prefix list として更新される。自前で CIDR を追随管理する必要がない。
- **追加コストなし**: SG ルールの変更のみ。CloudFront / WAF / ALB の構成は変わらない。

## 反対材料・トレードオフ

- **SSR → API が CloudFront 経由になり 1 ホップ増える**: ADR-0011 は SSR を ALB 直参照にしてレイテンシを抑えていた。本 ADR で SSR の API 呼び出しは NAT → CloudFront → ALB になり、レイテンシと NAT 転送量がわずかに増える。ただし SSR が呼ぶのは認証不要の `/events` 系のみ（レート制限対象外）で、CachingDisabled のため機能影響はない。ネットワーク境界の一貫性（全外部到達が CloudFront + WAF を通る）を優先する。
- **alb-http-only モードは保護しない**: CloudFront が無いモードのため prefix list 制限を掛けない。初回構築 fallback 専用（ADR-0008）で常用しないため許容する。
- **prefix list 制限だけでは L7 の CloudFront 識別ヘッダーは検証しない**: 別の AWS アカウントの CloudFront distribution も origin-facing prefix list に含まれるため、厳密には「任意の CloudFront」からは到達し得る。ただし自分の distribution 以外は正しい ACM/ホスト設定を持たず ALB のルーティングに乗らないため、実害は無視できる。より厳密にするには CloudFront → ALB 間の署名付きヘッダー（Secrets Manager 由来）を併用できるが、prefix list 制限で WAF 迂回とレート制限バイパスは解消するため、本 ADR の範囲では導入しない。

### 検討した代替案

- **識別ヘッダー値の秘匿化・ローテーション（L-12 の 3 要素目）**: `x-ticket-dest` をランダム値にし Secrets Manager 由来でローテーションする案。**不採用**。値が知られたら終わりの弱い防御で、CloudFront の custom header 設定と ALB listener rule の両方をローテーションのたびに同期する運用コストがかかる。ALB 直叩き自体を遮断すれば、そもそもヘッダーを知られても到達できないため、この対策は不要になる。
- **API Gateway + VPC Link 化**: ALB を非公開にし API Gateway を前段に置く案。**不採用**。コンテナベース（ECS Fargate + ALB）の現アーキテクチャに対して過剰で、VPC Link 分の常駐コストとレイテンシが増えるだけ。WAF / レート制限の目的は prefix list 制限で達成できる。

## 再検討のトリガー

- 同一アカウント外の CloudFront からの到達まで排除する必要が出たとき（CloudFront → ALB 間の署名付きヘッダー + Secrets Manager ローテーションの併用へ）。
- SSR の CloudFront 経由 API 呼び出しのレイテンシが問題化したとき（VPC 内の内部 ALB / Cloud Map などの内部経路の導入を検討）。
