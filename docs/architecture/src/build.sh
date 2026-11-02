#!/usr/bin/env bash
# 構成図の drawio を生成し、全体図と観点ごとの図の一致を検査する。
# 出力先はこのファイルのあるディレクトリからの相対パス。PNG への書き出しは README.md を参照。
set -euo pipefail
cd "$(dirname "$0")"
export PYTHONDONTWRITEBYTECODE=1
python3 scripts/build_architecture.py architecture.drawio
python3 scripts/build_request_flow.py views/request-flow.drawio
python3 scripts/build_operations.py views/operations.drawio
python3 scripts/check_d5.py architecture.drawio views/request-flow.drawio views/operations.drawio
