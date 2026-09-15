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
| `interfaces` | The device's interfaces; each carries `vlan`, `tagged_vlans`, `vrf`, `mtu`, `enabled`, … |
| `ip_addresses` | Every address assigned to the device; `assigned_interface_id` says where. |
| `routing` | What the device routes with - VRFs, static routes, BGP / OSPF / IS-IS, the VTEP and its VNIs, the policies and lists they reference, keychains. See [Routing](routing.md#rendering-a-config). |

Virtual machines render the same way (`vm` and `device` both name the VM;
`routing` is empty).

### Address filters

An address in Danbyte is a bare `10.0.0.5` whose length comes from its
prefix; a router config needs the pieces. These filters take a string
(`10.0.0.5/24`, `10.0.0.5`) or an address object, and work on IPv6 too:

| Filter | `10.0.0.5/24` becomes |
|---|---|
| `host` | `10.0.0.5` |
| `cidr` | `10.0.0.5/24` (an address object gets its prefix's length; a bare string is a host) |
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
  objects so you can see the output before saving.
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

## Permissions and audit

Export templates are managed by users with the **Customize** permission group, and
every create, edit, and delete is recorded in the [change log](change-log.md).
