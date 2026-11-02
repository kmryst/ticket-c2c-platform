"""全体図（architecture.drawio）を生成する。座標は絶対座標（全 cell が parent="1"。包含は座標で表す）。"""
import sys
from elements import (Diagram, GROUP, BOX, AURORA_LINES, LEGEND_ARROW, LEGEND_MAIN, LEGEND_OTHER, LEGEND_DASHED,
                      html, node_label, reflow)

OUT = sys.argv[1]
d = Diagram()
W, H = 2640, 1470
G = GROUP

# ---------- 枠 ----------
d.aws_group("aws", G["aws"], "cloud", 290, 70, 2160, 1385, fs=18)
d.aws_group("reg_edge", G["reg_edge"], "region", 510, 150, 890, 242)

d.aws_group("reg_main", G["reg_main"], "region", 330, 430, 2100, 930, fs=17)
d.aws_group("vpc", G["vpc"], "vpc", 840, 460, 1040, 875)
d.aws_group("pub", G["pub"], "public", 860, 500, 880, 145)
d.aws_group("pri", G["pri"], "private", 860, 680, 1000, 640, sl=190)
d.role_group("g_app", G["g_app"], 880, 720, 960, 270, fs=16, fill="#FFFFFF", sl=525)
d.role_group("g_data", G["g_data"], 880, 1052, 960, 250, fs=16, fill="#FFFFFF")


d.text("ticket-c2c-platform の AWS 構成（staging 環境）", 20, 15, 900, 40, fs=26, bold=True)

# ---------- ノード ----------
d.icon("user", 60, 205)
d.add("github", html(node_label("github")),
      "dashed=0;outlineConnect=0;html=1;shape=mxgraph.weblogos.github;verticalLabelPosition=bottom;verticalAlign=top;"
      "align=center;labelPosition=center;fontColor=#232F3E;fontSize=14;", 107, 1085, 90, 90)
d.icon("email", 2490, 1125)

d.icon("cloudfront", 350, 205, label_pos="top")
d.icon("waf", 600, 270)
d.icon("canary", 800, 235)
d.icon("alarm_edge", 1020, 235)
d.icon("sns_edge", 1230, 235)

d.icon("alb", 1201, 530, label_pos="right")
d.icon("nat", 1640, 530, label_pos="top")
d.icon("igw", 1785, 530)

d.box("fe_box", BOX["fe_box"], 910, 800, 210, 160)
d.icon("fe_task", 996, 895)
d.box("api_box", BOX["api_box"], 1160, 800, 380, 160)
d.icon("api_task", 1240, 870)
d.icon("api_adot", 1420, 872)
d.box("wk_box", BOX["wk_box"], 1580, 800, 240, 160)
d.icon("wk_task", 1615, 870)
d.icon("wk_adot", 1730, 872)

d.add("aurora_box", "", "rounded=1;arcSize=4;html=1;fillColor=none;strokeColor=#C925D1;strokeWidth=1.5;", 900, 1087, 360, 200)
d.icon("aurora", 920, 1098)
d.icon("aurora_writer", 1030, 1100, fs=14)
d.icon("aurora_reader", 1140, 1100, fs=14)
d.text("\n".join(AURORA_LINES), 910, 1172, 345, 110, fs=14)
d.icon("valkey", 1360, 1097)
d.icon("opensearch", 1640, 1097)

d.icon("eventbridge", 1995, 510, label_pos="right")
d.icon("sqs", 1995, 666, label_pos="right")
d.icon("xray", 1995, 855, label_pos="right")
d.icon("logs", 1995, 945, label_pos="right")
d.icon("alarm", 1995, 1110)
d.icon("sns", 2240, 1110)

d.icon("s3", 411, 780)
d.icon("ecr", 651, 780)
d.icon("secrets", 651, 966)
d.icon("sts", 340, 1375, label_pos="right")

# ---------- 主要な流れ（①〜⑨） ----------
d.edge("user", "cloudfront", "main", exit=(1, 0.5), entry=(0, 0.5), lpos=-0.3, ly=-24)
d.edge("cloudfront", "alb", "main", exit=(0.75, 1), entry=(0.5, 0),
       pts=[(408.5, 415), (1240, 415)], lpos=-0.88)
d.edge("alb", "api_box", "main", exit=(0.5, 1), entry=(0.21, 0), lpos=0.6, lx=-70)
d.edge("api_box", "valkey", "main", exit=(0.629, 1), entry=(0.5, 0), lpos=0.5)
d.edge("api_box", "aurora_writer", "main", exit=(0.105, 1), entry=(0.25, 0),
       pts=[(1200, 1020), (1043, 1020)], lpos=0.3)
d.edge("api_box", "eventbridge", "main", exit=(0.605, 0), entry=(0, 0.5),
       pts=[(1390, 662), (1920, 662), (1920, 549)], lpos=-0.907, lx=-70)
d.edge("eventbridge", "sqs", "main", exit=(0.5, 1), entry=(0.5, 0), lx=-14)
d.edge("wk_box", "sqs", "main", exit=(0.917, 0), entry=(0, 0.5),
       pts=[(1800, 705)], lpos=0.3)
d.edge("wk_box", "opensearch", "main", exit=(0.458, 1), entry=(0.64, 0), lpos=-0.11, lx=85)

# ---------- その他の通信 ----------
d.edge("alb", "fe_box", exit=(0, 0.5), entry=(0.5, 0), pts=[(1015, 569)], lpos=-0.5)
d.edge("fe_box", "cloudfront", exit=(0.148, 0), entry=(0, 0.83),
       pts=[(941, 662), (310, 662), (310, 270)], lpos=-0.35)
d.edge("api_box", "opensearch", exit=(0.947, 1), entry=(0.26, 0), pts=[(1520, 1035), (1660, 1035)], lpos=0.45)
d.edge("api_box", "secrets", exit=(0.039, 1), entry=(1, 0.5), pts=[(1175, 1005)], lpos=-0.1)
d.edge("g_app", "secrets", exit=(0, 0.9556), entry=(1, 0.154), lpos=0.0, ly=-2)
d.edge("api_task", "api_adot", exit=(1, 0.5), entry=(0, 0.5))
d.edge("wk_task", "wk_adot", exit=(1, 0.5), entry=(0, 0.5))
d.edge("api_adot", "xray", exit=(0.5, 0), entry=(0, 0.244), pts=[(1442, 782), (1935, 782), (1935, 874)], lpos=0.6)
d.edge("wk_adot", "xray", exit=(1, 0.5), entry=(0, 0.5), lpos=0.5)
d.edge("g_app", "nat", exit=(0.833, 0), entry=(0.5, 1), lpos=1, lx=-90, ly=-30)
d.edge("nat", "igw", exit=(1, 0.5), entry=(0, 0.5))
d.edge("g_app", "ecr", exit=(0, 0.3667), entry=(1, 0.5), lpos=0.0)
d.edge("g_app", "logs", exit=(1, 0.94), entry=(0, 0.5), lpos=0.0)
d.edge("g_app", "aurora_writer", "dashed", exit=(0.479, 1), entry=(0.75, 0),
       pts=[(1340, 1035), (1069, 1035)], lpos=-0.25, ly=0)
d.edge("g_app", "opensearch", "dashed", exit=(0.625, 1), entry=(0, 0.5),
       pts=[(1480, 1136)], lpos=0.5, lx=0)
d.edge("canary", "cloudfront", exit=(0, 0.1), entry=(1, 0.483), lpos=0.0)
d.edge("alarm_edge", "sns_edge", exit=(1, 0.5), entry=(0, 0.5))
d.edge("alarm", "sns", exit=(1, 0.5), entry=(0, 0.5))
d.edge("sns", "email", exit=(1, 0.5), entry=(0, 0.5))
d.edge("sns_edge", "email", exit=(1, 0.5), entry=(0.5, 0), pts=[(2529, 274)])
d.edge("github", "sts", exit=(0, 0.7), entry=(0, 0.5),
       pts=[(32, 1148), (32, 1400)], lpos=0.5, ly=-22)
d.edge("github", "s3", exit=(1, 0.08), entry=(0, 0.5), pts=[(310, 1092.2), (310, 819)], lpos=0.1, lx=-75)
d.edge("github", "g_app", exit=(1, 0.25), entry=(0, 0.037), pts=[(555, 1107.5), (555, 730)], lpos=0.55)
d.edge("github", "ecr", exit=(1, 0.45), entry=(0, 0.5), pts=[(570, 1125.5), (570, 819)], lpos=0.0, lx=-45)

# ---------- 凡例（矢印の注記と線の種類だけ） ----------
LX, LY = 20, 335
d.add("legend", "", "rounded=1;arcSize=3;html=1;fillColor=#FFFFFF;strokeColor=#5A6B86;", LX, LY, 255, 250)
d.text("凡例", LX + 12, LY + 8, 200, 26, fs=17, bold=True)
d.text(LEGEND_ARROW.replace("（", "\n（"), LX + 12, LY + 38, 235, 66, fs=14)
d.line_sample(LX + 14, LY + 132, 60, "main")
d.text(reflow(LEGEND_MAIN, "①〜⑨ 購入リクエスト\n1 回分の処理順"), LX + 84, LY + 112, 165, 42, fs=14)
d.line_sample(LX + 14, LY + 180, 60, "normal")
d.text(LEGEND_OTHER, LX + 84, LY + 168, 165, 24, fs=14)
d.line_sample(LX + 14, LY + 218, 60, "dashed")
d.text(LEGEND_DASHED, LX + 84, LY + 206, 165, 24, fs=14)

with open(OUT, "w", encoding="utf-8") as f:
    f.write(d.xml(W, H))
print("wrote", OUT, len(d.cells), "cells")
