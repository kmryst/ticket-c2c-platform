"""観点 operations（デプロイ・運用・監視）。全体図と同じ要素定義（elements.py）を使い、README 幅向けに配置し直す。"""
import sys
from squeeze import squeeze
from elements import Diagram, GROUP, BOX, AURORA_LINES, LEGEND_ARROW, LEGEND_DASHED, node_label, reflow

OUT = sys.argv[1]
FS = 16
d = Diagram(fs=FS)
G = dict(GROUP)
S64 = (64, 64)

# ---------- 枠 ----------
d.aws_group("aws", G["aws"], "cloud", 250, 70, 950, 1495, fs=18)
d.aws_group("reg_edge", G["reg_edge"], "region", 400, 150, 765, 215, fs=FS)
d.aws_group("reg_main", G["reg_main"], "region", 285, 470, 895, 1075, fs=18)
d.role_group("g_app", G["g_app"], 305, 770, 855, 220, fs=17, fill="#FFFFFF", sl=60)
d.role_group("g_data", G["g_data"], 305, 1030, 455, 285, fs=17, fill="#FFFFFF")

d.text("デプロイ・運用・監視（staging 環境）", 20, 10, 900, 40, fs=26, bold=True)

# ---------- ノード ----------
d.icon("github", 40, 848, size=S64, label="GitHub Actions\nterraform plan・\napply・destroy")
d.icon("email", 1222, 1442, size=(64, 40))
d.icon("sts", 285, 400, label_pos="right", size=(64, 41))

d.icon("cloudfront", 290, 222, size=S64, label="Amazon\nCloudFront")
d.icon("canary", 520, 222, size=S64)
d.icon("alarm_edge", 730, 222, size=S64)
d.icon("sns_edge", 960, 222, size=S64)

d.icon("s3", 325, 530, label_pos="right", size=S64, label="Amazon Simple Storage\nService（Amazon S3）\nTerraform state")
d.icon("ecr", 325, 640, label_pos="right", size=S64)
d.icon("secrets", 1080, 530, size=S64, label="")
d.text(node_label("secrets", "AWS Secrets\nManager"), 965, 540, 110, 44, align="right")

d.box("fe_box", BOX["fe_box"], 320, 830, 225, 145)
d.icon("fe_task", 414, 905)
d.box("api_box", BOX["api_box"], 575, 830, 295, 145)
d.icon("api_task", 650, 905)
d.icon("api_adot", 815, 907)
d.box("wk_box", BOX["wk_box"], 900, 830, 245, 145)
d.icon("wk_task", 940, 905)
d.icon("wk_adot", 1080, 907)

d.add("aurora_box", "", "rounded=1;arcSize=4;html=1;fillColor=none;strokeColor=#C925D1;strokeWidth=1.5;", 320, 1065, 270, 240)
d.icon("aurora", 335, 1075, size=(52, 52))
d.icon("aurora_writer", 415, 1075, size=(52, 52))
d.icon("aurora_reader", 500, 1075, size=(52, 52))
op_lines = ["Amazon Aurora", "PostgreSQL-Compatible Edition"] + AURORA_LINES[1:4] + ["reader は failover 先", "（アプリは未使用）"]
d.text("\n".join(op_lines), 328, 1152, 260, 148)
d.icon("opensearch", 650, 1075, size=S64)

d.icon("xray", 900, 1075, size=S64)
d.icon("logs", 900, 1210, label_pos="right", size=(64, 48))
d.icon("alarm", 900, 1310, label_pos="right", size=S64)
d.icon("sns", 900, 1430, size=S64)

# ---------- 通信 ----------
d.edge("canary", "cloudfront", exit=(0, 0.5), entry=(1, 0.5))
d.edge("alarm_edge", "sns_edge", exit=(1, 0.5), entry=(0, 0.5))
d.edge("sns_edge", "email", exit=(1, 0.5), entry=(0.5, 0), pts=[(1254, 254)])
d.edge("alarm", "sns", exit=(0.5, 1), entry=(0.5, 0), lx=24)
d.edge("sns", "email", exit=(1, 0.5), entry=(0, 0.5))

d.edge("github", "sts", exit=(0, 0.5), entry=(0, 0.5),
       pts=[(22, 880), (22, 420.5)], lpos=1, lx=-150, ly=-26)
d.edge("github", "s3", exit=(0.5, 0), entry=(0, 0.5), pts=[(72, 562)], lpos=0.42, ly=-22)
d.edge("github", "ecr", exit=(1, 0.1), entry=(0, 0.5), pts=[(215, 854.4), (215, 672)], lpos=0.0, lx=-62)
d.edge("github", "g_app", exit=(1, 0.5), entry=(0, 0.5), lpos=-0.27)
d.edge("g_app", "ecr", exit=(0.0433, 0), entry=(0.25, 1), lpos=0.0, lx=48)
d.edge("g_app", "secrets", exit=(0.9369, 0), entry=(0.5, 1), lpos=0.0, lx=-92)
d.edge("api_task", "api_adot", exit=(1, 0.5), entry=(0, 0.5))
d.edge("wk_task", "wk_adot", exit=(1, 0.5), entry=(0, 0.5))
d.edge("api_adot", "xray", exit=(0.5, 1), entry=(0.2656, 0), pts=[(837, 1050), (917, 1050)], lpos=0.0)
d.edge("wk_adot", "xray", exit=(0.5, 1), entry=(1, 0.5), pts=[(1102, 1107)], lpos=0.5, ly=-12)
d.edge("g_app", "logs", exit=(0.555, 1), entry=(0, 0.5), pts=[(780, 1234)], lpos=-0.35, lx=45)
d.edge("g_app", "aurora_writer", "dashed", exit=(0.1585, 1), entry=(0.5, 0), lpos=0.0, lx=45, ly=16)
d.edge("g_app", "opensearch", "dashed", exit=(0.4398, 1), entry=(0.5, 0), lpos=0.0, lx=-45, ly=16)

# ---------- 凡例（矢印の説明だけ） ----------
LX, LY = 20, 1030
d.add("legend", "", "rounded=1;arcSize=3;html=1;fillColor=#FFFFFF;strokeColor=#5A6B86;", LX, LY, 215, 232)
d.text("凡例", LX + 12, LY + 8, 100, 28, fs=18, bold=True)
d.text(reflow(LEGEND_ARROW, "矢印は通信の向き\n（通信を開始する側\n→ 受ける側。\n応答は描かない）"), LX + 12, LY + 40, 195, 86)
d.line_sample(LX + 14, LY + 150, 50, "normal")
d.text("通信", LX + 74, LY + 136, 130, 28)
d.line_sample(LX + 14, LY + 190, 50, "dashed")
d.text(reflow(LEGEND_DASHED, "standalone task\nの通信"), LX + 74, LY + 170, 135, 44)

with open(OUT, "w", encoding="utf-8") as f:
    d.cells = squeeze(d.cells, 140, 35)   # AWS Cloud の名前と us-east-1 の間の余白を詰める
    f.write(d.xml(1310, 1585 - 35))
print("wrote", OUT, len(d.cells), "cells")
