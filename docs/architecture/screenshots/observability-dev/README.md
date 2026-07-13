# Observability dev 実環境スクリーンショット

Issue #276 の dev 実環境検証（2026-07-12、`ticket-c2c-dev`）で撮影した
CloudWatch Dashboard / Alarm / Synthetics canary のスクリーンショット。destroy 前に記録として保存する。

AWS アカウント ID・アカウントエイリアスなど非公開情報が写り込む箇所は黒塗り（レダクト）済み。

| ファイル | 画面 |
|---|---|
| `01-dashboard-overview.png` | CloudWatch Dashboard（`ticket-c2c-dev-overview`）全体表示 |
| `02-alarms-tokyo-alarm-state.png` | ap-northeast-1（Tokyo）側アラーム一覧、強制発火による ALARM 状態 |
| `03-alarms-useast1-edge-alarm-state.png` | us-east-1（edge alerts）側アラーム一覧、強制発火による ALARM 状態 |
| `04-alarm-valkey-fail-open-detail-history.png` | `valkey-fail-open` アラーム詳細、ALARM 遷移履歴 |
| `05-alarm-valkey-fail-open-ok-recovery.png` | `valkey-fail-open` アラーム、OK への自動復帰確認 |
| `06-synthetic-canary-passed.png` | Synthetics canary 成功（`PASSED`）run |
