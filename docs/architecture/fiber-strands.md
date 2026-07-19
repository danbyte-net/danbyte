# Fiber strands — modelling & rendering (design)

> Status: **research / design proposal.** Nothing here is built yet. This
> document works out how Danbyte should model, colour, label, and eventually
> *trace* the individual fibres inside a fibre cable — a capability most
> IPAM/DCIM tools don't have, so it's a genuine differentiator.

---

## 1. Why

A fibre cable is not one wire — it's a bundle of **strands** (2, 12, 24, 48,
96, 144, 288 …). Each strand is a separate light path that can be spliced,
patched, labelled, and traced independently. Real fibre plant management lives
at the *strand* level: "trunk T-14, strand 7 (red), goes from panel A rear-3 to
panel B rear-9."

Danbyte today models a cable as a **single link** with an A end and
a B end. There is no notion of how many fibres are inside, no strand colours, no
per-strand labels, and no per-strand trace. Adding this makes Danbyte the tool a
fibre/OSP team actually wants — and it slots naturally onto the cable + cable
type + termination system we already have.

Danbyte already has *half* of the primitive: a patch-panel **`RearPort.positions`**
("Number of strands / front-port positions") with **`FrontPort.rear_port_position`**
selecting one. So a panel already knows it has N strand positions; what's missing
is the same concept **on the cable**, plus colours, labels, and strand-aware
terminations.

---

## 2. Fibre colour standard primer (TIA-598-C)

Strand identification in North America (and widely elsewhere) follows
**TIA-598-C**. The other major scheme is **IEC 60304 / IEC 60794**, which differs
mainly in a few hues and in unit ordering — worth allowing as an option, but
TIA-598-C is the sensible default.

### 2.1 The 12-colour base sequence

Positions 1–12 within a unit, in order:

| # | Colour | Hex (suggested) | Note |
|---|--------|-----------------|------|
| 1 | Blue | `#0071CE` | |
| 2 | Orange | `#FF7A00` | |
| 3 | Green | `#00A651` | |
| 4 | Brown | `#7B4A12` | |
| 5 | Slate (grey) | `#8A8D8F` | |
| 6 | White | `#F4F4F4` | needs a border on light UI |
| 7 | Red | `#E4002B` | |
| 8 | Black | `#101010` | needs a border on dark UI |
| 9 | Yellow | `#FFD100` | |
| 10 | Violet | `#8246AF` | |
| 11 | Rose (pink) | `#F4A6C0` | |
| 12 | Aqua | `#00B5C7` | |

Mnemonic: **B**lue **O**range **G**reen **B**rown **S**late **W**hite **R**ed
**B**lack **Y**ellow **V**iolet **R**ose **A**qua.

Two of these are traps for a UI: **white (#6)** disappears on a light surface and
**black (#8)** disappears on a dark surface. The dot renderer must always draw a
thin contrasting outline (see §6).

### 2.2 Beyond 12 fibres — units and tracers

For counts >12 the strands are organised into **12-fibre units** (loose-tube
"buffer tubes", or 12-fibre "ribbons"). There are **two** identification methods
in the wild, and a cable uses one or the other:

**(a) Unit (buffer-tube) colour coding** — loose-tube OSP cable.
Each 12-fibre *tube* is itself coloured per the same 12-colour sequence, and the
12 fibres *inside* each tube run Blue…Aqua again. A strand's identity is the
**pair** `(tube colour, fibre colour)`. Example, 48-fibre (4 tubes):

```
Tube 1 (Blue):   fibres 1–12  = Blue, Orange, … Aqua
Tube 2 (Orange): fibres 13–24 = Blue, Orange, … Aqua
Tube 3 (Green):  fibres 25–36 = Blue, Orange, … Aqua
Tube 4 (Brown):  fibres 37–48 = Blue, Orange, … Aqua
```

So strand 25 = "Green tube, Blue fibre."

**(b) Ring / tracer marking** — ribbon and many tight-buffered cables.
The 12 colours repeat, and the *repeat group* is distinguished by a printed
**tracer**: the second dozen (13–24) carries a mark, the third dozen (25–36) a
heavier mark, and so on. Vendors implement the mark as a **dash pattern, ring
count, or a black tracer stripe**.

**This is the behaviour you described:** the swatch shows the base colour, then
gains a **black stripe when the count passes 12**, and a **black ring when the
sequence wraps again**. That maps cleanly to a single derived value —
`group = floor((position − 1) / 12)` — rendered as escalating marks (§5, §6).

We should model *both*: store the fibre **count**, a **construction** hint
(loose-tube / ribbon / tight-buffered), and derive either the *(tube, fibre)*
pair or the *ring-count* presentation from `position`.

### 2.3 Simplex vs duplex (how many strands a link burns)

A duplex optic (LR/SR/…) uses **two** strands — one TX, one RX. Parallel optics
(e.g. 40G-SR4, 100G-SR4 on MPO) use **8 or more**. A "link" over a trunk
therefore consumes a *pair or group* of strands, not one. The model should let a
termination bind **a set of strand positions**, not just one, so a duplex LC or
an MPO-12 can be represented honestly. (Phase 2 — see §9.)

---

## 3. What Danbyte has today (grounding)

- **`Cable`** (`api/models.py`) — `type` (from `CABLE_TYPE_CHOICES`, already
  includes `smf`, `smf-os1/os2`, `mmf-om1…om5`), `color` (7-char hex of the
  *jacket*), `label`, `status`, `length`, `terminations`.
- **`CableTermination`** — one endpoint (`end` A/B) pointing at exactly one of
  `interface / front_port / rear_port / … / power_feed / aux_port`. A port is
  cabled at most once.
- **`RearPort.positions`** — "Number of strands / front-port positions";
  **`FrontPort.rear_port_position`** selects which strand. So a *panel* already
  has a strand axis; the collapse/trace engine (`api/cable_points.py`,
  `topology_views._collapse`, `strand_of`) already walks front⇄rear by position.
- **Colour rendering** — `ColorBadge` (`frontend/src/components/cells/color-badge.tsx`)
  draws a coloured pill with luminance-picked text; topology port rows draw small
  `KIND_DOT` swatches; the tray/trace overlays colour cables by `cable.color`.

**Gap:** the *cable* has no strand count, no per-strand colour/label, and a
`CableTermination` cannot say *which strand(s)* it lands on. Everything strand-y
today lives only on the panel `positions` axis.

---

## 4. Modelling options

### Option A — full `FiberStrand` rows (one row per strand)

```python
class FiberStrand(models.Model):
    cable = FK(Cable, related_name="strands")
    position = PositiveSmallInteger   # 1-based
    label = CharField(blank=True)
    status = CharField(...)           # in-use / spare / damaged / reserved
    # colour is DERIVED from position + standard, never stored
    # (phase 2) a_termination / b_termination FKs for strand-level trace
    unique_together = ("cable", "position")
```

- **Pros:** first-class strand identity, indexable labels, natural home for
  strand-level terminations (phase 2), per-strand status.
- **Cons:** a 288F trunk is 288 rows *whether or not anyone annotated them*.
  Violates the repo's "no rows until there's real data" instinct. Heavy to
  create/copy/delete.

### Option B — `fiber_count` + sparse JSONB on the cable

```python
Cable.fiber_count   = PositiveSmallInteger(null=True)   # only for fibre types
Cable.fiber_standard = CharField(default="tia598c")     # tia598c | iec | custom
Cable.fiber_construction = CharField(default="")        # loose-tube | ribbon | tight
Cable.strands = JSONField(default=dict)  # sparse: {"7": {"label": "...", "status": "damaged"}}
```

Colours are **derived** from `position + fiber_standard`. Labels/status live in a
sparse dict keyed by position — **no storage until a strand is actually
annotated** (fits the zero-pre-filled-data ethos, mirrors `custom_fields`).

- **Pros:** cheap, zero rows for un-annotated strands, dead-simple to render,
  ships fast. Enough for *visualisation + labelling* (the headline ask).
- **Cons:** can't (yet) attach a strand to a specific far-end position — the
  cable's A/B terminations stay whole-cable.

### Option C — hybrid (recommended trajectory)

Start with **B** (count + sparse JSONB) for Phase 1. When strand-level
**termination/splice** is needed (Phase 2), *promote* to sparse `FiberStrand`
rows created **only** for strands that are labelled or terminated — the JSONB
labels migrate into rows lazily. Best of both: cheap when idle, relational when
it matters.

**Recommendation:** ship **Option B now**, design the JSONB shape so it can be
migrated into **Option A rows** later without a rewrite (keep `position` the key
in both).

`fiber_count` as a real column (not `custom_fields`) is justified the same way
`length` is: it's an intrinsic structural attribute of the cable, not tenant
business data. The **colour table** is an industry spec (like `CABLE_TYPE_CHOICES`
and `LENGTH_UNITS`, which we already ship), so shipping TIA-598-C as the default
reference is consistent with the codebase — see §8.

---

## 5. Colour + marking derivation (single source of truth)

One pure function, shared by backend (for API-provided swatches / exports) and
frontend (for rendering). Given a 1-based `position`, the `count`, and the
`standard`:

```
TIA598C = [Blue, Orange, Green, Brown, Slate, White,
           Red, Black, Yellow, Violet, Rose, Aqua]   # {name, hex}

fiberColor(position, standard = "tia598c"):
    palette = PALETTES[standard]              # 12 entries
    idx     = (position - 1) % 12
    group   = (position - 1) // 12            # 0 for 1–12, 1 for 13–24, …
    base    = palette[idx]                    # {name, hex}
    return {
      position,
      name:   base.name,
      hex:    base.hex,
      group,                                  # which dozen (unit / ribbon)
      # presentation marks (the behaviour you described):
      stripe: group >= 1,                     # black tracer stripe once past 12
      rings:  max(0, group - 1),              # +1 black ring each further wrap
      # (loose-tube alt) the containing unit's own colour:
      unit:   palette[group % 12],            # tube colour for (tube,fibre) id
      unitIndex: group,
    }
```

- **1–12** → solid colour, no mark.
- **13–24** → same colours **+ one black stripe** (`stripe = true`).
- **25–36** → **+ one black ring** (`rings = 1`), 37–48 → two rings, …
- For **loose-tube** construction, also expose `unit` so the UI can label a
  strand as "Green tube · Blue fibre" instead of / in addition to the rings.

This is deliberately presentation-agnostic: the function yields *facts* (group,
stripe, rings, unit); the renderer decides marks vs tube-colour based on
`fiber_construction`.

---

## 6. Rendering

### 6.1 `<FiberDot>` — the atomic swatch

A small round (or squircle) swatch, the fibre analogue of the existing status
dots. Props: `position`, `count`, `standard`, `size`, optional `label`.

- **Fill** = `hex`.
- **Outline** = always a 1px contrasting ring (`rgba` picked from luminance) so
  White(#6), Aqua(#12), Yellow(#9) read on light surfaces and Black(#8) reads on
  dark — reuse `readableText()`'s luminance logic from `ColorBadge`.
- **Stripe** = a black diagonal bar across the swatch when `stripe` (13–24).
- **Rings** = `rings` concentric black rings inside the outline (25–36 = 1, …).
- **Tooltip** = "T-14 · fibre 25 · Blue · Green tube (unit 3)".

Renders as inline SVG (matches the topology dot convention — no icon lib).

### 6.2 `<FiberMap>` — the strip on the cable page

Given `fiber_count`, draw the strands as a grid **grouped into rows of 12**
(one row per unit/ribbon), each cell a `<FiberDot>` with its position number and
(if set) its label. A unit's leading swatch can carry the tube colour for
loose-tube cables. Interactions:

- Click a strand → inline label / status editor (writes `Cable.strands[pos]`).
- Hover → tooltip; the strand highlights on the trace map (§6.4).
- Header shows count, standard, construction; a legend chip explains
  stripe = 2nd dozen, ring = further dozens.

Lives on the **cable detail page** as a "Fibres" section, and read-only inside
the topology/trace deep-view.

### 6.3 Cable type / interface type integration

- The **Fibres** section only appears when `type` is a fibre medium
  (`smf*`, `mmf*`) — reuse the existing `CABLE_TYPE_CHOICES` grouping to decide.
- Interface **media/type** already exists; a fibre interface implies a strand
  demand (duplex = 2, MPO-8 = 8). Phase 2 can pre-select that many strands when
  cabling.

### 6.4 Topology / trace integration

- Where a cable edge is drawn today (`RoutedEdge`, tray overlays), a **fibre**
  cable can render as a **thin multi-line bus** or carry a small
  `count`-strand legend; hovering a strand in the `<FiberMap>` **highlights that
  strand's path** through the trace (reusing the existing highlight machinery).
- The topology port-row dots (`stencil-node.tsx`) can show the terminating
  **strand colour** for a fibre link instead of the generic kind dot.

### 6.5 Exports

Include the fibre map (colours + labels + tube grouping) in the cable PNG / the
floor-plan pull-sheet, so a splicer can work off the printout.

---

## 7. Strand labelling

- **Where:** `Cable.strands[position].label` (Option B) — sparse, only stored
  when set. Free text (e.g. "Cust-A pri", "spare", "dark").
- **Bulk:** a "label all" helper (prefix + auto-number), and copy-from-far-end.
- **Status per strand:** `in-use | spare | reserved | damaged | dark` — drives a
  muted / hatched swatch so a splicer sees dead fibres at a glance.
- **Search/filter:** strand labels should be searchable (phase 2 promotes to
  rows so this is an index, not a JSON scan).

---

## 8. Zero-pre-filled-data considerations

- The **TIA-598-C colour sequence is an industry standard**, the same category
  as `CABLE_TYPE_CHOICES`, `LENGTH_UNITS`, and the media list we already ship. So
  shipping it as a built-in *reference palette* is consistent — it is not tenant
  business data.
- Still, honour flexibility: `fiber_standard` is a **choice** (`tia598c`
  default, `iec` alternative), and a tenant may define a **custom palette** in
  the customization app (a 12-entry colour list) selected as `custom`. That keeps
  regional/vendor variance user-controlled without forcing a default on anyone.
- **No** strand rows, labels, or counts are created until the user sets them.

---

## 9. Phasing

**Phase 1 — visualise + label (Option B).**
`Cable.fiber_count`, `fiber_standard`, `fiber_construction`, `strands` (JSONB).
Shared `fiberColor()` function. `<FiberDot>` + `<FiberMap>`. Cable-page Fibres
section with click-to-label + per-strand status. Read-only map in the trace
deep-view. Exports include it. — *Delivers the headline value.*

**Phase 2 — strand-level terminations & trace.**

*Phase 2a — multi-fibre connectors (**shipped**).* `FrontPort.positions`
(+ template) gives a connector a fibre count, so an LC-duplex (2) or MPO (8–24)
claims a **range** of rear positions `[start … start+positions−1]` — overlap and
fit validated in `FrontPort.clean()`; a connector-type quick-fill
(`dcim_choices.CONNECTOR_FIBERS`) pre-fills it. `cable_points.strand_of` is
range-aware (a rear position resolves to the covering front port + local fibre
index). A per-tenant `FiberSettings.strand_modelling` (`off`/`count`/`accurate`)
gates how much fibre UI appears.

*Phase 2b — the strand map (**next**).* Add `CableTermination.strand_map`
(sparse `{cable strand → port position}`, `null` = straight-through). A connect-
time dialog (polarity presets: straight / crossed / custom) writes it, and
`strand_of` follows it when present — so a run tracks the **exact** strand through
duplex/MPO and crossed polarity. Promote heavily-annotated strands to sparse
`FiberStrand` rows if/when label indexing is needed.

**Phase 3 — splices & OSP.**
Splice points (fusion/mechanical) between strands of different trunks, loss
budget per strand, buffer-tube management, and fibre routing on the floor-plan
tray system (a tray already carries cables — let it carry *strand* assignments).

---

## 10. Open questions (for the user)

1. **Marking convention:** default to the **stripe-at-13, ring-at-25** scheme you
   described (ribbon/tracer style), or default to **tube-colour pairs** for
   loose-tube and use stripes/rings only for ribbon? (We can store `construction`
   and do both — this is just the default when unspecified.)
2. **Strand terminations in Phase 1?** Ship visualise+label first (Option B), or
   go straight to strand-level terminations (heavier, Option A/C now)?
3. **Custom palettes:** is TIA-598-C default enough for v1, or is a tenant custom
   palette needed on day one?
4. **Where the count comes from:** manual `fiber_count`, or inferred from the
   cable `type` + a chosen connector (e.g. "24F MPO trunk")?

---

## 11. Concrete first slice (if approved)

1. Migration: add `fiber_count` (null int), `fiber_standard` (default `tia598c`),
   `fiber_construction` (blank), `strands` (JSONB `{}`) to `Cable`. Guard in the
   serializer so they only validate/serialise for fibre `type`s.
2. `api/fiber_colors.py` — the palette table + `fiber_color(position, standard)`
   (backend twin of the frontend function; keeps API exports honest).
3. `frontend/src/lib/fiber.ts` — `fiberColor()` + palettes (single FE source).
4. `frontend/src/components/fiber/FiberDot.tsx`, `FiberMap.tsx`.
5. Cable detail page: a **Fibres** section (map + label/status editor), shown
   only for fibre cable types.
6. Docs: a user-facing `docs/dcim/fiber.md`, and a roadmap entry.
7. Gates: model/serializer tests (colour derivation, sparse strand round-trip,
   validation that `fiber_count` is only set for fibre types), `tsc`, eslint,
   prettier.
