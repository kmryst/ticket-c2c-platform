# 0008. staging をエフェメラルな prod-like 環境とし、初回 endpoint を alb-http-only にする

## ステータス

Accepted

## 日付

2026-07-04

## 背景

staging 環境設計（`docs/architecture/staging-environment.md`、PR #86）で ADR 候補として残っていた判断を、初回 staging 構築（Issue #88）に合わせて確定する。

1. staging を常時稼働にするか、検証ごとに destroy するエフェメラル環境にするか。
2. staging のデータを永続扱いにするか、seed / API 作成データで毎回再作成する前提にするか。
3. 初回 staging の公開エンドポイントを HTTPS（ACM / Route53）込みで作るか、ALB HTTP のみで始めるか。
4. OpenSearch Multi-AZ を staging 常時構成にするか、`capacity_profile=full` の一時構成にするか。

## 決定

1. staging は「検証後に毎回 destroy する prod-like 環境」として運用する。apply / deploy / smoke / destroy を個別 workflow として実行し、destroy は人間が結果確認後に手動実行する。
2. staging データは seed / API 作成データで再作成可能な前提とする。Aurora は deletion protection なし・final snapshot skip。永続データ保護は prod の責務にする。
3. 公開エンドポイントは `public_endpoint_mode` 変数（`alb-http-only` / `https-dns`）で切り替え、初回は `alb-http-only` とする。smoke test は `http://<alb_dns_name>` を使う。
4. OpenSearch Multi-AZ（zone awareness / 2 nodes）は `capacity_profile=full` の一時構成に限定し、normal は 1 node とする。

## 根拠

- staging の目的は「本番と同じ壊れ方を最小サイズで見る」ことであり、常時稼働の価値（長期データ蓄積）は現段階でない。エフェメラル運用なら NAT / ALB / Aurora / OpenSearch / Valkey の常時課金（概算で月 $150 超）を検証時間分だけに抑えられる。
- 初回構築の失敗要因を減らすため、DNS / ACM / HTTPS はネットワーク・データ層の配線確認と切り離す。ALB DNS 名への HTTP smoke test でアプリケーション経路の大半（ALB → API → Aurora / Valkey、EventBridge → SQS → Worker → OpenSearch）は検証できる。
- HTTPS / DNS の配線自体は dev で検証済み（ADR-0007）であり、staging では `https-dns` モードの有効化のみが残作業になる（Issue #94）。
- capacity profile と endpoint mode を直交する 2 変数に分けることで、「サイズの軸」と「入口の軸」を独立に切り替えられ、workflow 入力も単純になる。

## 反対材料・トレードオフ

- エフェメラル運用は毎回の apply / destroy 時間（Aurora / OpenSearch で計 30 分規模）がかかり、即時の再検証ができない。
- alb-http-only の間は平文 HTTP で、dev（HTTPS 化済み）より一時的に弱い入口になる。staging は短時間稼働・検証データのみである点で許容する。
- destroy を忘れると課金が続く。destroy workflow の残存リソース確認と、失敗調査で残す場合の Issue 記録（理由・期限・owner）で緩和する。

## 再検討のトリガー

- staging での検証頻度が上がり、毎回の構築時間が開発速度のボトルネックになった場合（常時稼働 + 夜間停止へ切り替え検討）。
- フロントエンド公開や外部関係者によるアクセスが必要になり、固定 URL / HTTPS が staging の前提になった場合（`https-dns` を既定へ）。
- prod 構築後、prod との構成差分が問題を見逃す原因になった場合。
