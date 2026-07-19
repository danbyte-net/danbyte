---
icon: lucide/cable
---

# Fibre strands

A fibre cable isn't one wire — it's a bundle of **strands**, each an independent
light path. Danbyte lets you record how many strands a fibre cable carries,
**colour-code** them to the industry standard, and **label** each one.

## How much you model — the modelling setting

Not every team wants to track fibres. **Customize → Fibre colours** has a
per-tenant **Fibre modelling** switch:

- **Off** — a cable is just a cable; no fibre UI appears anywhere.
- **Count + colours** *(default)* — strand count, colours and labels; the trace
  follows strands straight-through the panels. This is the everyday level.
- **Strand-accurate** — also model **multi-fibre connectors** (below); the
  panel front-port form gains a **Fibres** field.

Turn it **Off** and the whole feature gets out of your way.

## Multi-fibre connectors (LC-duplex, MPO)

A patch-panel **rear port** has *N* positions (strands). A **front port** used to
tap exactly one — but a real **LC-duplex** connector carries **2** fibres and an
**MPO** carries **8–24**. With modelling set to *Strand-accurate*, a front port
has a **Fibres** count and claims that many **consecutive** rear positions from
its start (e.g. an LC-duplex at start 1 owns strands 1–2). Danbyte validates that
the range fits the rear port and doesn't overlap another front port. Picking a
**connector type** (LC Duplex, MPO-12 …) pre-fills the count — you can still
edit it.

## Finding fibre cables

**DCIM → Fibre cables** lists every cable whose type is a fibre medium, with a
filter rail — narrow by **type** (mmf-om4, smf-os2 …), **strand count**, or
status, and search by device/port. Each row shows a colour strip of its first
strands; click through to the cable's Fibres section.

## Turning a cable into a fibre cable

Any cable whose **type** is an optical-fibre medium (single-mode `smf*` or
multimode `mmf*`) gets a **Fibres** section on its detail page (Overview tab).

1. Set the **strand count** (2, 12, 24, 48, 96…).
2. The strands render as coloured swatches, grouped into rows of 12
   (one row per buffer tube / ribbon).
3. **Click a strand** to give it a **label** (e.g. "Cust-A pri") and a
   **status** (in use · spare · reserved · dark · damaged). Dark/damaged strands
   render dimmed so they're obvious at a glance.

Only the strands you annotate are stored — an un-labelled 288-fibre trunk costs
nothing.

## The colour standard (TIA-598-C)

Strands follow **TIA-598-C**, the 12-colour sequence:

**Blue · Orange · Green · Brown · Slate · White · Red · Black · Yellow · Violet
· Rose · Aqua.**

Past 12 the sequence repeats, and each repeat is marked with a **diagonal
tracer** (a contrasting stripe, like a real striped fibre):

- **Strands 13–24** — the base colours with **one** tracer stripe.
- **Strands 25–36** — **two** stripes; **37–48** — three; and so on.

So strand 25 reads as "Blue with two tracers" — the third dozen. The tracer
colour is picked to contrast the fill, and White, Black and Aqua get a thin
outline, so every strand stays legible in light or dark mode. (Each row of the
fibre map is also one 12-fibre unit, labelled by its buffer-tube colour.)

## Customising the palette — Fibre colours settings

**Customize → Fibre colours** (`/fiber`) is a per-tenant setting for the strand
colour **order**. It defaults to TIA-598-C. You can:

- **Reorder** colours (move up / down),
- **Recolour** them (colour picker or hex),
- **Add / remove** entries, or
- **Reset to TIA-598-C**.

A live **24-strand preview** shows the effect. The tracer rule (stripe past 12,
ring on each further wrap) always applies on top of whatever colours you choose.
Every fibre map in the app — cable pages and (later) the trace views — uses this
palette.

## Tracing a strand end-to-end

On a **trunk** cable (both ends on patch-panel rear ports), strand *k* is a
real, independent light path: it maps to position *k* on each rear port, breaks
out through the panels' front ports, and patches on to the end devices. Click a
strand (or **Trace** in its editor) to follow it **end-to-end through the
panels** — `device-A ═ panel ═ TRUNK (strand k) ═ panel ═ device-B`, drawn as a
path strip with the trunk segment in the strand's fibre colour. The header shows
whether the run is complete (both ends reach a real port) or stops at a dangling
panel.

Strand-to-position is 1:1 by construction, so this works on any trunk with no
extra setup.

**In the path / trace views** (the device "Paths" tab, cable trace, and the map
deep-view — all the same shared strip) a **fibre** cable is marked with a small
duplex glyph and drawn as a thin duplex rail, and where a run threads a
strand-bearing trunk the segment is drawn in that **strand's colour** with a
`● strand N` tag. So you can see, at a glance, which fibre a run rides through
each panel. A quick **Trace** button (⟿) sits on every row of the **Cables**
and **Fibre cables** lists and on each cabled port in a device's **Hardware**
tab — it opens the end-to-end run in a dialog without leaving the page.

## How a strand maps to a front port

This is the patch-panel model, and **you control it** — nothing is guessed:

- A panel's **rear port** has a number of **positions** (its strand count). Strand
  *k* of a trunk cabled onto that rear port is simply **rear position *k*** — a
  fixed 1:1 mapping.
- Each **front port** taps one rear position via its **`rear_port_position`**.
  Front port `f1` with `rear_port_position = 1` breaks out strand 1; set it to 7
  and that front port now taps strand 7.

So "which fibre goes to which front" is exactly the front port's
`rear_port_position`, which you set when you **create or edit the front ports**
(Device → Hardware → front ports, or on the device type's port templates). The
trace then follows that mapping automatically: strand *k* → rear *k* → the front
port whose position is *k* → whatever's patched onto it.

## Splice closures

A splice closure is just a device whose type has front and rear ports mapped
1:1 — a cable in, a cable out, and the trace walks straight through it like
any patch panel. Model one as a device type ("Splice closure 48F": one
48-position rear port + 48 front ports, or 48 rear/front pairs for inline
splices), create devices from it, and cable through. If a mid-span closure
should show up in the site map's cross-site cable bundles, give it its own
(small) Site so the bundle splits at the closure.

## PON splitters

An optical splitter broadcasts one input to every output — a different animal
from a panel's 1:1 pass-through, so it gets its own flag: tick **Optical
splitter (PON)** on a rear port (or a rear-port template, so every device from
the type is born a splitter). The rules:

- a splitter rear port has exactly **1 position** — the input;
- its **front ports are the outputs**, all mapped to position 1 (the usual
  one-front-port-per-position rule is lifted);
- tracing **fans out**: from the OLT you reach every ONT behind the splitter
  (cascades included); from one ONT you reach the OLT *and* the sibling ONTs
  — the shared-medium reality of a PON tree;
- the topology map and cable traces keep the splitter as a visible node (it
  is never collapsed away like a patch panel), badged as a splitter.

A typical build: device type "1:8 splitter" = one rear port (positions 1,
splitter ticked) + front ports `out[1-8]`. Feeder cable into the rear, drop
cables out of the fronts.

## Building a PON, end to end

Nothing here is pre-filled — you define the vocabulary once, then stamp it
out:

1. **The OLT** is an ordinary device. Give its device type PON interfaces —
   interface type `gpon` / `xgs-pon` / `epon`… (the PON family is in the
   interface-type list). Each PON port feeds one splitter tree.
2. **The splitter** is a device type with one rear port (*positions 1*,
   **Optical splitter (PON)** ticked) and its outputs as front ports —
   `out[1-8]` for a 1:8. Create a device from it wherever the splitter
   lives (street cabinet, basement, closure).
3. **The ONTs** are devices with a PON-type interface each.
4. **Cable it**: feeder cable from the OLT's PON interface to the splitter's
   rear port; one drop cable from each splitter front port to each ONT.
5. **Trace**: from the OLT port you'll reach every ONT; from any ONT you'll
   see the OLT *and* the siblings (a PON is a shared medium). The splitter
   stays a visible, badged node on the trace and topology views.

Cascades just repeat step 2–4 (splitter front → next splitter's rear).

## Geographic routes — fiber on the site map

The [site map](../features/site-map.md) draws **every** cable whose ends are
placed — no route required. Click a device to see its cabling and ports,
trace a run on the map, or **＋ Connect** an empty port to wire a cable right
there. Draw **routes** (ducts, aerial spans, trenches) in the map's **Cables**
mode when you want a cable to follow real geometry instead of a straight
chord; assign cables to a route as you draw it or from the route inspector.
Every cable page gets a **Show on site map** button once it's placed.

## What's next

Binding a strand to a *non*-sequential far-end position, duplex/MPO grouping,
2:N splitters, and per-strand splice management — see
[fibre strands — design](../architecture/fiber-strands.md).
