# UI redesign plan: flagship look (Supabase-style)

Status: **plan only, not started.** Written after the third UI pass. Feedback was that the current
colour combination (graphite + blue accent + health colours) is "professional but could be better",
and that it should look like Supabase or another flagship product site.

---

## 1. What "flagship" means here

What these sites have in common (studied: supabase.com and its dashboard, linear.app, vercel.com,
stripe.com, raycast.com, resend.com):

| Trait | What they do | What we do today |
|---|---|---|
| **One brand colour, used sparingly** | Supabase: emerald `#3ECF8E` on primary buttons, active nav, focus rings, key numbers. Never decoration. | Blue `#8ab4ff` accent that doesn't belong to a brand |
| **Warm-neutral dark greys, not blue-black** | Supabase dark: `#121212` page, `#171717` / `#1c1c1c` surfaces, `#2e2e2e` borders, text `#ededed` / `#a0a0a0` / `#707070` | Slightly blue graphite `#0a0b0d` / `#111317` |
| **A strict 12-step grey scale** | Radix Colors "gray/sage/slate"; every surface, border and text colour is a step on it | Ad-hoc rgba values |
| **Depth from borders and light, not shadows** | 1px borders one step lighter than the surface, a 1px inner top highlight, almost no drop shadow | Mix of shadows and borders |
| **Texture in hero areas only** | Faint dot or line grid, one soft radial glow of brand colour behind the hero | Nothing (flat) or too much (earlier neon) |
| **Typography carries the design** | One good sans (Inter / Geist / Circular), tight tracking on headings, mono for code only, big confident numbers | OK, but headings too small and timid |
| **Motion is quick and quiet** | 120–200 ms ease-out, hover lifts are colour changes, not movement | Mostly fine |
| **Status colours are separate from the brand** | Supabase uses green for brand AND "healthy" but keeps healthy as a small dot, never a big fill | We fill whole 3D bodies green, which is loud |

---

## 2. Direction options

### Option A: Supabase (recommended)
Charcoal neutrals + emerald brand. It feels technical and calm, and is instantly recognisable as "modern dev tool".

- Page `#121212`, sidebar `#171717`, cards `#1c1c1c`, raised `#232323`, borders `#2e2e2e` / hover `#3e3e3e`
- Text `#ededed` / `#a1a1a1` / `#6b6b6b`
- Brand `#3ECF8E` (hover `#24b47e`, tint `rgba(62,207,142,.12)`), used for the primary button, active nav, focus ring, selection, live indicator
- **Health palette moves off the brand green** so "healthy" and "brand" never fight:
  - healthy → quiet: neutral clay body + small `#3ECF8E` dot. Green is a *signal*, not a paint job
  - degraded → `#F5A524` amber
  - critical → `#F31260` / `#E5484D` red (Radix red 9)
  - no data → `#6b6b6b`
- Charts: brand emerald for the primary series, then Radix `teal 9`, `indigo 9`, `violet 9`, `amber 9` for extra series

### Option B: Linear
Near-black `#08090a`, indigo/violet brand `#5e6ad2`, subtle top-down gradients on panels and a frosted sidebar. Sleeker and more "product-y", less technical.

### Option C: Vercel
Pure black / white, Geist font, no brand hue at all, with health as the only colour. The most minimal option; the risk is that it reads as the "too plain" version we just had.

### Option D: Raycast / Resend
Black with one vivid gradient brand moment (hero glow, logo) and everything else monochrome. Very striking, but harder to keep tasteful across 11 screens.

**Recommendation: A.** It is the closest match to "Supabase", it suits an infra / observability tool, and the emerald brand doubles as the "live / OK" signal without painting everything green.

---

## 3. Tokens to implement (Option A)

Replace the current `:root` block in `client/src/styles/index.css` with a scale-based system. Keep the old
variable names as aliases so no component breaks.

```css
:root {
  /* neutral scale (Radix gray dark, warm) */
  --gray-1:#111111; --gray-2:#191919; --gray-3:#222222; --gray-4:#2a2a2a; --gray-5:#313131;
  --gray-6:#3a3a3a; --gray-7:#484848; --gray-8:#606060; --gray-9:#6e6e6e; --gray-10:#7b7b7b;
  --gray-11:#b4b4b4; --gray-12:#eeeeee;

  /* brand */
  --brand-9:#3ecf8e; --brand-10:#24b47e; --brand-11:#4ee2a0; --brand-a3:rgba(62,207,142,.12); --brand-a6:rgba(62,207,142,.30);

  /* health (status only) */
  --ok:#3ecf8e; --warn:#f5a524; --bad:#e5484d; --none:#6e6e6e;

  /* semantic */
  --bg:var(--gray-1); --bg-subtle:var(--gray-2); --surface:var(--gray-3); --surface-hover:var(--gray-4);
  --border:var(--gray-5); --border-strong:var(--gray-7);
  --text:var(--gray-12); --text-muted:var(--gray-11); --text-dim:var(--gray-9);

  /* aliases for existing components */
  --color-bg-body:var(--bg); --color-bg-panel:var(--surface); --color-border:var(--border);
  --color-text-main:var(--text); --color-text-muted:var(--text-muted); --color-text-dim:var(--text-dim);
  --color-accent-cyan:var(--brand-9); --color-healthy:var(--ok); --color-degraded:var(--warn); --color-critical:var(--bad);
}
```

- **Type:** Inter (or Geist) 14px base. Page titles 24/600 with −0.02em tracking. Card titles 15/600. KPI numbers 32/600 tabular.
- **Radius:** 6 for inputs and chips, 8 for buttons, 12 for cards, 16 for modals.
- **Elevation:** border + `inset 0 1px 0 rgba(255,255,255,.04)` on cards; real shadow only on popovers and modals.

---

## 4. Screen-by-screen

| Area | Change |
|---|---|
| **Sidebar** | `--bg-subtle` background. Brand logo mark in emerald. Active item: `--surface` fill + emerald icon + 2px emerald bar on the left. Group labels in `--text-dim`. A project switcher card at the top (like Supabase's org/project picker). |
| **Top bar** | Breadcrumb `Org / Project / Page` with chevrons. Search becomes a wide "command palette" button (`⌘K`). Live pill in emerald when streaming. |
| **Page header** (new, shared) | Title + one-line description + right-aligned actions, with a hairline under it. Optional faint dot-grid backdrop behind headers only. |
| **KPI cards** | Bigger numbers, a tiny sparkline under each (data is already there), and a delta chip (`+4%` emerald, `−` red). No coloured card washes. |
| **Tables** | Supabase table style: `--bg-subtle` header row, 40px rows, row hover `--surface-hover`, status as dot + text. |
| **Buttons** | Primary = emerald fill, dark text (`#0b0b0b`). Secondary = `--surface` + border. Ghost = text only. |
| **Incidents** | The hero card gets a thin red top border and a red dot, with no red wash. The "Try first" command block uses a terminal look (`--gray-1` bg, mono, emerald `$`). |
| **3D scene** | Background `#111111` with a faint emerald radial glow at the horizon. Floor `--gray-2` with a dot grid in `--gray-4`. **Bodies:** neutral warm clay `#d9d9d6`. Health is shown by a coloured *status band* around the base plinth plus the LED dot, and failing services are fully tinted red/amber. Links: neutral `--gray-8` when idle, emerald packets flowing for live traffic, red when failing. This keeps the scene elegant (mostly neutral) with colour only where it means something. |
| **2D graph** | Cards on `--surface`, a status dot plus a status-coloured left band only when not healthy. Edges `--gray-7`, emerald animated dash for live traffic, red for failing. |
| **Charts** | Recharts theme: grid `--gray-4`, axis `--gray-9`, primary series emerald with a 10% area fill, tooltip on `--gray-3` with a border. |
| **Empty states** | Dot-grid illustration, title, one line, primary button (the Supabase pattern). |
| **Welcome screen** | Hero with a soft emerald glow, large headline, a "how it works" 3-step row, and a static preview image of the 3D map. |

---

## 5. Execution plan

1. **Tokens (½ day):** new scale and aliases in `index.css`. Remove `.mm-kpis` colour washes. Verify every screen still renders.
2. **Shell (½ day):** sidebar with project switcher, top bar breadcrumb and command button, shared `PageHeader`.
3. **Primitives (½ day):** button, chip, card, table, input, tabs/seg, tooltip, all in `index.css` and `ui/Panel.tsx`.
4. **3D + 2D (1 day):** neutral clay, status band, emerald packets, background glow and dot floor. Update `edgeHeat.ts` and its tests.
5. **Screens (1 day, can run in parallel):** Incidents, Telemetry, Traces, Dependencies, Analytics, ML pipeline, Findings, Experiments, panels, welcome.
6. **Verification:** Playwright screenshots of every tab, healthy and with an injected fault (`docker pause shopflow-cart-1`). Compare side by side with supabase.com/dashboard screenshots. `npx tsc -b`, `npm run build`, `npm test` all green.

**Acceptance criteria**
- One brand colour, visible on fewer than 5% of pixels on any healthy screen.
- A paused service is findable within 1 second on the 3D, 2D and Incidents views.
- No emoji, no neon glow, no rainbow categories.
- All tests pass.

---

## 6. Open questions for the owner
- Option A (Supabase emerald) or B (Linear indigo)?
- Keep the 3D clay bodies neutral (only trouble coloured), or keep the full health tint on every body?
- Any reference screenshots beyond Supabase to match?
