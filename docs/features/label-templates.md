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

!!! tip "Print at actual size"
    In the print dialog choose **Actual size / 100%** (not "Fit to page"), and
    set the printer's media/roll to match the label. A browser can't be made to
    print an *HTML* page at an exact physical size — the paper size is
    controlled by the print dialog, not by CSS — so Danbyte prints a PDF with
    the page dimensions baked in, which is the reliable way to get true label
    sizing with no browser header/footer.

Currently wired on **devices** and **racks**; the same action drops onto any
detail page or bulk bar with one line, so more object types are easy to add.

The PDF is produced by [WeasyPrint](https://weasyprint.org/) from the same
sanitized label HTML, with the QR composited server-side. On container/bare
deploys this needs the Pango/cairo/GDK-PixBuf system libraries (baked into the
Docker image and installed by `install.sh`).

## Safety

Label HTML is rendered in a **sandboxed** Jinja environment with autoescaping on,
so a field value containing markup is escaped rather than injected, and templates
can't reach code-executing attributes. The rendered HTML is then run through an
HTML sanitizer (`nh3`) that strips scripts, event handlers, and unsafe URLs from
the template author's own markup. The editor preview additionally renders inside
a scriptless `<iframe sandbox>` as defence in depth. Every object is re-checked
for your view permission before its label renders, and all queries are
tenant-scoped.
