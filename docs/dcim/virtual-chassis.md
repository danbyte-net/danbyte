---
icon: lucide/layers
---

# Virtual chassis (switch stacks)

A **virtual chassis** models a switch stack - several physical switches acting
as one logical chassis (Cisco StackWise, Juniper Virtual Chassis, Aruba VSF, and
friends). Each member stays an ordinary [device](devices.md) with its own
serial, rack position, and interfaces; the stack just ties them together and
records each member's position and master-election priority.

!!! note "Not a cluster"
    A **cluster** is the virtualization host group for VMs. A **virtual
    chassis** is physical switch stacking. Different objects, different pages.

## Create a stack

1. Open **DCIM → Devices → Virtual chassis** in the sidebar and click **Add**.
2. Fill in the form:

| Field | What it records |
|---|---|
| **Name** | A label for the stack (must be unique within the tenant). |
| **Domain** | The stack / VC domain identifier, where the platform has one. |
| **Topology** | **Ring** (default) or **Chain**: whether the last member is cabled back to the first. The 3D views draw a [derived ring](#in-3d) this way. |
| **Auto-connect stack ports** / **Auto-connect StackPower ports** | Record the derived rings as real cables and keep them in step with the members. Off by default. See [Auto-connect](#auto-connect). |
| **Master** | The member acting as stack master, if designated. Must be a member of this stack - Danbyte rejects anything else. |
| **Description / comments** | A short note, and long-form notes. |

3. Save.

Members with monitored IPs or services wear their live check state next to
the status pill - in the Members table and on each unit's row in the stack
drawing. Unmonitored members show nothing extra. Usually only the master has
an address; the stack's **Monitoring** tab shows the checks of the member it
is measured on.

## Add members

Membership lives on the **device**, and there are two doors in:

- **From the stack page** - the Members table's **Add member** button opens a
  device search; pick the switch, give it a position (pre-filled with the next
  free slot) and a priority. A device already in another stack moves over.
- **From the device** - open a member's edit form and fill in the
  **Stack membership** section:

| Field | What it records |
|---|---|
| **Virtual chassis** | The stack this device belongs to. |
| **Position** | The member id within the stack (0–255, unique per stack). |
| **Priority** | The master-election priority. |

Once a device is in, you can also edit its position/priority, promote it to
master, or remove it right from the stack's **Members** table.

## Position-aware interface names

Stacked switches name their ports by member number - member 2 of a Catalyst
stack owns `GigabitEthernet2/0/24`, not `1/0/24`. Danbyte handles this with a
**`{position}` token** in [component template](device-catalog.md) names:

```
GigabitEthernet{position}/0/[1-24]
```

- **`{position}`** resolves to the device's stack position when its components
  are stamped - member 1 gets `GigabitEthernet1/0/1`, member 2 gets
  `GigabitEthernet2/0/1`. A standalone device resolves it to `1`; vendors that
  count from zero (Juniper's `ge-0/0/0`) write `{position:0}` to set the
  standalone default. The token can sit anywhere in the name, so any vendor
  style works: `ge-{position}/0/[0-47]`, `{position}/1/[1-24]`, ….
- **`[1-24]`** is range shorthand in the template dialog - it creates one
  template per port in a single go, with a live preview of what you'll get.

**Names follow the device around.** When a device joins a stack, moves to a
different position, or leaves, Danbyte re-renders its `{position}` templates
and renames the matching interfaces - swap two members and both sets of ports
stay truthful. Renames never clobber: if a target name is already taken by
another interface, that port is skipped and everything else still renames.
The API reports the count (`vc_renamed_interfaces`) and the UI toasts it -
"added to stack - 28 interfaces renamed to match".

**3D models follow too.** A [model pack](model-packs.md#stack-members) is
authored as member 1 (`port:GigabitEthernet1/0/1`); on member 2 its ports,
port lights and generated photo ports are `GigabitEthernet2/0/…`.

## The stack page

Open a stack to see its tabs:

- **Overview** - the stack's facts plus a **Members** table sorted by position:
  position, device, priority, role (a *Master* / *Member* badge), serial, and
  status. Tick members and press **Remove N from stack** to release several
  at once; each is a device edit, checked and logged as one.
- **Interfaces** - every member's ports combined into one view (the tab badge
  shows the total), each row prefixed with the member's position and name.
- **Monitoring** - the SLAs the stack is in, with **Add to SLA**, then the
  member and address the stack is measured on and that member's checks.
- **SNMP**, **Journal** and **Change log**.
- The Overview draws the **stack itself** - one chassis bar per member in
  position order (gaps show as dashed empty slots), with the master crowned
  and each member's serial, priority, and status on the bar.

On a **member device's** page, the Interfaces tab gains a
**Whole stack / This member** toggle: the combined stack table (with the
member column, this device's rows tinted) or just the device's own ports.
The stack **master defaults to the whole-stack view** - open the master and
you see every port in the stack.

A member's own device page shows a **Stack** badge in the header
(`Stack: name · pos N · master`) linking back to the stack.

**Port utilization** sits under the stack elevation: the same card the device
page shows - connected / reserved / free per port kind, undocumented cables
counted as connected - summed across every member, by the same
[counting rule](devices.md#what-counts-as-a-port): physical interfaces and front
ports, virtual interfaces only when they are counted, rear ports never. The
card refreshes after a cable, port or reservation change anywhere.

!!! note "Changed in 0.17"
    A stack's SVIs and port-channels no longer count as ports by default, so
    the stack reads fuller than before. Until 0.17 the card also kept its old
    numbers after a cable change until the page was reloaded.

## In 3D {#in-3d}

A rack's [3D view](racks.md#the-rack-in-3d) and the floor plan's
[3D room](../features/floor-plans.md#the-3d-room-view) draw a stack's
**stack cables** between the members drawn with their 3D model:

- **Stack ports.** An interface of a type in the catalog's **Stacking**
  group (dedicated stacking ports), or any interface marked
  [**Stack port**](interfaces.md) - the data ports a VSF or IRF stack runs
  over, their media type unchanged. A device type's interface templates
  carry the mark to each device; a pack's YAML sets it with `stack: true`.
- **Recorded cables.** Any cable between two stack ports of members of the
  same stack is drawn between them. It is drawn once, by the stack, not
  again by the room's cable layer. [Auto-connect](#auto-connect) cables
  and cables made with [Record cable](#record-a-derived-cable) are recorded
  cables.
- **Derived ring.** Between ports that have no cable, Danbyte draws the
  ring the member order implies. A recorded cable replaces only its own
  link; the rest of the ring stays derived. A port cabled to anything else
  gets no derived cable either. Each member's stack ports are put in natural
  name order and the first two are its **A** and **B**: member *n*'s A to
  member *n+1*'s B, and the last member back to the first. `StackPort2/1` /
  `StackPort2/2`, `vcp-255/1/0` / `/1` and `1/1/49` / `50` all work, with no
  name patterns. A two-member stack gets two cables, A1 to B2 and A2 to B1.
  A stack whose **Topology** is **Chain** leaves out the closing cable. A
  member without one of the ports skips that cable; one with more than two
  uses A and B only - draw the rest by recording the cables.

### StackPower {#stackpower}

Cisco StackPower shares the members' power supplies over its own cables,
beside the data stack. Danbyte draws those **StackPower cables** the same
way:

- **StackPower ports.** A member's power ports of type **Cisco
  StackPower** (`cisco-stackpower`, the catalog's **Stack power** group).
  In natural name order the first two are its **A** and **B**
  (`StackPower1/A`, `StackPower1/B` on a Catalyst 9300).
- **Recorded cables.** Any cable between two StackPower ports of members of
  the same stack. A cable may join two power ports only when both are
  StackPower ports.
- **Derived ring.** Between free ports, as for the data ring: member *n*'s B to member
  *n+1*'s A, the last back to the first. A StackPower ring joins at most
  **four** switches (Cisco's limit on the C9300), so members 1-4, 5-8, …
  each close their own ring; a last member left on its own gets none. The
  stack's **Topology** does not apply to it.

The data ring and the StackPower ring are decided apart: a recorded
StackPower cable leaves the derived data ring in place, and the other way
round. A derived StackPower cable is a drawing aid like a derived stack
cable: it hides the ports' covers while drawn and counts for nothing else -
not utilization, power draw or a power budget. A recorded one hides its
ports' covers as any cabled port does. Viewing StackPower cables needs view
on power ports (and cables, for recorded ones).

Each end seats the tenant's StackPower head (`CAB-SPWR`, `fits:
[cisco-stackpower]`) and the cable is drawn in its `cable:` profile (an
8.5 mm round jacket). Its `END_BAND` follows Cisco's marking: the
**green** band is the end that may only go into a switch, the **yellow**
band the end that may go into a switch or an XPS. Between two switches
either end fits, so Danbyte colours them as stack cables: **yellow** at the
A end, **green** at the B end - a derived link's A end is member *n*'s B
port. The same **Stacks** choice shows, ghosts or hides them.

Hover a stack cable for its card: **Stack cable** or **StackPower cable**,
with **(derived from member order)** on a derived one, and the two ports. A derived ring is a drawing aid, not
data: its ports hide their [port covers](model-packs.md#port-covers) while
it is drawn, and count for nothing else - not port utilization, capacity or a
port's connected state.

**The stack as one.** Hover or select any member and every member of its
stack lights with it. The hover card names the stack, the member number
(`Member 1 · master` on the master) and the master. The device card gains a
**Stack** line linking to the stack.

**Stack-cable heads.** On a dedicated stacking port, when the tenant has a
stack-cable part - an [accessory type](model-packs.md#stack-cable-heads) of
`kind: cord` that fits the port's type - one is seated at each end and the
cable runs between their `cable` empties, drawn in the head's profile: one
round jacket, or a zip cord's or ribbon's jackets side by side. Its corners
bend no tighter than the head's bend, or the per-length one a recorded
cable's label names. A head with an `END_BAND` ring colours the two
ends of each cable apart: **yellow** at the A end, **green** at the B end -
a recorded cable's own A and B terminations, a derived link's member *n*
(A) and member *n+1* (B) - so one cable reads the same in every view. A
marked data port takes what any
cabled port of its type takes: a DAC head, an optic and its cord, an RJ45
plug. Without a part, a plain dark cable runs from the ports.

**How a cable hangs.** A stack cable leaves each head along its `cable`
empty's +Z for a short lead, bends down one bend radius behind the
furthest head, drops past the members and loops under the lower end - the
whole loop in one upright plane behind the ports, as a StackWise cable
hangs, so a cable between adjacent members never passes through a
chassis. The loop hangs at least 60 mm, and two bends, below the lower
end, and its bottom is at least two bends wide. Corners bend no tighter
than the head's bend where the run leaves room; ends right above each
other bend tighter at the bottom.

A stack's cables, data and StackPower, are laid out together so they lie
beside and on each other instead of through each other:

- They are taken in order of their upper end, lowest first, then stack
  cables before StackPower cables. Each takes the first **lane** no earlier
  cable across the same width holds.
- A lane is one jacket diameter and 3 mm further out from the stack. Its
  drops move in from the ports by as much, so a lead out to an outer lane
  passes beside the inner cables' drops, never through them.
- A lane's loop rests on the one inside it: its bottom one lane higher,
  below the lowest end of the cables it shares the width with.

The lanes are worked out from the cables' ends alone, so a refresh draws
the same picture. In a large stack, where the drops run out of room
between the ports, lanes are best-effort.

**A recorded cable hangs to its length.** A recorded cable with a
**Length** has its loop sized so the drawn cable is that long: a longer
cable hangs lower. It is never drawn shorter than its lane's run. Below
600 mm under its lower end it hangs no deeper, and the rest lies back
along the bottom of the loop, away from the stack. A derived link and a
cable without a length keep the default sag. The length also picks the
head's per-length bend when the label names a `min_bend_by_part` part.

### Tracing a cable {#tracing-a-cable}

Click a stack or StackPower cable, or the head at either end, to pick it.
Hovering a head previews its cable the same way.

- The cable draws solid in the selection colour, with both ends marked.
  Every other stack cable is ghosted.
- A card pinned in the view's corner names it (**Stack cable** or
  **StackPower cable**, **Derived** or **Recorded**), both ends (member
  and port), its label, and **Open cable** for a recorded one.
- Click it again, click anything else in the view, or press **Esc** to
  let it go. A click on a port that has a stack cable picks that cable.

**Cables**, on the toolbar of the device page's Stack view, the stack
page's 3D tab and the rack's 3D view, lists each drawn cable as `1/1 →
2/2`, grouped **Stack** and **StackPower** (by stack too where a rack holds
more than one). Pick a row to pick its cable; hover a row to preview it.
It is hidden while **Stacks** is **Hide**. The 3D room picks cables by
click and shows the same card.

### Record a derived cable {#record-a-derived-cable}

A derived cable is a drawing aid. To make it data, pick it and press
**Record cable** on its card, or use **Record all** at the bottom of
**Cables** for every derived cable drawn:

| Field | What it sets |
|---|---|
| **Part number** | The cable's **Label**. The head's part numbers (`STACK-T1-50CM`, `STACK-T1-1M`, `CAB-SPWR-30CM`, …) are offered; any text is accepted. |
| **Length** / **Unit** | The cable's length. A part number that ends in a plain length (`50CM`, `1M`, `150CM`) fills them in; otherwise type it. |

**Record all** has **Length for all** at the top, which sets every row
from one part; each row stays editable. The cable gets the two ports as
its A and B terminations and the cable type **Stack cable** or
**StackPower cable** (the **Stacking** group of cable types). Each is an ordinary cable create: it needs
cable add, is scoped and validated like any cable, and is logged in the
change log. The views then draw it as recorded - and, as a recorded
cable always does, it takes the place of its own derived link.

### On a port's page {#on-a-ports-page}

A stack port in a derived link shows where its cable would be: the
interface page's **Interface** card gains a **Stack cable** row, `Stack
cable (derived from member order) → sw3 · StackPort3/1`, the far member
linked, with **Record cable** for a reader who may add cables. On the
device's **Interfaces** and **Power ports** tabs the cable cell of such a
port says *derived*. It still counts as not connected. A recorded cable
shows as any cable does.

The rows come from `GET /api/devices/<id>/stack-links/`: `{"ports":
{"<port id>": {kind, name, far: {device, device_name, port, id},
parts}}}`, the far end listed only when the reader may view its device
and port. It follows the 3D rule: a kind with any recorded stack cable in
the stack has no derived links.

**Show, ghost or hide.** **Stacks** sits next to **Pluggables** in the 3D
room's View menu, on the rack's 3D toolbar and, with **Stack** on, on a
member's 3D card:

| Choice | What draws |
|---|---|
| **Show** (default) | The stack cables and their heads. |
| **Ghost** | The same at a quarter opacity, so the port markers read through them. |
| **Hide** | No stack cables. The covers come back on the ports of a derived ring; a recorded cable's ports keep theirs hidden, as any cabled port does. |

The choice is kept in this browser and shared by the rack's 3D view, the
room and the device page.

### On the device page {#on-the-device-page}

A member's [3D view](devices.md#3d-model) (the Panel card's **3D**) draws
the device alone. **Stack**, next to **Pluggables** on its toolbar, draws
the whole stack instead. The choice is kept in this browser, for every
member's card:

- **Every member you may view**, each with its own model (a member
  without one is left out), its lights, plugs and stack heads, and the
  stack cables between them as the room draws them. **Stacks** shows,
  ghosts or hides the cables.
- **Where they stand.** Members in the same rack as this device keep their
  real U positions, gaps included. When this device is in no rack, the rack
  holding the most members is used. Every other member - in another rack,
  or none - is stacked below them in member order, the lowest number on
  top, **1U** apart. Fronts line up.
- **This device** is outlined in the selection colour and stays the
  viewer's own: its port markers, bays, panel and right-click menus work as
  they do alone, and **Ports** outlines its ports. The other members show
  no port markers.
- **Hover** a member for its card: its name, `Member 2` (`Member 1 ·
  master` on the master) and the master; over one of this device's ports,
  only the port's card shows. **Click** another member to select it; its
  panel has **Open device**. A click on this device's body, or on empty
  space, clears the selection.
- **Front**, **Rear**, **Top**, **3D** and **Fit** frame the whole stack.
  Refreshed data never re-frames it while you move the camera. A click on
  a member also pivots the camera there, as in every
  [3D view](../features/floor-plans.md#navigate-3d).
  When the members' models together pass the room's triangle budget
  ([3D room](../features/floor-plans.md#the-3d-room-view)), the other
  members draw their far copies.

With one visible member, or none other with a model, the card shows the
device alone.

**Scope.** Only members the reader may view are drawn or listed, and no
cable is drawn to a member they may not view. A recorded cable needs view
on the cable and both interfaces; without interface view nothing is drawn.

### On the stack page {#on-the-stack-page}

The stack page's **Stack** card has a **3D** tab beside Photo and Rendered
when its master (or, without a master, its first member) has a 3D model. It
shows the same whole-stack view as a member's 3D card, always the whole
stack, so there is no Stack switch: every member, the stack and StackPower
cables, and the Stacks Show / Ghost / Hide choice. The master is the
highlighted member.

## Auto-connect {#auto-connect}

A stack's **Auto-connect stack ports** and **Auto-connect StackPower
ports** switches (on its form and its Overview) turn the derived rings into
real cables that Danbyte keeps in step with the stack:

- **On:** each link of the [derived ring](#in-3d) - by member order, a
  chain without its closing link, StackPower in rings of at most four - is
  recorded as a cable between the two ports. Its label is the head's
  shortest part number (`STACK-T1-50CM`, `CAB-SPWR-30CM`) with that length,
  when the tenant has a head part; typed **Stack cable** or **StackPower cable**.
- **Kept in step:** a member added, removed or renumbered, the stack's
  topology changed, or a stack port added, removed or retyped, and the
  stack's auto cables are brought in line when the change commits: a cable
  whose link is gone is deleted, a missing one is made.
- **Your cables win:** a port that already has a cable that is not auto is
  skipped, and no such cable is ever changed. Editing an auto cable in
  any way (through the API or a form) makes it an ordinary cable that
  Danbyte no longer manages.
- **Off:** deletes only the cables still auto; released ones stay.
- Deleting the stack leaves its auto cables as ordinary cables.

Auto cables are ordinary cables: they count as connected, show on the
ports and cables pages, and are logged in the change log with the cause
**Auto-connect: stack *name***. The cable records `auto_source` (`stack`
or `stack-power`) and `auto_chassis` (the stack), read-only in the API.
The work runs as the system within the stack's tenant. Turning a switch
on or off needs **change** on the stack and cable **add** and **delete**
at every member's site; without them the save is refused with a field
error.

`manage.py reconcile_stack_cables` brings every stack with a switch on (or
auto cables left) in line - for changes made by writes that skip the
model's signals, such as a bulk update of member positions. It is
idempotent.

## SNMP

A stack is polled once, through its master (or lowest member), and the
observation is split per member so drift and sync stay member-accurate. The
stack answers with one `sysName`, so only the owner is checked for name drift.
The
stack page's **SNMP** tab polls and syncs the whole stack; details in
[SNMP discovery → Polling a stack](../features/snmp-discovery.md#polling-a-stack).
An interface can be moved between members from its edit form.

## SLAs

A stack is one member of a [service level agreement](../features/sla.md#switch-stacks),
measured on its master's primary address - or, when the master has none, on
the first member's by position that has one. Add the chassis itself (the
**Virtual chassis** kind, or **Add to SLA** on its Monitoring tab), or add its
devices: devices of one stack that include one without an address count once
as the stack. The other members are never scored as down for having no
address. A member device's own SLA panel shows the stack's figure.

## Deleting a stack

Deleting a virtual chassis **releases its members** - their positions and
priorities are cleared and they carry on as standalone devices, each release
recorded in that device's change log. The devices themselves are never
deleted with the stack. Its [auto-connect](#auto-connect) cables stay, as
ordinary cables.

To delete several stacks, tick them in **Virtual chassis** and press **Delete**
in the bar. The confirmation says how many member devices are released, and
each stack releases its members the same way
(`POST /api/virtual-chassis/bulk-delete/`). More than 1000 stacks go 1000 at a
time (see [Large selections](../features/table-preferences.md#large-selections)).

## Editing several stacks

Tick stacks in **Virtual chassis** and press **Edit** in the bar to set the
**domain** and **description** and to add or remove **tags** on all of them.
Only the fields you change are applied. Name and master are per stack and stay
on each stack's own edit form. The bulk edit is
`POST /api/virtual-chassis/bulk-update/` with `{"ids": [...], "fields":
{"domain", "description", "add_tag_ids", "remove_tag_ids"}}` and needs the
*change* permission.

## Tags & custom fields

Need to track something extra - a stack firmware train, a maintenance window?
Add a **custom field** for virtual chassis and it appears on every form. See
[Tags & custom fields](../features/tags-and-custom-fields.md).
