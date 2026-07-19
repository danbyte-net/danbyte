---
icon: lucide/list-tree
---

# Interface & cable types

Interfaces and cables carry an optional **type** — the physical medium. The
values are a **standards-based taxonomy** (IEEE / TIA / ITU-T media types),
not tenant data: Danbyte ships the vocabulary the same way it ships length
units, and nothing is pre-selected. Both dropdowns are searchable and
**grouped into sub-categories**, so 200+ media types stay navigable.

The single source of truth is `api/dcim_choices.py`; the frontend fetches it
from `GET /api/dcim/choices/` (each choice carries `value`, `label`, `group`).
Slugs deliberately track a **standard device-type vocabulary**, so device-type
imports, operator muscle memory, and external tooling carry over 1:1.

## Interface type groups

| Group | Examples |
|---|---|
| Virtual | `virtual`, `bridge`, `lag` |
| Fast Ethernet (100M) | `100base-tx`, `100base-t1`, `100base-fx` |
| Gigabit Ethernet (1G) | `1000base-t`, `1000base-sx`, `1000base-lx`, `1000base-zx`, BiDi |
| 2.5 / 5 Gigabit Ethernet | `2.5gbase-t`, `5gbase-t` |
| 10 → 800 Gigabit Ethernet | per-speed groups: `10gbase-sr/lr/er`, `100gbase-dr/fr1/lr1`, `400gbase-zr`, … |
| 1.6 Terabit Ethernet | `1.6tbase-cr8`, `1.6tbase-dr8` |
| Ethernet (pluggable transceivers) | form-factor slugs: `10gbase-x-sfpp`, `100gbase-x-qsfp28`, `400gbase-x-osfp`, `1.6tbase-x-osfp1600` |
| Ethernet (backplane) | `10gbase-kr`, `100gbase-kr4` — chassis/blade midplanes |
| Wireless | 802.11a → 802.11be (Wi-Fi 7), Bluetooth, LR-WPAN |
| Cellular | `gsm`, `cdma`, `lte`, `4g`, `5g` |
| SONET / SDH | `sonet-oc3` → `sonet-oc3840` |
| Fibre Channel | 1GFC → 128GFC by transceiver |
| InfiniBand | SDR → XDR |
| Serial / WAN | `t1`, `e1`, `t3`, `e3` |
| Broadband (DSL / coax) | `xdsl`, `docsis`, `moca` |
| PON | `bpon` → `50g-pon` (all ITU-T / IEEE generations) |
| Stacking | Cisco StackWise family, Juniper VCP, Extreme SummitStack |
| Other | `other` |

**Fixed vs pluggable:** media-specific slugs (`10gbase-lr`) say *what the
link is*; transceiver slugs (`10gbase-x-sfpp`) say *what the port accepts*.
Use the form-factor slug for switch ports that take optics, and the
media-specific slug when the medium is fixed (RJ45, BiDi OLT/ONT ports,
fixed-optic gear).

## Cable type groups

| Group | Examples |
|---|---|
| Copper — twisted pair | `cat3` → `cat8`, `mrj21-trunk` |
| Copper — twinax / DAC | `dac-active`, `dac-passive` |
| Copper — coaxial | `coaxial`, `rg-6`/`rg-8`/`rg-11`/`rg-59`/`rg-62`/`rg-213`, `lmr-100/200/400` |
| Fiber — multimode | `mmf`, `mmf-om1` → `mmf-om5` |
| Fiber — single-mode | `smf`, `smf-os1`, `smf-os2` |
| Fiber — other | `aoc` |
| Power / other | `power`, `usb` |

The coax family matters for broadcast/OSP plants (RG-6/RG-11 drops, RG-59
CCTV, LMR antenna runs); DAC/AOC matter in-rack; OM/OS grades drive optic
reach budgets.

## Custom values still round-trip

The API serializers accept **any** string for `type` (lenient `CharField`),
so imports and SNMP syncs never fail on an unknown medium; the UI shows an
unknown value verbatim at the top of the dropdown and keeps it selectable.
The curated lists only control what the dropdown *offers*. Deployments can
trim/extend the lists in `api/dcim_choices.py`.

## Research notes — what was added and why

Added in the 2026-07 expansion:

- **Media-specific Ethernet** (`10gbase-lr`, `100gbase-dr`, `400gbase-zr`, …)
  — lets an interface say which IEEE PMD is in the port, not just the cage
  form factor. Needed for optical budget/reach planning and for modelling
  fixed-optic hardware.
- **BiDi variants** (`1000base-bx10-d/u`, `10gbase-br-d/u`, `40gbase-sr4-bd`,
  `100gbase-sr1.2`, `400gbase-sr4_2`) — single-strand links are direction-
  asymmetric; FTTx and strand-constrained plants model each end differently.
- **Backplane Ethernet** (`*base-kr*`, `*-kx*`, `*-kp4`) — blade chassis and
  stacked fabric midplanes.
- **1.6T Ethernet + OSFP1600/QSFP-DD1600** — IEEE P802.3dj generation; ships
  in AI-fabric gear.
- **SONET/SDH OC-3 → OC-3840** — legacy carrier/WAN links still in every
  telco inventory.
- **Stacking media** (StackWise, VCP, SummitStack) — stack ports are cabled
  ports; without a type they pollute "other".
- **PON generations** `bpon`, `25g-pon`, `50g-pon` on top of the existing
  GPON/XGS-PON set — 50G-PON (ITU-T G.9804) is the current build-out edge.
- **Wi-Fi 7 / LR-WPAN / MoCA / DOCSIS / 4G / 5G** — access-edge completeness.
- **Cable coax + USB families** — RG/LMR grades and USB (console/serial
  leads) so real patch schedules don't need free-text.

Deliberately **not** added: vendor marketing names (e.g. "SFP56-DD"),
pre-standard optics without an IEEE/ITU slug, and anything better modelled as
a custom field on the interface (channel width, DWDM wavelength, PoE class).

## Plan — parametric cable profiles (OSP fiber)

The type taxonomy says what a cable is *made of*; it does not describe its
**internal structure** (strand/tube/ribbon layout). That's the next gap for
outside-plant fiber:

- OSP **loose-tube** cable groups fibers into buffer tubes (typically 12 per
  tube): a 144-fiber cable is 12 tubes × 12 fibers; 288-fiber = 24×12 or
  12×24.
- OSP **ribbon** cable stacks 12/24-fiber ribbons; Sumitomo SWR reaches
  3456–6912 fibers in one sheath.
- Splice closures and FDHs join these mid-span; accurate tracing needs the
  cable to know its tube/ribbon layout.

Today Danbyte models this with `RearPort.positions` + `FrontPort` mappings on
patch-panel devices, which covers structured cabling but forces splice
closures to be modelled as devices. The plan — a cable-profiles /
dynamic slug-parsing approach — is:

1. **`Cable.profile` slug field** (blank = simple cable, current behaviour).
   Two parseable shapes, mirroring how symmetric cables really present:
   - `single-{C}c{P}p` — one logical connector of *P* positions per end
     (`single-1c144p` = 144-fiber cable, one bundle).
   - `trunk-{C}c{P}p` — *C* connectors of *P* positions per end
     (`trunk-12c12p` = 12 buffer tubes × 12 fibers).
2. **Slug parser + class factory, cached** — profiles are *generated* from
   the slug (regex `^(single|trunk)-(\d+)c(\d+)p$`), not hand-listed, so any
   real-world tube/ribbon count works without code changes. Generated
   classes are cached in a module dict keyed by slug (bulk tracing rebuilds
   nothing).
3. **Complex profiles stay hardcoded** — breakout/shuffle layouts (non-linear
   position maps, e.g. MPO shuffle cassettes) get dedicated classes looked up
   by exact slug *before* the parser runs.
4. **Validation in `Cable.clean()`**, not `choices=` — bounds
   `connectors ≤ 256`, `positions ≤ 8192` (8192, not 1024: Sumitomo ships
   6912-fiber cable; headroom on top). The UI dropdown stays a curated list;
   API/import accept any slug that parses.
5. **Termination positions** — `CableTermination` grows a `positions` array
   so an end can land on specific strands of a port; trace logic maps
   per-position through the profile instead of treating the cable as opaque.

This keeps one physical cable = one `Cable` row (instead of splitting a
288-fiber cable into 24 logical cables), and makes splice-point tracing
position-accurate.
