"""余白を詰める: y >= y0 にある要素・折れ点を dy だけ上へ移し、y0 をまたぐ枠は高さを dy 減らす。"""
import re


def _num(v):
    return int(v) if float(v).is_integer() else round(v, 2)


def squeeze(cells, y0, dy):
    def geo(m):
        y, h = float(m.group(2)), float(m.group(4))
        if y >= y0:
            y -= dy
        elif y + h > y0:
            h -= dy
        return f'<mxGeometry x="{m.group(1)}" y="{_num(y)}" width="{m.group(3)}" height="{_num(h)}" as="geometry"/>'

    def pt(m):
        y = float(m.group(2))
        if y >= y0:
            y -= dy
        return f'<mxPoint x="{m.group(1)}" y="{_num(y)}"{m.group(3)}/>'

    out = []
    for c in cells:
        c = re.sub(r'<mxGeometry x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" as="geometry"/>', geo, c)
        c = re.sub(r'<mxPoint x="([^"]+)" y="([^"]+)"((?: as="(?:sourcePoint|targetPoint)")?)/>', pt, c)
        out.append(c)
    return out
