---
icon: lucide/wifi
---

# Wireless

Wireless is where you record your **Wi-Fi networks (SSIDs)** and the groups that
organize them - and you can link each SSID to the VLAN it bridges onto.

You build it in two layers: **wireless LAN groups** (how you organize SSIDs) and
the **wireless LANs** (the SSIDs themselves).

## Add a wireless LAN group

A group bundles related SSIDs together - for example *Corporate*, *Guest*, or
*IoT*.

1. Open **Wireless → Wireless LAN groups** in the sidebar and click **Add
   group**.
2. Give it a **name** and a **slug** (a short URL-friendly identifier).
3. Optionally add a **description**.
4. Save.

!!! note "Nothing is pre-filled"
    Danbyte ships no sample groups or SSIDs - you create exactly the ones your
    network uses.

## Add a wireless LAN (SSID)

1. Open **Wireless → Wireless LANs** and click **Add wireless LAN**.
2. Enter the **SSID** - the broadcast network name.
3. Optionally put it in a **group**.
4. Set a **status**, the **authentication** details, and an optional **VLAN
   bridge** (see below).
5. Save.

### SSID details

| Field | What it records |
|---|---|
| **Status** | active, reserved, disabled, or deprecated. |
| **VLAN** | the VLAN this SSID bridges onto, so wireless and wired networks line up. |
| **Authentication type** | open, WEP, WPA-Personal, or WPA-Enterprise. |
| **Authentication cipher** | auto, TKIP, or AES. |
| **Description / comments** | free-text notes. |

### SSID status

| Status | Meaning |
|---|---|
| **Active** | Broadcasting and in service. |
| **Reserved** | Planned or held, not yet live. |
| **Disabled** | Turned off. |
| **Deprecated** | Being retired. |

!!! warning "Groups in use can't be deleted"
    If a group still has SSIDs attached, Danbyte blocks the delete. Move or
    remove those SSIDs first.

## Wireless LAN group pages

Click a **wireless LAN group** name in its list to open its detail page - the
pencil in the header edits it.

The Overview shows the group's name, slug and description; the **Wireless LANs**
tab lists every SSID in the group, using the same table the main Wireless LANs
page draws (minus the redundant Group column). It is powered by
`GET /api/wireless-lans/?group=<id>`, and it is the check to run before you
move or delete a group.

The page also carries **Journal** and **Change log** tabs. Groups have been
audited all along, so the tab shows every recorded change to the row, including
ones made before the page existed.

## Wireless LAN pages

Clicking an **SSID** in **Wireless → Wireless LANs** opens that SSID's own page
(it used to drop you straight into the edit form).

- **Overview** - the SSID, status, group, and description; then the **Network**
  card, which is what you actually come here to read: the VLAN it bridges onto,
  the authentication type, and the cipher. Comments render below if there are
  any.
- **Journal** - your notes on this SSID.
- **Change log** - the automatic record of changes to the row.

Nothing in the data model points back at a wireless LAN, so the page has no
related tabs - it links *out* to its group and VLAN, and stops there rather than
padding itself with tabs that would always be empty.

## Tags & custom fields

Need to track something extra - a controller name, a band, a PSK rotation date?
Add a **custom field** for wireless LANs and it appears on every form. See
[Tags & custom fields](tags-and-custom-fields.md).
