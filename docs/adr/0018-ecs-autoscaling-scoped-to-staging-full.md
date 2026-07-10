# 0018. ECS Auto Scaling policy は staging-full にのみ実装し、frontend は desired_count のみで冗長化する

## ステータス

Accepted

## 日付

2026-07-10

## 背景

api / worker / frontend の ECS desired_count・Auto Scaling 設定を見直すにあたり、次の 3 点が既存設計の問題として見つかった（Issue #234）。

1. `terraform/modules/ecs-service` には `aws_appautoscaling_target`（min/max）はあるが、実際にスケールを発火させる `aws_appautoscaling_policy`（target-tracking / step scaling）が存在しない。そのため staging normal の API（min 0 / max 3）・Worker（min 0 / max 4）は「設定はあるが実際にはスケールしない」見せかけの構成になっていた。
2. staging-full（負荷試験・failover 検証用の一時強化 profile）でも同様に policy がなく、負荷試験の効果を確認できない。
3. frontend（SSR）は全 profile で desired_count 1 固定。負荷検証対象外という既存方針（`docs/architecture/staging-environment.md`）自体は妥当だが、full は AZ 跨ぎの failover 検証用 profile であり、frontend が 1 task 固定のままだと frontend だけ failover 検証ができず profile の目的と矛盾する。

## 決定

1. `terraform/modules/ecs-service` に CPU 使用率ベースの target-tracking `aws_appautoscaling_policy`（`ECSServiceAverageCPUUtilization`）を追加する。`autoscaling_cpu_target` 変数が non-null かつ `autoscaling_min_capacity` / `autoscaling_max_capacity` が有効な場合のみ作成する。
2. staging **normal** の api / worker の autoscaling min/max を撤去する（null 化）。normal は「安価な日常検証」profile であり、policy を実装しない環境に動かない min/max だけを残さない。
3. staging **full** の api / worker に autoscaling min=2 / max=4（現状 desired_count の対称 2 倍）と CPU 60% の target-tracking policy を有効化する。実測データ（過去の負荷試験結果、キューのバックログ推移など）がまだない段階のため、api / worker で非対称な倍率にする根拠を持てない。まず対称な 2 倍から始め、full での負荷試験結果を見て必要なら worker の max だけ引き上げる。CPU 60% という閾値は、ECS target-tracking の一般的な出発点である 50〜70% の範囲から選ぶ。
4. frontend は autoscaling を実装せず、desired_count のみ normal=1 / full=2 にする。frontend は「スケールする層」ではなく「落ちない層」という位置づけとし、CPU 閾値ベースの autoscaling は負荷特性データがなく根拠を持てないため入れない。

## 根拠

- policy のない Auto Scaling target は「設定した気になるだけ」のリスクがある。将来 CloudWatch アラームや別の運用者がこの min/max を見て「autoscaling が効いている」と誤認する可能性を、normal から撤去することで防ぐ。
- normal と full の役割分担（安価な日常検証 vs 負荷試験・failover 検証）に合わせ、policy は実際に負荷をかけて検証できる full にのみ実装する。動くことのない設定（枠だけで発火しないもの）を置かないという方針。
- api / worker の max を対称にするのは、「説明できない数字を置かない」という SRE 方針による。旧設定（worker max=8）は api の 2 倍だったが、根拠となる負荷試験結果やキューのバックログ推移のデータがなかった。
- CPU 60% の閾値は、ECS target-tracking CPU 使用率の一般的な出発点である 50〜70% の範囲から選んだ。閾値が高すぎるとバースト吸収の余地がなくスケールアウトが間に合わず、低すぎると過剰スケールアウトでコストが増える。ECS Fargate のタスク起動には環境変数取得・DB コネクションプール初期化等で 1〜2 分程度かかりうるため、60% にすることで残り 40% の余白でその間の負荷増を吸収できる。staging-full は「本番相当構成での負荷試験により autoscaling の実動作を検証する」ための profile であり、閾値は「テストで発火させやすいから」ではなく実運用を想定した一般的な値を採用する。
- frontend は元々「負荷検証の対象外」という既存の設計判断（`ecs-service` module 呼び出しのコメント）がベースにある。今回の desired_count 1→2 の目的は負荷分散ではなく、full が failover 検証用 profile である以上、frontend だけ 1 台固定だと profile の目的（AZ 跨ぎの failover 検証）と矛盾するため。CPU 閾値ベースの autoscaling は frontend の負荷特性データがなく根拠を持てない。

## 反対材料・トレードオフ

- normal から autoscaling min/max を撤去することで、normal では「安価に日常検証しつつ、たまたま負荷が上がった時にスケールする」余地がなくなる。normal は desired_count 固定（api=1, worker=1）で常時運用する前提になる。
- api / worker の max=4 は実測データに基づかない初期値であり、full での負荷試験結果次第で早期に見直しが必要になる可能性がある。
- frontend の desired_count 2 化は常時 2 task 分のコストが staging-full 稼働中にかかる（staging はエフェメラル運用のため影響は検証時間分に限定される）。

## 再検討のトリガー

- staging-full で実際に負荷試験を行い、api / worker の CPU 使用率・スケールアウト挙動の実測データが得られた場合（worker の max を api と非対称に引き上げるか判断する）。
- normal でもスケールアウト挙動を検証したいニーズが出てきた場合（policy を normal にも展開するか、normal と full の役割分担自体を見直す）。
- frontend で実際に負荷試験を行い、SSR のリソース特性データが得られた場合（frontend にも CPU 閾値ベースの autoscaling を入れるか判断する）。
