---
icon: lucide/layers
---

# Virtual chassis (switch stacks)

A **virtual chassis** models a switch stack — several physical switches acting
as one logical chassis (Cisco StackWise, Juniper Virtual Chassis, Aruba VSF, and
friends). Each member stays an ordinary [device](devices.md) with its own
serial, rack position, and interfaces; the stack just ties them together and
records each member's position and master-election priority.

!!! note "Not a cluster"
    A **cluster** is the virtualization host group for VMs. A **virtual
    chassis** is physical switch stacking. Different objects, different pages.

## Create a stack

1. Open **DCIM → Virtual chassis** in the sidebar and click **Add**.
2. Fill in the form:

| Field | What it records |
|---|---|
| **Name** | A label for the stack (must be unique within the tenant). |
| **Domain** | The stack / VC domain identifier, where the platform has one. |
| **Master** | The member acting as stack master, if designated. Must be a member of this stack — Danbyte rejects anything else. |
| **Description / comments** | A short note, and long-form notes. |

3. Save.

## Add members

Membership lives on the **device**, and there are two doors in:

- **From the stack page** — the Members table's **Add member** button opens a
  device search; pick the switch, give it a position (pre-filled with the next
  free slot) and a priority. A device already in another stack moves over.
- **From the device** — open a member's edit form and fill in the
  **Stack membership** section:

| Field | What it records |
|---|---|
| **Virtual chassis** | The stack this device belongs to. |
| **Position** | The member id within the stack (0–255, unique per stack). |
| **Priority** | The master-election priority. |

Once a device is in, you can also edit its position/priority, promote it to
master, or remove it right from the stack's **Members** table.

## Position-aware interface names

Stacked switches name their ports by member number — member 2 of a Catalyst
stack owns `GigabitEthernet2/0/24`, not `1/0/24`. Danbyte handles this with a
**`{position}` token** in [component template](device-catalog.md) names:

```
GigabitEthernet{position}/0/[1-24]
```

- **`{position}`** resolves to the device's stack position when its components
  are stamped — member 1 gets `GigabitEthernet1/0/1`, member 2 gets
  `GigabitEthernet2/0/1`. A standalone device resolves it to `1`; vendors that
  count from zero (Juniper's `ge-0/0/0`) write `{position:0}` to set the
  standalone default. The token can sit anywhere in the name, so any vendor
  style works: `ge-{position}/0/[0-47]`, `{position}/1/[1-24]`, ….
- **`[1-24]`** is range shorthand in the template dialog — it creates one
  template per port in a single go, with a live preview of what you'll get.

**Names follow the device around.** When a device joins a stack, moves to a
different position, or leaves, Danbyte re-renders its `{position}` templates
and renames the matching interfaces — swap two members and both sets of ports
stay truthful. Renames never clobber: if a target name is already taken by
another interface, that port is skipped and everything else still renames.
The API reports the count (`vc_renamed_interfaces`) and the UI toasts it —
"added to stack — 28 interfaces renamed to match".

## The stack page

Open a stack to see two tabs:

- **Overview** — the stack's facts plus a **Members** table sorted by position:
  position, device, priority, role (a *Master* / *Member* badge), serial, and
  status.
- **Interfaces** — every member's ports combined into one view (the tab badge
  shows the total), each row prefixed with the member's position and name.
- The Overview draws the **stack itself** — one chassis bar per member in
  position order (gaps show as dashed empty slots), with the master crowned
  and each member's serial, priority, and status on the bar.

On a **member device's** page, the Interfaces tab gains a
**Whole stack / This member** toggle: the combined stack table (with the
member column, this device's rows tinted) or just the device's own ports.
The stack **master defaults to the whole-stack view** — open the master and
you see every port in the stack.

A member's own device page shows a **Stack** badge in the header
(`Stack: name · pos N · master`) linking back to the stack.

## Deleting a stack

Deleting a virtual chassis **releases its members** — their positions and
priorities are cleared and they carry on as standalone devices. The devices
themselves are never deleted with the stack.

## Tags & custom fields

Need to track something extra — a stack firmware train, a maintenance window?
Add a **custom field** for virtual chassis and it appears on every form. See
[Tags & custom fields](../features/tags-and-custom-fields.md).
