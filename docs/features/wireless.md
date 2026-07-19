---
icon: lucide/wifi
---

# Wireless

Wireless is where you record your **Wi-Fi networks (SSIDs)** and the groups that
organize them — and you can link each SSID to the VLAN it bridges onto.

You build it in two layers: **wireless LAN groups** (how you organize SSIDs) and
the **wireless LANs** (the SSIDs themselves).

## Add a wireless LAN group

A group bundles related SSIDs together — for example *Corporate*, *Guest*, or
*IoT*.

1. Open **Wireless → Wireless LAN groups** in the sidebar and click **Add
   group**.
2. Give it a **name** and a **slug** (a short URL-friendly identifier).
3. Optionally add a **description**.
4. Save.

!!! note "Nothing is pre-filled"
    Danbyte ships no sample groups or SSIDs — you create exactly the ones your
    network uses.

## Add a wireless LAN (SSID)

1. Open **Wireless → Wireless LANs** and click **Add wireless LAN**.
2. Enter the **SSID** — the broadcast network name.
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

## Tags & custom fields

Need to track something extra — a controller name, a band, a PSK rotation date?
Add a **custom field** for wireless LANs and it appears on every form. See
[Tags & custom fields](tags-and-custom-fields.md).
