"""Step 3: fill the contents / figure / table lists with real page numbers (render with LibreOffice, read the footers)."""
import copy, json, os, re, subprocess, sys
import docx
from docx.text.paragraph import Paragraph
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); B = f'{R}/docx/build'
idx = json.load(open(f'{B}/index.json'))
D = docx.Document(f'{B}/stage1.docx')
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'

def short(c):
    c = re.sub(r'\s+', ' ', c).strip()
    first = re.split(r'(?<=[a-z\)])\.\s', c)[0].rstrip('.')
    if len(first) > 95:
        first = first[:92].rsplit(' ', 1)[0] + '…'
    return first

def tables():
    ts = {}
    for t in D.tables:
        if len(t.rows[0].cells) < 3: continue
        h = t.rows[0].cells[0].text.strip().lower()
        if h.startswith('sr'):
            second = t.rows[0].cells[1].text.strip().upper()
            ts[second.split()[0]] = t
    return ts
TS = tables()      # keys: CONTENTS, TITLE (figures first, tables second)
toc = TS['CONTENTS']
lists = [t for t in D.tables if len(t.rows[0].cells) > 1 and t.rows[0].cells[1].text.strip().upper() == 'TITLE']
lof, lot = lists[0], lists[1]

def fill(table, rows, pages):
    tmpl = copy.deepcopy(table.rows[1]._tr)
    for r in list(table.rows)[1:]: table._tbl.remove(r._tr)
    for (a, b), pg in zip(rows, pages):
        tr = copy.deepcopy(tmpl); table._tbl.append(tr)
        cells = tr.findall(W + 'tc')
        for tc, text in zip(cells, (a, b, pg)):
            ps = tc.findall(W + 'p')
            for extra in ps[1:]: tc.remove(extra)
            p = Paragraph(ps[0], D)
            runs = p.runs
            if runs:
                runs[0].text = text
                for r in runs[1:]: r._r.getparent().remove(r._r)
            else:
                p.add_run(text)

toc_rows = []
for n, t in idx['chapters']:
    toc_rows.append((n + '.' if n else '', t))
fig_rows = [(l, short(c)) for l, c in idx['figs']]
tab_rows = [(l, short(c)) for l, c in idx['tabs']]

def render(path):
    subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', B, path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    pdf = os.path.splitext(path)[0] + '.pdf'
    n = int(re.search(r'Pages:\s+(\d+)', subprocess.run(['pdfinfo', pdf], capture_output=True, text=True).stdout).group(1))
    pages = []
    for i in range(1, n + 1):
        pages.append(subprocess.run(['pdftotext', '-f', str(i), '-l', str(i), '-layout', pdf, '-'], capture_output=True, text=True).stdout)
    return pages

def footer_no(txt, i):
    m = re.findall(r'Page (\d+)', txt)
    return m[-1] if m else str(i + 1)

def locate(pages):
    start = next(i for i, t in enumerate(pages) if re.match(r'\s*CHAPTER 1\s*\n', t))
    res = {'chap': [], 'fig': [], 'tab': []}
    for n, t in idx['chapters']:
        for i in range(start, len(pages)):
            first = [ln.strip() for ln in pages[i].split('\n') if ln.strip()]
            if not first: continue
            key = f'CHAPTER {n}' if n else t.split(':')[0].title() if t.startswith('APPENDIX') else 'References'
            if first[0] == key or (t.startswith('APPENDIX') and first[0].upper().startswith(t.split(':')[0])) :
                res['chap'].append(footer_no(pages[i], i)); break
        else: res['chap'].append('')
    for kind, rows in (('fig', idx['figs']), ('tab', idx['tabs'])):
        pos = start
        for lab, _ in rows:
            for i in range(pos, len(pages)):
                if re.search(r'^\s*' + re.escape(lab) + r':', pages[i], re.M):
                    res[kind].append(footer_no(pages[i], i)); pos = i; break
            else: res[kind].append('')
    return res

fill(toc, toc_rows, [''] * len(toc_rows)); fill(lof, fig_rows, [''] * len(fig_rows)); fill(lot, tab_rows, [''] * len(tab_rows))
D.save(f'{B}/pass1.docx'); pages = render(f'{B}/pass1.docx'); loc = locate(pages)
for _ in range(2):
    fill(toc, toc_rows, loc['chap']); fill(lof, fig_rows, loc['fig']); fill(lot, tab_rows, loc['tab'])
    D.save(f'{B}/pass2.docx'); pages = render(f'{B}/pass2.docx'); new = locate(pages)
    if new == loc: break
    loc = new
out = f'{R}/docx/Project_Report_MITE_format.docx'
D.save(out); print('pages', len(pages), 'saved', out)
print(loc['chap'])
