"""共通の要素定義（名前・アイコン・ラベル）。全体図と観点ごとの図で共有する。\n\nstyle 名は drawio の shape 索引（drawio skill の scripts/find-shapes.js）で実在を確認したもの。\n"""
from xml.sax.saxutils import escape

FONT = "Helvetica,Arial,IPAPGothic,Hiragino Sans,Yu Gothic,Meiryo,sans-serif"
TXT = "#232F3E"

# 公式アイコン（find-shapes.js の結果の style の要点。fillColor はカテゴリの色）
def res_icon(res, fill):
    return (f"sketch=0;outlineConnect=0;fontColor={TXT};fillColor={fill};strokeColor=#ffffff;dashed=0;"
            f"html=1;aspect=fixed;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.{res};")

def shape_icon(shape, fill):
    return (f"sketch=0;outlineConnect=0;fontColor={TXT};gradientColor=none;fillColor={fill};strokeColor=none;dashed=0;"
            f"html=1;aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.{shape};")

ICON = {
    "users": (shape_icon("users", "#232F3D"), 78, 78),
    "github": ("dashed=0;outlineConnect=0;html=1;shape=mxgraph.weblogos.github;", 75, 75),
    "email": (shape_icon("email_2", "#232F3D"), 78, 49),
    "cloudfront": (res_icon("cloudfront", "#8C4FFF"), 78, 78),
    "waf": (res_icon("waf", "#DD344C"), 78, 78),
    "alb": (shape_icon("application_load_balancer", "#8C4FFF"), 78, 78),
    "nat": (shape_icon("nat_gateway", "#8C4FFF"), 78, 78),
    "igw": (shape_icon("internet_gateway", "#8C4FFF"), 78, 78),
    "ecs": (res_icon("ecs", "#ED7100"), 40, 40),
    "task": (shape_icon("ecs_task", "#ED7100"), 37, 48),
    "adot": (res_icon("distro_for_opentelemetry", "#E7157B"), 44, 44),
    "ecr": (res_icon("ecr", "#ED7100"), 78, 78),
    "aurora": (res_icon("aurora", "#C925D1"), 56, 56),
    "aurora_instance": (shape_icon("aurora_instance", "#C925D1"), 52, 52),
    "valkey": (shape_icon("elasticache_for_valkey", "#C925D1"), 78, 69),
    "opensearch": (res_icon("elasticsearch_service", "#8C4FFF"), 78, 78),
    "eventbridge": (res_icon("eventbridge", "#E7157B"), 78, 78),
    "sqs": (res_icon("sqs", "#E7157B"), 78, 78),
    "sns": (res_icon("sns", "#E7157B"), 78, 78),
    "secrets": (res_icon("secrets_manager", "#DD344C"), 78, 78),
    "logs": (shape_icon("cloudwatch_logs", "#E7157B"), 78, 58),
    "alarm": (shape_icon("alarm", "#E7157B"), 78, 78),
    "synthetics": (shape_icon("cloudwatch_synthetics", "#E7157B"), 78, 77),
    "xray": (res_icon("xray", "#C925D1"), 78, 78),
    "s3": (res_icon("s3", "#7AA116"), 78, 78),
    "sts": (shape_icon("sts", "#DD344C"), 78, 50),
}

# 要素 ID → (アイコン, ラベル)。ラベルは改行を "\n" で書く
NODES = {
    "user": ("users", "利用者（ブラウザ）"),
    "github": ("github", "GitHub Actions\nterraform plan・apply・destroy"),
    "email": ("email", "email"),
    "cloudfront": ("cloudfront", "Amazon CloudFront"),
    "waf": ("waf", "AWS WAF\n（protection pack (web ACL)）"),
    "canary": ("synthetics", "Amazon CloudWatch\nSynthetics（canary）"),
    "alarm_edge": ("alarm", "CloudWatch alarm\n対象: CloudFront・\nAWS WAF・canary"),
    "sns_edge": ("sns", "Amazon Simple\nNotification Service\n（Amazon SNS）"),
    "alb": ("alb", "Application Load Balancer\nCloudFront からのみ受ける"),
    "nat": ("nat", "NAT gateway"),
    "igw": ("igw", "internet gateway"),
    "fe_task": ("task", ""),
    "api_task": ("task", ""),
    "api_adot": ("adot", ""),
    "wk_task": ("task", ""),
    "wk_adot": ("adot", ""),
    "aurora": ("aurora", ""),
    "aurora_writer": ("aurora_instance", "writer"),
    "aurora_reader": ("aurora_instance", "reader"),
    "valkey": ("valkey", "Amazon ElastiCache\n（Valkey）\n在庫の前段判定・\nレート制限"),
    "opensearch": ("opensearch", "Amazon OpenSearch\nService\nイベント検索"),
    "eventbridge": ("eventbridge", "Amazon EventBridge\n（custom event bus・rule）"),
    "sqs": ("sqs", "Amazon Simple Queue\nService（Amazon SQS）\ndead-letter queue\n（DLQ）あり"),
    "secrets": ("secrets", "AWS Secrets Manager"),
    "ecr": ("ecr", "Amazon Elastic Container\nRegistry（Amazon ECR）"),
    "s3": ("s3", "Amazon Simple Storage Service\n（Amazon S3）\nTerraform state"),
    "xray": ("xray", "AWS X-Ray"),
    "logs": ("logs", "Amazon CloudWatch Logs\nembedded metric format\n（EMF）のメトリクスを含む"),
    "alarm": ("alarm", "Amazon CloudWatch\nalarm・dashboard\n対象: ALB・ECS・\nAurora・DLQ・EMF"),
    "sns": ("sns", "Amazon SNS"),
    "sts": ("sts", "AWS Security Token Service（AWS STS）"),
}

# 箱（ECS service）のラベル
BOX = {
    "fe_box": "Frontend（Next.js）\nServer-side Rendering（SSR）",
    "api_box": "API（NestJS）\n購入・検索・認証",
    "wk_box": "Worker\nsearch projection の更新",
}

GROUP = {
    "aws": "AWS Cloud",
    "reg_edge": "Region: us-east-1",
    "reg_main": "Region: ap-northeast-1",
    "vpc": "VPC",
    "pub": "Public subnet (2 AZs)",
    "pri": "Private subnet (2 AZs)",
    "g_app": "Amazon ECS cluster (AWS Fargate)",
    "g_data": "Data store",
}

# 線のラベル（全体図と観点ごとの図で共有）。(通信元, 通信先) → (1 行目, 技術)。
# 要求の流れの線は C4 の形（1 行目に目的、2 行目に [技術]）。技術が書けない線は ""、運用の線は None（目的と手段だけ）
EDGE = {
    ("user", "cloudfront"): ("① 購入リクエスト", "JSON/HTTPS"),
    ("cloudfront", "alb"): ("② origin へ転送", "JSON/HTTPS"),
    ("alb", "api_box"): ("③ API へ転送", "JSON/HTTP"),
    ("api_box", "valkey"): ("④ 在庫の前段判定", "RESP/TLS"),
    ("api_box", "aurora_writer"): ("⑤ 購入の確定", "PostgreSQL protocol/TLS"),
    ("api_box", "eventbridge"): ("⑥ イベントの発行", "HTTPS"),
    ("eventbridge", "sqs"): ("⑦ イベントの配信", ""),
    ("wk_box", "sqs"): ("⑧ メッセージの受信", "HTTPS"),
    ("wk_box", "opensearch"): ("⑨ projection の更新", "HTTPS"),
    ("alb", "fe_box"): ("画面の転送", "HTTP"),
    ("fe_box", "cloudfront"): ("SSR の API 取得", "JSON/HTTPS"),
    ("api_box", "opensearch"): ("イベント検索", "HTTPS"),
    ("api_box", "secrets"): ("DB password の取得", "HTTPS"),
    ("g_app", "nat"): ("外向きの通信", "HTTPS 443"),
    ("nat", "igw"): ("", None),
    ("canary", "cloudfront"): ("外形監視\n（5 分ごと）", None),
    ("alarm_edge", "sns_edge"): ("通知", None),
    ("alarm", "sns"): ("通知", None),
    ("sns_edge", "email"): ("", None),
    ("sns", "email"): ("", None),
    ("github", "sts"): ("AssumeRoleWithWebIdentity\n（OpenID Connect）", None),
    ("github", "s3"): ("state の読み書き\n（Terraform backend）", None),
    ("github", "ecr"): ("docker push", None),
    ("github", "g_app"): ("デプロイ\n（UpdateService）", None),
    ("g_app", "ecr"): ("image pull", None),
    ("g_app", "secrets"): ("secret の注入\n（API の task 起動時）", None),
    ("api_task", "api_adot"): ("", None),
    ("wk_task", "wk_adot"): ("", None),
    ("api_adot", "xray"): ("trace", None),
    ("wk_adot", "xray"): ("trace", None),
    ("g_app", "logs"): ("ログ\n（awslogs）", None),
    ("g_app", "aurora_writer"): ("migration", None),
    ("g_app", "opensearch"): ("migration", None),
}

LEGEND_ARROW = "矢印は通信の向き（通信を開始する側 → 受ける側。応答は描かない）"
LEGEND_MAIN = "①〜⑨ 購入リクエスト 1 回分の処理順"
LEGEND_OTHER = "その他の通信"
LEGEND_DASHED = "standalone task の通信"

AURORA_LINES = ["Amazon Aurora PostgreSQL-Compatible Edition", "（Aurora Serverless v2）",
                "購入の確定（正本）", "automated backups 1 日", "reader は failover 先（アプリは未使用）"]

LEGEND_ECS = "Amazon Elastic Container\nService（Amazon ECS）\nの task（service ごと）"
LEGEND_ADOT = "AWS Distro for\nOpenTelemetry（ADOT）\nCollector（sidecar）"


def _squash(text):
    return text.replace("\n", "").replace(" ", "")


def reflow(base, label=None):
    """共通定義の文字列 base の改行位置だけを変えた label を返す（label が None なら base）。
    改行と空白を除いて base と一致しなければ失敗する（図ごとに意味が変わるのを防ぐ）。"""
    if label is None:
        return base
    if _squash(label) != _squash(base):
        raise ValueError(f"label {label!r} が共通定義 {base!r} と違う")
    return label


def node_label(nid, label=None):
    """NODES のラベル。改行位置だけを変える時は label を渡す。"""
    return reflow(NODES[nid][1], label)


def html(label):
    return escape(label).replace("\n", "<br>")


class Diagram:
    def __init__(self, fs=14):
        self.cells = []
        self.n = 0
        self.fs = fs

    def _id(self, pref):
        self.n += 1
        return f"{pref}{self.n}"

    def add(self, cid, value, style, x, y, w, h):
        self.cells.append(
            f'<mxCell id="{cid}" value="{escape(value, {chr(34): "&quot;"})}" style="{style}fontFamily={FONT};" vertex="1" parent="1">'
            f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')
        return cid

    def icon(self, nid, x, y, label_pos="bottom", fs=None, label=None, size=None):
        fs = fs or self.fs
        kind, lab = NODES[nid]
        if label == "":
            lab = ""   # ラベルを別の text で置く時（中身は node_label で共通定義から取る）
        elif label is not None:
            lab = reflow(lab, label)
        style, w, h = ICON[kind]
        if size:
            w, h = size
        if label_pos == "bottom":
            lp = "verticalLabelPosition=bottom;verticalAlign=top;align=center;labelPosition=center;"
        elif label_pos == "top":
            lp = "verticalLabelPosition=top;verticalAlign=bottom;align=center;labelPosition=center;"
        else:  # right
            lp = "labelPosition=right;verticalLabelPosition=middle;align=left;verticalAlign=middle;spacingLeft=4;"
        return self.add(nid, html(lab), style + lp + f"fontSize={fs};", x, y, w, h)

    def aws_group(self, cid, label, kind, x, y, w, h, fs=16, sl=30):
        base = ("points=[];outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontStyle=1;container=1;"
                "pointerEvents=0;collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;verticalAlign=top;"
                f"align=left;spacingLeft={sl};")
        kinds = {
            "cloud": "grIcon=mxgraph.aws4.group_aws_cloud;strokeColor=#232F3E;fillColor=none;fontColor=#232F3E;dashed=0;",
            "region": "grIcon=mxgraph.aws4.group_region;strokeColor=#00A4A6;fillColor=none;fontColor=#147EBA;dashed=1;",
            "vpc": "grIcon=mxgraph.aws4.group_vpc2;strokeColor=#8C4FFF;fillColor=none;fontColor=#8C4FFF;dashed=0;",
            "public": "grIcon=mxgraph.aws4.group_security_group;grStroke=0;strokeColor=#7AA116;fillColor=#F2F6E8;fontColor=#248814;dashed=0;",
            "private": "grIcon=mxgraph.aws4.group_security_group;grStroke=0;strokeColor=#00A4A6;fillColor=#E6F6F7;fontColor=#147EBA;dashed=0;",
        }
        return self.add(cid, html(label), base + kinds[kind] + f"fontSize={fs};", x, y, w, h)

    def role_group(self, cid, label, x, y, w, h, fs=16, fill="none", sl=10, valign="top"):
        st = (f"rounded=1;arcSize=3;html=1;whiteSpace=wrap;container=1;collapsible=0;dashed=1;dashPattern=6 4;"
              f"strokeColor=#5A6B86;strokeWidth=1.5;fillColor={fill};fontColor=#2E3B4E;fontStyle=1;"
              f"verticalAlign={valign};align=left;spacingLeft={sl};spacingTop=2;spacingBottom=4;fontSize={fs};")
        return self.add(cid, html(label), st, x, y, w, h)

    def box(self, cid, label, x, y, w, h, fs=None, extra=""):
        fs = fs or self.fs
        st = (f"rounded=1;arcSize=6;html=1;whiteSpace=wrap;fillColor=#FFFFFF;strokeColor=#ED7100;strokeWidth=1.5;"
              f"fontColor={TXT};verticalAlign=top;align=center;spacingTop=4;fontSize={fs};" + extra)
        return self.add(cid, html(label), st, x, y, w, h)

    def text(self, label, x, y, w, h, fs=None, align="left", bold=False, extra=""):
        fs = fs or self.fs
        st = (f"text;html=1;whiteSpace=wrap;strokeColor=none;fillColor=none;align={align};verticalAlign=middle;"
              f"fontColor={TXT};fontSize={fs};" + ("fontStyle=1;" if bold else "") + extra)
        return self.add(self._id("t"), html(label), st, x, y, w, h)

    def edge(self, src, dst, kind="normal", pts=(), exit=None, entry=None, lx=None, ly=None, lpos=None, label=None):
        """ラベルは EDGE（共通定義）から取る。label は改行位置だけを変える時に渡す（改行と空白を除いて EDGE と一致しなければ失敗）。
        tech があれば C4 の形: 1 行目に目的、2 行目に小さく [技術]（README 幅の最小 12px を守るため 2 行目は self.fs、1 行目を +2）"""
        base, tech = EDGE[(src, dst)]
        try:
            label = reflow(base, label)
        except ValueError as e:
            raise ValueError(f"{src}->{dst}: {e}") from None
        up = 2 if tech is not None else 1
        if kind == "main":
            st = f"strokeColor=#D6336C;strokeWidth=3.5;fontColor=#C2255C;fontStyle=1;fontSize={self.fs + up};endSize=8;"
        elif kind == "dashed":
            st = f"strokeColor=#545B64;strokeWidth=1.5;dashed=1;dashPattern=8 5;fontColor=#232F3E;fontSize={self.fs};"
        else:
            st = f"strokeColor=#545B64;strokeWidth=1.5;fontColor=#232F3E;fontSize={self.fs + (1 if tech else 0)};"
        st = ("edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;html=1;endArrow=block;endFill=1;"
              "labelBackgroundColor=#FFFFFF;" + st)
        if exit:
            st += f"exitX={exit[0]};exitY={exit[1]};exitDx=0;exitDy=0;"
        if entry:
            st += f"entryX={entry[0]};entryY={entry[1]};entryDx=0;entryDy=0;"
        eid = self._id("e")
        geo_pts = "".join(f'<mxPoint x="{px}" y="{py}"/>' for px, py in pts)
        arr = f'<Array as="points">{geo_pts}</Array>' if pts else ""
        lbl_geo = ""
        x_rel = lpos if lpos is not None else 0
        if lx is not None or ly is not None:
            lbl_geo = f'<mxPoint x="{lx or 0}" y="{ly or 0}" as="offset"/>'
        val = html(label)
        if tech:
            val += f'<br><span style="font-size:{self.fs}px;font-weight:normal">[{escape(tech)}]</span>'
        self.cells.append(
            f'<mxCell id="{eid}" value="{escape(val, {chr(34): "&quot;"})}" style="{st}fontFamily={FONT};" edge="1" parent="1" source="{src}" target="{dst}">'
            f'<mxGeometry x="{x_rel}" relative="1" as="geometry">{arr}{lbl_geo}</mxGeometry></mxCell>')
        return eid

    def line_sample(self, x, y, w, kind):
        """凡例用: 端点だけの矢印"""
        if kind == "main":
            st = "strokeColor=#D6336C;strokeWidth=3.5;endSize=8;"
        elif kind == "dashed":
            st = "strokeColor=#545B64;strokeWidth=1.5;dashed=1;dashPattern=8 5;"
        else:
            st = "strokeColor=#545B64;strokeWidth=1.5;"
        eid = self._id("l")
        self.cells.append(
            f'<mxCell id="{eid}" value="" style="html=1;endArrow=block;endFill=1;{st}" edge="1" parent="1">'
            f'<mxGeometry relative="1" as="geometry"><mxPoint x="{x}" y="{y}" as="sourcePoint"/>'
            f'<mxPoint x="{x + w}" y="{y}" as="targetPoint"/></mxGeometry></mxCell>')

    def xml(self, w, h):
        body = "".join(self.cells)
        return (f'<mxfile><diagram id="architecture" name="architecture">'
                f'<mxGraphModel dx="{w}" dy="{h}" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" '
                f'fold="1" page="1" pageScale="1" pageWidth="{w}" pageHeight="{h}" math="0" shadow="0">'
                f'<root><mxCell id="0"/><mxCell id="1" parent="0"/>{body}</root></mxGraphModel></diagram></mxfile>')
