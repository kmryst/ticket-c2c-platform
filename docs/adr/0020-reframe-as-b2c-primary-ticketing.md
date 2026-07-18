# 0020. プラットフォームを B2C 一次チケット販売へ再定義する

## ステータス

Accepted

## 日付

2026-07-16

## 背景

本プロジェクトは C2C チケット販売プラットフォームとして開始した。一方、実装と技術検証の中心は、イベント単位の共通在庫、人気イベントへの購入集中、在庫超過防止、Waiting Room、Protected Zone、Ticket Hold、および購入確定である。

C2C 再販で中心となる個人別 Listing、チケット保有確認、個人間の売上金精算、チケット譲渡、不正出品対策は実装しておらず、今後検証したい販売開始時刻の集中アクセスと座席確保は B2C 一次販売の課題に近い。C2C と B2C を同時に扱うと、在庫、決済、精算、譲渡、不正対策の境界が広がり、負荷制御と信頼性検証の焦点がぼやける。

## 決定

既存リポジトリを、イベント主催者（Organizer）が保有する一次販売チケットを購入者（Customer）へ販売する B2C 一次チケット販売プラットフォームへ再定義する。

個人による再出品、個人間取引、売上金精算、チケット譲渡、および二次流通は対象外とする。既存リポジトリと Git 履歴は維持し、C2C として取得した PoC 結果と ADR は転換前の歴史的記録として残す。

リポジトリ名、GitHub OIDC、IAM、Terraform state、AWS リソース名は本 ADR では変更しない。名称変更は、B2C 目標構成の移行順序と AWS 連携への影響を別 Issue で確認してから行う。

## 根拠

- イベント単位の大量在庫と販売開始時の集中アクセスは、B2C 一次販売として説明した方がデータモデルと業務フローが一貫する。
- Waiting Room、Protected Zone、Ticket Hold、購入確定を、同じ Customer journey として検証できる。
- Amazon ECS、Aurora PostgreSQL、Valkey、CloudFront、Application Auto Scaling、CloudWatch、k6 の既存資産を継続利用できる。
- 新規リポジトリへ全ファイル、CI、Terraform、Docs を複製せず、運用と履歴を一元化できる。

## 反対材料・トレードオフ

- 過去の Issue、Pull Request、ADR、metric 名、AWS リソース名には C2C の表記が残る。
- 既存の Buyer / Seller field を Customer / Organizer へ変更するには、API、DB migration、Dashboard、runbook の段階的な移行が必要になる。
- C2C と B2C を比較できる独立した完成形は残らない。
- 将来、二次流通を追加する場合は、別 bounded context または別サービスとして境界を設計し直す必要がある。

## 再検討のトリガー

- 個人による再出品、チケット譲渡、Seller 精算をプロダクト要件へ追加するとき。
- 一次販売と二次流通を同じ Platform で扱う事業要件が確定したとき。
- B2C への段階移行より、新規リポジトリへの分離の方が運用コストを下げる具体的な根拠が得られたとき。
