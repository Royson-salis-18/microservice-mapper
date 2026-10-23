"""Parse the user's hand-reworded PDF into {section_number: [sentences]} (chapters 1-7 only)."""
import re, json, subprocess, sys, os
R = '/home/user/microservice-mapper/report'
pdf = sys.argv[1]
txt = subprocess.run(['pdftotext', '-layout', pdf, '-'], capture_output=True, text=True).stdout
lines = txt.split('\n')
# body starts at the first real chapter heading (after the lists)
start = next(i for i, l in enumerate(lines) if l.strip() == 'CHAPTER 1' and i > 400)
end = next((i for i, l in enumerate(lines) if re.match(r'\s*(REFERENCES|APPENDIX A)\s*$', l) and i > start), len(lines))
body = lines[start:end]
chap_titles = {'INTRODUCTION', 'LITERATURE REVIEW', 'PROPOSED SYSTEM AND SCOPE', 'METHODOLOGY',
               'IMPLEMENTATION & EXPERIMENTAL WORK', 'IMPLEMENTATION AND EXPERIMENTAL WORK',
               'RESULTS, ANALYSIS AND DISCUSSION', 'CONCLUSION AND FUTURE SCOPE'}
vocab = set(re.findall(r"[A-Za-z]+(?:-[A-Za-z]+)+", open(R + '/chapters/ch1_introduction.tex').read() + ''.join(open(f'{R}/chapters/{f}').read() for f in os.listdir(R + '/chapters') if f.endswith('.tex'))))
cur = None; secs = {}; order = []; hdr = False
chap = 0
for l in body:
    s = l.strip()
    if not s: continue
    if re.fullmatch(r'\d{1,3}', s) and False: continue
    m = re.match(r'CHAPTER (\d)$', s)
    if m: chap = int(m.group(1)); cur = None; continue
    if s in chap_titles: hdr = True; continue
    h = re.match(r'(\d+\.\d+(?:\.\d+)?)\s+([A-Z][^.]{2,90})$', s)
    if h and int(h.group(1).split('.')[0]) == chap and len(h.group(2).split()) <= 12 and not s.endswith(('.', ',')):
        cur = h.group(1); secs[cur] = {'title': h.group(2), 'lines': []}; order.append(cur); continue
    if cur is None: continue
    if hdr and secs[cur]['lines'] and not re.search(r'[.!?:;)\]]$', secs[cur]['lines'][-1]) and s[:1].isupper() and not re.match(r'(•|\d+\.|[A-Z]{2,})', s):
        s = s[0].lower() + s[1:] if not re.match(r'[A-Z][a-z]+[A-Z]|[A-Z]\w*-', s) and s.split()[0] not in ('I', 'A') or s.split()[0] == 'A' else s
    hdr = False
    secs[cur]['lines'].append(s)
out = {}
for k in order:
    parts = []
    for s in secs[k]['lines']:
        if parts and parts[-1].endswith('-') and s[:1].islower():
            a = parts[-1][:-1]; w1 = re.findall(r'[A-Za-z]+$', a)
            w2 = re.match(r'[A-Za-z]+', s)
            joined = (w1[0] + w2.group(0)).lower() if w1 and w2 else ''
            hy = (w1[0] + '-' + w2.group(0)) if w1 and w2 else ''
            parts[-1] = a + ('-' if hy in vocab else '') + s
        else:
            parts.append(s)
    text = ' '.join(parts)
    text = re.sub(r'\s+', ' ', text)
    out[k] = {'title': secs[k]['title'], 'text': text}
json.dump(out, open(R + '/docx/merge/mine_sections.json', 'w'), indent=1, ensure_ascii=False)
print(len(out), 'sections;', sum(len(v['text'].split()) for v in out.values()), 'words')
print(list(out)[:12])
