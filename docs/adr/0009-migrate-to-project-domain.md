# 0009. プロジェクト専用ドメイン ticket-c2c.click へ移行する

## ステータス

Accepted（[0007](./0007-alb-https-with-acm-and-ingress-variable.md) の hosted zone 選定部分を更新する）

## 日付

2026-07-04

## 背景

ADR-0007 で dev の ALB を HTTPS 化した際、hosted zone には兄弟リポジトリ terraform-hannibal が取得済みの `hamilcar-hannibal.click`（無関係な別プロジェクトのドメイン）を流用した。ADR-0007 は再検討のトリガーとして「プロジェクト専用ドメインを取得した場合」を挙げており、`ticket-c2c.click` の取得と Route53 public hosted zone の作成（zone ID `Z08628092SR418FE2HI1E`、AutoRenew は無効）が完了したため、そのトリガーが成立した（Issue #87）。

流用の問題点:

- Terraform コードベース間の結合。terraform-hannibal 側のドメイン運用（移管・解約）が本リポジトリの dev / staging を壊し得る。
- 同一 hosted zone を共有するため、レコード名の衝突に注意が必要だった。
- ブランディング上の不整合。

## 決定

1. dev / staging（および将来の prod）の `hosted_zone_name` 変数の既定値を `ticket-c2c.click` にする。サブドメイン命名は `ticket-api-<環境>.ticket-c2c.click`（例: `ticket-api-dev` / `ticket-api-staging`）で統一する。
2. hosted zone / ドメイン登録自体は Terraform 管理外（手動取得済み）とし、各環境 root からは従来どおり data source 参照に留める。
3. ADR-0007 の決定 1（HTTPS 化・301 リダイレクト）と決定 2（`alb_allowed_ingress_cidrs`）は維持する。変更は hosted zone の選定（決定の一部と変数既定値）のみ。
4. `hamilcar-hannibal.click` への新規レコード作成は今後行わない。既存の dev 環境レコードは環境 destroy 済みのため残存しない。

## 根拠

- dev / staging は destroy 前提の使い捨て環境で外部利用者の依存がなく、本番稼働前の今が移行コスト最小のタイミング（変数既定値の変更 + apply で完結）。
- `hosted_zone_name` / `api_subdomain` は ADR-0007 の時点で変数化済みのため、コード変更は既定値と参照ドキュメントの更新のみ。
- プロジェクト単位の DNS 名前空間分離により、terraform-hannibal との結合・ブラストラジアスを解消できる。

## 反対材料・トレードオフ

- ドメイン維持費（.click の年額、約 $3）が追加でかかる。AutoRenew は意図的に無効のまま維持し、手動更新を [Production Readiness M-11](../architecture/production-readiness.md) で管理する。2026-07-19 の確認時点の有効期限は 2027-07-04 10:08:53 JST、手動更新期限は 2027-06-04 とする（放置するとドメイン失効で dev / staging と将来の prod の公開入口が壊れる）。
- hosted zone が Terraform 管理外の手動リソースとして残る（bootstrap 同様の「土台」扱い。prod 化の際に IaC 管理へ移すか再検討する）。

## 再検討のトリガー

- prod 用に別ドメイン・別アカウント（ADR-0003 のアカウント分離）を採用する場合。
- CloudFront + WAF を前段に追加し、TLS 終端位置を再設計する場合。
- ドメイン失効・移管が必要になった場合。
