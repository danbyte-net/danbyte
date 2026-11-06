---
icon: lucide/workflow
---

# Interface

A network port on a [device](site.md) - physical (a switch port, a NIC) or
virtual (a sub-interface, LAG, loopback). Interfaces terminate
[cables](../dcim/cabling.md), carry [IP addresses](ip-address.md) and
[VLANs](vlan.md), and are what monitoring, discovery, and the topology views
reason about.

## Fields

### Device

The device this interface belongs to. An interface's name must be unique on
its device.

### Module

Read-only. The installed [module](../dcim/device-catalog.md#module-types)
that created this interface (`module_id`), or empty for the device's own
ports. Removing the module removes the interfaces it owns.

### Name

The port's name (`GigabitEthernet0/1`, `eth0`). On create, a `[a-b]` range in
the name fans out into one interface per number.

### Type

The media type (`1000base-t`, `10gbase-x-sfpp`, …) from the standard
taxonomy. Drives the faceplate rendering and the speed-capability colouring.
The virtual types - `virtual`, `bridge`, `lag` and `vxlan` (a VXLAN netdev a
[VTEP membership](../features/routing.md#overlay-evpn-and-vxlan) can point
at) - have no physical port and always save as virtual.

### Enabled

Administratively up. Disabled interfaces render dashed on faceplates.

### Description

Free-text note shown on rows and the detail page.

### Tags

Tenant-scoped [tags](tag.md).

## Switching & routing

### 802.1Q mode

How the port handles VLAN tagging: **Access** (one untagged VLAN),
**Tagged** (a native VLAN plus tagged VLANs), or **Tagged (all)** (carries
every VLAN). Blank for routed ports.

### Untagged VLAN

The access / native [VLAN](vlan.md).

### Tagged VLANs

The VLANs carried tagged on a trunk. Only valid in *Tagged* mode.

### VRF

The [VRF](vrf.md) this interface routes in. Empty = the Global table.

## State

### Status

Lifecycle status from the tenant's [status catalog](../features/catalogs-and-settings.md),
distinct from **Enabled** (the admin flag the device reports). Seeded values:
Active, Disabled, Planned, Not present, Decommissioning. Empty reads as
Active. **Not present** marks hardware the agent reports as absent - a
pre-allocated stack port or an empty slot; SNMP sync sets it automatically
when the *Import pre-allocated ports* setting is on. Not present and
Decommissioning ports are excluded from port-utilization capacity entirely.

### Management only

Out-of-band management port; excluded from data-plane views. Still counted
in port utilization: it is a real port.

### Mark connected

A cable is physically in the port but not documented yet. Counts as
connected in [port utilization](../dcim/devices.md#the-device-page) and
clears itself when a real cable is attached.

### Reservation

A [port reservation](port-reservation.md) holding this (uncabled) port -
who claimed it, the note, and since when. Read-only here; managed through
the reserve actions or `/api/port-reservations/`.

### Link peer

What the port's cable reaches, read-only: `link_peer` is
`{"device", "port", "port_label"}` for the far end, or `null` on an
uncabled port. A far end on a device you may not view is not named: it reads
`{"device": "", "port": "", "port_label": "", "hidden": true}`, in the API,
the faceplate and rack port labels, export templates and the device report.

### Uplink

**Automatic**, **Always** or **Never** - two fields on the API:

- `is_uplink` (Always) - faces other network gear: discovery never suggests
  hosts on this port, a learned MAC is located on it only as *behind uplink*
  when no access port reports it, and topology treats it as an infrastructure
  link.
- `never_uplink` (Never) - never an uplink, whatever the automatic
  [uplink rules](../features/snmp-discovery.md#uplinks) say (an LLDP switch
  neighbour, a LAG, more learned MACs than *Uplink above*).

Both off is Automatic. Both on is refused (400).

## Hardware

### Speed

Free-text speed label (`10G`); the type's capability is used when unset. A
bare integer is taken as **kbps** and normalised on save (`1000000` → `1G`).

### MTU

Maximum transmissible unit.

### MAC address

The primary MAC. Additional MACs live as first-class MAC address objects
linked to the interface.

### Duplex

Half / full / auto.

### PoE mode / PoE type

Whether the port supplies or draws power, and the PoE standard.

### WWN

Fibre Channel World Wide Name.

### Combo group

Combo / shared port: alternate connectors of one logical port (an RJ45 and
its SFP twin) share a group name; enabling one disables the others on the
device.

## Nesting

### Virtual interface

Marks a sub-interface, LAG, or loopback - no physical attributes, cannot be
cabled. Always set for types `virtual`, `bridge` and `lag`: `save()`, bulk
edit and the device-type and module installs set it, and SNMP discovery
creates loopbacks, SVIs, tunnels and VLAN interfaces as type `virtual`.
[Port utilization](../dcim/devices.md#what-counts-as-a-port) counts an interface
as virtual when this is set or its type is one of those three, and leaves
virtual interfaces out of the total unless the deployment's
`port_count_virtual` setting is on.

!!! note "Changed in 0.17"
    Only type `lag` set the flag before 0.17. Migrations `api.0193` and
    `monitoring.0107` set it on existing rows: every `virtual`, `bridge` and
    `lag` interface, and every blank-type interface whose name matches a port
    its device's last SNMP poll reported as loopback, virtual, tunnel, l3vlan,
    l2vlan or LAG.

### Parent interface

The interface a sub-interface nests under.

### LAG / aggregate

The aggregate interface this port is a member of. The target must be an
interface of **type LAG** on the same device or virtual chassis; an aggregate
can't itself be a member. Changing an aggregate's type away from LAG is
refused while it has members.

## Bundle

Set on the aggregate (type LAG) only - "Only an interface of type LAG has
bundle settings." Picking type LAG marks the interface virtual.

### Protocol

`lag_protocol`: blank = static aggregate (no negotiation), `lacp` (802.3ad),
`pagp`. The port-channel / ae / bond is the logical link; this is the protocol
negotiating it. The form labels blank **None (static)**; the API also accepts
`"static"` as input and stores it blank, so there is one spelling to filter
and template on.

### Mode / Hash policy / MII monitor

The Linux bond settings, for an `/etc/network/interfaces` or systemd-networkd
render:

- `lag_mode`: `balance-rr`, `active-backup`, `balance-xor`, `broadcast`,
  `802.3ad`, `balance-tlb`, `balance-alb` (`bond-mode`). `802.3ad` sets the
  protocol to LACP; LACP with any other mode is refused.
- `lag_hash_policy`: `layer2`, `layer2+3`, `layer3+4`, `encap2+3`,
  `encap3+4`, `vlan+srcmac` (`bond-xmit-hash-policy`).
- `lag_miimon`: the link-monitor interval in ms (`bond-miimon`).

All three are blank by default and cleared on save when the type is not LAG.
Nothing guesses a mode for an existing static bundle. A template reads them
off the interface row, with the members from `lag_members`:

```jinja
{% for i in interfaces if i.type == "lag" %}
auto {{ i.name }}
iface {{ i.name }} inet manual
    bond-slaves {{ i.lag_members.all()|map(attribute="name")|join(" ") }}
{% if i.lag_mode %}    bond-mode {{ i.lag_mode }}
{% endif %}{% if i.lag_hash_policy %}    bond-xmit-hash-policy {{ i.lag_hash_policy }}
{% endif %}{% if i.lag_miimon %}    bond-miimon {{ i.lag_miimon }}
{% endif %}{% endfor %}
```

### LACP mode / LACP rate

`lacp_mode` (`active` / `passive`) and `lacp_rate` (`slow` 30 s / `fast` 1 s).
Only kept under LACP - any other protocol clears them on save.

### Min links

`lag_min_links`: members that must be up for the bundle to count as up
(at least 1). The detail page flags the bundle when it has fewer members.

### Bridge

The bridge interface this one belongs to.

## MACsec

IEEE 802.1AE link encryption on the port, with the keys agreed by MKA
(802.1X-2010). Danbyte documents the intent; it does not render or push
device config, so a template of your own turns these fields into one (see the
example below).

The edit form has a **MACsec** section, the Overview a **MACsec** card, and
the device's Interfaces tab bulk edit and CSV import / export carry all four
fields. Interface templates do not: set MACsec on the interfaces themselves.

### MACsec enabled

`macsec_enabled`, off by default. The other three fields only mean something
while it is on.

### Cipher

`macsec_cipher`: `gcm-aes-128`, `gcm-aes-256`, `gcm-aes-xpn-128`,
`gcm-aes-xpn-256`, or blank for the device's default. The values are the
`iproute2` spellings. The XPN suites use 64-bit packet numbers, for links
fast enough to wrap a 32-bit counter during one key's lifetime.

### Keychain

`macsec_keychain` (write `macsec_keychain_id`): a
[routing keychain](routing.md) whose secret holds the MKA CAK. It is the same
contract as the BGP, OSPF and IS-IS keychain references: the interface API
returns the keychain's id, name and algorithm, never the key. The key is read
only through the audited `POST /api/routing/keychains/<id>/reveal-psk/`. A
keychain must belong to the interface's tenant; one from another tenant is a
400. Deleting the keychain clears the reference.

### Replay window

`macsec_replay_window`: replay protection's window in packets. Blank leaves
replay protection to the device's default; `0` means strict ordering.

### Validation

Turning MACsec off clears the cipher, keychain and replay window on save, so
a disabled port never carries stale settings. Setting any of the three on a
port that has MACsec off, in the same request or already, is refused with a
400 on that field: turn MACsec on in the same write. A bulk edit follows the
same rules: one that turns MACsec off clears the three, and one that sets
them without turning MACsec on is refused when a selected port has it off.

### Example: both ends of a cable

Both ends of a MACsec link need the same cipher and the same CAK / CKN. The
template below takes two interface rows from the API: `a`
(`GET /api/interfaces/<id>/`) and `b`, its far end (the interface named by
`a.link_peer.port` on the device `a.link_peer.device`), and prints a Linux
`ip link` line and a `wpa_supplicant` MKA block for each. The CAK is a
`<keychain:NAME>` placeholder, the same shape the
[routing templates](../features/routing-templates.md) print: the tool that
pushes the config replaces it with the revealed key. The CKN is not secret;
this example keeps it in a custom field `mka_ckn` on the keychain, passed
in as `ckn`.

```jinja
{% if a.macsec_keychain and b.macsec_keychain
      and a.macsec_keychain.id != b.macsec_keychain.id %}
# WARNING: {{ a.name }} and {{ b.name }} use different keychains
{% endif %}
{% for i in [a, b] if i.macsec_enabled %}
# {{ i.device.name }}: {{ i.name }}
ip link add link {{ i.name }} macsec0 type macsec encrypt on
{%- if i.macsec_cipher %} cipher {{ i.macsec_cipher }}{% endif %}
{%- if i.macsec_replay_window is not none %} replay on window {{ i.macsec_replay_window }}{% endif %}

# /etc/wpa_supplicant/macsec-{{ i.name }}.conf
eapol_version=3
ap_scan=0
network={
    key_mgmt=NONE
    eapol_flags=0
    macsec_policy=1
{%- if i.macsec_cipher in ("gcm-aes-256", "gcm-aes-xpn-256") %}
    macsec_csindex=1
{%- endif %}
{%- if i.macsec_replay_window is not none %}
    macsec_replay_protect=1
    macsec_replay_window={{ i.macsec_replay_window }}
{%- endif %}
    mka_cak=<keychain:{{ i.macsec_keychain.name }}>
    mka_ckn={{ ckn }}
}
{% endfor %}
```

With MKA, `wpa_supplicant -D macsec_linux -i <if>` creates and keys the
MACsec device itself; the `ip link` line is the static-key alternative, or a
check that the kernel accepts the cipher. Network operating systems take the
same three values: a cipher suite, a replay window and a key chain holding the
CKN and CAK.

## Discovery

### SNMP name

What the polled agent calls this port; links the row to
[SNMP discovery](../features/snmp-discovery.md). Clearing it unlinks.

### Exclude from SNMP drift

The agent can never report this port - it is skipped by drift comparison.

## Read-only

`cable` (the terminating cable and its status), `ip_addresses`,
`tunnel_terminations` (VPN ends on this port), `child_count`,
`lag_member_count`, `lag_protocol_display`. A member's `lag` relation carries
the aggregate's `lag_protocol` and `lacp_mode`.

`ip_addresses` lists only the addresses the caller may view: IP view
permission in the active tenant, with its site scope and row constraints. A
viewer limited to Site A sees the Site A address on a port, not the Site B
address bound to the same port, and the port shows as L2 when none are
visible. The device's Interfaces tab and `GET /api/interfaces/<id>/ips/`
follow the same rule.

`GET /api/interfaces/<id>/lag/` returns an aggregate's members as full rows
plus `capacity` (sum of parseable member speeds), `unparsed_speeds`,
`min_links` / `degraded`, `peers` (the far-end aggregates its members' direct
cables land on, with a member count each), `unpaired` (members whose far end
is uncabled, on a panel, or in no bundle) and `mixed_peers` (more than one
peer - an MLAG / vPC pair). The list accepts `?type=lag` and `?lag=<id>`.
