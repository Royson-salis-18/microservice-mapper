"""Flatten the LaTeX chapters into a pandoc-friendly file (step 1 of build_docx)."""
import re, subprocess, os, sys
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(R, 'docx', 'build'); IMG = os.path.join(OUT, 'img')
os.makedirs(IMG, exist_ok=True)

aux = open(f'{R}/main.aux').read()
LABEL = {m.group(1): m.group(2) for m in re.finditer(r'\\newlabel\{([^}]+)\}\{\{([^}]*)\}', aux)}
BIB = {m.group(1): m.group(2) for m in re.finditer(r'\\bibcite\{([^}]+)\}\{(\d+)\}', aux)}

def refsub(t):
    def one(m):
        out = []
        for k in m.group(1).split(','):
            out.append(LABEL.get(k.strip(), '??'))
        return ','.join(out)
    t = re.sub(r'(?:Figs?|Tables?|Sections?|Chapters?|Algorithms?|Listings?|Appendix|Eq)\.?~\\(?:ref|eqref)\{([^}]+)\}',
               lambda m: m.group(0).split('~')[0].replace('Eq', 'Equation') + ' ' + one(m), t)
    t = re.sub(r'\\(?:eqref|ref|autoref)\{([^}]+)\}', lambda m: one(m), t)
    return t

def cite(t):
    def one(m):
        ns = sorted({int(BIB[k.strip()]) for k in m.group(1).split(',') if k.strip() in BIB})
        return '[' + ', '.join(map(str, ns)) + ']'
    t = re.sub(r'~?\\cite(?:\[[^\]]*\])?\{([^}]+)\}', lambda m: ' ' + one(m), t)
    return t

def pngof(name):
    base = os.path.splitext(os.path.basename(name))[0]
    for d in ('figures', 'diagrams'):
        for ext in ('.pdf', '.png', '.jpg'):
            p = f'{R}/{d}/{base}{ext}'
            if os.path.exists(p):
                dst = f'{IMG}/{base}.png'
                if not os.path.exists(dst):
                    if ext == '.pdf':
                        subprocess.run(['pdftoppm', '-r', '170', '-png', '-singlefile', p, f'{IMG}/{base}'], check=True)
                    else:
                        subprocess.run(['convert', p, dst], check=True)
                return dst
    sys.exit('missing figure ' + name)

def brace(s, i):
    """return (content, end) of the {...} group starting at s[i]=='{'"""
    d = 0
    for j in range(i, len(s)):
        if s[j] == '{': d += 1
        elif s[j] == '}':
            d -= 1
            if d == 0: return s[i+1:j], j+1
    raise ValueError

def figdiagram(t):
    out = ''; i = 0
    while True:
        k = t.find('\\figdiagram', i)
        if k < 0: out += t[i:]; break
        out += t[i:k]; j = k + len('\\figdiagram')
        if t[j] == '[':
            j = t.index(']', j) + 1
        f, j = brace(t, j); c, j = brace(t, j); l, j = brace(t, j)
        out += f'\\begin{{figure}}\\includegraphics{{{pngof(f)}}}\\caption{{{c}}}\\label{{{l}}}\\end{{figure}}'
        i = j
    return out

def algs(t):
    def one(m):
        body = m.group(0)
        cap = re.search(r'\\caption\{(.*)\}', body).group(1)
        lab = re.search(r'\\label\{([^}]+)\}', body).group(1)
        lines = []; ind = 0
        for ln in re.search(r'\\begin\{algorithmic\}(?:\[\d\])?(.*)\\end\{algorithmic\}', body, re.S).group(1).split('\n'):
            ln = ln.strip()
            if not ln: continue
            ln = re.sub(r'\\Require', 'Require:', ln); ln = re.sub(r'\\Ensure', 'Ensure:', ln)
            ln = re.sub(r'\\State\s*', '', ln)
            ln = re.sub(r'\\For\{([^}]*)\}', lambda x: 'for ' + x.group(1) + ' do ', ln)
            ln = re.sub(r'\\If\{([^}]*)\}', lambda x: 'if ' + x.group(1) + ' then ', ln)
            ln = ln.replace('\\ElsIf', 'else if').replace('\\EndFor', 'end for').replace('\\EndIf', 'end if')
            lines.append(ln)
        txt = '\n\n'.join(lines)
        return ('\\textbf{Algorithm @@ALG:' + lab + '@@: ' + cap + '}\n\n' + txt + '\n')
    return re.sub(r'\\begin\{algorithm\}.*?\\end\{algorithm\}', one, t, flags=re.S)

def listings(t):
    def one(m):
        opts, path = m.group(1), m.group(2)
        cap = re.search(r'caption=\{(.*?)\},label', opts).group(1)
        lab = re.search(r'label=\{([^}]+)\}', opts).group(1)
        code = open(f'{R}/{path}').read().rstrip('\n')
        return ('\\textbf{Listing @@LST:' + lab + '@@: ' + cap + '}\n\n\\begin{verbatim}\n' + code + '\n\\end{verbatim}\n')
    return re.sub(r'\\lstinputlisting\[(.*?)\]\{([^}]+)\}', one, t)

def tables(t):
    t = re.sub(r'\\begin\{tabularx\}\{[^}]*\}', lambda m: '\\begin{tabular}', t)
    t = t.replace('\\end{tabularx}', '\\end{tabular}')
    # tabular spec: drop >{...} decorations, X -> l
    def spec(m):
        s = m.group(1)
        s = re.sub(r'>\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', '', s)
        s = s.replace('X', 'l')
        return '\\begin{tabular}{' + s + '}'
    t = re.sub(r'\\begin\{tabular\}\{((?:[^{}]|\{[^{}]*\})*)\}', spec, t)
    t = re.sub(r'\\begin\{tabular\}(?!\{)', lambda m: m.group(0), t)
    return t

def misc(t):
    t = re.sub(r'\\resizebox\{[^}]*\}\{[^}]*\}\{\\input\{fig_prop\.tex\}\}', lambda m: '\\includegraphics{' + IMG + '/fig_prop.png}', t)
    t = re.sub(r'\\code\{', r'\\texttt{', t)
    t = re.sub(r'\\(Bigl|Bigr|bigl|bigr|Big|big)\b', lambda m: {'Bigl':'\\left','bigl':'\\left','Bigr':'\\right','bigr':'\\right'}.get(m.group(1),''), t)
    t = t.replace('\\cn', 'C+N').replace('\\checkmark', '✓').replace('\\arraybackslash', '')
    t = re.sub(r'\\acc\{([^}]*)\}', r'A@\1', t)
    t = re.sub(r'\\paragraph\{([^}]*)\}', r'\\textbf{\1}\\ ', t)
    t = re.sub(r'\\(?:clearpage|newpage|FloatBarrier|small|footnotesize|scriptsize|centering|raggedright|noindent|sloppy)\b', '', t)
    t = re.sub(r'\\(?:begin|end)\{(?:sloppypar|center|spacing)\}(?:\{[^}]*\})?', '', t)
    t = re.sub(r'\\(?:renewcommand|setlength|vspace|hspace)\*?\{[^}]*\}(?:\{[^}]*\})?', '', t)
    t = re.sub(r'\\(?:tabcolsep|arraystretch)', '', t)
    t = re.sub(r'\\(?:midrule|toprule|bottomrule)', '\\\\hline', t)
    t = t.replace('\\E', '\\mathbb{E}').replace('\\-', '')
    t = re.sub(r'\[!?htbp?\]|\[p\]', '', t)
    t = re.sub(r'\{\\ttfamily ([^}]*)\}', r'\\texttt{\1}', t)
    t = re.sub(r'\\label\{(?!fig:|tab:|alg:|lst:)[^}]*\}', '', t)
    return t

def eqs(t, chap):
    """number equations; mark with a sentinel to be moved to the right margin"""
    n = [0]
    def one(m):
        n[0] += 1
        body = re.sub(r'\\label\{[^}]*\}', '', m.group(1)).strip()
        return '\\[' + body + ' \\qquad \\text{@@EQ%s.%d@@}\\]' % (chap, n[0])
    t = re.sub(r'\\begin\{equation\}(.*?)\\end\{equation\}', one, t, flags=re.S)
    def al(m):
        n[0] += 1
        body = re.sub(r'\\label\{[^}]*\}|\\nonumber', '', m.group(1)).strip()
        return '\\[\\begin{aligned}' + body + '\\end{aligned} \\qquad \\text{@@EQ%s.%d@@}\\]' % (chap, n[0])
    return re.sub(r'\\begin\{align\}(.*?)\\end\{align\}', al, t, flags=re.S), n[0]

def convert(path, chap):
    t = open(path).read()
    t = re.sub(r'^\\(?:renewcommand|titleformat|appendix)\b.*$', '', t, flags=re.M)
    t = re.sub(r'(?<!\\)%.*', '', t)
    t, ne = eqs(t, chap)
    t = figdiagram(t)
    t = re.sub(r'\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}', lambda m: '\\includegraphics{' + pngof(m.group(1)) + '}', t)
    t = algs(t); t = listings(t); t = tables(t); t = misc(t)
    t = cite(refsub(t))
    return t

CH = ['ch1_introduction', 'ch2_literature', 'ch3_system', 'ch4_methodology', 'ch5_implementation', 'ch6_results', 'ch7_conclusion']
parts = []
for i, c in enumerate(CH, 1):
    parts.append(convert(f'{R}/chapters/{c}.tex', str(i)))
app = convert(f'{R}/chapters/appendices.tex', 'A')
app = re.sub(r'\\appendix', '', app)
app = re.sub(r'\\titleformat\{.*', '', app)
APPPART = '\n\\section*{@@APPENDICES@@}\n' + app.replace('\\chapter{', '\\chapter{@@APP@@')
# references
bbl = open(f'{R}/main.bbl').read()
items = re.split(r'\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}', bbl)[1:]
refs = []
for k, body in zip(items[0::2], items[1::2]):
    body = body.split('\\end{thebibliography}')[0].replace('\\newblock', '').strip()
    refs.append(f'[{BIB[k]}] {body}')
refs.sort(key=lambda s: int(re.match(r'\[(\d+)\]', s).group(1)))
parts.append('\n\\chapter{@@REFS@@}\n\n' + '\n\n'.join(refs))
parts.append(APPPART)
open(f'{OUT}/body.tex', 'w').write('\n\n'.join(parts))
print('ok', len(refs), 'refs')
