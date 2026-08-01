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

Security Group、ECS desired count、Valkey 構成を変更する場合は、対象環境、変更前の値、復旧値、ユーザー影響を記録し、実行承認を得てから Terraform / deploy workflow または AWS CLI を使用する。staging full の API は Application Auto Scaling 対象のため、手動 task 数変更前に scaling activity を確認する。

1. **Valkey ノード障害の場合**: ElastiCache 側の自動フェイルオーバー（`automatic_failover_enabled`。staging の capacity profile 次第）を待つか、AWS 側の状態を確認する。dev は単一ノード構成（`num_cache_clusters=1`）のため自動フェイルオーバーがなく、ノード復旧を待つ必要がある。
2. **ネットワーク変更が原因の場合**: security group の変更履歴を確認し、意図しない変更であれば復元する。
3. **fail-open が継続している間の緩和**: Aurora 側の負荷（`aurora-connections-high` 等）が同時に上昇している場合は、`alarm-aurora.md` の runbook に従い一時的に API の desired_count を絞ることも選択肢（トレードオフ: スループット低下）。
4. Valkey は「正本ではない」設計（fail-open 前提、キャッシュ・前段フィルタ用途）のため、Valkey 単独の障害でデータ不整合は発生しない。復旧を急ぐ理由は「Aurora 保護層の早期回復」である。

## Ticket Type cutover 時の Aurora 到達（Issue #389）

Ticket Type 単位 cutover（ADR-0029 / ADR-0030）では、`requestId` 付きの sold-out request を
Valkey で即時終了させず、authoritative な冪等性判定のために PostgreSQL へ通します。requestId を
変え続ける sold-out traffic は、DB 到達数と rejected row を増やすため、ID 値を含めない低
カーディナリティ metric で到達率を監視します。

- **DB 到達率**: `PurchaseSoldOutToPostgres`（Count、Service=api）。requestId 付き sold-out を
  Valkey で終了させず DB へ通した回数。総 request に対する比で「Valkey で早期拒否できていない
  sold-out traffic」の割合を見る。
- **rejected insert rate**: `PurchaseRejectedPersisted`（Count、Service=api）。新規 rejected row を
  DB へ永続化した回数（replay は含まない）。requestId を変え続ける traffic の増加兆候。
- 併せて `aurora-connections-high` / `aurora-cpu-high` と、`ValkeyFailOpen`（Ticket Type 単位操作
  を含む）、`TicketTypeScopeMismatch`、`WriterModeMismatch`、`PrefilterBypass`、`CompensationFailure`
  を確認する。
- `PurchaseSoldOutToPostgres` / `PurchaseRejectedPersisted` は legacy / ticket_type の両 writer mode
  経路で同じ意味で発行される（どちらの経路が有効でも DB 到達率と rejected insert rate を一貫して
  観測できる）。`WriterModeMismatch` の増加は activation / rollback 途中の writer mode drift、
  `PrefilterBypass` の増加は resolver 到達不能を示す。

### 前段 guard の再検討条件

上記 traffic で Aurora 保護が必要になった場合、次の対策を検討する。いずれも #376 の
authoritative replay（同一 key・同一 payload は元結果を返す）と payload 相違 409 を壊さない
ことを前提とする。

- **前段 guard / WAF rate 制御**: 同一 buyer が requestId を変え続ける sold-out 連打を、CloudFront
  / WAF または購入 API の dual-key レート制限（ADR-0015）でエッジ寄りに絞る。requestId 値では
  なく buyer / IP 単位で絞ることで idempotency を壊さない。
- **rate limit の強化**: 購入エンドポイントの user_id 主体 dual-key レート制限の閾値を、sold-out
  event に対して一時的に厳しくする。
- **容量制御**: Aurora 接続数・ECS desired count・読み取り経路の分離で DB 保護層を厚くする。
  実行時は対象環境・変更前後値・ユーザー影響を記録し承認を得る。

判断の目安: `PurchaseSoldOutToPostgres` と `PurchaseRejectedPersisted` の増加が `aurora-connections-high`
と相関し始めたら、上記のいずれかを Issue 化して導入を検討する。Terraform の alarm / dashboard
追加は #389 の対象外であり、必要になった時点で別 Issue で扱う。

## エスカレーション条件

- **Critical**: 通知受信次第、1 時間以内に状況確認開始。Valkey 障害が 1 時間以上継続する場合は Aurora 側の負荷を監視しながら復旧を最優先タスク化。
- 同一アラームが 1 週間に 3 回以上発報する場合は、Valkey の構成（ノード数・自動フェイルオーバー）見直しを Issue 化する。

## 関連

- Issue #218（EMF ビジネスメトリクスのアラーム導入）
- `docs/architecture/observability.md`「ビジネスメトリクス（CloudWatch EMF）」節
- Valkey 前段フィルタの設計判断（production-readiness M-1 / M-2）
