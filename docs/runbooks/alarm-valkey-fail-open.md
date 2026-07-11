# Runbook: ValkeyFailOpen アラーム

対象: dev / staging の API（ECS Fargate）。Issue #218、Issue #254。

対象アラーム: `<name>-valkey-fail-open`（severity: Critical）

severity 分類・エスカレーション条件の全体方針は `docs/architecture/observability.md`「アラームの severity と escalation 方針（Issue #257）」節を正本とする。

## 影響範囲

Valkey は購入 API の前段フィルタ（レート制限・売り切れ前段拒否）を担う。Valkey 障害時、API は fail-open（前段フィルタを素通りさせて Aurora 判定へ進む）設計のため、購入自体は継続できるが、**前段フィルタ・レート制限が無効化されたまま「静かに」進行するリスク**がある（Aurora が無防備な状態）。oversold 自体は DB 層（トランザクション + 制約）で防御されるが、Aurora への負荷が想定外に増える。アラーム設計自体も「1 件でも観測したら即 ALARM」の思想（`dimensions = { Service = "api" }` のみで集計、Operation 別の内訳はコンソールで確認）。

## 初動確認

1. CloudWatch Dashboard（`<name>-overview`）の「ValkeyFailOpen / WorkerProcessingLagMs (EMF)」widget で発生状況を確認する。
2. Valkey（ElastiCache）のクラスタ状態を確認する。
3. 同時刻に `aurora-cpu-high` / `aurora-connections-high` / 購入 API 系アラームが発報していないか確認する（fail-open による Aurora 負荷増の兆候）。

## 主な原因候補

- Valkey ノードの障害・再起動（ElastiCache のメンテナンス・AZ 障害等）。
- security group / ネットワーク変更で API → Valkey の経路が塞がれている。
- Valkey への接続タイムアウト（`connectTimeout` 超過。実装は fail-open のため、タイムアウトそのものがアラーム発火条件）。
- Valkey のメモリ逼迫・eviction によるコマンド失敗。

## 確認コマンド

```bash
# ElastiCache（Valkey）レプリケーショングループの状態
aws elasticache describe-replication-groups --replication-group-id <name>-valkey \
  --query 'ReplicationGroups[].{status:Status,nodeGroups:NodeGroups[].Status}'

# ValkeyFailOpen の発生件数・Operation 別内訳（EMF ログから）
aws logs start-query \
  --log-group-name "/ecs/<name>-api" \
  --start-time "$(date -u -d '-30 min' +%s)" --end-time "$(date -u +%s)" \
  --query-string 'fields @timestamp, @message | filter @message like /ValkeyFailOpen/ | sort @timestamp desc | limit 50'

# security group の ingress/egress 確認（API SG → Valkey SG の経路）
aws ec2 describe-security-groups --group-ids <valkey security group id>
```

## 復旧・緩和の判断

1. **Valkey ノード障害の場合**: ElastiCache 側の自動フェイルオーバー（`automatic_failover_enabled`。staging の capacity profile 次第）を待つか、AWS 側の状態を確認する。dev は単一ノード構成（`num_cache_clusters=1`）のため自動フェイルオーバーがなく、ノード復旧を待つ必要がある。
2. **ネットワーク変更が原因の場合**: security group の変更履歴を確認し、意図しない変更であれば復元する。
3. **fail-open が継続している間の緩和**: Aurora 側の負荷（`aurora-connections-high` 等）が同時に上昇している場合は、`alarm-aurora.md` の runbook に従い一時的に API の desired_count を絞ることも選択肢（トレードオフ: スループット低下）。
4. Valkey は「正本ではない」設計（fail-open 前提、キャッシュ・前段フィルタ用途）のため、Valkey 単独の障害でデータ不整合は発生しない。復旧を急ぐ理由は「Aurora 保護層の早期回復」である。

## エスカレーション条件

- **Critical**: 通知受信次第、1 時間以内に状況確認開始。Valkey 障害が 1 時間以上継続する場合は Aurora 側の負荷を監視しながら復旧を最優先タスク化。
- 同一アラームが 1 週間に 3 回以上発報する場合は、Valkey の構成（ノード数・自動フェイルオーバー）見直しを Issue 化する。

## 関連

- Issue #218（EMF ビジネスメトリクスのアラーム導入）
- `docs/architecture/observability.md`「ビジネスメトリクス（CloudWatch EMF）」節
- Valkey 前段フィルタの設計判断（production-readiness M-1 / M-2）
