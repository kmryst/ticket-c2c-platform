# 0007. dev の ALB を HTTPS 化し、HTTP は明示的リダイレクトに限定する

## ステータス

Accepted

## 日付

2026-07-03

## 背景

dev 環境の ALB は HTTP:80 のみで、稼働中はインターネット全体から平文で公開 API が叩けた（production-readiness M-5）。選択肢は次の 2 つだった。

1. HTTPS 化（ACM 証明書 + 443 リスナー + 80 は 443 へリダイレクト）
2. 検証時のみ ingress を自分の IP に絞る変数の用意（HTTP のまま）

前提を確認したところ、この AWS アカウントには Route53 public hosted zone `hamilcar-hannibal.click`（兄弟リポジトリ terraform-hannibal で取得済みのドメイン）が存在し、ACM の DNS 検証・レコード作成に利用できる。既存の ACM 証明書 `api.hamilcar-hannibal.click` は terraform-hannibal 管理下のため流用しない。

## 決定

1. dev の ALB を HTTPS 化する。本リポジトリの Terraform で専用サブドメイン `ticket-api-dev.hamilcar-hannibal.click` の ACM 証明書を発行（DNS 検証、hosted zone は data source 参照）し、443 リスナーで forward、80 リスナーは 443 への 301 リダイレクトに変更する。
2. あわせて ALB の ingress CIDR を変数 `alb_allowed_ingress_cidrs`（既定 `0.0.0.0/0`）として切り出す。長時間の負荷検証などで外部トラフィックを遮断したい場合に自分の IP へ絞れるようにする。
3. hosted zone 名とサブドメインは変数（`hosted_zone_name` / `api_subdomain`）とし、staging / prod では別サブドメインを与える。

## 根拠

- ドメインと hosted zone が既にあるため、HTTPS 化の追加コストはゼロ（ACM パブリック証明書は無料、Route53 レコードは実費なし）。IP 制限案は「平文のまま」という M-5 の本質（経路上での盗聴・改竄可能性）を解消しない。
- dev は prod へ育てる本番系トラックの最初の環境（ADR-0002）であり、staging / prod で必須になる TLS 終端・リダイレクト・証明書ローテーション（ACM 自動更新）の配線を dev で先に検証できる（環境パリティ。ADR-0005 と同じ判断軸）。
- ingress 変数の追加は数行で、M-5 が挙げた「コスト前提が外部トラフィックで崩れる」リスクへの追加の保険になる。

## 反対材料・トレードオフ

- dev はドメイン付きで公開されることになり、DNS 名からエンドポイントが推測されやすくなる（もともと ALB の DNS 名で公開されていたため実質的な差は小さい）。
- 証明書とレコードが hosted zone `hamilcar-hannibal.click` に依存する。ドメインを手放す・移管する場合は dev root module の変数変更が必要。
- terraform-hannibal と同一 hosted zone を共有するため、レコード名の衝突に注意が必要（本リポジトリは `ticket-api-*` プレフィックスのみ使用する）。
- 認証は依然としてない。公開 API である事実は変わらず、WAF / 認証は prod 前の別課題として残る。

## 再検討のトリガー

- ドメイン `hamilcar-hannibal.click` を手放す、またはプロジェクト専用ドメインを取得した場合。
- staging / prod でアカウント分離（ADR-0003）を実施し、hosted zone の共有ができなくなった場合。
- CloudFront + WAF を前段に追加する時（TLS 終端位置の再設計）。
