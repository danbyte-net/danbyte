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
| `interfaces` | The device's interfaces; each carries `vlan`, `tagged_vlans`, `vrf`, `mtu`, `enabled`, … and `link_peer` - the cable's far end as `{device, interface, description, custom_fields}`, or `None` on an uncabled port. Read-only: it is a plain dict, so `i.link_peer.custom_fields.frr_name` works and nothing behind the peer row is reachable. |
| `ip_addresses` | Every address assigned to the device; `assigned_interface_id` says where. |
| `routing` | What the device routes with - VRFs, static routes, BGP / OSPF / IS-IS, the VTEP and its VNIs, the policies and lists they reference, keychains. See [Routing](routing.md#rendering-a-config). |

Virtual machines render the same way (`vm` and `device` both name the VM;
`routing` is empty).

A port description the way a running config carries it, from the far end:

```jinja
{% for i in interfaces %}
interface {{ i.name }}
{% if i.link_peer %}
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
    reached through a relation either. Output is always served as a download of an inert type:
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

- **Overview** - what the template is for (name, object type, description), what
  it produces (file extension, MIME type, inline or attachment), when it was
  created and last changed, and then the **template body itself**, rendered in a
  scrollable monospace box.
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

- The device's **Config tab** preselects the resolved template in its
  **Render config** box and shows how it was bound (*device* or *role/platform*).
- `GET /api/devices/<id>/render/` renders the bound template when no
  `?template=` parameter is given - so a drift runner doesn't need to know
  template ids per device.

See [Config drift](iac-runner.md) for the full intended-vs-actual loop.

## Bundles: every file a device needs

FRR is one of several files a router runs on - `frr.conf`,
`/etc/network/interfaces`, a systemd `.link` unit, `nft.conf`, a WireGuard
config. A **config bundle** (**Customize → Config bundles**) names the
device templates that produce them and the **device roles** it applies to,
so "push from Danbyte" is one call that returns every file with its path.

Each template says where its file lands with a **Target path**
(`/etc/frr/frr.conf`); a template without one is keyed by its name and
extension. Two templates in one bundle cannot land at the same path.

```
GET /api/devices/<id>/render/?bundle=leaf-files       → {bundle, files: {path: {…}}}
GET /api/devices/<id>/render/?bundle=role             → the bundle bound to the device's role
GET /api/devices/<id>/render/?bundle=role&archive=tar → a tarball, paths kept relative
```

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

## Permissions and audit

Export templates are managed by users with the **Customize** permission group, and
every create, edit, and delete is recorded in the [change log](change-log.md).
