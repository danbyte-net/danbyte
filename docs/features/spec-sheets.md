---
icon: lucide/file-text
---

# Spec sheets

A **spec sheet** is a one-object PDF that reads like a vendor datasheet: the
device, virtual machine or virtual chassis with everything Danbyte knows
about it, laid out to be handed to an external party, a site technician, or
a colleague who never opens Danbyte. Open the object and click **Spec sheet**
- the PDF opens in a new tab, where the browser's viewer prints or saves it.

## What is on the page

A4, built to print in black and white as well as colour:

- **Header** - the name in bold, with role, site and rack position (or cluster
  for a VM) under it, the status pill, and the deployment name and generation
  time in the corner. The login logo uploaded under Settings → General is
  used when there is one.
- **Elevations** - the device type's front and rear images as full-width
  strips right under the header, so the hardware is the first thing on the
  page. A virtual chassis shows every member's front, in position order.
- **Three stat boxes** - the numbers wanted at a glance. Device: interfaces,
  power draw (the sum of its power ports' allocated or maximum draw), rack
  position. VM: vCPU, memory, total disk. Virtual chassis: members,
  interfaces, ports used.
- **Details** - serial number, asset tag, type and part number, height,
  platform, primary and OOB IP, tenant, site, location, rack, cluster,
  virtual chassis, description, tags, and every custom field that has a value
  and is not hidden in its definition.
- **Modules and inventory** (device), **Storage** (VM), or the **member
  table** (virtual chassis: position, device, master or member, priority,
  type, serial, status) followed by every member's front elevation in
  position order and each member's interfaces.
- **Interfaces** - name, type, speed, MAC with its vendor, VLAN, IPs, and what
  the cable at the far end lands on. Sub-interfaces are indented; the dot in
  front of the name is filled when the port is enabled.
- **Comments** - as written.
- **Images** - the image attachments on the object, two per row with their
  captions, at the end.

Every page carries the object name, its Danbyte URL and the page count in
the footer.

## Endpoint

`GET /api/devices/<id>/spec-sheet/`, `GET /api/virtual-machines/<id>/spec-sheet/`
and `GET /api/virtual-chassis/<id>/spec-sheet/` return `application/pdf`. The
sheet is served inline; add `?download=1` for a download with the filename
`<name>-spec-<date>.pdf`. Reading a sheet needs the same **view** permission
as the object page, so site scoping applies unchanged.

The PDF is rendered server-side with the same engine as
[label templates](label-templates.md), so it looks identical on every machine
and needs no browser print dialog.

## Roadmap

- A logical topology drawing (the object's VLANs and L2 neighbours) below the
  interfaces.
- Circuits as a third type - the handover sheet a provider or site tech asks
  for.
- One merged PDF for a selection of devices.
