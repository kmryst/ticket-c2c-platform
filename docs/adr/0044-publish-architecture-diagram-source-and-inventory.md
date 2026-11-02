# 0044. 構成図の作図スクリプトと inventory を公開リポジトリに置き、deny list / allow list は非公開リポジトリで管理する

## ステータス

Accepted

## 日付

2026-11-02

## 背景

README に載せている構成図（`docs/architecture/diagrams/request-flow.png`、`docs/architecture/diagrams/operations.png`）は、Python の作図スクリプトで drawio を生成し、PNG に書き出したものである。
作図スクリプトと、その元にした inventory（IaC・CI/CD・docs から作ったリソースと接続の一覧）はリポジトリの外にあり、図を直すときに同じ図を再現できなかった（Issue #619）。

inventory には、リソース名、Terraform のリソースの論理名（例: `aws_route53_record.app_alias`）、サービス名などの識別子が入っている。
公開リポジトリに置くと、これらの識別子を誰でも読めるようになる。

構成図の公開可否の検査（check-publish）では、公開してはいけない値の一覧（deny list）と、公開してよいと決めた値の一覧（allow list）を使う。
deny list は隠したい値そのものの一覧である。

## 決定

1. README に載せる観点ごとの図は、drawio と PNG を `docs/architecture/diagrams/` に並べて置く。作図スクリプト（`elements.py`、`squeeze.py`、`build_*.py`、`check_d5.py`）、inventory、全体図の drawio は `docs/architecture/diagrams/src/` に置く。
2. inventory の識別子（リソース名、IaC の論理名、サービス名など）は外さずに入れる。まだ公開されていない値（AWS account ID、ARN の account 部分、メールアドレス、人の名前、アカウントや契約の事情、secret の値、tfvars の値で未公開のもの）は入れない。
3. 線とノードのラベル（線の目的と技術、ノードの名前、凡例の文言）は `elements.py` の 1 か所で定義する。図ごとに変えてよいのは改行の位置だけで、改行と空白を除いて共通定義と一致しなければ生成が失敗する。
4. 調査担当の報告（inventory の元）と deny list / allow list は公開リポジトリに置かず、非公開リポジトリ `check-publish-lists` で管理する。

## 根拠

- inventory に入る識別子は、同じ値が `terraform/` に既に公開されている。inventory を非公開にしても、識別子を知られないようにする効果は無い。
- 守りの本体は、識別子を知られても入れない作り（ALB の ingress を CloudFront managed prefix list に限定する [ADR-0013](./0013-restrict-alb-ingress-to-cloudfront-prefix-list.md)、IAM の権限、secret を Secrets Manager に置くことなど）である。NIST SP 800-123（Guide to General Server Security）の 2.4 Server Security Principles は、Open Design を次のように書いている（[NIST SP 800-123](https://csrc.nist.gov/pubs/sp/800/123/final)）。
  - "Open Design—System security should not depend on the secrecy of the implementation or its components."
  - （訳: Open Design — システムのセキュリティは、実装やその構成要素が秘密であることに依存すべきではない。）
  - この原則は「識別子を隠す根拠」ではなく、「実装が知られても安全である作りにする」ことを求めるものである。この ADR でも識別子を公開してよい理由として使い、隠す理由には使わない。
- 作図スクリプトをリポジトリに置くと、生成した drawio がバイト単位で同じになることを PR で確かめられる（Issue #619 の PR に sha256 を記録した）。
- deny list / allow list は、公開してはいけない値を集めた一覧なので、公開リポジトリに置くとそれ自体が漏えいになる。

## 反対材料・トレードオフ

- 本番の環境では、inventory や IaC は非公開リポジトリに置くべきである。公開リポジトリは偵察の材料になる。MITRE ATT&CK の T1593.003 は次のように書いている（[T1593.003](https://attack.mitre.org/techniques/T1593/003/)）。
  - "Adversaries may search public code repositories for information about victims that can be used during targeting."
  - （訳: 攻撃者は、標的化の際に使える被害者の情報を求めて、公開されたコードリポジトリを検索することがある。）
  - このリポジトリは個人開発の検証用で、dev / staging は未使用時に destroy するのが定常である（[ADR-0008](./0008-staging-ephemeral-prod-like-environment.md)）。IaC を既に公開しているので、inventory を足しても新たに知られる識別子は無い。
- inventory の出典欄は調査担当の報告（`raw/`）を参照しているが、`raw/` はリポジトリに入れない。出典の一部はリポジトリだけでは辿れない。
- check-publish を CI で実行するには deny list が要るが、deny list は非公開リポジトリにあるので、公開リポジトリの CI では実行しない。公開前の検査は作図した人がローカルで行う。

## 再検討のトリガー

- 本番の環境を持つ、または常時稼働する環境を持つとき（inventory と IaC を非公開リポジトリへ移す）
- inventory に、IaC で公開されていない値を入れる必要が出たとき
- deny list を使わずに CI で公開可否を検査する方法を採るとき
