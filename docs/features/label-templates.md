---
icon: lucide/printer
---

# Label templates

Label templates let you design a **printable label** for any object — a device
asset tag, a rack label, an IP or cable tag — with your own HTML and an optional
QR code, then print it for one object or a whole selection.

You author the label once with **Jinja2 + HTML** (the same templating language as
[export templates](export-templates.md)), size it in millimetres, and Danbyte
renders it against live data. Templates live under **Customize → Label
templates**.

## Create a template

1. Go to **Customize → Label templates** → **New template**.
2. Set the **name**, the **object type** it labels (Device, Rack, IP address, …),
   and the physical **width / height / margin** in millimetres.
3. Write the **label HTML**. Reference the object's fields with `{{ … }}` — e.g.
   `{{ device.name }}`, `{{ device.serial }}`, `{{ rack.name }}`. The **Fields**
   panel lists every available token for the chosen type (including custom
   fields) — click one to insert it.
4. To include a **QR code**, tick *Include a QR code* and drop a
   `<div class="qr"></div>` where it should appear. By default the QR encodes the
   object's own page URL, so scanning it opens the object in Danbyte; set **QR
   content** to any Jinja expression (e.g. `ASSET:{{ device.name }}`) to encode
   something else.
5. The **live preview** renders your label against a real object of that type at
   its true size as you type.
6. Optionally mark it the **default** for that object type — it's preselected
   when printing.

Special tokens always available: `{{ url }}` (the object's absolute page URL),
`{{ qr }}` (the resolved QR value), and `{{ obj }}` (the object under a generic
name).

## Printing

A **Print label** action appears on an object's page (and in the list **bulk
bar** for a multi-select) whenever a template exists for that type — no
per-page configuration. Pick a template and Danbyte opens a **PDF** whose page
is sized exactly to the label (one label per page), rendered server-side. Your
browser's PDF viewer previews it and prints it to any office or dedicated label
printer.

Choose a layout from the **Print label** menu:

- **Label roll (exact size)** — one label per page, the page sized to the
  label. Best for a dedicated label printer with matching media.
- **A4 sheet** / **Letter sheet** — labels tiled at true size on an office
  sheet, with dashed cut guides. Best for an ordinary printer: the PDF page
  already matches the paper, so it prints at real size with nothing to scale.

!!! tip "If a label prints too big on a normal printer"
    That's the print dialog scaling a small label-roll page up to fill A4/Letter.
    Either pick the **A4/Letter sheet** layout above, or in the print dialog set
    **Scale → Actual size** (not "Fit to page"). A browser can't be forced to
    print at an exact physical size from CSS — the paper size and scale are
    dialog-controlled — which is why Danbyte bakes the size into a PDF and offers
    a sheet layout that matches office paper.

Currently wired on **devices** and **racks**; the same action drops onto any
detail page or bulk bar with one line, so more object types are easy to add.

The PDF is produced by [WeasyPrint](https://weasyprint.org/) from the same
sanitized label HTML, with the QR composited server-side. On container/bare
deploys this needs the Pango/cairo/GDK-PixBuf system libraries (baked into the
Docker image and installed by `install.sh`).

## Short id and QR links

A full UUID is long and makes for a dense QR. Every object also has a
**per-tenant human number** (`numid`, e.g. `27`) — enable it with
**human-readable object numbers** in deployment settings. Labels can use:

- `{{ short_id }}` — the human number, to print alongside the name.
- `{{ short_url }}` — a compact link, `…/l/<tenant>/<type>/<number>`, that
  resolves to the object's page.

The default QR now encodes `short_url` (falling back to the full URL when an
object has no number), so scanned codes are smaller. Scanning opens
`/l/<tenant>/<type>/<number>`, which looks the object up and redirects to it.

!!! info "Which tenant a scan opens"
    The short link includes the tenant, because the human number is only unique
    within a tenant. When you scan a label, Danbyte switches your active tenant
    to the one on the label (only if you're allowed to see that object — an
    unknown or forbidden code just 404s) and then opens the object. On a
    single-tenant install this is invisible; on a multi-tenant one it means a
    label always opens the right object regardless of which tenant you were in.

## Targeting device types and roles

By default a template applies to **every** object of its type. For device (and
virtual-machine) templates you can narrow that in the editor's **Applies to**
section:

- **Device types** — only devices of the chosen types offer this label.
- **Roles** — only devices/VMs with the chosen roles offer it.

Leave both empty to apply to everything. Restrictions are additive: a device
must match a named device type **and** a named role (when each is set). Because
several templates can match one device, a single device can carry **more than
one label** — the **Print label** menu lists every applicable template. The
device page filters the menu to exactly the labels that apply to that device.

## Copy text and Excel export

For an external label printer's own software (Phoenix Contact, Weidmüller, DYMO,
…) you often want the label *text*, not a PDF. Each entry in the **Print label**
menu offers:

- **Copy text** — copies the label's rendered plain text to the clipboard (one
  label per block), ready to paste into another program.
- **Export to Excel** — downloads an `.xlsx` with one row per object: the full
  label text plus each line split into its own column, so it maps straight onto
  an import template.

Both work from a single object's page and from the **device list bulk bar** —
tick the devices you want, choose a template, and export them all at once.

## Safety

Label HTML is rendered in a **sandboxed** Jinja environment with autoescaping on,
so a field value containing markup is escaped rather than injected, and templates
can't reach code-executing attributes. The rendered HTML is then run through an
HTML sanitizer (`nh3`) that strips scripts, event handlers, and unsafe URLs from
the template author's own markup. The editor preview additionally renders inside
a scriptless `<iframe sandbox>` as defence in depth. Every object is re-checked
for your view permission before its label renders, and all queries are
tenant-scoped.
