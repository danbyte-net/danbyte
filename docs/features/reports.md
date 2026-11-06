---
icon: lucide/file-text
---

# PDF reports

A **PDF report** prints devices, prefixes or IP addresses as clean tables,
in the [floor plan report](floor-plans.md#the-report)'s style: statuses,
roles and tags as square badges in their own colours, a table header that
repeats on every page, and the tenant, the date and the page number on each
page. You pick what goes in it. The [topology report](#topology-report)
adds the topology diagram to the tables of what is on it.

## Where to start one

| From | Click | The report covers |
|---|---|---|
| A device, prefix or IP address page | **PDF report…** in the page actions | That object, with the sections you tick |
| The Devices, Prefixes or IP addresses list | **Import / Export ▸ PDF report…** | Every row the list shows now (its search and filters) |
| The same lists, rows selected | **Export ▸ PDF report…** in the bulk bar | The selected rows |
| The topology map | **Export ▸ PDF report…** | The view on the map - see [Topology report](#topology-report) |
| **Topology**, views selected | **PDF report…** in the bulk bar | Each selected saved view |

**Print** opens the PDF in a new tab for the browser to print;
**Download** saves it. A large report renders in the background: the button
reads *Generating… 40%* while it runs, and the PDF downloads (or opens for
printing) by itself when it is ready. Keep the dialog open until then.

## What you can choose

- **Title** - defaults to the object (*Device sw-a*) or *Devices report*.
- **Paper** - A4, Letter or A3, portrait or landscape.
- **List columns** (more than one object) - the same columns the list page
  offers, custom fields included. Tick a column to add it, drag its handle to
  order them.
- **Group by** - split the table by status, role, site and similar: one
  table per value. A prefix report starts grouped by **VRF**, as the
  Prefixes list is (below); **No grouping** prints one flat table.
- **Summary** - counts by status, role (or VRF) and site, each value as its
  badge.
- **Show IPs** (prefixes) - each prefix in the table is followed by a small
  table of its IP addresses: address, status and role badges, DNS name and
  what it is assigned to. They are read like the IP list, so only the
  addresses you may view are shown, and they count towards the row limits.
  The *IP addresses* detail section is separate.
- **Details for each device** (or prefix, or IP address) - after the table,
  a block for each object with the sections you pick under it. Each object
  starts a new page. A single object always gets its details.
- **Detail sections** - shown under the tick once it is on, each with its
  own column picker:

| Type | Sections |
|---|---|
| Device | Overview (attributes and custom fields), Photo (the type's front and rear), Interfaces (type, status, LAG, VLANs, IPs, cable peer), IP addresses, Cables, Installed software (version, end of support, licence), Power ports, Console ports, Lifecycle (platform, software version, warranty, support coverage, next lifecycle date), Monitoring (each check's state), Journal, Change log |
| Prefix | Overview, Utilisation (a bar with the usable, used and free addresses), VLAN and VRF, Child prefixes, IP addresses (status and role badges, DNS names), IP ranges, Monitoring, Journal, Change log |
| IP address | Overview, Assignment (device or VM and interface, switch port, MAC), NAT, DNS records, Monitoring, Journal, Change log |

- **Journal and change log entries** - the latest N (20 until you change it,
  at most 200).
- **Include cover page** - a title page before the report. See
  [Cover page](#cover-page).

The dialog remembers your choices per type in this browser (the cover tick,
its project line and image choice included).

### Prefixes by VRF

Grouped by VRF, a prefix report reads like the Prefixes list:

- One table, **Global** (no VRF) first, then each VRF by name. Each group
  starts with a banner row across the table, as the list's group header:
  *VRF* `TENANT-A` *RD 64599:5000 · 3 rows* - the VRF as its badge, its
  route distinguisher when it has one, and how many prefixes it holds. The
  VRF column is left out; the banner says it.
- Within a VRF, each prefix sits under its nearest parent in the report,
  one **↳** per level (/16, then ↳ /24, then ↳↳ /26), as the list nests
  them.
- With **Show IPs**, each prefix's addresses stay right under it, inside its
  VRF's group.

The VLAN column prints as the list's badge, *100 · servers*, in the VLAN's
own colour or else its zone's. Statuses, tags and the VLAN's zone print as
their badges too. Another **Group by** (status, site, VLAN, location)
prints one table per value as for the other types.

Under the options a line says what the report costs as you change it:
*About 1,200 cells* renders at once, *About 14,200 cells · renders in the
background* takes longer, and *Too large: … · leave out …* names what to
drop. **Download** and **Print** are off only while it is too large.

## Cover page

Tick **Include cover page** for a title page of its own, at the report's
paper size and orientation, with no running header or footer. The cover is
a full-page background with white text on it:

- at the top, the deployment's logo - the **Login-page logo** under
  **Settings → Branding & identity** when one is uploaded, else the white
  Danbyte wordmark - over a thin translucent rule;
- in the middle, the tenant's name in spaced capitals (or the
  **Organisation or project** you type), the **Cover title** large and
  heavy (the report's title until you change it), the **Subtitle**
  (generated - *48 prefixes · Group by VRF*, or the type for one object -
  and editable; clear it for none) and *Prepared by* with your full name
  (your user name when it is blank);
- the date at the bottom left in your date format, and Danbyte with its
  version at the bottom right.

The top and the bottom of the background are darkened a little so the text
reads on any background.

**Background** picks this report's background: **Default** (the tenant's),
or another of **Waves**, **Plain colour**, **Your upload** (when the tenant
has one) and **None** (white paper, dark text and the colour wordmark).
Everything else is the tenant's, so every report in a tenant matches - see
[Report cover settings](#report-cover-settings) below.

The cover counts as one page in the estimate.

### Report cover settings {#report-cover-settings}

Tenant admins set the look under **Settings → Tenant policy → Report cover**,
with a thumbnail that follows the choices as you make them:

| Setting | Choices |
|---|---|
| Background | **Waves** (default): softly rolling waves fading into a dark horizon. **Plain colour**: the horizon colour. **Your upload**: the cover image. **None**: white paper. |
| Colours | **Horizon** (the darkest tone, and the plain background), **Wave** (moves the mid tones) and **Crest** (the light on the crests). **Presets** set all three: **Danbyte** (the default blue), then each colour family of the colour picker - its darkest shade for the horizon and its 600 shade for the waves. |
| Cover image | A PNG, JPEG or SVG, at most 2 MB. **Upload…** replaces it, **Remove** deletes it. |

The waves are a still shipped with Danbyte in grey, coloured on the server
with the three colours (the default colours give the Danbyte blue). The
coloured page is kept in the media folder's `cache/report-covers/` as a
JPEG, so a tenant's covers are coloured once (about a third of a second for
an A4 page); deleting that folder is safe. A cover adds well under 100 KB to
the PDF.

A photo fills the page, cropped, with the same darkening at the top and the
bottom; an SVG is shown whole over the plain colour. A PNG or JPEG must be
the image it says it is (and at most 36 megapixels); an SVG is rebuilt by
the same sanitiser as the drawing PDFs - scripts, event handlers, external
references and DOCTYPEs are refused or dropped - and only the clean copy is
kept. The image is stored with the tenant's settings, not in the media
folder, so it is never served without a session; only tenant admins can
upload, view or remove it. Removing it while the background is **Your
upload** sets the background back to **Waves**.

## Topology report

A topology report puts a topology view on paper with the tables that
explain it:

- an optional [cover](#cover-page) and a [contents page](#contents-page);
- the **Diagram**: the map exactly as **Export ▸ PDF** draws it, on a page
  of its own, fitted to the paper, landscape, with the same title block;
- **Devices**: the devices on the map - name, role, type, site, primary IP
  and status by default, any column of the Devices list;
- **IP addresses**: the addresses assigned to those devices;
- **Cabling**: the cables between them - label, both ends with their
  ports, type, length and status.

Statuses and roles print as their badges. Untick a section to leave it out,
and pick its columns as for the other reports.

**From the map:** **Export ▸ PDF report…** reports on the map as it is
drawn - the current view, edited or not, or No view. Hidden cards are not
drawn, so they are not in the tables either. The Export menu's **Title and
legend** choice is the diagram's title block here too.

**From the Topology page:** select saved views and click **PDF report…**.
Each view is drawn in turn as it is saved (the button reads *Drawing 2 of
5…*), then the report is made. **Output** picks **One PDF**, with a
[chapter](#chapters-and-contents) per view, or a **ZIP of PDFs**, one PDF
a view. **Print** is for one PDF only. A report holds at most 20 views.

How the views are drawn: each one opens in the real map page in a hidden
frame of this browser tab, which loads the view, lays it out and draws it
the way **Export ▸ PDF** does, then hands the drawing back. So a report
looks like the map, but takes about as long per view as opening it. The
server never draws a map.

The diagram page and the PDF export are the same code on both sides: the
browser makes the drawing with one function, and the server lays it out
on paper with one function, so a change to the PDF export changes the
report's diagram too.

## Chapters and contents

Long reports are split into **chapters**. A report of several topology
views has one chapter per view, each opening with a **divider page**: a
banner across the top third in the cover's background (the tenant's waves
or colour), the chapter's number and title on it, and below it the
view's filters and what the chapter holds. A report of one view makes each
section a chapter, opening with a short **banner** at the top of its first
page instead, so it does not cost a page.

### Contents page

A report with two or more chapters gets a **contents page** after the
cover: the chapters and their sections with their page numbers. The page
numbers are filled in when the PDF is laid out, so they always match. The
chapters and sections are also the PDF's **bookmarks**, for the viewer's
sidebar.

## Markings

A report can carry a **marking**: a short label such as *Internal* or
*Confidential* in its own colour, with an optional icon. When it has one,
the marking prints as a square badge at the top and the bottom of every
page, on the cover and on the chapter dividers. Reports have none yet: the
labels and how they are picked come with the label catalog.

## The report framework

Every report above is laid out by one framework, `api/reports/`, so they
share their look and their limits:

| Part | What it does |
|---|---|
| `engine.py` | The document: paper size, margins, the running header (the tenant, top right) and footer (title, date and Danbyte version, bottom left; *Page n / N*, bottom right), the shared CSS, and `ReportContext`, what every page of a report shares |
| `blocks.py` | Tables with a header that repeats, rows that never split, band rows, key/value tables; square badges; utilisation bars; photo figures |
| `cover.py` | The [cover page](#cover-page) in the tenant's look |
| `divider.py` | [Chapter](#chapters-and-contents) divider pages and banners, in the cover's background |
| `toc.py` | The [contents page](#contents-page) and the PDF bookmarks |
| `marking.py` | The [marking](#markings) every page band, the cover and the dividers show |
| `registry.py` | Report **kinds** (the device, prefix, IP address and topology reports) and their **sections** as plug-ins: each section registers its key, label, the object types it needs view on, its columns and how it is built |

Sections read their rows only through the list endpoints, as you, so a
report never shows more than the lists do. The floor plan report, cable
schedule, spec sheets, rack and cabinet PDFs, SLA reports and labels still
lay out their own pages; they move onto the framework one at a time.

## Who sees what

A report reads exactly what the lists show you:

- An object you may not view - another site's under
  [site separation](permissions.md), or another tenant's - is left out, as
  the list leaves it out, and never named.
- A section whose objects you may not view (Interfaces without view on
  interfaces) is greyed out in the dialog and left out of the report with a
  note. Its rows are the rows its list would show you; a column the list
  shows (an interface's cable peer, say) prints as the list shows it.
- Nothing is written: a report is not recorded in the change log.
- A topology report's devices are the ones the drawing shows, read through
  the Devices list as you; a device you may not view is dropped and never
  named, and so are its addresses and cables. A saved view you may not view
  is dropped from a bulk report. It needs view on devices, like the PDF
  export.

## Limits

| | |
|---|---|
| Objects in one report | 2,000 - more is refused with the limit; narrow the filters or select fewer rows |
| Objects with details | 50 |
| Rows in one section of one object | 500 (the report notes the rest) |
| Rows in all sections together | 20,000 |
| Columns in one table | 40 |
| Table cells rendered at once | about 12,800 (details lower it); more renders in the background |
| Table cells in one report | about 130,000 with the default 5-minute background deadline |

The PDF is made under the drawing PDFs' limits: one at a time per user, a few
across the server, and a 30-second render deadline. Rendering costs about
1.5 ms per table cell and 60 ms per object with details, so before it renders
a report is estimated from its cells (rows times columns, Show IPs and
section tables included) and its objects with details:

- One that finishes in about 70% of the 30 seconds renders in the request.
- A longer one renders in the background, as a job on the `low` queue (so it
  never holds up monitoring) with a 5-minute deadline
  ([`DANBYTE_REPORT_JOB_TIMEOUT`](../reference/settings.md#pdf-reports-danbyte_report_job_timeout)).
  The job reads the data again as you, so a permission taken away in the
  meantime applies. One background report per user runs at a time, and one
  across the server. The finished PDF is kept for an hour, for you only.
- One past about 70% of the background deadline is refused at once (400)
  with what fits: how many rows with these columns, how many columns for these
  rows, or to leave out the details or Show IPs.

For example, 48 prefixes with every detail section and Show IPs (about 14,200
cells) render in the background in about half a minute.

A topology report is estimated the same way, with each diagram page at
about 0.4 s and each divider and cover at about 60 ms. It renders in the
background past the same budget.

A report that still runs past its deadline on a busy server is stopped (503,
or a failed background report); try again later or with fewer rows or
columns.

## API

`GET /api/devices/report/`, `/api/prefixes/report/` and `/api/ips/report/`
describe what a report can hold for the caller: `columns` and
`default_columns` (the list's column catalog, custom fields as `cf.<key>`),
`group_by` and `default_group_by` (the grouping a list report gets when the
request names none: `vrf` for prefixes, else null), `sections` (each `key`, `label`, `kind`, `available`, `note`,
`group_by`, `cover` (`project`, the tenant's name; `upload`, whether the
tenant has a cover image; `background`, its default), `sections` (each `key`, `label`, `kind`, `available`, `note`,
`columns`, `default_columns`, `default`, `last`), `show_ips` (prefixes, with
view on IP addresses) and `limits` (`cells` is the table cells rendered at
once, `background_cells` the most in one report).

`POST` to the same path makes the PDF:

```json
{
  "ids": ["…"],
  "filters": {"search": "leaf", "site": "…"},
  "sections": ["overview", "interfaces", "journal"],
  "columns": {
    "list": ["name", "status", "role", "site", "cf.owner_team"],
    "interfaces": ["name", "type", "status", "link_peer"]
  },
  "options": {
    "title": "Leaf switches",
    "paper": "a4",
    "orientation": "landscape",
    "group_by": "site",
    "include_summary": true,
    "list_table": true,
    "per_object": false,
    "show_ips": false,
    "last": 20
  }
}
```

- `ids` - the objects; without it, every row `filters` matches.
- `filters` - the list endpoint's own query parameters (paging and picker
  parameters are ignored).
- `sections` and `columns` - unknown columns are dropped; a section missing
  from `columns` uses its defaults.
- `options.list_table` and `options.per_object` (details for each object)
  default to a table for many objects and details for one.
- `options.show_ips` (prefixes) - each list row followed by its IP addresses.
- `options.group_by` - left out, a prefix report is grouped by VRF (banner
  rows, nested prefixes); `null` or `""` prints the flat table; any other
  key from `group_by` groups by it. A banner row is one table cell in the
  estimate.
- `options.cover` - a cover page. `cover_title` (default: the title),
  `cover_subtitle` (absent or null: generated; blank: none),
  `cover_project` (default: the tenant's name) and `cover_background`
  (`default`, `waves`, `plain`, `upload` or `none`).

The answer is the PDF as an attachment, or with `?print=1` `{url}`: a link
to it for five minutes, for the same user and tenant
(`GET /api/<type>/report/file/<token>/`, `?download=1` to save it). A 400
names the limit it hit, or what fits when the report is too large; a 403
means no view on the type; a 503 means the render ran past its deadline.

A report too large to render at once is answered with **202** and
`{job, status, state, seconds}` instead. Poll `status`
(`GET /api/<type>/report/job/<token>/`) for `{state, progress, url, detail}`:
`state` is `queued`, `waiting`, `running`, `done` or `failed`; `progress`
(0-95) is the render's time so far against its estimate; `url`
(`…/report/job/<token>/file/`, `?download=1` to save it) is the PDF once
`done`; `detail` says why it `failed`. Both answer only the user and tenant
that asked, for an hour; anyone else gets 404. A second background report
while one is queued or running is 429.

`POST …/report/?estimate=1` with the same body builds the report without
rendering it: `{cells, pages, seconds, mode, fits}`, `mode` being `now`,
`background` or `too_large` (with `detail`, what fits), `pages` the objects
with details plus one for a cover, and `fits` the cells that fit `now` and in the `background`.

```bash
curl -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '{"filters": {"site": "…"}, "options": {"include_summary": true}}' \
  -o devices.pdf https://danbyte.example/api/devices/report/
```

### Topology report API

`GET /api/topology/report/` describes the report for the caller in the same
shape as the object reports (`type` is `topology`; `sections` are
`diagram`, `devices`, `ip_addresses` and `cables`, each with its columns;
`limits.objects` is the most views). It needs view on devices.

`POST /api/topology/report/` makes it:

```json
{
  "views": [
    {
      "view": "…saved view id, or null…",
      "title": "DC1 fabric",
      "filters": "Site DC1",
      "svg": "<svg …>…</svg>",
      "device_ids": ["…", "…"]
    }
  ],
  "sections": ["diagram", "devices", "ip_addresses", "cables"],
  "columns": {"devices": ["name", "role", "device_type", "site", "primary_ip", "status"]},
  "options": {
    "title": "Core network",
    "paper": "a4",
    "orientation": "portrait",
    "diagram_orientation": "landscape",
    "title_block": true,
    "toc": null,
    "dividers": "auto",
    "output": "pdf",
    "cover": true
  }
}
```

- `views` - 1 to 20. Each is a drawing as `POST /api/topology/export/pdf/`
  takes it (`svg`, sanitised the same way, with the same caps), its
  title-block `title` and `filters`, and the `device_ids` it shows (at most
  2,000). `view` names the saved view; one the caller may not view is
  dropped, and a blank `title` takes the view's name.
- `options.toc` - `null` (default): a contents page with two or more
  chapters; `true` or `false` to force it.
- `options.dividers` - `auto` (default: full divider pages for several
  views, banners for one), `full` or `compact`.
- `options.output` - `pdf` (default) or `zip`: one PDF per view, in a ZIP.
- The cover options are the object reports'.

The answer, the print link (`GET /api/topology/report/<token>/`), the
background job (`/api/topology/report/job/<token>/` and its `file/`) and
`?estimate=1` (`svg` may be blank) work as for the object reports; a ZIP is
`application/zip`.
