---
icon: lucide/cloud
---

# VMware Cloud Director sync

Danbyte imports a Cloud Director organization's inventory into the existing
cluster/VM model - agentless, over the Cloud Director REST API, one session
per sync pass. Enable the **Cloud Director sync** toggle and add a source
under **Integrations → Virtualization sources**; see
[External sync](external-sync.md) for the shared ground rules.

Cloud Director is a tenanted product, so one source is **one organization**.
An account belongs to an org (`sync@my-org`), and that is what scopes
everything it can see. Connect a second source for a second org.

## The connection

- **Host** - the Cloud Director portal FQDN or IP. Default API port `443`.
- **Auth** - a **username and password**, where the username carries the org.
  A read-only role is enough for inventory sync. Credentials are encrypted at
  rest and write-only.
- **API version** - leave it blank. See [API versions](#api-versions).
- **Address VRF** - the routing context guest addresses land in; see [where
  synced addresses land](external-sync.md#where-synced-addresses-land).
- **Test connection** reports the product, the API version the two sides
  agreed on, and the VM count. There is no node count: an org-scoped account
  cannot see the hypervisor hosts underneath.

## API versions

Unlike the other connectors, Cloud Director's API version is **negotiated
rather than configured**. The appliance publishes the versions it speaks;
Danbyte reads that list and uses the newest one this release has been tested
against.

| Situation | What happens |
| --- | --- |
| The appliance offers the tested version | It is used, and nothing is said. |
| The appliance is **newer** than Danbyte | The newest tested version is used and the source page says so. Syncing continues. |
| The appliance is **older** than the supported floor | The sync refuses by name, rather than failing on a payload it cannot read. |

This release is tested against **38.1** and supports **36.0** and later. The
source page shows which version the last pass actually spoke, next to the
tested one, so "what did it agree on?" is answerable without running a probe.

Pin a version in **API version** only to work around a specific appliance's
behaviour. A pinned version skips negotiation entirely, which also means an
appliance that stops offering it will start failing rather than quietly
falling back.

## What syncs in

| Cloud Director object | Danbyte object |
| --- | --- |
| Organization | **Cluster group** (created on demand) |
| Org VDC | **Cluster** (a *VMware Cloud Director* cluster type is created on demand) |
| vApp | **VM group** on that cluster - *opt-in, on by default* |
| Virtual machine | **Virtual machine** (vCPUs, memory, disk) |
| VM description | **Description** (blank-filled, never overwrites yours) |
| Network connection | **VM interface** (`nic0`, `nic1`…) with its MAC |
| Org VDC network | **Virtual switch** + network - *opt-in* |
| Reported address | **IP address** assigned to the interface |
| External address | **NAT rule** - *opt-in, off by default* |

Guest identity comes from the VM's **URN** in its API link (`vm-<uuid>`),
which survives both a rename and a move between vApps. The query record's
own `id` field is empty on a real appliance, so it is not used.

A VM that is not in a VDC Danbyte can name falls back to its vApp, and then
to the source's own name - a virtual machine has to belong to a cluster.

## vApps and VM groups

Cloud Director has no flat VM list: every machine lives in a vApp. **Sync
vApps as VM groups** (on by default) mirrors that, so a cluster page's **VM
groups** tab reads the way the Cloud Director console does, and each VM's
Overview names the vApp it is in.

The hypervisor owns membership only until you say otherwise. A VM you move
into a group of your own keeps your grouping; the sync fills a blank one and
follows the hypervisor for machines it created itself, in Automatic mode.

Groups are their own object with their own permissions, and deleting one
leaves its VMs alone.

## External addresses and NAT (opt-in)

A Cloud Director VM can report an **external address** alongside its internal
one - the public side of a translation on the Org VDC edge gateway. With
**Record external addresses as NAT rules** on, each translated interface
becomes a static [NAT rule](ipam-objects.md#nat-rules): outside address,
inside address, and the VM's name.

Two deliberate limits:

- **No device.** The translation happens on the edge gateway, which an
  org-scoped account cannot see. Inventing a Device for it would write into
  your physical inventory, so the rule's device is left blank.
- **Both addresses must be placeable.** A NAT rule needs real IPAM rows at
  both ends, and an address is only recorded when a prefix already contains
  it - sync never invents address space. Model a prefix for your public range
  first, or the rule is skipped and reported.

The switch is **off by default**: a NAT rule is operator-facing policy, and an
estate that documents its edge by hand does not want rows appearing in it.
Turning the switch off later leaves the rules already written in place; the
sync only prunes a rule it created while the switch is on.

## vApp templates

Templates are skipped. A template is a golden image rather than a running
machine, and an estate with a library of them would double its VM count for
no benefit. **Import vApp templates** brings them in if you want them.

## Sync mode - who is the source of truth

- **Automatic (mirror)** - the sync applies everything on a schedule: new VMs
  created, specs updated, vanished guests removed. **Cloud Director is the
  source of truth.**
- **Review** (default) - polls on a schedule but only **detects**; changes
  land in a review inbox and apply on **Accept**. **Danbyte stays the source
  of truth.**
- **Manual** - like Review, but detection runs only when you press **Sync**.

**Skip powered-off VMs** leaves stopped guests' detail unread, but they still
count as *present* - a VM that is merely switched off is never pruned for
being off. That is a narrower rule than a script that drops powered-off
machines from its output entirely, and it is the safe one: a machine missing
from a list is indistinguishable from a machine that was deleted.

## What each side owns

- **Cloud Director owns** a VM's existence, its vApp, its power state, and -
  in Automatic mode - its specs (vCPU/RAM/disk).
- **You own** everything else: role, platform, tags, custom fields,
  description, site, the primary-IP choice, and any grouping you set by hand.

Rules:

- VMs, interfaces and IPs you already have are linked and blank-filled, never
  overwritten - and never deleted by sync. Only sync-created objects are
  removed (Automatic) or offered as removals (Review/Manual).
- An IP is only created when a **containing prefix** already exists. An estate
  with no prefixes modelled will sync its VMs with no addresses and a list of
  skipped notes on the Last sync badge; model the prefixes first.
- Cloud Director states **no VLAN** on a network connection - the tag lives on
  the backing network pool, which an org account cannot read - so a synced
  network's VLAN stays yours to set.
- Cloud Director states **no MTU** for a VM NIC either, so an MTU you set is
  left alone rather than raised as drift.
- **VM names must be unique per tenant in Danbyte, but only per vApp in Cloud
  Director.** Two machines called `web01` in different vApps cannot both be
  imported; the second is skipped and named on the Last sync badge. Rename one
  of them.
- The sync is read-only - Danbyte never changes the hypervisor.

## Large estates

Every VM costs one detail request, because the addressing only arrives that
way. That is fine for hundreds of machines and slow for thousands; if a sync
runs long, raise the poll interval rather than the timeout.

## See also

- [VMware vCenter sync](virt-vcenter.md) · [Proxmox VE sync](virt-proxmox.md) -
  the sibling connectors.
- [External sync](external-sync.md) - toggles, allowlist, where things live.
- [Virtual machines](virtual-machines.md) · [Clusters](clusters.md) ·
  [Virtual switches](virtual-switches.md) - the objects a sync fills in.
- [NAT rules](ipam-objects.md#nat-rules) - what the optional external-address rules become.
