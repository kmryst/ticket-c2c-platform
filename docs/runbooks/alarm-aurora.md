# Runbook: Aurora CPU / memory / connections / ACU near max アラーム

対象: dev / staging の Aurora Serverless v2 クラスタ。Issue #218、Issue #254。

対象アラーム:

- `<name>-aurora-cpu-high`（severity: 基本 Warning。下記併発条件で Critical）
- `<name>-aurora-freeable-memory-low`（severity: Critical）
- `<name>-aurora-connections-high`（severity: 基本 Warning。下記併発条件で Critical）
- `<name>-aurora-acu-near-max`（severity: 基本 Warning。下記併発条件で Critical）

severity 分類・エスカレーション条件の全体方針は `docs/architecture/observability.md`「アラームの severity と escalation 方針（Issue #257）」節を正本とする。

## secret / credential 値の取り扱いに関する注意

Aurora のマスター認証情報は RDS 管理シークレット（`master_user_secret`）で管理されている。**本 runbook の確認コマンドで `get-secret-value` を実行する場合、`--query SecretString` の出力をそのまま画面・ログ・チケットに貼り付けない。** 接続確認が必要な場合は、ECS タスクの環境変数（`DB_PASSWORD_SECRET_ARN`）経由でアプリが解決する仕組みを使い、シークレット値そのものを人が取得・共有する運用は避ける。

## 影響範囲

Aurora は API / Worker 双方の唯一の永続化層。容量逼迫（CPU / 接続数 / ACU）は Saturation の予兆であり、それ単体では応答が返せていないとは限らない（基本 Warning）。ただし `aurora-freeable-memory-low` は OOM →クラスタ不安定化の直前指標のため Critical。

**併発エスカレーション運用**（Composite Alarm は実装せず、確認手順として本 runbook に記載。ADR-0017 の composite alarm 不採用判断を踏襲）:

> `aurora-cpu-high` / `aurora-connections-high` / `aurora-acu-near-max` は、`purchase-error-burn-rate-fast`・`alb-5xx`・`synthetic-check-failure`（#256）のいずれかと同時に ALARM 状態の場合、Critical へ格上げする（= 容量逼迫が実際にユーザー影響へ転化している状態）。

## 初動確認

1. CloudWatch Dashboard（`<name>-overview`）の「Aurora: CPUUtilization / ServerlessDatabaseCapacity」「Aurora: FreeableMemory / DatabaseConnections」widget で現状を確認する。
2. 併発エスカレーション対象（`purchase-error-burn-rate-fast` / `alb-5xx` / `synthetic-check-failure`）が同時 ALARM かを確認する。
3. min 0 ACU の auto-pause 中（トラフィックゼロ時の正常状態）でないかを確認する（`treat_missing_data = notBreaching` のため誤発火はしないが、直前に auto-resume した直後は一時的に高負荷に見えることがある）。

## 主な原因候補

- 接続プールの想定超過（API タスク数 × プールサイズが Aurora の `max_connections` を超えている。production-readiness L-8 で既知）。
- 特定クエリの性能劣化（インデックス欠如、N+1 等）。
- ACU 上限到達によるスロットリング（`max_capacity` の設定値そのものが低すぎる可能性）。
- 接続リーク（`DatabaseService.connect()` でチェックアウトした client が正しく `release()` されていない。H-4 で対応済みだが新規コード変更時は要注意）。
- 大量の同時購入・イベント一覧取得等の負荷試験・実トラフィック増。

## 確認コマンド

```bash
# Aurora クラスタの現在の CPU / ACU / 接続数
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS --metric-name CPUUtilization \
  --dimensions Name=DBClusterIdentifier,Value=<name>-aurora \
  --start-time "$(date -u -d '-1 hour' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 300 --statistics Average

aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS --metric-name DatabaseConnections \
  --dimensions Name=DBClusterIdentifier,Value=<name>-aurora \
  --start-time "$(date -u -d '-1 hour' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 300 --statistics Average

# クラスタの現在の ACU 設定・自動一時停止設定
aws rds describe-db-clusters --db-cluster-identifier <name>-aurora \
  --query 'DBClusters[].{min:ServerlessV2ScalingConfiguration.MinCapacity,max:ServerlessV2ScalingConfiguration.MaxCapacity}'

# 併発エスカレーション判定
aws cloudwatch describe-alarms \
  --alarm-names "<name>-alb-5xx" "<name>-purchase-error-burn-rate-fast" "<name>-synthetic-check-failure" \
  --state-value ALARM
```

## 復旧・緩和の判断

1. **ACU 上限到達が原因の場合**: `max_capacity` の一時的な引き上げを検討（コスト増を伴うため、prod 化前の恒久対応は Issue 化する）。
2. **接続数超過が原因の場合**: API タスク数を一時的に減らす、または接続プールサイズを見直す（production-readiness L-8 の恒久対応と同じ論点）。
3. **接続リークが疑われる場合**: 直近デプロイの `DatabaseService` 周りの変更を確認し、疑わしい場合は rollback。
4. **意図的な負荷試験が原因と分かっている場合**: 負荷生成プロセスを直ちに停止する（ALARM 確認後即負荷停止する方針で dev 実地検証時に合意済み）。
5. `aurora-freeable-memory-low`（Critical）は OOM 直前のシグナルのため、上記いずれの原因でも優先的に負荷を下げる対応を取る。

## エスカレーション条件

- **Critical（`aurora-freeable-memory-low`、または他 3 アラームが併発条件成立時）**: 通知受信次第、1 時間以内に状況確認開始。
- **Warning（`aurora-cpu-high` / `aurora-connections-high` / `aurora-acu-near-max` 単独）**: 24 時間以内に確認。24 時間 OK 復帰しない場合は Critical 相当として扱う。
- 同一アラームが 1 週間に 3 回以上発報する場合は、容量設計（ACU 上限・接続プールサイズ）の見直しを Issue 化する。

## 関連

- Issue #218（Golden Signals アラーム導入）
- production-readiness L-8（Postgres 接続プール上限の既知課題）
- H-4（Aurora failover 時の未捕捉例外対応）
- `terraform/modules/aurora/main.tf`（アラーム定義）
