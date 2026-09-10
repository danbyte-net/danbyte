---
icon: lucide/layers-3
---

# VMware vCenter sync

Danbyte imports a vCenter's inventory into the existing cluster/VM model -
agentless, over the vSphere Automation REST API (`/api/`), one login session
per sync pass. Enable the **vCenter sync** toggle and add a source
under **Integrations → Virtualization sources**; see
[External sync](external-sync.md) for the shared ground rules.

## The connection

- **Host** - the vCenter Server FQDN or IP. Default API port `443`.
- **Auth** - an **SSO username and password** (a read-only role is enough for
  inventory sync). Credentials are encrypted at rest and write-only.
- **Address VRF** - the routing context guest addresses land in; see [where
  synced addresses land](external-sync.md#where-synced-addresses-land).
- **Test connection** reports the reachable host and VM counts. vSphere's REST
  list endpoints carry no version string, so no version is shown.

## What syncs in

| vCenter object | Danbyte object |
| --- | --- |
| Cluster (single-cluster vCenters; else the source name) | **Cluster** (a *VMware vCenter* cluster type is created on demand) |
| Virtual machine | **Virtual machine** (vCPUs, memory, disk, description) |
| VM annotation | **Description** (blank-filled, never overwrites yours) |
| Ethernet adapter | **VM interface** with its MAC |
| Virtual disk device | **Virtual disk** (name, size, datastore, controller) - *opt-in* |
| Port-group VLAN | **VLAN** (in the source's VLAN group) + the interface's access VLAN - *opt-in* |
| Standard / distributed switch | **Virtual switch** - *opt-in* |
| VMware Tools reported IP | **IP address** assigned to the interface |
| ESXi host | linked to the **Device** of the same name |

Guest identity uses the VM **MoRef**, whose numeric part is the stable id.


### Allowed networks - keeping container noise out

A guest running containers (Docker, Podman) reports every bridge and overlay
address it owns - easily 50-100 per host - and each one either lands in IPAM
or raises an unmatched-prefix warning. Two guards:

- **Allowed networks** on the source: a CIDR list (one per line). When set,
  guest-reported IPs are only recorded when they fall inside one of the
  networks; everything else is dropped **silently** - no warnings, no sync
  errors. Empty = record everything a prefix matches, as before.
- **Ignore IPs from sync** on a VM interface: the per-NIC hammer for when the
  noisy addresses share a subnet with real ones - sync records nothing from
  that NIC, whatever the allow-list says.

## Disks, switches, networks and hosts (opt-in)

Per-source switches widen what a source imports:

- **Sync disks** (on by default) - each VM's virtual disks become **Virtual
  disk** rows (shown on the VM's Overview): name, size, datastore, and
  controller. Optical drives are skipped.
- **Sync virtual switches & networks** (off by default) - standard and
  distributed switches become **Virtual switch** rows, and each VLAN-tagged
  port-group becomes a **VLAN** in a VLAN group named after the source. A VM
  interface's access VLAN is **blank-filled** from the port-group tag (never
  overwriting a VLAN you set).
- **Set platform from the guest OS** (off by default) - fills each VM's
  **platform** from what the hypervisor reports, creating the platform on
  demand. vCenter's own label is used when VMware Tools supplies one
  (*Red Hat Enterprise Linux 8 (64-bit)*); otherwise the raw enum is unpacked
  into something readable (`RHEL_8_64` becomes *RHEL 8 (64-bit)*). Rename it
  afterwards if you prefer - matching is by slug as well as name, so the next
  sync still finds your row instead of making a second one. Blank-fill only.
- **Read host hardware** (off by default, needs *Create hosts as devices*) -
  fills each host Device's **model**, **vendor** and **serial** from vSphere,
  and its platform (e.g. *VMware ESXi 8.0.3*). The model becomes a **device
  type** under a **manufacturer**, both created on demand, which is why it is a
  separate switch: wanting host placeholders is not the same as wanting rows
  minted in a catalog you curate. All of it is blank-fill - anything you have
  already set is left alone, and a host that reports no serial (nested ESXi,
  for instance) simply keeps an empty one.

    This is the one thing that needs the **vSphere SOAP** API: the REST API
    returns four fields per host and has no host-detail endpoint at all, so
    `pyvmomi` is used for it. It is loaded only when this switch is on, and a
    failure there is reported without failing the rest of the sync.
- **Create hosts as devices** (off by default) - each ESXi host becomes
  a **Device**: name, cluster and status, with a *Hypervisor* role created on
  demand. Device type and site are left empty - nothing on the wire says what
  they are. A host you already model is matched **case-insensitively** and
  adopted, never duplicated. This is what lets VMs link to their host, and
  what gives bridge uplinks a Device to hang NICs off.

### What the sync is allowed to overwrite, and what it removes

Three more switches decide how far the sync reaches into what you already
have:

- **Sync interface MTU** (on by default) - copies the hypervisor's MTU onto a
  VM interface that has none, and reports a differing one as drift. Turn it
  off to make Danbyte the source of truth for MTU: the value is then not read
  at all, so it neither fills a blank nor shows up as a disagreement you can
  never clear.

    vCenter's VM-NIC payload carries no MTU, so on a vCenter source this
    switch has nothing to act on today. It bites on Proxmox, which states it
    per NIC.
- **Skip powered-off VMs** (off by default) - stopped guests are listed but
  their detail is not read, so nothing about them is updated. They still
  count as **present**: a VM that is merely switched off is never treated as
  missing, and so is never pruned for being off.
- **Remove VMs deleted from the hypervisor** (on) with **Remove after** (days)
  - a VM that stops appearing is marked *missing* and kept until it has been
  missing that long. One API error, one network blip, one paused vCenter is
  then not enough to delete a VM record and everything hanging off it. The
  moment the VM reappears the clock resets - it does not resume a part-spent
  delay.

    **0 days** removes it on the first sync that cannot see it, which is what
    Danbyte did before this setting existed. **Sources that already existed
    when you upgraded are set to 0**, so nothing changed under you; new
    sources start at **7 days**. In review mode the *proposal* waits the same
    delay, because approving a deletion a flaky poll invented loses the same
    data.

    Turning the switch off keeps missing VMs indefinitely, flagged, for you to
    delete by hand.

Once networks are synced, each **virtual switch** page has a **Networks** tab
and **Virtualization → Network topology** draws the whole picture - switches,
their networks (VLANs) as bars, and the VMs on each.

### Host pNICs and uplinks - filled automatically

With **Create hosts as devices** on, the sync reads each ESXi host's
physical NICs over the vSphere SOAP API (the same retrieval the hardware
enrichment uses - no extra round trip) and creates them as **Interfaces**
(`vmnic0`…) on the host Device, with MAC and link speed blank-filled. Each
virtual switch's **Uplinks · physical adapters** then link themselves:
standard vSwitches from their bridge spec, distributed switches from the
host's proxy-switch backing. This is the vCenter "Physical Adapters" layer -
the uplink traces straight through to its cabled port, and the topology
shows the adapters feeding each switch. Linking is **additive** and
blank-fill only: uplinks or NIC values you set are never removed or
overwritten.

## Sync mode - who is the source of truth

- **Automatic (mirror)** - the sync applies everything on a schedule: new VMs
  created, specs updated, vanished guests removed. **vCenter is the source of
  truth.**
- **Review** (default) - polls on a schedule but only **detects**; changes
  land in a review inbox and apply on **Accept**. **Danbyte stays the source
  of truth.**
- **Manual** - like Review, but detection runs only when you press **Sync**.

A new source defaults to **Review**, so a fresh connection never reshapes
your inventory before you've seen what it would do.

## What each side owns

- **vCenter owns** a VM's existence, its host, power state, and - in
  Automatic mode - its specs (vCPU/RAM/disk).
- **You own** everything else: role, platform, tags, custom fields,
  description, site, and the primary-IP choice. The sync never overwrites
  those in any mode.

Rules:

- VMs, interfaces and IPs you already have are linked and blank-filled, never
  overwritten - and never deleted by sync. Only sync-created objects are
  removed (Automatic) or offered as removals (Review/Manual) when their guest
  disappears.
- Guest IPs come from **VMware Tools**, so they only appear for running VMs
  with Tools present. An IP is only created when a **containing prefix**
  already exists - sync never invents address space. Which VRF's prefixes count
  is the source's **Address VRF**; addresses it can't place are reported as
  *unplaced* and listed on the Last sync badge. See [where synced addresses
  land](external-sync.md#where-synced-addresses-land). The first private IPv4
  becomes the VM's primary IP (if it had none).
- VM templates are skipped; the sync is read-only - Danbyte never changes the
  hypervisor.

### Interface drift

An interface that exists on both sides but whose **MAC, MTU or VLAN disagrees**
is raised as a change on the source's review list, alongside the existing
*not on the hypervisor* flag. The VM's **Components** tab shows an amber
**drift** badge on the interface, listing each field as `yours → theirs`.

Accepting takes the hypervisor's values; leaving it alone keeps yours, and the
flag clears by itself once the two agree again. In Automatic mode a
**sync-created** interface is corrected silently - the same rule that lets
Automatic mode mirror a sync-created VM's specs - while an interface you made
is always raised rather than rewritten.

Three things are deliberately not drift:

- **A field the hypervisor doesn't report.** vCenter states no MTU for a VM
  NIC, so an MTU you set is left alone. Silence is not a contradiction, and
  treating it as one would flag every interface you own.
- **A field that is empty in Danbyte.** That is blank-filled, as always -
  asking you to approve filling in a blank would make the review list useless.
- **A MAC written differently.** `AA-BB-CC` and `aa:bb:cc` are one address.

## See also

- [Proxmox VE sync](virt-proxmox.md) - the sibling connector.
- [External sync](external-sync.md) - toggles, allowlist, where things live.
- [Virtual machines](virtual-machines.md) · [Clusters](clusters.md) · [Virtual switches](virtual-switches.md) - the objects a sync fills in.
