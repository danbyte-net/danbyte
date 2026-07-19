---
icon: lucide/cable
---

# Cabling & connections

Danbyte records the **physical connections** between ports — patch cables,
breakouts, trunks, and links that run *through* patch panels — and can trace any
connection from one end to the other.

**Terminable ports:** interfaces, front/rear (patch-panel) ports,
console + console-server ports, power ports/outlets/feeds, and **aux
ports** — so USB console links or video runs are first-class cables.

## Connect two ports

1. Open **DCIM → Cables** and click **Add cable** (or start from a port's detail
   page).
2. Build each end — **A side** then **B side** — the same way:
   - pick the **port type** (interface, front/rear port, console, console
     server, power port, or power outlet),
   - pick the **device** with the searchable [device picker](devices.md#picking-a-device)
     (use its **advanced search** to filter by site, role, tag, …),
   - **tick the port(s)** on that device. Selected ports appear as chips; switch
     the device or type and keep ticking to add ports from **several devices**
     on the same end (breakout).
3. Optionally set the cable's **type**, **status**, **length**, **color**, and a
   description.
4. Save.

A port can be cabled **only once** — Danbyte rejects connecting a port that's
already in use, so every connection stays unambiguous.

### Cable type

Pick the medium from the **Type** dropdown, organised into sub-categories —
copper twisted pair (CAT3–CAT8, MRJ21), twinax/DAC, coaxial (RG-6…RG-213,
LMR-100…400), fiber multimode (OM1–OM5), fiber single-mode (OS1/OS2), AOC,
power, and USB. Start typing (e.g. `om4`, `os2`, `dac`, `rg-6`) to filter.
Full taxonomy: [Interface & cable types](type-taxonomy.md).

### Cable status & color

| Field | Notes |
|---|---|
| **Status** | connected, planned, or decommissioning. |
| **Length** | a number plus a unit (m / cm / ft / in). |
| **Color** | the literal color of the physical cable — shown on the [topology map](../features/topology.md) and the cable page's path strip. |

A cable's detail page draws its **end-to-end path** under the A/B boxes —
every device and panel the run passes through as linked chips, with the
pass-through ports shown `front ⇄ rear` and each cable segment labelled
(the current cable highlighted). Breakout fan-outs fall back to the Trace tab.

## Connection shapes

You're not limited to one-to-one patches:

| Shape | A side | B side | Example |
|---|---|---|---|
| **Patch** | 1 port | 1 port | switch ⇄ server |
| **Breakout** | 1 port | many ports | one QSFP → four SFP |
| **Trunk** | many | many | bundled links |

## Patch panels

A patch panel is just a device with **front ports** and **rear ports**. Each
front jack maps to a rear strand. When a cable lands on a front port, the
connection **passes through** to the rear and continues on whatever's cabled
there — so a link can cross several panels and Danbyte still follows it.

Manage a panel's front/rear ports from its device page, alongside its interfaces.

## Tracing a connection

Every interface, cable, and panel port has a **Trace** tab. It walks the
connection end to end — hopping across each cable and *through* each patch panel —
and draws the whole path as a single chain, so you can see the real far end of a
link even when it runs through three panels to get there.

## Topology map

The **Topology** page (sidebar, under DCIM) draws an interactive **device-to-
device map** of your cabling. Filter it by **site** to focus on one location, or
by **device** to pull in just that device's neighbours. Drag nodes around, use
the minimap to navigate, and click **re-layout** to tidy it up. Cable colors
carry through to the links. On very large networks, filter by site first — the
map will prompt you.


## Connecting from a port

You don't have to start from the Cables page: any **uncabled interface** offers
a **Connect cable** button — on the interfaces table (row action) and in the
interface detail header. It opens the cable form with that port already on the
A side; pick the B side and save.
