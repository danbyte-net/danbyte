---
icon: lucide/file-code
---

# Export templates

Export templates let you turn every object of a given type into a text file of
your own design - a CSV extract, a device config, a DNS zone file, a report,
anything you can write as a template.

You write the template once using **Jinja2** (a widely used templating language),
and Danbyte renders it against your live data on demand. Templates live under
**Customize → Export templates** in the sidebar.

## Create a template

1. Go to **Customize → Export templates** and click **Add export template**.
2. Fill in the form:

   | Field | What it does |
   |---|---|
   | **Name** | A label for the template. |
   | **Object type** | Which objects feed the template (prefixes, devices, IPs, …). |
   | **Description** | Optional note. |
   | **Template** | The Jinja2 source, edited in a monospace editor. |
   | **MIME type** | The content type of the output (defaults to `text/plain`). |
   | **File extension** | The extension for the downloaded file (defaults to `txt`). |
   | **Download as attachment** | Whether **Render & download** should save a file rather than show it inline. |

3. Save. Danbyte checks the template compiles and that the object type is valid,
   so mistakes surface immediately rather than when you run it.

The template body is stored exactly as sent - leading indentation, trailing
spaces and the final newline included - so a client that writes a template
over the API reads the same bytes back. Names are still trimmed. Label
template HTML, CSS and QR content, and script source, are kept the same way.

## What you can use in a template

When the template runs, it has access to the objects of its type within your
tenant:

| Variable | What it holds |
|---|---|
| `objects` | The list of objects to render. (`queryset` is an alias for the same list.) |
| `count` | How many objects there are. |

A small example that lists device names and serials:

```jinja
{% for d in objects %}
{{ d.name }},{{ d.serial }}
{% endfor %}
Total: {{ count }}
```

!!! note "Templates run in a sandbox"
    Templates are rendered in a restricted environment - they can read your object
    data and use normal Jinja2 features, but they can't reach into Python
    internals or run arbitrary code. This keeps a shared template library safe.

### Rendering one device

A template bound as a device's [config template](#config-template-bindings)
renders per device (**Config → Render config**, `GET /api/devices/<id>/render/`)
with a richer context:

| Variable | What it holds |
|---|---|
| `device` | The device itself - `device.name`, `device.site`, `device.platform`, `device.custom_fields`, … |
| `config_context` | The merged [config context](config-contexts.md) for the device. |
| `interfaces` | The device's interfaces; each carries `vlan`, `tagged_vlans`, `vrf`, `mtu`, `enabled`, … and `link_peer` - the cable's far end as `{device, interface, description, mac_address, mtu, custom_fields}` (the far port's own MAC and MTU), or `None` on an uncabled port. A far end on a device the reader may not view names nothing: every field is empty and `hidden` is true. Read-only: it is a plain dict, so `i.link_peer.custom_fields.frr_name` works and nothing behind the peer row is reachable. |
| `ip_addresses` | Every address assigned to the device; `assigned_interface_id` says where. |
| `routing` | What the device routes with - VRFs, static routes, policy rules, BGP / OSPF / IS-IS, the VTEP and its VNIs, the policies and lists they reference, keychains. See [Routing](routing.md#rendering-a-config). |
| `tunnels` | Every tunnel end on the device, with its far end(s) resolved. See [Tunnels](#tunnels). |
| `tunnels_by_interface` | The same rows keyed by the local port name (`tunnels_by_interface["wg0"]`). |
| `backing_vm` | When the device runs as an [intended VM](virtual-machines.md#intended-vms) you may view (**Is router**), that VM's build: `name`, `vmid`, `cluster`, `node`, `cpu_type`, `sockets`, `vcpus`, `memory_mb`, `disk_gb`, `image`, `storage`, `hypervisor_options`, `interfaces` (each with `index`, `model`, `bridge`, `mac_address`, `mtu`, `vlan`, …) and `disks`. A plain dict, the same shape a [provision](iac-runner.md#provisioning-an-intended-vm) sends. `None` otherwise. |

#### Tunnels

```
tunnels: [{id, name, encapsulation, tunnel_id, role, interface: "wg0",
           outside_ip: "198.51.100.4",
           wireguard: {listen_port, public_key, private_key_ref, allowed_ips,
                       endpoint_port, persistent_keepalive} | null,
           peers: [{id, device, interface, role, outside_ip, endpoint_port,
                    endpoint: "203.0.113.9:51820", public_key, allowed_ips,
                    persistent_keepalive}]}]
tunnels_by_interface: {"wg0": <the same row>}
```

`tunnel_id` is the tunnel's number, not a row id. `wireguard` is `null` on a
tunnel of another encapsulation. `peers` follows the end's role (a peer
talks to every other end, a hub to the spokes and other hubs, a spoke to the
hubs), and each peer's `endpoint_port` is already resolved: the far end's
endpoint port, else its listen port. `allowed_ips` on a peer is the
addresses behind that peer - see [WireGuard](vpn.md#wireguard). A peer's
device name is shown even when it sits at another site, as a BGP session's
`peer_device` is.

An `/etc/network/interfaces` block for a WireGuard end - the same template
renders both ends, each printing the other's key:

```jinja
{% set t = tunnels_by_interface["wg0"] %}
auto wg0
iface wg0 inet static
    pre-up ip link add wg0 type wireguard
    pre-up wg set wg0 private-key {{ t.wireguard.private_key_ref }} listen-port {{ t.wireguard.listen_port }}
{% for p in t.peers %}
    pre-up wg set wg0 peer {{ p.public_key }} allowed-ips {{ p.allowed_ips|join(",") }}{% if p.endpoint %} endpoint {{ p.endpoint }}{% endif %}{% if p.persistent_keepalive %} persistent-keepalive {{ p.persistent_keepalive }}{% endif %}
{% endfor %}
```

### Rendering one VM

Virtual machines render the same way (`GET /api/virtual-machines/<id>/render/?template=`;
`vm` and `device` both name the VM, `routing` holds what the VM routes
with), plus:

| Variable | What it holds |
|---|---|
| `interfaces` | The VM's interfaces, in slot (`index`) order, then by name. |
| `disks` | Its [virtual disks](virtual-machines.md#disks). |
| `represents_device` | `{id, name}` of the device the VM is, or `None`. |
| `build` | The VM's build, as `backing_vm` above. |

### Rendering one object of any type

A template's list render (`objects`) puts every row of its type in one file.
For one object, add `?object=<id>` to its preview or render:

```
GET /api/export-templates/<id>/preview/?object=<object id>   → {output}
GET /api/export-templates/<id>/render/?object=<object id>    → the file
GET /api/clusters/<id>/render/?template=<template id>        → {output, template}
```

The object must be of the template's type, in your tenant, and one you may
view; anything else is a 404. Devices and VMs get the contexts above. Any
other type gets the object under its type name (`cluster`) and as
`object`, with `objects` holding just it and `count` 1. Clusters also get:

| Variable | What it holds |
|---|---|
| `cluster` | The cluster - `cluster.name`, `cluster.type`, `cluster.group`, `cluster.site`, `cluster.custom_fields`, … |
| `hosts` | Devices in the cluster, and the hosts its VMs run on, by name. |
| `virtual_machines` | The cluster's VMs, by name. |
| `vm_groups` | Its [VM groups](vm-groups.md). |

Each list holds only the rows you may view, as in an export. The cluster
alias needs the **view** permission on export templates and on clusters,
and takes only a template whose object type is cluster. A Kolla
`globals.yml` per cluster:

```jinja
kolla_internal_vip_address: "{{ cluster.custom_fields.kolla_vip }}"
{% for h in hosts %}
# {{ h.name }} {{ h.primary_ip.ip_address if h.primary_ip else "" }}
{% endfor %}
```

[Bundles](#bundles-every-file-a-device-needs) stay device-only.

A port description the way a running config carries it, from the far end:

```jinja
{% for i in interfaces %}
interface {{ i.name }}
{% if i.link_peer and not i.link_peer.hidden %}
 description to {{ i.link_peer.device }} {{ i.link_peer.custom_fields.frr_name or i.link_peer.interface }}
{% elif i.description %}
 description {{ i.description }}
{% endif %}
{% endfor %}
```

### Address filters

An address in Danbyte is a bare `10.0.0.5` whose length comes from its
prefix; a router config needs the pieces. These filters take a string
(`10.0.0.5/24`, `10.0.0.5`) or an address object, and work on IPv6 too:

| Filter | `10.0.0.5/24` becomes |
|---|---|
| `host` | `10.0.0.5` |
| `cidr` | `10.0.0.5/24` (an address object gets its own mask length when one is set, else its prefix's; a bare string is a host) |

!!! note "What a template can reach"
    `objects` holds the rows the **caller** may view - the same row and site
    restriction the list pages apply - so a site-scoped user renders their
    site, not the tenant. A type that carries credentials (webhooks,
    automation targets, device credentials) cannot be a template's subject,
    and a secret-bearing field is unreadable from any row a template reaches.
    A model's **methods** are refused too - only a `get_…_display()` choice
    label is callable - so an accessor that opens the secret store cannot be
    reached through a relation either.

    Walking a relation stays inside your tenant and your permissions: a
    related list (`rack.devices.all()`) holds only this tenant's rows that
    you may view, and a row of another tenant reads as nothing. Accounts,
    groups and the tenant show their name at most - `owner.username`,
    `tenant.name` - never an address, a membership or the organisation
    behind them. Accounts, groups and grants cannot be a template's subject,
    and a tenant template covers the tenant it runs in. On a related list
    a template may call `all`, `count`, `exists`, `first`, `last`,
    `filter`, `exclude`, `get`, `order_by`, `reverse`, `distinct` and
    `none`; a lookup names one field of that row (`name__startswith`), never
    a path into another table (`site__name`).

    A template renders for whoever runs it - the preview for the editor, a
    download for the person downloading - and shows them what the API
    shows them. A field the API leaves out reads as empty and cannot be
    filtered or ordered on: a contract's cost without *view cost*, an SLA's
    credits and fee without *view credits*, an address's device, interface,
    prefix or VM the user can't see. A coverage row whose contract the user
    can't see is left out, and an SLA's stored period figures and rule
    snapshots are not reachable.

    Output is always served as a download of an inert type:
    `text/plain`, CSV, JSON, XML or YAML. A template declaring `text/html`
    downloads as plain text.
| `prefixlen` | `24` |
| `netmask` | `255.255.255.0` |
| `wildcard` | `0.0.0.255` |
| `network` | `10.0.0.0/24` |

Plus the tests `ipv4` and `ipv6` (`{% if ip is ipv6 %}`). So an IOS line
reads `ip address {{ ip | host }} {{ ip | netmask }}` and an FRR line
`ip address {{ ip | cidr }}`.

## Open a template

Clicking a name in **Customize → Export templates** opens that template's detail
page, the same way every other object in Danbyte works. The pencil in the header
edits it; **Render** produces the file without leaving the page.

- **Overview** - what the template is for (name, object type, description, and
  how many lines it has), what it produces (file extension, MIME type, inline or
  attachment), when it was created and last changed, and then the **template
  body itself**, in the [file viewer](#the-file-viewer).
- **Journal** - your notes on this template.
- **Change log** - the automatic record of changes to the row.

An export template has no reverse relations: nothing in the data model points
back at one, and a render is produced on demand rather than stored. So the page
is deliberately short - the template body is the content, and there is no
"what uses this" tab to show.

## Preview and download

- While editing a template, the **Run preview** pane renders it against your live
  objects so you can see the output before saving. The preview loops over the
  first 200 rows only; `count` still says how many the real render will see.
- A render loops over at most **50,000** rows - the same bound as the list
  export. Past it the render is refused with the row count; use the list
  export for a whole large table.
- From the template list, each row has a **Render & download** action that
  produces the file (saved as an attachment when you enabled that option). The
  same action sits in the header of the template's own page.

## Bulk changes

Tick rows in the template list - with the `change` or `delete` grant - to
reveal the bulk bar:

- **Export** downloads the selected templates as CSV, Excel or JSON.
- **Edit** sets **As attachment** or **Description** on every selected
  template. The body, object type and file name stay per template.
- **Delete** first shows what would happen and names the templates that sit
  in a config bundle: they leave the bundle, as a single delete does.

| Endpoint | Needs |
|---|---|
| `POST /api/export-templates/bulk-update/` | `exporttemplate.change`; `{ids, fields}` with `as_attachment`, `description` |
| `GET /api/export-templates/bulk-edit-fields/` | `exporttemplate.change` |
| `POST /api/export-templates/bulk-delete/` | `exporttemplate.delete`; `{ids, dry_run}` |

## Config-template bindings

An export template with object type **device** can double as a device's **config
template** - the source of its intended configuration. Instead of picking a
template by hand every time, bind one where it belongs:

| Bound on | Where | Applies to |
|---|---|---|
| **Device** | device form → **Config template** | that one device (an override). |
| **Device role** | role form → **Config template** | every device with that role. |
| **Platform** | platform form → **Config template** | every device on that OS. |

Resolution is **device → role → platform** - the first binding found wins.
The binding is used in two places:

- The device's **Config tab** renders what is bound as soon as it opens - the
  one bundle on the device's role, else the resolved template - and says how
  it was bound (*role …*, *device* or *role/platform*). The picker still
  renders any other template or bundle.
- `GET /api/devices/<id>/render/` renders the bound template when no
  `?template=` parameter is given - so a drift runner doesn't need to know
  template ids per device.

See [Config drift](iac-runner.md) for the full intended-vs-actual loop.

### The file viewer

The Config tab shows a render in a file viewer rather than a plain text box:

| Part | What it does |
|---|---|
| **Files** | A bundle or directory template lists its files on the left: path, line count, and *Changed*, *Matches* or *Never pushed*. Above it, *N of M files changed since last push*. **Re-render** runs it again; **Download .tar** still fetches the whole set. |
| **Colours** | Picked from the file's name, else from its first lines: JSON (keys, string values, numbers, `true`/`false`/`null`), XML (tags, attributes, values, comments, CDATA), YAML, INI and systemd units (`[Section]`, `Key=`), and network config such as FRR and `/etc/network/interfaces` (comments starting `!` or `#`, `interface`/`router`/`vrf`/`address-family`/`iface`/`auto`, IPv4 and IPv6 addresses and prefixes, numbers). Logs dim timestamps and mark errors and failures red, warnings amber and ok/succeeded green. A diff keeps its added/removed line colours with the code coloured inside. |
| **Outline** | The file's sections - `interface …`, `router …`, `iface …`, `[Section]` headers (systemd-networkd, INI) and `### FILE:` markers. A click jumps to the line; the same lines carry fold markers in the gutter. |
| **Search** | ++slash++ focuses it (when you are not typing elsewhere); matches are highlighted, ++enter++ / ++shift+enter++ or the arrows step through them. |
| **Wrap**, **Copy**, **Download** | Copy and Download take the file on screen (or its diff), never the line numbers. |
| **Diff vs last push** | Unified by default or **Side by side**, with old and new line numbers. **Only changes** shows each change with 3 lines of context; clear it to read the whole file with the changes in place. |
| **Height** | The viewer fills the window and scrolls on its own. Drag the bar under it to resize (double-click resets); the height is kept per user in this browser. **Full screen** takes the whole window; ++esc++ leaves. |

The same viewer shows the config context, the Ansible host vars, the config
drift diff, a template's body and its **Run preview**, a script run's log and
its text outputs, a pipeline run's step logs and its "What the next step
receives" JSON, and a pipeline's *As code* YAML.

## Bundles: every file a device needs

FRR is one of several files a router runs on - `frr.conf`,
`/etc/network/interfaces`, a systemd `.link` unit, `nft.conf`, a WireGuard
config. A **config bundle** (**Customize → Config bundles**) names the
device templates that produce them and the **device roles** it applies to,
so "push from Danbyte" is one call that returns every file with its path.

Each template says where its file lands with a **Target path**
(`/etc/frr/frr.conf`); a template without one is keyed by its name and
extension. Two templates in one bundle cannot land at the same path. A
target path ending in `/` makes the template a directory of files - see
[Several files from one template](#several-files-from-one-template).

```
GET /api/devices/<id>/render/?bundle=leaf-files       → {bundle, files: {path: {…}}}
GET /api/devices/<id>/render/?bundle=role             → the bundle bound to the device's role
GET /api/devices/<id>/render/?bundle=role&archive=tar → a tarball, paths kept relative
```

### Several files from one template

Some files come one per thing on the device: a systemd `.link` unit per NIC
(`10-mgmt0.link`, `11-gi1.link`, …), a WireGuard config per tunnel, a file
per VRF. A device template whose **Target path ends in `/`** is a
**directory**: each `{% file %}` block writes one file into it.

```jinja
{% for i in interfaces %}
{% file "%02d-%s.link" % (10 + loop.index0, i.name) %}
[Match]
OriginalName={{ i.name }}
{% endfile %}
{% endfor %}
```

With the target path `/etc/systemd/network/`, a device with three NICs
renders three files, `/etc/systemd/network/10-mgmt0.link` and so on. Each
one appears in a bundle render, the bulk render and the tarball under its
own path, with its own `sha256`, push record, `drift` and `diff` - exactly
like a single-file template's file. Rendered on its own,
`GET /api/devices/<id>/render/?template=<id>` answers
`{template, template_id, path, files: {path: {…}}}` instead of one file, and
`&archive=tar` works there too. The export template's own **preview** answers
`{output: "", files}` and its **render** download is a tarball; both need
`?object=<device id>`, since the files are per device.

The rules, each a `400` with the reason:

- **The name is a plain file name.** No `/` or `\`, not `.` or `..`, no NUL
  or other control character, no leading or trailing space, at most 128
  characters, and the directory plus the name fits 255. A push tool writes
  these paths to disk, so nothing may step out of the directory - and the
  check runs on the rendered name, so a NIC called `../x` is refused too.
  The directory itself may not contain a `..` segment.
- **Names are unique in one render.** Two blocks with one name is an error,
  as are two templates of one bundle writing the same path. Two directory
  templates may share a directory (`.link` and `.network` files side by
  side); only a clash of whole paths is refused.
- **Everything goes inside a block.** Whitespace between blocks is ignored;
  any other text outside a block is refused rather than dropped, since it is
  most often a forgotten `{% file %}`.
- **No blocks, no files.** A device the template writes nothing for renders
  no files: the bundle simply has none from that template, and the Render box
  shows *No files for this device*.
- **Blocks need a directory.** A file block in a template whose target path
  does not end in `/` is refused on save and at render, and blocks cannot
  nest. Only a device template can have a directory target.
- At most 256 files per template render. `config-pushed` takes 50 files per
  call; a tool with more sends several calls.

[Config drift](iac-runner.md)'s `config-state` compares one running config
per device, so it refuses a directory template; compare its files through
`config-pushed` and the render's per-file `drift` instead.

The bundle list takes the same bulk bar as the templates: **Export**, **Edit**
(the **Description**) and a previewed **Delete**, through
`/api/config-bundles/bulk-update/` (`configbundle.change`) and
`/api/config-bundles/bulk-delete/` (`configbundle.delete`).

Every rendered file carries its `sha256`, so a tool can skip what has not
changed. `bundle=role` is an error rather than a guess when the role has no
bundle or more than one. The device's **Config → Render** box offers bundles
beside single templates and shows each file on its own tab.

### Many devices at once

```
GET /api/devices/render/?bundle=role&role_slug=leaf
GET /api/devices/render/?template=<id>&site=<id>&hashes=1
```

renders one template or bundle for every device the list filters select
(`role`, `role_slug`, `site`, `platform`, `search`), answering
`{devices: {id: {name, files}}, skipped: {id: reason}}` - a device the bundle
does not apply to is skipped and named, not fatal. `hashes=1` leaves the text
out for a tool that only wants to know what moved. Capped at 500 devices;
narrow the filter past that.

### What was last pushed

Danbyte never pushes a config. The tool that does can say what it pushed:

```
POST /api/devices/<id>/config-pushed/
{"files": [{"path": "/etc/frr/frr.conf", "sha256": "…", "output": "…"}],
 "bundle": "leaf-files", "source": "ansible", "note": "change 4711"}
```

(or the single-file shorthand `{"path", "sha256", "output"}`). The hash is
always kept; the text is kept when it is under 1 MB, for the diff. From then
on every render of that path also answers `pushed` (hash, when, by whom),
`drift` - `true` when the current render differs from the last push, `false`
when it matches, `null` when nothing was ever pushed - and `diff`, the
unified diff against the pushed text. The Render box shows the same as a
badge per file (*Matches last push*, *Changed since last push*, *Never
pushed*) with a **Diff vs last push** view.

This is the other half of [config drift](iac-runner.md): drift compares the
intended config against what is **running** on the box; a push record
compares the current render against what was last **sent**, so a model
change shows up before anyone reads the box. Recording a push needs `change`
on the device.

### Secrets in a render

A render never contains a key. Where a template needs one it prints
`<keychain:NAME>`, exactly that shape, with `NAME` the keychain's name - a
[contract](routing-templates.md#nx-os-style) a push tool can rely on: replace
every match of `<keychain:([^<>\s]+)>` with the key from
`POST /api/routing/keychains/<id>/reveal-psk/` (an audited read behind the
`reveal` permission) or from its own store.

An FHRP group's authentication key follows the same contract by group id:
`<fhrp-key:ID>` (a `by_interface` row's `fhrp[].key_placeholder`), resolved
from `POST /api/fhrp-groups/<ID>/reveal-psk/`.

A WireGuard private key is never stored. A termination's
`private_key_ref` (`tunnels[].wireguard.private_key_ref`) is printed as
written: a path on the box, which the router fills itself, or a
`<keychain:NAME>` placeholder, which the push tool resolves like any other
keychain. Danbyte refuses a value that decodes as a key.

## Permissions and audit

Export templates are managed by users with the **Customize** permission group, and
every create, edit, and delete is recorded in the [change log](change-log.md).
