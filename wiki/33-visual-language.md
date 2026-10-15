# Reading the picture

Every colour, line width and moving light in the interface encodes a measurement. This chapter is the legend: what each visual element means, the exact rule that produces it, and why it was designed that way.

---

## The palette, and the one rule behind it

The interface is a dark navy-to-black gradient with an indigo accent. The rule:

> **Cool colours mean volume. Warm colours mean trouble, and nothing else.**

A link turns orange or red only when something is slow, erroring or down. A busy, healthy link gets *brighter blue*, never warmer. So the eye goes to amber and red only when there is something to act on.

| Status | Colour | Used for |
|---|---|---|
| healthy | `#25e3a3` green | service status light |
| degraded | `#ffab40` amber (`#ff9a3c` on links) | service rim, slow or erroring links |
| critical | `#ff3d5e` red | service rim (pulsing), failing links |
| idle / declared | `#5b6aa0` slate | links declared in config but never seen |
| selection | indigo | the selected card or link, in every view |

**Why so restrained.** An earlier version used bright neon with bloom everywhere. It looked impressive in a screenshot and was tiring to work in, because everything glowed equally and nothing stood out. Now bloom is **off** by default (a toggle in the 3D HUD, remembered as `mm.scene3d.bloom`). The opposite overcorrection followed: links capped at 0.8 intensity read as dull wires on the navy ground. They now run at 0.85–1.0 on a brighter azure-to-cyan ramp, with a visible additive sleeve in 3D, which is bright without glare because there is still no bloom.

---

## Links: colour

One function, `edgeAppearance()` in `client/src/components/shared/edgeHeat.ts`, decides every link's colour in the 2D canvas, the 3D scene and the inspector. It checks conditions in this order and stops at the first that matches:

| # | Condition | Colour | Label |
|---|---|---|---|
| 1 | link marked `failed` | red | failing |
| 2 | error rate ≥ 5% | red | failing, "N% of requests failing" |
| 3 | latency (p95, else mean) ≥ 1000 ms | red | very slow |
| 4 | observed, no request data, and the **callee is critical** | red | "calls a service that is down" |
| 5 | link marked `degraded` | orange | degraded |
| 6 | error rate ≥ 1% | orange | erroring |
| 7 | latency ≥ 300 ms | orange | slow |
| 8 | observed, no request data, and the callee is degraded | orange | "calls a degraded service" |
| 9 | never observed (declared only) | slate | declared, not observed |
| 10 | observed, no activity rate yet | deep blue `#4f7dff` | observed |
| 11 | activity > 1200/min | sky `#9cf4ff` | very heavy |
| 12 | activity > 250/min | `#1fd1ff` | heavy |
| 13 | activity > 60/min | `#2f9bff` | busy |
| 14 | otherwise | `#4f7dff` | calm |

Two details matter:

- **Measured request data beats the callee's status.** If a link carries clean, fast requests, it is not drawn as failing just because its callee was flagged for memory pressure. Rules 4 and 8 apply only when no request data covers the link.
- **The volume bands are absolute.** They are calibrated on 47 live links (median 112/min, p75 256, p90 1774, max 5571), not relative to the busiest link. A link's colour does not change meaning because some unrelated service got noisy.

Every orange or red link carries a `reason` in words, shown on hover and in the inspector.

---

## Links: thickness

In 2D, thickness is the **dependency weight**: how much the caller relies on this callee (see [The graph store](03-graphstore.md)).

```
strokeWidth = 1.2 + 4.3 × weight        (weight 0 → 1.2 px, weight 1 → 5.5 px)
telemetry links: always 1 px            (they are weighted at a tenth anyway)
```

When there is no weight yet, the width falls back to the heat band (1 px declared, 2 px calm, 2.6 px busy or heavy, 3.4 px very heavy or failing). Hovering or selecting a link shows its weight as a small pill on the line: the caller's share of traffic that goes over it.

---

## Links: moving light

Pulses travel along each link at a rate tied to its traffic (`client/src/components/shared/linkFlow.ts`):

```
pulses per second = clamp(0.3 + 1.6 × log10(1 + rate), 0.25, 5)
```

| rate | pulses/s |
|---|---|
| 0.1 /s | ≈ 0.4 |
| 2 /s | ≈ 1.0 |
| 30 /s | ≈ 2.7 |
| 100 /s | ≈ 3.5 |
| 1000 /s and up | 5 (cap) |

**Which rate.** If a request-level source measured the link (gateway log, Prometheus), the rate is **requests per second**, and the label says `req/s`. Otherwise it is the activity index ÷ 60. That tracks how busy the link is, but it is not a count of anything, so it is never labelled as requests or connections per second.

**Why a log scale.** Real links span four orders of magnitude. On a linear scale a 1 req/s link would look frozen next to a 500 req/s one. On a log scale both are readable, and their order is still right.

**Exactness.** In 2D, `svgPulses(pulses, length)` chooses how many pulses to keep on a path and how long each trip takes, so that exactly `pulses` arrive per second whatever the path's length. In 3D, each link draws from an instanced pool of up to 12 pulses and advances a phase by `pulses × Δt`.

---

## Service cards (2D)

Cards are **flat and matte** on purpose. Gloss and reflections were tried and rejected, because shine competes with the status colours that carry the information.

```
┌─────────────────────────────────┐   RISK 72%   ← shown above 60%; red above 80%
│ [icon]  orders            ●     │   ANOMALY    ← ML ensemble, persistent only
│         sock-shop               │
│ CPU ▓▓▓▓▓▓░░░░░░  41.0%         │   ← share of its CPU allowance
│ MEM ▓▓▓░░░░░░░░░  22.5%         │   ← share of its memory limit; "-" if unmeasured
└─────────────────────────────────┘
```

- **The icon tile and tint** show the service type (gateway, service, database, queue, cache, and so on), from `TYPE_VISUAL`.
- **The status light** breathes slowly when healthy. The card's **rim** turns amber for degraded and pulses red for critical.
- **Meters** colour by load, and their tooltips say exactly what the bar is ("41% of its 2-core allowance").
- Cards re-render only when a *displayed* value changes (to one decimal place), which keeps a 50-service canvas smooth on a 5-second update cycle.

---

## The inspector

Clicking a service opens the side panel (`InspectionPanel.tsx`):

- **Hero:** name, type, status, and the reason for the status in words.
- **Live metrics:** CPU as a share of allowance ("· of N cores"), memory, network in and out **per second** (totals in the tooltip), and ports with duplicates removed.
- **Reliability:** health with its factor breakdown, risk, criticality, the cascade probability and *via which dependency* it arrives.
- **What-if:** what fails, and with what probability, if this service goes down (`GET /api/reliability/whatif/:id`).
- **Incident role:** if its project has an open incident, what this service is in it: the root cause, another scored candidate (a suspect), affected, or uninvolved. Polled every 10 s while the panel is open.
- **Calls / called by:** its observed dependencies in both directions, each clickable.

Clicking a link opens `EdgeInspectionPanel.tsx`. It shows the evidence chips (`observed`, `declared`, `direction:listen-port`…), the weight with its confidence basis and share, and the flow as either `req/s` or "2 open · 8 new/min". Latency (with p50, p95 and p99 where available) and error rate appear only where a request-level source measured them. Elsewhere the panel says plainly that they are unknown and why the link has its colour.

---

## The 3D scene: islands

The default 3D layout, **Islands** (`client/src/components/3d/site.ts`, drawn by `Islands.tsx`), places each project as a **district** of raised platforms, one platform per role:

| Island | Holds | Colour |
|---|---|---|
| Edge | frontends, gateways | `#38bdf8` |
| Messaging | queues, caches | `#c084fc` |
| Services | everything in between | `#6b8cff` |
| Data | databases | `#2ed3a0` |
| Infrastructure | infrastructure, external | `#94a3b8` |
| Observability | Grafana, Jaeger, Prometheus, collectors… | `#2dd4bf` |

The arrangement follows a request: **edge on the left, services in the middle, data on the right**, messaging between edge and services, infrastructure behind. Observability sits off to one side, because it watches the application rather than serving it. Platforms stand at different heights, so each section reads as its own place, and every service stands exactly on its platform's top surface (a test checks this).

Around them:

- **Tracks** run along the ground between two sections *only if services in them call each other*, so the ground itself shows the architecture.
- **Pads, roads, light posts and drifting motes** fill the landscape outside the districts. They are scenery only, placed so they never overlap a district.
- **Cables** route in one of two styles, chosen in the HUD and remembered as `mm.scene3d.routing`:
  - **conduit:** right-angle runs, bundled, x-first. This style applies to the Islands layout too.
  - **arc:** curved, for an overview.

The other layouts (Clusters, Tiers and more) are still available in the HUD. They were kept because a flat grid is sometimes easier to scan. A "server room" and a "building" layout were tried and dropped.

---

## Why 2D and 3D both exist

- **2D (Architecture)** is for **work**. It is dense, every label is readable, and it supports precise selection and eight deterministic layouts.
- **3D (3D Vision)** is for **orientation**: seeing a whole estate at once, which sections are busy, and where the warm colours are. It uses the same `edgeAppearance()` and `linkFlow()`, so it never tells a different story from the 2D view.

The bell in the 3D view lists everything that needs attention, grouped and most urgent first: **down**, **degraded**, **ML-flagged**, **at risk**. Each entry gives its reason, and clicking one selects that service and flies to it; "Next" walks through them in order. The bell takes the colour of its worst entry: red only when something is down, amber for degraded, calm violet when it holds only ML flags and predictions. Island cards count the same four states, so a card never says "all healthy" over a unit drawn as flagged or at risk.

The 3D view also carries the HUD: layout, routing and bloom toggles, the legend, and the consistency chip (see [Keeping the numbers honest](32-accuracy-and-self-check.md)).
