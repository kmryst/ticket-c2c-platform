import xml.etree.ElementTree as ET, re, html, sys
def load(p):
    cells={}
    for c in ET.parse(p).iter('mxCell'):
        v=html.unescape(c.get('value') or ''); v=re.sub(r'<[^>]+>',' ',v); v=re.sub(r'\s+','',v)
        cells[c.get('id')]=(c.get('edge')=='1',c.get('source'),c.get('target'),v)
    return cells
full=load(sys.argv[1]); bad=0
fe={(s,t):v for (e,s,t,v) in full.values() if e}
for p in sys.argv[2:]:
    view=load(p); n=0
    for cid,(e,s,t,v) in view.items():
        if e and s:
            n+=1
            if (s,t) not in fe: print(p.split('/')[-1],'edge missing in full',s,t); bad+=1
            elif fe[(s,t)]!=v: print(p.split('/')[-1],'label diff',s,t,repr(v),repr(fe[(s,t)])); bad+=1
        elif not e and cid in full and v and full[cid][3] and full[cid][3]!=v and not cid.startswith('t'):
            print(p.split('/')[-1],'name diff',cid,repr(v),repr(full[cid][3])); bad+=1
    print(p.split('/')[-1], 'edges checked', n)
print('mismatches', bad); sys.exit(1 if bad else 0)
