"""Step 2: inject the converted chapters into the department template, fill cover/lists/page numbers."""
import copy, re, os, sys, subprocess, json
import docx
from docx.shared import Pt, Cm, RGBColor, Emu
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from docx.text.paragraph import Paragraph
from docx.table import Table

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
B = f'{R}/docx/build'
meta = open(f'{R}/meta.tex').read()
def M(name):
    m = re.search(r'\\newcommand\{\\' + name + r'\}\{(.*?)\}[ \t]*(?:%.*)?$', meta, re.M)
    return m.group(1).replace('--', '–') if m else ''
TITLE = M('ProjectTitle'); COURSE = M('CourseLine'); AY = M('AcademicYear')
ST = [(M(n), M(u)) for n, u in [('StudentOne', 'USNOne'), ('StudentTwo', 'USNTwo'), ('StudentThree', 'USNThree'), ('StudentFour', 'USNFour')]]
GUIDE, GDES, HOD, PRIN = M('GuideName'), M('GuideDesignation'), M('HODName'), M('PrincipalName')
DEPT = 'ARTIFICIAL INTELLIGENCE AND MACHINE LEARNING'; DEPT_T = 'Artificial Intelligence and Machine Learning'
COURSE_CODE = COURSE.split()[0]

T = docx.Document(f'{B}/template.docx')
P = docx.Document(f'{B}/body.docx')

# ---------------------------------------------------------------- helpers
def settext(p, text, color=True):
    """replace a paragraph's text but keep its first run's formatting (placeholders are red: make black)"""
    runs = p.runs
    if not runs:
        p.add_run(text); return
    runs[0].text = text
    for r in runs[1:]: r._r.getparent().remove(r._r)
    if color and runs[0].font.color is not None and runs[0].font.color.type is not None:
        runs[0].font.color.rgb = RGBColor(0, 0, 0)

def blacken(p):
    for r in p.runs:
        if r.font.color is not None and r.font.color.type is not None: r.font.color.rgb = RGBColor(0, 0, 0)

body = T.element.body
els = list(body.iterchildren())
def par(i): return Paragraph(els[i], T)

# ---------------------------------------------------------------- front matter
cover = {13: None}
settext(par(15), '  ' + COURSE.replace('--', '–'))
settext(par(17), '“' + TITLE.upper() + '”')
settext(par(25), DEPT + ' ')
for k, i in enumerate((29, 30, 31, 32)):
    settext(par(i), f'{ST[k][0]}\t{ST[k][1]}')
    pf = par(i).paragraph_format
    par(i).alignment = WD_ALIGN_PARAGRAPH.LEFT
    pf.left_indent = Cm(3.2); pf.tab_stops.add_tab_stop(Cm(9.2))
settext(par(35), GUIDE); settext(par(36), GDES)
# department line (blue run + red note)
p38 = par(38)
for r in p38.runs: pass
settext(p38, 'DEPARTMENT OF ' + DEPT, color=False)
p39 = par(39)
for r in list(p39.runs): r._r.getparent().remove(r._r)
settext(par(46), AY)

# certificate
p57 = par(57)
p57.runs[0].text = '\nDEPARTMENT OF ' + DEPT + '\n'
for r in p57.runs[1:]: r._r.getparent().remove(r._r)
cert = (f'This is to certify that the Project Phase – II ({COURSE_CODE}) work entitled “{TITLE.upper()}” is a bonafide work carried out by '
        + ', '.join(f'{n} ({u})' for n, u in ST) +
        f' in partial fulfillment for the award of degree of Bachelor of Engineering in {DEPT_T} of Mangalore Institute of Technology & Engineering (Autonomous) during the year {AY}. '
        'It is certified that all corrections and suggestions indicated for Internal Assessment have been incorporated in the report deposited in the departmental library. '
        'The project has been approved as it satisfies the academic requirements in respect of project work prescribed for the Bachelor of Engineering degree.')
settext(par(59), cert)
p = par(64); p.runs[0].text = GUIDE + '\nProject Guide'
for r in p.runs[1:]: r._r.getparent().remove(r._r)
p = par(66); p.runs[0].text = f'{HOD}        Head of Dept. AI & ML'
for r in p.runs[1:]: r._r.getparent().remove(r._r)
p = par(71); p.runs[0].text = PRIN + '\nPrincipal'
for r in p.runs[1:]: r._r.getparent().remove(r._r)
for i in (64, 66, 71): blacken(par(i))

# declaration
decl = (f'We declare that this Project Phase – II ({COURSE_CODE}) report titled “{TITLE}” submitted in partial fulfillment of the degree of B.E. in {DEPT_T} '
        f'is a record of original work carried out by us under the supervision of {GUIDE}, and has not formed the basis for the award of any other degree, in this or any other Institution or University. '
        'In keeping with ethical practice in reporting scientific information, due acknowledgements have been made wherever the findings of others have been cited.')
settext(par(75), '      ' + decl)
decl_tbl = Table(els[77], T)
for k in range(4):
    c = decl_tbl.rows[k + 1].cells
    c[1].paragraphs[0].text = ''
    r = c[1].paragraphs[0].add_run(f'{ST[k][0]} ({ST[k][1]})')

# acknowledgements
settext(par(96), f'The successful completion of the Project Phase – II ({COURSE_CODE}) work titled “{TITLE}” would not have been possible without the support of those, whose constant guidance and encouragement helped turn our efforts into success.')
settext(par(97), f'We would like to thank our Project Guide {GUIDE}, {GDES}, Department of {DEPT_T} for his/her constant encouragement and support extended throughout.')
settext(par(98), f'We would like to express appreciation to {HOD}, Head of Department of {DEPT_T} for his/her support and guidance.')
settext(par(99), f'We would like to thank our Principal {PRIN}, for encouraging us and giving us an opportunity to accomplish the project.')
for k, i in enumerate((105, 106, 107, 108)):
    settext(par(i), f'{ST[k][0]} ({ST[k][1]})')

# abstract (the template limits it to 150 words)
ABSTRACT = open(f'{R}/docx/abstract.txt').read().strip()
assert len(ABSTRACT.split()) <= 150, len(ABSTRACT.split())
settext(par(113), ABSTRACT)
els[112].getparent().remove(els[112])   # template note

# abbreviations
abbr = open(f'{R}/docx/abbreviations.txt').read().strip().split('\n')
ab_head = [i for i in range(len(els)) if els[i].tag.endswith('}p') and Paragraph(els[i], T).text.strip() == 'Abbreviations / Notations'][0]
tmpl_line = els[ab_head + 1]
for i in range(ab_head + 1, ab_head + 9): els[i].getparent().remove(els[i])
anchor = els[ab_head]
for line in reversed(abbr):
    ne = copy.deepcopy(tmpl_line)
    pp = Paragraph(ne, T)
    if line.startswith('#'):
        settext(pp, line[1:].strip())
        for r in pp.runs: r.bold = True
    else:
        settext(pp, line)
    anchor.addnext(ne)

# ---------------------------------------------------------------- body of the new document
CHAPTERS = []   # (num, title)
FIGS, TABS = [], []   # (label, caption)
W = lambda t: '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}' + t
pels = list(P.element.body.iterchildren())
ct = {'fig': {}, 'tab': {}}
chap_n = 0; appendix = False; sec = sub = 0
out = []   # new elements
MADE = set()
def mkp(style, text='', bold=None, align=None, size=None, keep_next=False, page_break=False):
    p = OxmlElement('w:p'); MADE.add(id(p))
    pp = Paragraph(p, T)
    pp.style = T.styles[style]
    if page_break: pp.paragraph_format.page_break_before = True
    if align is not None: pp.alignment = align
    if keep_next: pp.paragraph_format.keep_with_next = True
    if text:
        r = pp.add_run(text)
        if bold is not None: r.bold = bold
        if size: r.font.size = Pt(size)
    return p

def pstyle(el):
    ps = el.find('.//' + W('pStyle'))
    return ps.get(W('val')) if ps is not None else 'Normal'

def has_draw(el): return el.find('.//' + W('drawing')) is not None
def text_of(el): return ''.join(t.text or '' for t in el.iter(W('t')))

LETTER = 'ABC'
app_i = 0
EQ = {}
for el in pels:
    tag = el.tag.split('}')[1]
    if tag == 'sectPr': continue
    if tag == 'p':
        st = pstyle(el); txt = text_of(el)
        if st == 'Heading1':
            if '@@REFS@@' in txt:
                out.append(mkp('Section Heading', 'References', page_break=True)); CHAPTERS.append(('', 'REFERENCES')); continue
            if '@@APP@@' in txt:
                title = txt.replace('@@APP@@', '')
                L = LETTER[app_i]; app_i += 1; appendix = True; chap_n = L; sec = sub = 0
                out.append(mkp('Section Heading', f'Appendix {L}: {title}', page_break=True))
                CHAPTERS.append(('', f'APPENDIX {L}: {title.upper()}')); continue
            chap_n += 1; sec = sub = 0
            ttl = txt.upper().replace('&AMP;', '&').replace('IMPLEMENTATION AND EXPERIMENTAL WORK', 'IMPLEMENTATION & EXPERIMENTAL WORK')
            out.append(mkp('Chapter Title', f'CHAPTER {chap_n}', page_break=True)); out.append(mkp('Chapter Title', ttl))
            CHAPTERS.append((str(chap_n), ttl)); continue
        if st == 'Heading2':
            if '@@APPENDICES@@' in txt: continue
            sec += 1; sub = 0
            out.append(mkp('Section Heading', f'{chap_n}.{sec} {txt}', keep_next=True) if not appendix else mkp('Section Heading', f'{chap_n}.{sec} {txt}', keep_next=True)); continue
        if st == 'Heading3':
            sub += 1
            out.append(mkp('Subsection Heading', f'{chap_n}.{sec}.{sub} {txt}', keep_next=True)); continue
        if st in ('Heading4', 'Heading5'):
            e = copy.deepcopy(el); out.append(e); continue
        if st in ('ImageCaption', 'TableCaption', 'Caption'):
            kind = 'tab' if st == 'TableCaption' else 'fig'
            if txt.startswith('@@') : pass
            ct[kind][chap_n] = ct[kind].get(chap_n, 0) + 1
            num = f'{chap_n}.{ct[kind][chap_n]}'
            lab = ('Table ' if kind == 'tab' else 'Figure ') + num
            e = copy.deepcopy(el)
            ep = Paragraph(e, P)
            # strip pandoc's style
            for ppr in e.findall(W('pPr')): e.remove(ppr)
            first = OxmlElement('w:r'); rpr = OxmlElement('w:rPr'); b = OxmlElement('w:b'); rpr.append(b); first.append(rpr)
            tt = OxmlElement('w:t'); tt.text = lab + ': '; tt.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve'); first.append(tt)
            e.insert(0, first)
            pp = Paragraph(e, T); pp.style = T.styles['Normal']
            pp.alignment = WD_ALIGN_PARAGRAPH.CENTER
            pp.paragraph_format.line_spacing = 1.0
            pp.paragraph_format.space_after = Pt(10) if kind == 'fig' else Pt(4)
            pp.paragraph_format.keep_with_next = (kind == 'tab')
            for r in pp.runs: r.font.size = Pt(11)
            cap = re.sub(r'^.*?: ', '', pp.text, count=1)
            (TABS if kind == 'tab' else FIGS).append((lab, cap))
            MADE.add(id(e)); out.append(e); continue
        if st == 'SourceCode' or el.find('.//' + W('rStyle')) is not None and False:
            pass
        e = copy.deepcopy(el)
        out.append(e)
    else:
        out.append(copy.deepcopy(el))


# ================================================================ part 2: restyle pandoc content and merge
import io
from docx.oxml.ns import nsmap
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      'm': 'http://schemas.openxmlformats.org/officeDocument/2006/math',
      'wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'}
RID = '{%s}embed' % NS['r']

# list kinds from pandoc's numbering part
numroot = P.part.numbering_part.element
absfmt = {}
for an in numroot.findall(W('abstractNum')):
    aid = an.get(W('abstractNumId'))
    absfmt[aid] = {int(l.get(W('ilvl'))): l.find(W('numFmt')).get(W('val')) for l in an.findall(W('lvl'))}
numfmt = {}
for n in numroot.findall(W('num')):
    numfmt[n.get(W('numId'))] = absfmt[n.find(W('abstractNumId')).get(W('val'))]
counters = {}

def fix_image(blip_parent):
    for blip in blip_parent.iter('{%s}blip' % NS['a']):
        rid = blip.get(RID)
        blob = P.part.related_parts[rid].blob
        new_rid, _ = T.part.get_or_add_image(io.BytesIO(blob))
        blip.set(RID, new_rid)
    # fit to the text width (15.3 cm) and a page-friendly height
    for ext in blip_parent.iter('{%s}extent' % NS['wp']):
        cx, cy = int(ext.get('cx')), int(ext.get('cy'))
        maxw = Cm(15.0); maxh = Cm(11.5)
        k = min(maxw / cx, maxh / cy, 1e9)
        if cx > maxw or cy > maxh or cx < Cm(6):
            k = min(maxw / cx, maxh / cy)
            if cx * k < Cm(6) and cy * (Cm(6) / cx) <= maxh: k = Cm(6) / cx
        ext.set('cx', str(int(cx * k))); ext.set('cy', str(int(cy * k)))
        for a_ext in blip_parent.iter('{%s}ext' % NS['a']):
            if a_ext.get('cx'): a_ext.set('cx', str(int(cx * k))); a_ext.set('cy', str(int(cy * k)))

def style_table(tbl):
    tblPr = tbl.find(W('tblPr'))
    sty = tblPr.find(W('tblStyle'))
    if sty is not None and sty.get(W('val')) == 'FigureTable':
        # row of images: no borders
        for p in tbl.iter(W('p')):
            pp = Paragraph(p, T); pp.style = T.styles['Normal']; pp.alignment = WD_ALIGN_PARAGRAPH.CENTER
            pp.paragraph_format.line_spacing = 1.0; pp.paragraph_format.space_after = Pt(0)
        return
    if sty is None: sty = OxmlElement('w:tblStyle'); tblPr.insert(0, sty)
    sty.set(W('val'), T.styles['Table Grid'].style_id)
    for tag in ('tblW', 'tblLook', 'jc', 'tblLayout', 'tblCaption', 'tblDescription'):
        for e in tblPr.findall(W(tag)): tblPr.remove(e)
    w = OxmlElement('w:tblW'); w.set(W('type'), 'pct'); w.set(W('w'), '5000'); tblPr.append(w)
    jc = OxmlElement('w:jc'); jc.set(W('val'), 'center'); tblPr.append(jc)
    lay = OxmlElement('w:tblLayout'); lay.set(W('type'), 'autofit'); tblPr.append(lay)
    rows = tbl.findall(W('tr'))
    ncols = max(len(r.findall(W('tc'))) for r in rows)
    weights = [1.0] * ncols
    for tr in rows:
        for ci, tc in enumerate(tr.findall(W('tc'))[:ncols]):
            tx = ''.join(t.text or '' for t in tc.iter(W('t')))
            longest = max([len(w_) for w_ in tx.split()] or [1])
            weights[ci] = max(weights[ci], longest * 1.0 + 2, min(len(tx), 34) * 0.55 + 2)
    tot = sum(weights); TOTAL = 8600
    widths = [max(int(TOTAL * w_ / tot), 520) for w_ in weights]
    lay2 = tblPr.find(W('tblLayout')); lay2.set(W('type'), 'fixed')
    tw = tblPr.find(W('tblW')); tw.set(W('type'), 'dxa'); tw.set(W('w'), str(sum(widths)))
    for gc, wd in zip(tbl.iter(W('gridCol')), widths): gc.set(W('w'), str(wd))
    for tr in rows:
        for tc, wd in zip(tr.findall(W('tc')), widths):
            tcw = tc.find(W('tcPr')).find(W('tcW')) if tc.find(W('tcPr')) is not None else None
            if tcw is None:
                tcPr_ = tc.find(W('tcPr'))
                if tcPr_ is None: tcPr_ = OxmlElement('w:tcPr'); tc.insert(0, tcPr_)
                tcw = OxmlElement('w:tcW'); tcPr_.insert(0, tcw)
            tcw.set(W('type'), 'dxa'); tcw.set(W('w'), str(wd))
    size = 10 if ncols <= 4 else (9 if ncols <= 6 else 8)
    for ri, tr in enumerate(rows):
        trPr = tr.find(W('trPr'))
        if trPr is not None: tr.remove(trPr)
        trPr = OxmlElement('w:trPr'); tr.insert(0, trPr)
        cs = OxmlElement('w:cantSplit'); trPr.append(cs)
        if ri == 0:
            th = OxmlElement('w:tblHeader'); trPr.append(th)
        for tc in tr.findall(W('tc')):
            tcPr = tc.find(W('tcPr'))
            if tcPr is None: tcPr = OxmlElement('w:tcPr'); tc.insert(0, tcPr)
            for old in tcPr.findall(W('shd')) + tcPr.findall(W('tcMar')): tcPr.remove(old)
            if ri == 0:
                shd = OxmlElement('w:shd'); shd.set(W('val'), 'clear'); shd.set(W('color'), 'auto'); shd.set(W('fill'), 'E7E6E6'); tcPr.append(shd)
            mar = OxmlElement('w:tcMar')
            for side in ('top', 'bottom'):
                m_ = OxmlElement('w:' + side); m_.set(W('w'), '30'); m_.set(W('type'), 'dxa'); mar.append(m_)
            tcPr.append(mar)
            for p in tc.findall(W('p')):
                pp = Paragraph(p, T); pp.style = T.styles['Normal']
                pp.alignment = WD_ALIGN_PARAGRAPH.LEFT
                pf = pp.paragraph_format; pf.line_spacing = 1.0; pf.space_before = Pt(1); pf.space_after = Pt(1)
                for r in pp.runs:
                    r.font.size = Pt(size)
                    if ri == 0: r.bold = True
                for mr in p.iter('{%s}r' % NS['m']): pass

def restyle(e):
    """Normalise one pandoc body element for the template."""
    tag = e.tag.split('}')[1]
    if tag == 'tbl':
        style_table(e)
        for d in e.iter(W('drawing')): fix_image(d)
        return e
    if tag != 'p': return e
    st = pstyle(e)
    pp = Paragraph(e, T)
    # drop external hyperlinks (keep the visible text)
    for h in list(e.findall(W('hyperlink'))):
        for ch in list(h): h.addprevious(ch)
        e.remove(h)
    numPr = e.find('.//' + W('numPr'))
    if numPr is not None:
        nid = numPr.find(W('numId')).get(W('val')); lvl = int(numPr.find(W('ilvl')).get(W('val')) or 0) if numPr.find(W('ilvl')) is not None else 0
        fmt = numfmt.get(nid, {}).get(lvl, 'bullet')
        key = (nid, lvl)
        counters[key] = counters.get(key, 0) + 1
        mark = '•' if fmt == 'bullet' else f'{counters[key]}.'
        for ppr in e.findall(W('pPr')): e.remove(ppr)
        pp.style = T.styles['Normal']
        pf = pp.paragraph_format; pf.left_indent = Cm(0.9 + 0.8 * lvl); pf.first_line_indent = Cm(-0.6); pf.space_after = Pt(2)
        r = OxmlElement('w:r'); t = OxmlElement('w:t'); t.text = mark + '\t'; t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve'); r.append(t); e.insert(0, r)
        return e
    for ppr in e.findall(W('pPr')): e.remove(ppr)
    if st == 'SourceCode':
        pp.style = T.styles['Normal']
        pf = pp.paragraph_format; pf.line_spacing = 1.0; pf.space_after = Pt(0); pf.left_indent = Cm(0.3)
        pp.alignment = WD_ALIGN_PARAGRAPH.LEFT
        for r in pp.runs:
            r.font.name = 'Courier New'; r.font.size = Pt(8)
            rpr = r._r.get_or_add_rPr(); rf = rpr.find(W('rFonts'))
            if rf is not None: rf.set(W('ascii'), 'Courier New'); rf.set(W('hAnsi'), 'Courier New'); rf.set(W('cs'), 'Courier New')
        return e
    pp.style = T.styles['Normal']
    if has_draw(e):
        pp.alignment = WD_ALIGN_PARAGRAPH.CENTER; pp.paragraph_format.keep_with_next = True
        pp.paragraph_format.line_spacing = 1.0; pp.paragraph_format.space_after = Pt(4)
        for d in e.iter(W('drawing')): fix_image(d)
    return e

# equations: number at the right margin (centre tab + right tab), like Word's equation-numbering idiom
def number_equations(e):
    txt = ''.join(t.text or '' for t in e.iter('{%s}t' % NS['m']))
    m = re.search(r'@@EQ([A-Z0-9.]+)@@', txt)
    if m is None: return
    num = m.group(1)
    for t in e.iter('{%s}t' % NS['m']):
        if t.text and '@@EQ' in t.text: t.text = re.sub(r'\s*@@EQ[A-Z0-9.]+@@', '', t.text)
    # drop the \qquad \text{...} remnants: spaces only
    omp = e.find('.//' + '{%s}oMathPara' % NS['m'])
    if omp is not None:
        omath = omp.findall('{%s}oMath' % NS['m'])
        par_ = omp.getparent()
        for om in omath:
            e.append(om) if False else None
        # unwrap oMathPara into plain oMath siblings of the paragraph
        idx = list(par_).index(omp)
        for k, om in enumerate(omath): par_.insert(idx + k, om)
        par_.remove(omp)
    pp = Paragraph(e, T)
    pf = pp.paragraph_format
    pf.tab_stops.add_tab_stop(Cm(7.65), alignment=1)     # centre
    pf.tab_stops.add_tab_stop(Cm(15.3), alignment=2)     # right
    pf.line_spacing = 1.0; pf.space_before = Pt(6); pf.space_after = Pt(6)
    pp.alignment = WD_ALIGN_PARAGRAPH.LEFT
    r0 = OxmlElement('w:r'); t0 = OxmlElement('w:tab'); r0.append(t0)
    first_math = e.find('{%s}oMath' % NS['m'])
    first_math.addprevious(r0)
    r1 = OxmlElement('w:r'); t1 = OxmlElement('w:tab'); r1.append(t1)
    r2 = OxmlElement('w:r'); tx = OxmlElement('w:t'); tx.text = f'({num})'; r2.append(tx)
    e.append(r1); e.append(r2)

# ---- swap pandoc content into the template -----------------------------------------------------------
final_sect = els[-1]
assert final_sect.tag.endswith('sectPr')
# remove everything after the abbreviations block
last_abbr = anchor
for k in range(len(abbr)): last_abbr = last_abbr.getnext()
cut = last_abbr.getnext()
while cut is not final_sect:
    nxt = cut.getnext(); cut.getparent().remove(cut); cut = nxt
# list pages: replace the runs of empty paragraphs with page breaks
def tidy_lists():
    kids = list(body.iterchildren())
    out_ = []
    prev_empty = False
    for k in kids:
        is_empty_sh = k.tag.endswith('}p') and Paragraph(k, T).text.strip() == '' and Paragraph(k, T).style.name in ('Section Heading', 'Body Text') and 'sectPr' not in k.xml and 'w:br' not in k.xml
        if is_empty_sh and prev_empty: body.remove(k); continue
        prev_empty = is_empty_sh
tidy_lists()
ab_h = [k for k in body.iterchildren() if k.tag.endswith('}p') and Paragraph(k, T).text.strip() == 'Abbreviations / Notations'][0]
pb = mkp('Normal'); Paragraph(pb, T).paragraph_format.page_break_before = False
ab_h_p = Paragraph(ab_h, T); ab_h_p.paragraph_format.page_break_before = True
for k in body.iterchildren():
    if k.tag.endswith('}p') and Paragraph(k, T).text.strip() == 'LIST OF TABLES': Paragraph(k, T).paragraph_format.page_break_before = True
for k in list(body.iterchildren()):   # remove empty headings that preceded 'Abbreviations' and 'LIST OF TABLES' (kept as one break)
    pass

new = []
for el in pels:
    if el.tag.endswith('sectPr'): continue
    new.append(el)
# apply the structural transformation again but now building real output
final = []
for item in out:
    final.append(item if id(item) in MADE else restyle(item))
for item in final:
    if item.tag.endswith('}p') and item.find('.//' + '{%s}oMath' % NS['m']) is not None:
        number_equations(item)
    final_sect.addprevious(item)
    if item.tag.endswith('}tbl'):
        sp_ = mkp('Normal'); spp = Paragraph(sp_, T)
        spp.paragraph_format.space_after = Pt(0); spp.paragraph_format.line_spacing = 1.0
        rr = spp.add_run(''); rr.font.size = Pt(6)
        final_sect.addprevious(sp_)

# listing / algorithm numbers
LABEL = json.load(open(f'{B}/labels.json')) if os.path.exists(f'{B}/labels.json') else {}
for t in body.iter(W('t')):
    if t.text and '@@' in t.text:
        t.text = re.sub(r'@@(?:ALG|LST):([^@]+)@@', lambda m: LABEL.get(m.group(1), '?'), t.text)

# page setup (A4, margins from the template's checklist: left 1.25in, right 1in, top/bottom 0.75in)
sp = final_sect
pgsz = sp.find(W('pgSz')); pgsz.set(W('w'), '11906'); pgsz.set(W('h'), '16838')
json.dump({'chapters': CHAPTERS, 'figs': FIGS, 'tabs': TABS}, open(f'{B}/index.json', 'w'), indent=1)
for n_, dp in enumerate(T.element.body.iter('{%s}docPr' % NS['wp']), 1): dp.set('id', str(n_))
for n_, cp in enumerate(T.element.body.iter('{http://schemas.openxmlformats.org/drawingml/2006/picture}cNvPr'), 1): cp.set('id', str(n_))
T.save(f'{B}/stage1.docx')
print(len(final), 'body elements;', len(FIGS), 'figures', len(TABS), 'tables;', len(CHAPTERS), 'chapters')
