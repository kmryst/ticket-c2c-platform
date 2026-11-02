# 構成図のソース

`docs/architecture/images/` の構成図（`request-flow.png`、`operations.png`）を生成する作図スクリプトと、その元にした inventory を置く。
ここに置く判断と、置かないもの（調査担当の報告、deny list / allow list）は [ADR-0044](../../adr/0044-publish-architecture-diagram-source-and-inventory.md) を参照。

## ファイル

| パス | 内容 |
| --- | --- |
| `inventory.md` | IaC・CI/CD・docs から作ったリソースと接続の一覧。図に描くかどうかと、その理由 |
| `scripts/elements.py` | 共通定義。ノード・枠・線のラベル（線の目的と技術）・凡例の文言を 1 か所で定義する |
| `scripts/build_architecture.py` | 全体図（`architecture.drawio`）を生成する。観点ごとの図の照合の基準 |
| `scripts/build_request_flow.py`、`scripts/build_operations.py` | 観点ごとの図（`views/*.drawio`）を生成する |
| `scripts/squeeze.py` | 指定した y より下の要素を上下に移して余白を調整する |
| `scripts/check_d5.py` | 観点ごとの図の線（通信元・通信先・ラベル）とノード名が全体図と一致するかを検査する |
| `build.sh` | 上の 3 つの drawio を生成し、`check_d5.py` を実行する |

## 生成

```bash
docs/architecture/src/build.sh
```

図ごとに変えてよいのはラベルの改行の位置だけで、文言を変えるときは `scripts/elements.py` を直す。
改行と空白を除いて共通定義と違うラベルを図に書くと、生成が失敗する。

PNG への書き出しは draw.io で行い、`docs/architecture/images/` の同名のファイルを置き換える。
