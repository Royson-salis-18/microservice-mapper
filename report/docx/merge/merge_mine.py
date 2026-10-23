"""Merge the user's own wording into the current report, sentence by sentence, only where the facts still match."""
import re, json, os, math, unicodedata, collections, sys
R = '/home/user/microservice-mapper/report'
CH = ['ch1_introduction', 'ch2_literature', 'ch3_system', 'ch4_methodology', 'ch5_implementation', 'ch6_results', 'ch7_conclusion']
mine = json.load(open(f'{R}/docx/merge/mine_sections.json'))
APPLY = '--apply' in sys.argv
THR = float(next((a.split('=')[1] for a in sys.argv if a.startswith('--thr=')), 0.42))

STOP = set('the a an and or of to in on for with that this these those is are was were be been by as at it its from not no but we our can may which who what when where how than then also into over per each both any all one two more most such only same other their there they them have has had will would should could do does did'.split())
def toks(s):
    s = unicodedata.normalize('NFKC', s).lower()
    out = []
    for w in re.findall(r'[a-z][a-z\-]{2,}', s):
        w = w.strip('-')
        if w in STOP: continue
        for suf in ('ing', 'ed', 'es', 's', 'ly'):
            if w.endswith(suf) and len(w) - len(suf) >= 4: w = w[:-len(suf)]; break
        out.append(w)
    return out

def plain_latex(s):
    s = re.sub(r'\\(?:cite|ref|eqref|label)\{[^}]*\}', ' ', s)
    s = re.sub(r'~', ' ', s)
    s = re.sub(r'\$([^$]*)\$', lambda m: ' ' + re.sub(r'\\[a-zA-Z]+', '', m.group(1)) + ' ', s)
    s = re.sub(r'\\(?:texttt|code|emph|textbf|textit|textrm|acc|cn)\*?\{', '', s)
    s = s.replace('\\%', '%').replace('\\&', '&').replace('\\_', '_').replace('\\,', ' ').replace('\\ ', ' ')
    s = re.sub(r'\\[a-zA-Z]+', ' ', s)
    s = re.sub(r'[{}]', '', s).replace('``', '"').replace("''", '"').replace('--', '–')
    return re.sub(r'\s+', ' ', s).strip()

def nums(s, theirs=False):
    s = unicodedata.normalize('NFKC', s)
    s = re.sub(r'\b(?:Section|Sections|Figure|Figures|Table|Tables|Chapter|Chapters|Appendix|Eq\.?)\s+[A-Z]?\d+(?:\.\d+)*[a-z]?(?:\s*(?:and|,|–|-)\s*\d+(?:\.\d+)*)*', ' ', s)
    s = re.sub(r'\[\d+(?:\s*[,–-]\s*\d+)*\]', ' ', s)
    s = s.replace('−', '-')
    return sorted(set(re.findall(r'(?<![A-Za-z])\d+(?:\.\d+)?', s)))

def split_sents(s):
    s = s.replace('•', ' • ')
    s = re.sub(r'^\s*•\s*', '', s)
    parts = re.split(r'(?<=[.!?:;])["”’)]*\s+(?=[A-Z“"(•\\]|\d\.\s)|\s•\s', s)
    return [p.strip() for p in parts if p and len(p.split()) >= 4]

# ---------------- their sentences per two-level section
theirs = collections.defaultdict(list)
for k, v in mine.items():
    key = '.'.join(k.split('.')[:2])
    theirs[key] += split_sents(v['text'])

# ---------------- our sentences per two-level section (with their position in the file)
def our_units(path, chap0=0):
    s = open(path).read()
    lines = s.split('\n'); i = 0
    chap = chap0 - 1; sec = 0; sub = 0
    skip_env = re.compile(r'\\begin\{(table|figure|tabular|longtable|equation|align|algorithm|lstlisting|verbatim|tikzpicture|landscape|minipage)\*?\}')
    end_env = re.compile(r'\\end\{(table|figure|tabular|longtable|equation|align|algorithm|lstlisting|verbatim|tikzpicture|landscape|minipage)\*?\}')
    out = []; depth = 0
    for n, ln in enumerate(lines):
        if skip_env.search(ln): depth += 1
        if depth: 
            if end_env.search(ln): depth -= 1
            continue
        m = re.match(r'\\chapter', ln)
        if m: chap += 1; sec = sub = 0; continue
        m = re.match(r'\\section\{', ln)
        if m: sec += 1; sub = 0; continue
        m = re.match(r'\\subsection\{', ln)
        if m: sub += 1; continue
        if not ln.strip() or ln.lstrip().startswith(('%', '\\label', '\\begin', '\\end', '\\caption', '\\centering', '\\small', '\\renewcommand', '\\figdiagram', '\\clearpage', '\\paragraph{')) and not ln.lstrip().startswith('\\paragraph'):
            continue
        out.append((n, f'{chap}.{sec}', ln))
    return lines, out

def esc(s):
    s = unicodedata.normalize('NFKC', s)
    s = s.replace('\\', '\\textbackslash{}')
    for a, b in (('&', '\\&'), ('%', '\\%'), ('#', '\\#'), ('_', '\\_'), ('$', '\\$'), ('{', '\\{'), ('}', '\\}'), ('^', '\\^{}')):
        s = s.replace(a, b)
    s = s.replace('“', '``').replace('”', "''").replace('‘', '`').replace('’', "'")
    s = re.sub(r'(?<=\d) (?=(?:s|ms|kB|MB|GB|min)\b)', '\\\\,', s)
    return s

def build(our_s, their_s):
    """their wording with our citations, refs and code spans put back; None if they cannot be reconciled"""
    cites = re.findall(r'\\cite\{[^}]*\}', our_s)
    refs = re.findall(r'(?:(?:Section|Sections|Figure|Figures|Table|Tables|Chapter|Appendix)~)?\\ref\{[^}]*\}', our_s)
    t = unicodedata.normalize('NFKC', their_s)
    t = re.sub(r'^\s*(?:•\s*|\(?[ivx]+\)\s+|\d+[.)]\s+)', '', t)
    t = re.sub(r'\s*•\s*', ' ', t).strip()
    tc = re.findall(r'\[\d+(?:\s*[,–-]\s*\d+)*\]', t)
    tr = re.findall(r'\b(?:Section|Sections|Figure|Figures|Table|Tables|Chapter|Appendix)\s+[A-Z]?\d+(?:\.\d+)*[a-z]?', t)
    if len(tc) != len(cites) or len(tr) != len(refs): return None
    # code spans from ours
    spans = sorted(set(re.findall(r'\\(?:texttt|code)\{([^{}]*)\}', our_s)), key=len, reverse=True)
    t = t.replace('\\', ' ')
    ph = []
    def stash(x): ph.append(x); return f'\x00{len(ph)-1}\x00'
    it = iter(cites)
    t = re.sub(r'\s*\[\d+(?:\s*[,–-]\s*\d+)*\]', lambda m: ' ' + stash(next(it)), t)
    it = iter(refs)
    t = re.sub(r'\b(?:Section|Sections|Figure|Figures|Table|Tables|Chapter|Appendix)\s+[A-Z]?\d+(?:\.\d+)*[a-z]?', lambda m: stash(next(it)), t)
    plainspans = {}
    for sp in spans:
        raw = sp.replace('\\_', '_').replace('\\%', '%')
        if raw and raw in t and len(raw) > 2:
            t = t.replace(raw, stash('\\texttt{' + sp + '}'))
    t = esc(t)
    t = re.sub(r'\x00(\d+)\x00', lambda m: ph[int(m.group(1))], t)
    return re.sub(r'\s+', ' ', t).strip()

# ---------------- similarity machinery
all_our = {}
for c in CH:
    lines, units = our_units(f'{R}/chapters/{c}.tex', CH.index(c) + 1)
    all_our[c] = (lines, units)
docs = []
for c in CH:
    for n, key, ln in all_our[c][1]:
        for s in split_sents(ln): docs.append(toks(plain_latex(s)))
for key, ss in theirs.items():
    for s in ss: docs.append(toks(s))
df = collections.Counter(w for d in docs for w in set(d)); N = len(docs)
idf = lambda w: math.log((N + 1) / (df[w] + 1)) + 1
def vec(ts):
    c = collections.Counter(ts); v = {w: n * idf(w) for w, n in c.items()}
    nrm = math.sqrt(sum(x * x for x in v.values())) or 1
    return {w: x / nrm for w, x in v.items()}
def cos(a, b): return sum(x * b.get(w, 0) for w, x in a.items())


log = []
stats = collections.Counter()
def rare(ts): return {w for w in ts if df[w] <= 60}
edits = {}      # (file, line_no) -> new line
sent_edits = []
SENT_THR = float(next((a.split('=')[1] for a in sys.argv if a.startswith('--sthr=')), 0.6))
for c in CH:
    lines, units = all_our[c]
    paras = collections.defaultdict(list)     # key -> [(line_no, [sentences])]
    for n, key, ln in units:
        ss = [re.sub(r'^\\item\s*', '', x) for x in split_sents(ln)]
        if ss: paras[key].append((n, ln, ss))
    for key, plist in paras.items():
        osents = [(n, x) for n, ln, ss in plist for x in ss]
        stats['our_paragraphs'] += len(plist)
        tsents = theirs.get(key, [])
        if not tsents: stats['no_counterpart_section'] += len(plist); continue
        ov = [vec(toks(plain_latex(x))) for _, x in osents]; tv = [vec(toks(x)) for x in tsents]
        S = [[cos(a, b) for b in tv] for a in ov]
        n_, m_ = len(ov), len(tv); D = [[0.0] * (m_ + 1) for _ in range(n_ + 1)]; B = [[None] * (m_ + 1) for _ in range(n_ + 1)]
        for i in range(n_ - 1, -1, -1):
            for j in range(m_ - 1, -1, -1):
                best, bk = D[i + 1][j], 'u'
                if D[i][j + 1] > best: best, bk = D[i][j + 1], 'l'
                if S[i][j] >= THR and S[i][j] + D[i + 1][j + 1] > best: best, bk = S[i][j] + D[i + 1][j + 1], 'd'
                D[i][j] = best; B[i][j] = bk
        i = j = 0; match = {}
        while i < n_ and j < m_:
            if B[i][j] == 'd': match[i] = j; i += 1; j += 1
            elif B[i][j] == 'u': i += 1
            else: j += 1
        used = set(); idx = 0
        for ln_no, ln, ss in plist:
            ids = list(range(idx, idx + len(ss))); idx += len(ss)
            ms = [match[k] for k in ids if k in match]
            ours_full = ' '.join(ss)
            if not ms:
                log.append({'file': c, 'section': key, 'action': 'kept', 'reason': 'no matching sentence in your text', 'ours': plain_latex(ours_full)[:240]}); stats['kept_nomatch'] += 1; continue
            lo, hi = min(ms), max(ms)
            rng = tsents[lo:hi + 1]; used.update(range(lo, hi + 1))
            theirs_full = ' '.join(rng)
            ot, tt = toks(plain_latex(ours_full)), toks(theirs_full)
            cov = len(rare(ot) & set(tt)) / max(1, len(rare(ot)))
            newrare = rare(tt) - set(ot)
            low = (ours_full + ' ' + theirs_full).lower()
            hit_old = [w for w in ('forest', 'isolation', '329') if (w in theirs_full.lower()) != (w in ours_full.lower())]
            hit_new = [w for w in ('load-aware', 'load factor', 'workload', 'residual', 'tail spread', 'change-point', 'hypothes') if (w in theirs_full.lower()) != (w in ours_full.lower())]
            reason = None
            if '$' in ln: reason = 'math in our paragraph'
            elif '\\textbf' in ln or '\\paragraph' in ln or '\\caption' in ln: reason = 'formatted label in our paragraph'
            elif abs(len(re.sub(r'\W', '', plain_latex(re.sub(r'^\\item\s*', '', ln.strip())))) - len(re.sub(r'\W', '', plain_latex(ours_full)))) > 3: reason = 'short sentence would be lost'
            elif hit_old or hit_new: reason = 'facts changed since your version (%s)' % ', '.join(hit_old + hit_new)
            elif nums(plain_latex(ours_full)) != nums(theirs_full): reason = 'numbers differ: ours %s vs yours %s' % (nums(plain_latex(ours_full)), nums(theirs_full))
            elif cov < 0.62: reason = 'your wording drops content our paragraph has (coverage %.2f)' % cov
            elif len(newrare) > 8: reason = 'your wording adds content not in the current report: %s' % sorted(newrare)[:6]
            else:
                newtxt = build(ours_full, theirs_full)
                if newtxt is None: reason = 'citation/reference count differs'
            if reason:
                stats['kept_' + reason.split(' ')[0]] += 1
                log.append({'file': c, 'section': key, 'action': 'kept', 'reason': reason, 'ours': plain_latex(ours_full)[:260], 'yours': theirs_full[:260]})
                # sentence-level: reuse single sentences that carry exactly the same facts
                for k in ids:
                    if k not in match or S[k][match[k]] < SENT_THR: continue
                    osent = osents[k][1]; tsent = tsents[match[k]]
                    if '$' in osent or '\\textbf' in osent or '\\paragraph' in osent: continue
                    a_, b_ = toks(plain_latex(osent)), toks(tsent)
                    ca = len(rare(a_) & set(b_)) / max(1, len(rare(a_))); nb = rare(b_) - set(a_)
                    bad = [w for w in ('forest', 'isolation', '329', 'load-aware', 'load factor', 'workload', 'residual', 'tail spread', 'change-point', 'hypothes') if (w in tsent.lower()) != (w in osent.lower())]
                    if bad or nums(plain_latex(osent)) != nums(tsent) or ca < 0.7 or len(nb) > 1: continue
                    nt = build(osent, tsent)
                    if nt is None or nt.strip() == osent.strip() or osent not in ln: continue
                    sent_edits.append((c, ln_no, osent, nt)); used.add(match[k]); stats['sentences_replaced'] += 1
                    log.append({'file': c, 'section': key, 'action': 'sentence', 'ours': plain_latex(osent)[:200], 'yours': tsent[:200], 'sim': round(S[k][match[k]], 2)})
                continue
            pre = '\\item ' if ln.lstrip().startswith('\\item') else ''
            edits[(c, ln_no)] = (ln, pre + newtxt)
            stats['replaced'] += 1
            log.append({'file': c, 'section': key, 'action': 'replaced', 'ours': plain_latex(ours_full)[:300], 'yours': theirs_full[:300], 'cov': round(cov, 2)})
        for j, ts in enumerate(tsents):
            if j not in used: log.append({'file': c, 'section': key, 'action': 'unused', 'yours': ts[:260]})
json.dump(log, open(f'{R}/docx/merge/merge_log.json', 'w'), indent=1, ensure_ascii=False)
print(dict(stats), 'thr', THR)
if APPLY:
    for c in CH:
        path = f'{R}/chapters/{c}.tex'; lines = open(path).read().split('\n'); k = 0
        for (cc, n), (old, new) in edits.items():
            if cc == c: assert lines[n] == old; lines[n] = new; k += 1
        k2 = 0
        for cc, n, old, new in sent_edits:
            if cc == c:
                assert old in lines[n]; lines[n] = lines[n].replace(old, new, 1); k2 += 1
        open(path, 'w').write('\n'.join(lines)); print(c, k, 'paragraphs +', k2, 'sentences replaced')
