---
icon: lucide/lock
---

# VPN tunnels

VPN tunnels are where you record the **encrypted links between sites or peers** —
the tunnel itself, the groups that organize tunnels, and reusable crypto
profiles you can share across many tunnels.

You build it in three layers: **tunnel groups** (how you organize tunnels),
**IPSec profiles** (reusable crypto settings), and the **tunnels** themselves.

## Add a tunnel group

A group bundles related tunnels together — for example by region, customer, or
purpose.

1. Open **VPN → Tunnel groups** in the sidebar and click **Add group**.
2. Give it a **name** and a **slug** (a short URL-friendly identifier).
3. Optionally add a **description**.
4. Save.

## Add an IPSec profile

An IPSec profile captures a set of crypto settings once so you can reuse it on
every tunnel that shares that policy — no retyping the same parameters.

1. Open **VPN → IPSec profiles** and click **Add IPSec profile**.
2. Give it a **name**.
3. Fill in the crypto parameters:

| Field | What it records |
|---|---|
| **IKE version** | 1 or 2. |
| **Encryption** | the encryption algorithm. |
| **Authentication** | the authentication/hashing algorithm. |
| **DH group** | the Diffie-Hellman group for key exchange. |
| **PFS group** | the Perfect Forward Secrecy group (optional). |
| **SA lifetime** | how long a security association stays valid. |

4. Save.

!!! note "Nothing is pre-filled"
    Danbyte ships no sample groups, profiles, or tunnels — you create exactly the
    ones your network uses.

## Add a tunnel

1. Open **VPN → Tunnels** and click **Add tunnel**.
2. Give it a **name** (must be unique).
3. Pick the **encapsulation** — IPSec (tunnel or transport), GRE, IP-in-IP, or
   WireGuard.
4. Set a **status** and, optionally, a **tunnel ID**.
5. Optionally put it in a **group**. For IPSec encapsulations, you can also pick
   an **IPSec profile** — that field only appears when the encapsulation is
   IPSec.
6. Save.

## Terminate a tunnel

A tunnel is inert until its ends are bound. Each **termination** attaches one
end of the tunnel to a **device interface** or a **VM interface** (exactly
one), with:

- a **role** — *peer* (point-to-point), or *hub* / *spoke* for hub-and-spoke
  topologies;
- an optional **outside IP** — the underlay / public address the tunnel rides
  on. The tunnel's *inside* addresses attach to the terminating interface the
  normal way.

1. Open the tunnel's detail page → **Terminations** tab.
2. **Add termination**, pick the device (or VM) and its interface, set the
   role, and optionally the outside IP.

A point-to-point tunnel has two *peer* terminations; a hub-and-spoke design has
one *hub* and many *spokes*.

## Tunnel map

The tunnel's detail page has a **Map** tab — a read-only topology view of the
tunnel drawn from its terminations:

- **Hub-and-spoke** tunnels put the hub(s) in the centre with every spoke on a
  ring around them, one link per hub ↔ spoke.
- **Point-to-point / peer** tunnels show the peers side by side (three or more
  form a ring, fully meshed).

Each card shows the terminating device (or VM), the interface, the **outside
IP**, and the end's role; clicking a card jumps to that interface (or VM).
The map fills in as you add terminations — an empty tunnel just points you to
the Terminations tab.

## Where tunnels show up on interfaces

An interface that terminates a tunnel is flagged everywhere interfaces are
listed:

- **Interface tables** (the interfaces list, a device's Interfaces tab, the
  whole-stack view) show a small tunnel chip next to the interface name,
  linking to the tunnel.
- The **interface detail** page shows the same chip in its header and lists
  each tunnel with the end's role under **Relationships → Tunnels**.

Behind this, the interface API (`/api/interfaces/`) exposes a read-only
`tunnel_terminations` field — `[{id, role, role_display, tunnel: {id, name}}]`,
scoped to the interface's tenant.

### Tunnel status

| Status | Meaning |
|---|---|
| **Planned** | Designed but not yet built. |
| **Active** | Up and carrying traffic. |
| **Disabled** | Configured but turned off. |

!!! warning "Groups and profiles in use can't be deleted"
    If a group or IPSec profile still has tunnels attached, Danbyte blocks the
    delete. Reassign or remove those tunnels first.

## L2VPN overlays

Alongside point-to-point tunnels, Danbyte models **L2VPNs** — layer-2 overlay
services such as EVPN, VXLAN, VPWS, and VPLS. An L2VPN records the overlay
itself; **terminations** attach it to the VLANs and interfaces that carry it.

### Add an L2VPN

1. Open **VPN → L2VPNs** and click **Add L2VPN**.
2. Fill in the form:

| Field | What it records |
|---|---|
| **Name** and **slug** | A label and a URL-friendly identifier (slug unique per tenant). |
| **Type** | The overlay technology — VXLAN, VXLAN-EVPN, MPLS-EVPN, PBB-EVPN, VPWS, VPLS, EPL, EVPL, SPB, or TRILL. |
| **Identifier** | The overlay identifier — a VNI or VC-ID (optional). |
| **Status** | Your own status catalog, same as elsewhere. |
| **Import / export route targets** | BGP route targets, picked from your existing [route targets](ipam-objects.md). |

3. Save.

### Terminate an L2VPN

Like a tunnel, an L2VPN is inert until it's attached to something. Each
termination binds it to **exactly one** endpoint — a **VLAN**, a **device
interface**, or a **VM interface** — from the L2VPN's detail page.

- An endpoint can terminate **at most one L2VPN** — Danbyte blocks a second.
- Point-to-point types (VPWS, EPL, EVPL) typically get two terminations;
  multipoint types (VPLS, the EVPN family) get as many as the overlay spans.

## Tags & custom fields

Need to track something extra — a peer IP, a pre-shared-key reference, a contract
ID? Add a **custom field** for tunnels (or L2VPNs) and it appears on every form.
See [Tags & custom fields](tags-and-custom-fields.md).
