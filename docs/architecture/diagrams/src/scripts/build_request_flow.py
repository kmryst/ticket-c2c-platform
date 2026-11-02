"""観点 request-flow（リクエストの流れ）。
B6（Issue #615）: 線のラベルを C4 の形（1 行目に目的、2 行目に [技術]）にする。
左列を上から Secrets Manager / EventBridge / SQS にし、⑥ を Worker の上で通して ⑥ と ⑨ の交差をなくす。
「検索」は OpenSearch の右から入れて ⑨ との近接をなくす。"""
import sys
from squeeze import squeeze
from elements import Diagram, GROUP, BOX, AURORA_LINES, LEGEND_ARROW, LEGEND_MAIN, LEGEND_OTHER, node_label

OUT = sys.argv[1]
FS = 16
d = Diagram(fs=FS)
G = dict(GROUP)
G["g_app"] = G["g_app"].replace(" (", "\n(")   # 改行位置だけ変える（名前は共通定義）
S64 = (64, 64)
DX = 280   # VPC の中身を右へずらす量（左列のラベルの幅を取る）
LC = 120   # 左列のアイコンの x（中心 152）

# ---------- 枠 ----------
d.aws_group("aws", G["aws"], "cloud", 20, 150, 1285, 1180, fs=18)
d.aws_group("reg_edge", G["reg_edge"], "region", 60, 230, 1000, 120, fs=FS)
d.aws_group("reg_main", G["reg_main"], "region", 40, 400, 1245, 910, fs=18)
d.aws_group("vpc", G["vpc"], "vpc", 60 + DX, 440, 925, 850, fs=FS)
d.aws_group("pub", G["pub"], "public", 170 + DX, 480, 790, 130, fs=FS)
d.aws_group("pri", G["pri"], "private", 80 + DX, 650, 885, 620, fs=FS, sl=455)
d.role_group("g_app", G["g_app"], 100 + DX, 690, 850, 215, fs=17, fill="#FFFFFF", sl=440)
d.role_group("g_data", G["g_data"], 100 + DX, 1035, 850, 215, fs=17, fill="#FFFFFF", sl=750)

d.text("リクエストの流れ（staging 環境）", 20, 10, 900, 40, fs=26, bold=True)

# ---------- ノード ----------
d.icon("user", 1100, 60, size=S64, label="")
d.text(node_label("user"), 930, 76, 165, 30, align="right")
d.icon("cloudfront", 1100, 270, label_pos="right", size=S64, label="Amazon\nCloudFront")
d.icon("waf", 980, 270, size=S64, label="")
d.text(node_label("waf"), 745, 278, 230, 48, align="right")

d.icon("igw", 80 + DX, 510, size=S64, label="internet\ngateway")
d.icon("nat", 200 + DX, 510, label_pos="right", size=S64)
d.icon("alb", 480 + DX, 510, label_pos="right", size=S64)

d.box("wk_box", BOX["wk_box"], 115 + DX, 765, 215, 125)
d.icon("wk_task", 204 + DX, 830)
d.box("api_box", BOX["api_box"], 360 + DX, 765, 300, 125)
d.icon("api_task", 492 + DX, 830)
d.box("fe_box", BOX["fe_box"], 690 + DX, 765, 235, 125)
d.icon("fe_task", 789 + DX, 830)

d.icon("opensearch", 395 + 70, 1070, size=S64)
d.icon("valkey", 990, 1067, size=(64, 57))
AX = 620
d.add("aurora_box", "", "rounded=1;arcSize=4;html=1;fillColor=none;strokeColor=#C925D1;strokeWidth=1.5;", AX, 1065, 300, 177)
d.icon("aurora", AX + 15, 1075, size=(52, 52))
d.icon("aurora_writer", AX + 95, 1075, size=(52, 52), label="")
d.text(node_label("aurora_writer"), AX + 147, 1086, 50, 30)
d.icon("aurora_reader", AX + 200, 1075, size=(52, 52), label="")
d.text(node_label("aurora_reader"), AX + 252, 1086, 50, 30)
rf_lines = [AURORA_LINES[0].replace(" PostgreSQL", "\nPostgreSQL")] + AURORA_LINES[1:3] + AURORA_LINES[4:]
d.text("\n".join(rf_lines), AX + 8, 1132, 290, 106, fs=FS)

d.icon("secrets", LC, 470, size=S64, label="AWS Secrets\nManager")
d.icon("eventbridge", LC, 770, size=S64, label="Amazon\nEventBridge\n（custom event\nbus・rule）")
d.icon("sqs", LC, 1070, size=S64, label="Amazon Simple\nQueue Service\n（Amazon SQS）\ndead-letter queue\n（DLQ）あり")

API_L = 360 + DX          # API の箱の左端 640
WK_L = 115 + DX           # Worker の箱の左端 395

# ---------- ①〜⑨（C4 の形: 1 行目に目的、2 行目に [技術]）。座標は下の squeeze(640, -40) の前の値 ----------
d.edge("user", "cloudfront", "main", exit=(0.5, 1), entry=(0.5, 0), lpos=0.2, lx=90)
d.edge("cloudfront", "alb", "main", exit=(0.25, 1), entry=(0.5, 0),
       pts=[(1116, 382), (792, 382)], lpos=0.1)
d.edge("alb", "api_box", "main", exit=(0.25, 1), entry=((776 - API_L) / 300, 0), lpos=-0.37, lx=-65)
d.edge("api_box", "valkey", "main",
       exit=(0.95, 1), entry=(0.5, 0), pts=[(925, 925), (1022, 925)], lpos=0.55, lx=82)
d.edge("api_box", "aurora_writer", "main", exit=((741 - API_L) / 300, 1), entry=(0.5, 0), lpos=-0.1,
       lx=108)
d.edge("api_box", "eventbridge", "main", exit=(8 / 300, 0), entry=(0.5, 0),
       pts=[(API_L + 8, 740), (152, 740)], lpos=0.62)
d.edge("eventbridge", "sqs", "main", exit=(0, 0.5), entry=(0, 0.5),
       pts=[(70, 802), (70, 1102)], lpos=-0.05, lx=80)
d.edge("wk_box", "sqs", "main", exit=(0, 0.85), entry=(1, 0.5),
       pts=[(300, 871), (300, 1102)], lpos=0.1, lx=-92)
d.edge("wk_box", "opensearch", "main", exit=((497 - WK_L) / 215, 1), entry=(0.5, 0),
       lpos=-0.25, lx=92)

# ---------- その他 ----------
d.edge("alb", "fe_box", exit=(0.75, 1), entry=(47 / 235, 0), pts=[(808, 630), (1017, 630)], lpos=0.12, lx=-58)
d.edge("fe_box", "cloudfront", exit=((1150 - 970) / 235, 0), entry=(0.7797, 1),
       lpos=-0.36, lx=-62)
d.edge("api_box", "opensearch", exit=(60 / 300, 1), entry=(1, 0.5),
       pts=[(700, 1000), (590, 1000), (590, 1102)], lpos=-0.35)
d.edge("api_box", "secrets", exit=(40 / 300, 0), entry=(1, 0.5),
       pts=[(680, 712), (260, 712), (260, 502)], lpos=0.5, lx=-82)
d.edge("g_app", "nat", exit=((232 - 100) / 850, 0), entry=(0.5, 1), lpos=0.15, lx=58)
d.edge("nat", "igw", exit=(0, 0.5), entry=(1, 0.5))

# ---------- 凡例（矢印の説明だけ） ----------
LX, LY = 20, 1345
d.add("legend", "", "rounded=1;arcSize=3;html=1;fillColor=#FFFFFF;strokeColor=#5A6B86;", LX, LY, 1285, 125)
d.text("凡例", LX + 14, LY + 8, 80, 28, fs=18, bold=True)
d.text(LEGEND_ARROW, LX + 100, LY + 8, 640, 28)
d.line_sample(LX + 16, LY + 60, 60, "main")
d.text(LEGEND_MAIN, LX + 86, LY + 46, 300, 28)
d.line_sample(LX + 16, LY + 100, 60, "normal")
d.text(LEGEND_OTHER, LX + 86, LY + 86, 200, 28)

with open(OUT, "w", encoding="utf-8") as f:
    d.cells = squeeze(d.cells, 640, -40)  # Public subnet と Private subnet の間を広げる（③・画面の転送・SSR の API 取得・外向きの通信のラベルを置く）
    d.cells = squeeze(d.cells, 225, 35)   # us-east-1 の上の余白を詰める
    f.write(d.xml(1325, 1480 - 35 + 40))
print("wrote", OUT, len(d.cells), "cells")
