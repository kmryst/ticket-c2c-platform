# 0038. GitHub Environment の required reviewer を bootstrap 以外で外す

## ステータス

Accepted

## 日付

2026-10-07

## 背景

GitHub Environment `bootstrap` / `dev-destroy` / `staging` / `staging-destroy` には required reviewer（kmryst）を設定していた（Issue #65、PR #66）。
このリポジトリは 1 人運用で、reviewer は workflow を起動した本人と同じであり、承認はセルフ承認しかなかった（`prevent_self_review=false`）。
staging の apply → deploy → smoke → destroy の 1 サイクルで承認が何度も必要になり、手間だけが増えていた。

承認は、AI Agent が起動した workflow を人が止められる関門でもあった。

## 決定

`dev-destroy` / `staging` / `staging-destroy` の required reviewer を外す（2026-10-07 に GitHub 上で設定変更済み）。
`bootstrap` の required reviewer は残す。
branch restriction（custom branch policy で `main` のみ）は全 Environment で維持する。

## 根拠

- dev / staging は通常 destroy 済みで、データは使い捨てである。誤って apply / deploy / destroy されても、作り直せば済む。
  検証のために立てている最中に消されても、作り直せば済む。
- apply ロールの OIDC trust は `sub` の `environment:<name>` しか見ないが、Environment の branch restriction により実行できるのは `main` からだけである。
  workflow を改変して勝手に apply / destroy するには、PR と required status check を通して `main` へマージする必要がある。
- write 権限者は 1 人で、セルフ承認は本人以外に対する統制にならなかった。
- `bootstrap` は apply ロールの IAM ポリシーと OIDC trust 自体を変更する。誤適用すると CI から AWS へ入れなくなり、作り直しにローカルからの apply が要るため、承認を残す。

## 反対材料・トレードオフ

- **AI Agent が起動した workflow の人による関門がなくなる。** dev / staging では作り直せば済むことを理由に受け入れる。
  AI Agent に workflow を起動させるかは、作業ごとの指示で人が決める。
- **全部残す案は採らなかった。** 1 人運用ではセルフ承認になり、手間に見合う統制にならない。
- **apply と destroy だけ残す案は採らなかった。** 消されても作り直せば済む点は apply / destroy でも同じで、deploy との差がない。
- **承認を 1 サイクルで 1 回にまとめる案は採らなかった。** workflow を 1 本にまとめる必要があり、apply / deploy / smoke / destroy を個別 workflow にした方針（[staging-environment.md](../architecture/staging-environment.md)「GitHub Actions」）と合わない。
- **wait timer で代用する案は採らなかった。** 待ち時間が増えるだけで、止める人がいない。

## 再検討のトリガー

- 本番環境（prod）を作るとき。
- write 権限者が増えたとき。
- dev / staging に作り直せないデータを置くようになったとき。
- [github-flow-guardrails.md](../operations/github-flow-guardrails.md)「Environment 承認の強化」の条件に該当したとき。
