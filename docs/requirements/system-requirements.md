# システム要件

## サービス概要

イベント主催者（Organizer）が保有する一次販売チケットを購入者（Customer）へ販売する、B2C チケット販売プラットフォームを設計する。

このサービスは最大 500 万人のユーザーが利用することを想定する。人気イベントではリクエストが通常の 100 倍程度まで増加する可能性がある。

## スコープ

### 利用者

- Organizer はイベントと Ticket Type、販売可能なチケット在庫を登録できる。
- Customer はイベントを検索し、一次販売チケットを購入できる。
- 個人が Seller となる C2C 再販は扱わない。

### Customer の検索

Customer はチケット購入時に、以下の条件でイベントを検索できる。

- イベント開催地の位置情報
- イベント種別
  - 例: スポーツ、音楽、芸術など
- イベント開催日

検索項目は今後増える可能性がある。

### イベント一覧

- 検索条件に一致したイベントを一覧表示する。

### チケット購入

- 初期実装は General Admission（自由席）の数量在庫を扱う。
- Ticket Type と Ticket Hold は、将来 Reserved Seating（指定席）を追加できる境界にする。
- Waiting Room から Protected Zone への入場レートと最大同時利用者数を制御できる。
- Customer は Protected Zone 内で Purchase Session を開始し、Ticket Hold、決済認可、Purchase 確定、結果確認の順に購入する。
- 1 Customer / 1 Event につき、確定 Purchase は 1 件、合計 4 枚までとする。
- Ticket Hold は作成から 5 分間有効とし、Customer による延長は許可しない。
- 在庫を超えた Ticket Hold と Purchase が行われないようにする。

購入フローの詳細は [B2C 一次チケット販売フロー](../architecture/primary-ticket-sales.md) を正本とする。

## スコープ外

- 実際の Payment Service Provider とカード情報の処理
- 購入確定後のキャンセルと返金
- 料金や収容人数による検索
- 個人によるチケット再出品、個人間取引、売上金精算、チケット譲渡
- チケットの二次流通

## 制約

- 販売開始前に Waiting Room へ参加した Customer は、販売開始時にランダムな順番へ並べる。
- 販売開始後の Customer は待ち行列の末尾へ FIFO で追加する。
- イベント内容によってトラフィックが集中する場合がある。
- 人気イベントにトラフィックが集中しても、他イベントと同様のパフォーマンスで利用できる必要がある。
- Ticket Hold、決済認可、Purchase 確定は再送されても重複処理してはならない。
- Aurora PostgreSQL をチケット在庫、Ticket Hold、Purchase の正本とする。

## 設計で扱うヒント

### 検索と購入の分離

検索への大量アクセスと Protected Zone 内の購入処理を分けて考える必要がある。

検討観点:

- データベースへの直接リクエストを減らす。
- 検索用の情報設計を行う。
- 検索結果やイベント概要を読み取り最適化する。

### 検索用ストレージ

検索条件には位置情報、イベント種別、開催日が含まれる。今後検索条件が増える可能性もある。

検討観点:

- 位置情報検索に向いたデータ構造。
- 複数条件検索に向いた検索基盤。
- Aurora PostgreSQL を正本にしつつ、OpenSearch のような検索用ストアを使うか。

### 在庫の安全性

在庫数を超えた Ticket Hold と Purchase を防ぐ必要がある。

検討観点:

- RDB トランザクションと条件付き更新による正確性。
- Valkey/Redis などのインメモリストアによる高速な在庫チェック。
- 人気イベント時のホットスポット対策。
- 正本をどこに置くか。

## 関連ドキュメント

- [技術スタックドラフト](../architecture/technology-stack.md)
- [B2C 一次チケット販売フロー](../architecture/primary-ticket-sales.md)
- [ADR-0020: プラットフォームを B2C 一次チケット販売へ再定義する](../adr/0020-reframe-as-b2c-primary-ticketing.md)
- [ADR-0021: Protected Zone の購入フローに Purchase Session と Ticket Hold を採用する](../adr/0021-protected-zone-purchase-flow.md)
