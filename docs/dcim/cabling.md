---
icon: lucide/cable
---

# Cabling & connections

Danbyte records the **physical connections** between ports - patch cables,
breakouts, trunks, and links that run *through* patch panels - and can trace any
connection from one end to the other.

**Terminable ports:** interfaces, front/rear (patch-panel) ports,
console + console-server ports, power ports/outlets/feeds, and **aux
ports** - so USB console links or video runs are first-class cables.

## Connect two ports

1. Open **DCIM → Cables** and click **Add cable** (or start from a port's detail
   page).
2. Build each end - **A side** then **B side** - the same way:
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

A port can be cabled **only once** - Danbyte rejects connecting a port that's
already in use, so every connection stays unambiguous.

## Port reservations

Sometimes you know a port will be needed before you know where its cable will
land - a colleague claims "I'll need one on this switch" with the far end
still undecided. A **port reservation** holds exactly one uncabled port, no
far end required, complementing the *Planned*-cable flow (which needs both
ends picked).

- Reserve from any port row's bookmark action (interfaces, front/rear ports,
  console, power) or from the interface page's **Reserve port** button, with
  an optional note. The row tints amber, shows a **Reserved** badge with the
  note and reserver on hover, and the faceplate outlines the port amber.
- A reserved port counts as **reserved** in [port
  utilization](devices.md#the-device-page), exactly like a planned cable.
- The hold releases **automatically** the moment any cable terminates on the
  port - including a *Planned* one, which then carries the reserved state
  itself. Releasing by hand: the same bookmark action, or the list page.
- **DCIM → Connections → Port reservations** lists every hold in the tenant:
  port, kind, site, who reserved it, note, and age
  (`/api/port-reservations/`) - with kind/site/reserved-by facets, search,
  a pencil to edit the note, and select + release-many for bulk cleanup.
  Reservations are RBAC-controlled (*Port reservations* object type) and
  audited.

### Cable type

Pick the medium from the **Type** dropdown, organised into sub-categories -
copper twisted pair (CAT3–CAT8, MRJ21), twinax/DAC, coaxial (RG-6…RG-213,
LMR-100…400), fiber multimode (OM1–OM5), fiber single-mode (OS1/OS2), AOC,
power, and USB. Start typing (e.g. `om4`, `os2`, `dac`, `rg-6`) to filter.
Full taxonomy: [Interface & cable types](type-taxonomy.md).

### Cable status & color

| Field | Notes |
|---|---|
| **Status** | connected, planned, or decommissioning. |
| **Length** | a number plus a unit (m / cm / ft / in). |
| **Color** | the literal color of the physical cable - shown on the [topology map](../features/topology.md) and the cable page's path strip. |

A cable's detail page draws its **end-to-end path** under the A/B boxes -
every device and panel the run passes through as linked chips, with the
pass-through ports shown `front ⇄ rear` and each cable segment labelled
(the current cable highlighted). Breakout fan-outs fall back to the Trace tab.

The port cells in a chip are click targets: an interface opens its own page,
while a front / rear / console / power port opens its device's
[Components → Hardware](devices.md#the-device-page) sub-tab
(`?tab=components&sub=hardware`), where those ports live.

## Connection shapes

You're not limited to one-to-one patches:

| Shape | A side | B side | Example |
|---|---|---|---|
| **Patch** | 1 port | 1 port | switch ⇄ server |
| **Breakout** | 1 port | many ports | one QSFP → four SFP |
| **Trunk** | many | many | bundled links |

**One end may span devices.** A breakout's four legs commonly land in four
different servers, so the ports on a single end don't have to share a device.
The cable form gives each end a tab per device for exactly this.

**One end is one kind of port.** Several interfaces on an end is a breakout;
an interface *and* a power port on the same end is a typo, and is rejected -
no cable is half network and half power.

## Patch panels

A patch panel is just a device with **front ports** and **rear ports**. Each
front jack maps to a rear strand. When a cable lands on a front port, the
connection **passes through** to the rear and continues on whatever's cabled
there - so a link can cross several panels and Danbyte still follows it.

Manage a panel's front/rear ports from its device page, alongside its interfaces.
Each port takes a **description** - the room the trunk runs to, the label on the
sticker - shown as a column in the front/rear port tables and editable in bulk.

## Tracing a connection

Every interface, cable, and panel port has a **Trace** tab. It walks the
connection end to end - hopping across each cable and *through* each patch panel -
and draws the whole path as a single chain, so you can see the real far end of a
link even when it runs through three panels to get there.

## Topology map

The **Topology** page (sidebar, under DCIM) draws an interactive **device-to-
device map** of your cabling. Filter it by **site** to focus on one location, or
by **device** to pull in just that device's neighbours. Drag nodes around, use
the minimap to navigate, and click **re-layout** to tidy it up. Cable colors
carry through to the links. On very large networks, filter by site first - the
map will prompt you.


## Connecting from a port

You don't have to start from the Cables page: any **uncabled interface** offers
a **Connect cable** button - on the interfaces table (row action) and in the
interface detail header. It opens the cable form with that port already on the
A side; pick the B side and save.

The same affordance follows every other cable-able port, permissions allowing
(you need cable-add rights; the server enforces them regardless):

- **Power tab** - uncabled **power ports** and **power outlets** carry the same
  ghosted connect button as interface rows, landing on the cable form with the
  inlet or outlet pre-seeded as side A.
- **Photo faceplate** - on a device whose type has
  [photo ports](device-catalog.md#photo-ports), a **free** power / console /
  console-server / aux / front / rear marker is a button: click it and the
  cable maker opens right there, titled from that port, with it already on the
  A side. Cabled markers keep their hover card.
- **3D room** - clicking a free port marker on a device's face offers the same
  connect flow (pick the far end in 3D, or open the cable maker) - see
  [floor plans](../features/floor-plans.md#the-3d-room-view).

However you arrive, the pre-seeded port shows as a **named chip**
(`device:port`) on the form, never a raw id - a **power feed** chip reads
`panel:feed`, since feeds terminate on power panels rather than devices.
