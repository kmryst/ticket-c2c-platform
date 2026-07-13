# Runbook: PR Policy Check の concurrency 起因マージブロック

対象: 本リポジトリの CI（GitHub Actions `pr-policy-check.yml`）。Issue #61 / #220、PR #221。

## 前提知識

- `PR Policy Check`（`.github/workflows/pr-policy-check.yml`）は Issue link・必須 4 ラベル・厳密運用時の rollback 欄を検査する required status check。
- ラベル判定は job 内で `gh pr view` により**最新ラベルを都度再取得**する。古い payload の run が後から実行されても判定結果は変わらない。
- required status check（GitHub Rulesets）の判定は、同名 check run の**履歴全体**を評価対象にする。したがって CANCELLED / expected のまま残った run が 1 つでもあると、後から同名 context が SUCCESS しても判定が未充足になり得る。
- PR 作成 helper（`scripts/github/create-pr-with-labels.sh`）は type / area / risk / cost の必須ラベルを**連続して付与**する。このとき `pull_request` の `labeled` イベントが短時間に連発する。

## 事象と根本原因

### 症状

ラベル連続付与により `pull_request.labeled` が連発すると、`PR Policy Check` が一時的に `expected`（未充足）扱いになり PR がマージブロックされる。

### 根本原因（2 段階）

1. **実行中 run の cancel（Issue #61 / PR #60 で発生）**: `concurrency.cancel-in-progress: true` だと、同一 SHA への連続イベントで in_progress の run が cancel される。cancel された run は CANCELLED の check run として commit に残り、required check 判定に混入して PR を**恒久ブロック**する。→ `cancel-in-progress: false` に変更して対応。
2. **pending run の cancel（Issue #220 / PR #221 で発生）**: `concurrency` はデフォルトで `queue: single` として振る舞い、**pending run を 1 つしか保持しない**。`labeled` / `unlabeled` 連発時に古い pending run が新しい run の到着で cancel され、required check が一時的に `expected` 扱いになる。

いずれも「concurrency による run の cancel が required check 判定に混入する」という GitHub Actions の一般的な挙動が原因。

## 対応

`.github/workflows/pr-policy-check.yml` の `concurrency` を次のとおり設定する。

```yaml
concurrency:
  group: pr-policy-check-caller-${{ github.event.pull_request.number }}
  cancel-in-progress: false   # 実行中 run の cancel を防ぐ（Issue #61）
  queue: max                  # pending run を cancel せず FIFO 実行（Issue #220）
```

2026-07-13、`.github/workflows/pr-policy-check.yml` は `idp-golden-path` の reusable workflow（`@v1`）を呼ぶ薄い caller workflow に移行した（Issue #296、ADR-0008）。`concurrency` はトリガー・permissions と同様に caller 側が持つ契約のため、この設定自体は caller workflow にそのまま残っている。ただし group 名は `pr-policy-check-caller-<PR番号>` に変更した。idp-golden-path 側の reusable workflow（callee）自身も同名パターンの `concurrency` group（`pr-policy-check-<PR番号>`）を持っており、caller と同一名にすると GitHub Actions が「top level workflow と呼び出し先の間のデッドロック」と判定し job を 1 つも起動せず run をキャンセルすることが Commitlint 移行（Issue #294）で実測判明したため（idp-golden-path#106 に記録）、`-caller` サフィックスで衝突を避けている。

- `cancel-in-progress: false`: 実行中 run を cancel せず、CANCELLED check run を commit に残さない。
- `queue: max`: pending run を cancel せず **FIFO で順次実行**する。古い pending run が捨てられなくなる。
- **併用制約**: `queue: max` は `cancel-in-progress: false` と**のみ**併用できる。`cancel-in-progress: true` との併用は workflow の validation error になる。heavy CI を新 SHA で上書きしたいワークフローには `queue: max` を付けない。
- ラベル判定は `gh pr view` で最新ラベルを再取得するため、順次実行による遅延はあっても誤判定は起きない。

## 検証方法

1. 実 PR に対しラベルを短時間で複数回付け外しする（本対応の実地検証では 11 回連続で付け外した）。
2. `gh run list --workflow pr-policy-check.yml` で run の終了状態を確認し、`CANCELLED` が発生していないことを確認する。
3. `gh pr view <PR番号> --json mergeStateStatus` が `BLOCKED` にならないことを確認する。

### 実地検証結果

同一構成の 3 リポジトリ（ticket-c2c-platform / terraform-hannibal / idp-golden-path）で横断検証した。

| 指標 | 結果 |
| --- | --- |
| 対象リポジトリ | 3 |
| 集計 run 数 | 合計 47 |
| CANCELLED | 0 |
| required check の恒久ブロック | なし（すべて FIFO で SUCCESS に解決） |

## 関連

- Issue #61（CANCELLED run が required check を恒久ブロックする問題。`cancel-in-progress: false` 対応）
- Issue #220 / PR #221（`queue: max` 追加。pending run cancel 対策）
- `.github/workflows/pr-policy-check.yml`（対象 workflow）
- [GitHub Docs: Control the concurrency of workflows and jobs](https://docs.github.com/en/actions/using-jobs/using-concurrency)
