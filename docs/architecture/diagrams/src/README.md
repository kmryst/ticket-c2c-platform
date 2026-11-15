# 構成図のソース

`docs/architecture/diagrams/` の構成図（`request-flow.drawio` / `.png`、`operations.drawio` / `.png`）を生成する作図スクリプトと、その元にした inventory を置く。
ここに置く判断と、置かないもの（調査担当の報告、deny list / allow list）は [ADR-0044](../../../adr/0044-publish-architecture-diagram-source-and-inventory.md) を参照。

## ファイル

| パス | 内容 |
| --- | --- |
| `inventory.md` | IaC・CI/CD・docs から作ったリソースと接続の一覧。図に描くかどうかと、その理由 |
| `scripts/elements.py` | 共通定義。ノード・枠・線のラベル（線の目的と技術）・凡例の文言を 1 か所で定義する |
| `scripts/build_architecture.py` | 全体図（`architecture.drawio`）を生成する。観点ごとの図の照合の基準 |
| `scripts/build_request_flow.py`、`scripts/build_operations.py` | 観点ごとの図（`../request-flow.drawio`、`../operations.drawio`）を生成する |
| `scripts/squeeze.py` | 指定した y より下の要素を上下に移して余白を調整する |
| `scripts/check_d5.py` | 観点ごとの図の線（通信元・通信先・ラベル）とノード名が全体図と一致するかを検査する |
| `build.sh` | 上の 3 つの drawio を生成し、`check_d5.py` を実行する |

## 生成

```bash
docs/architecture/diagrams/src/build.sh
```

図ごとに変えてよいのはラベルの改行の位置だけで、文言を変えるときは `scripts/elements.py` を直す。
改行と空白を除いて共通定義と違うラベルを図に書くと、生成が失敗する。

PNG への書き出しは architecture-diagram の支援スクリプト `export.js`（Playwright と draw.io viewer で書き出す）で行い、`docs/architecture/diagrams/` の同名の PNG を置き換える。

```bash
# DIAGRAM_SCRIPTS: export.js・check-publish.py があるディレクトリ。PLAYWRIGHT_PATH: Playwright の install 先
D=docs/architecture/diagrams
OUT=$(mktemp -d)
node "$DIAGRAM_SCRIPTS/export.js" "$D/request-flow.drawio" "$OUT/request-flow.svg" "$D/request-flow.png"
node "$DIAGRAM_SCRIPTS/export.js" "$D/operations.drawio" "$OUT/operations.svg" "$D/operations.png"
```

`export.js` は、PNG の tEXt チャンク（キーワード `source-sha256`）に、元の `.drawio` のファイルの SHA-256 を入れる（入れるのはハッシュだけ）。
書き出した後に `check-publish.py` を実行し、PNG の `source-sha256` が同じフォルダの同名の `.drawio` の SHA-256 と一致することを確かめる。
違えば古い PNG として検出される（終了コード 1）。`source-sha256` が無い PNG（draw.io desktop など別のツールで書き出したもの）は、照合できないという警告になる。

```bash
python3 "$DIAGRAM_SCRIPTS/check-publish.py" --deny "$LISTS/deny.txt" --allow "$LISTS/allow.txt" \
  "$D/request-flow.png" "$D/operations.png" \
  "$D/request-flow.drawio" "$D/operations.drawio" "$D/src/architecture.drawio"
```

`$LISTS` は deny list / allow list のディレクトリ（このリポジトリには置かない。ADR-0044）。合格の基準は検出 0 件・終了コード 0。
