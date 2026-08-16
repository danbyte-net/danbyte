<div align="center">

<img src="https://danbyte.net/readme/danbyte-logo.png" alt="Danbyte" width="360">

**A customizable IPAM / DCIM platform — one place for your IP space, your physical gear, and how it all connects.**

[![Version](https://img.shields.io/github/v/tag/danbyte-net/danbyte?label=version&color=0ea5e9)](https://github.com/danbyte-net/danbyte/releases)
[![Live demo](https://img.shields.io/badge/live_demo-danbyte.net%2Fdemo-0ea5e9)](https://danbyte.net/demo)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/sDuzc6pufU)
[![Reddit](https://img.shields.io/badge/Reddit-r%2Fdanbyte-FF4500?logo=reddit&logoColor=white)](https://www.reddit.com/r/danbyte)
[![Docs](https://img.shields.io/badge/docs-read-0ea5e9)](docs/index.md)
[![License](https://img.shields.io/badge/license-Apache_2.0-0ea5e9)](LICENSE)
[![Django](https://img.shields.io/badge/Django-5.2_LTS-092e20)](https://www.djangoproject.com/)
[![Python](https://img.shields.io/badge/Python-3.13-3776ab)](https://www.python.org/)

<img src="https://danbyte.net/readme/hero.webp" alt="Danbyte dashboard" width="900">

</div>

---

## What is Danbyte?

Danbyte tracks your network the way you actually run it: the subnets and
addresses (IPAM), the racks, devices, and cabling (DCIM), and everything that
ties them together — VLANs, VRFs, circuits, power, floor plans, and live
health.

Its one guiding idea is **no demo inventory**. Danbyte ships the *models*, not
someone else's data — no sample devices, sites, or prefixes to delete before you
start. A first run seeds only the minimal operational catalogs the app needs to
function (a small set of IP statuses and roles, and the RBAC groups); everything
that describes *your* network — device types, custom statuses and roles,
compliance rules, and custom fields — you define yourself, so the system mirrors
your network instead of a template.

## Try it — no install

Spin up a private, throwaway Danbyte in your browser at
**[danbyte.net/demo](https://danbyte.net/demo)** — a full instance seeded with a
real sample network (sites, racks, cabling, IP space, monitoring), yours for
30 minutes. No sign-up, nothing to install.

## Highlights

- **IPAM** — subnets with automatic utilization, IP addresses, VLANs, VRFs,
  route targets, and aggregates. Overlap-aware, with per-VRF uniqueness.
- **DCIM** — devices, racks with elevations, interfaces, cabling (front/rear
  ports, patch panels, modules), power panels & feeds.
- **Racks in 3D & faceplates** — walk racks in 3D and trace a cable from any
  port; map a device type's ports onto its real front/rear photo so faceplates
  show live status, speed and drift right on the panel.
- **Floor plans & maps** — draw a room or site as a grid, drop devices, racks,
  and cameras (with field-of-view cones) onto it, nest plans inside each other,
  and zoom out to a geographic map with the circuits and fibre between sites.
- **Topology map** — an interactive graph of how everything connects.
- **Certificates & keys as truth** — track TLS certificates and SSH host keys by
  fingerprint, get drift the moment reality diverges from what you recorded, and
  issue certs via **ACME** or a secret store (**Vault/OpenBao**).
- **Monitoring & SNMP drift** — multi-protocol health checks with a live status
  pipeline, plus a read-only observed layer that surfaces SNMP drift you accept
  on your own terms.
- **Lifecycle management** — record vendor EoS / EoL dates on hardware types and
  OS platforms; Danbyte draws a lifetime bar and flags what's aging out, right
  in the device table.
- **Label maker** — design QR labels per object type with a live preview, then
  print at true physical size (roll, A4 / Letter) or export a selection to Excel.
- **Compliance & governance** — configuration rules, a full change log,
  per-object journals, attachments on any object, and an audit trail.
- **Identity & access** — **SAML 2.0** SSO alongside local accounts and API
  tokens, granular role-based permissions, and optional per-site scoping for
  multi-team setups.
- **NetBox import** — migrate an existing NetBox instance over its API, with a
  live-progress UI and a safe dry-run preview (including floor plans from the
  netbox-map plugin).
- **Made yours** — tags and custom fields on everything, a customizable
  dashboard, and models you define instead of a template to delete.

## See it in action

<table>
<tr>
<td width="50%"><img src="https://danbyte.net/readme/ipam-prefixes.webp" alt="IPAM — prefixes and tree"><br><sub><b>IPAM</b> — prefixes, the derived tree and live utilization</sub></td>
<td width="50%"><img src="https://danbyte.net/readme/device-detail.webp" alt="Device detail"><br><sub><b>DCIM</b> — a device with interfaces, components and cabling</sub></td>
</tr>
<tr>
<td><img src="https://danbyte.net/readme/racks-3d.webp" alt="Racks in 3D"><br><sub><b>Racks in 3D</b> — walk the hall, trace a cable from any port</sub></td>
<td><img src="https://danbyte.net/readme/faceplate.webp" alt="Link-state faceplate"><br><sub><b>Faceplates</b> from the real device photo, lit with live status</sub></td>
</tr>
<tr>
<td><img src="https://danbyte.net/readme/floorplan.webp" alt="Floor plan"><br><sub><b>Floor plans</b> — racks, tiles and cameras on a real footprint</sub></td>
<td><img src="https://danbyte.net/readme/topology.webp" alt="Topology canvas"><br><sub><b>Topology</b> — an interactive graph of how it all connects</sub></td>
</tr>
<tr>
<td><img src="https://danbyte.net/readme/snmp-drift.webp" alt="SNMP drift"><br><sub><b>SNMP drift</b> — observed vs intended, reconciled on your terms</sub></td>
<td><img src="https://danbyte.net/readme/site-map.webp" alt="Site map"><br><sub><b>Maps</b> — every site with the circuits and fibre between them</sub></td>
</tr>
<tr>
<td><img src="https://danbyte.net/readme/label-editor.webp" alt="Label maker"><br><sub><b>Label maker</b> — QR labels for any object, printed at true size</sub></td>
<td valign="center"><sub>…and certificates as a source of truth, SAML SSO, attachments, compliance rules, and a NetBox importer. <a href="https://danbyte.net/demo">Try the live demo →</a></sub></td>
</tr>
</table>

## Quick start

Every release ships a **self-contained bundle** — Python, Node, all
dependencies, and the prebuilt frontend baked in. On a fresh Ubuntu/Debian box,
**one line** installs everything (service user, database, secrets, nginx + TLS):

```bash
curl -fsSL https://danbyte.net/install.sh | bash -s -- --host danbyte.example.com
```

It resolves the latest release, verifies the bundle's SHA-256, and runs the
installer (flags after `--` pass through). Pin a version with
`DANBYTE_VERSION=<x.y.z>`, or download the bundle manually — see the
[installation guide](https://docs.danbyte.net/getting-started/installation/).

It prints the generated admin password when it finishes — open
`https://danbyte.example.com/`, sign in as `admin`, and change it under
**User → Preferences**.

> **Requirements:** Linux, PostgreSQL 15+ (17/18 recommended), and Redis.
> Everything else is bundled — a fresh box needs nothing else, and the bundle
> works fully offline.

Prefer containers? A production **Docker / Podman** compose stack ships too.
Building from source or setting up a dev checkout? See the
**[installation guide](https://docs.danbyte.net/getting-started/installation/)**.

## Tech stack

Python 3.13 · Django 5.2 LTS · Django REST Framework · PostgreSQL · Redis + RQ
workers · a React / TanStack single-page frontend, served behind nginx and run
as rootless systemd services.

## Documentation

The full docs live in **[`docs/`](docs/index.md)** — installation, every
feature, the data model, the API, and the architecture notes. A few good
starting points:

- [installation guide](https://docs.danbyte.net/getting-started/installation/)
- [IPAM objects](https://docs.danbyte.net/ipam/) · [Device catalog](https://docs.danbyte.net/dcim/device-catalog/)
- [NetBox import](https://docs.danbyte.net/features/netbox-import/)
- [Permissions & access](https://docs.danbyte.net/features/permissions/)

## Status

Danbyte is preparing its **first public preview**. It's already running real
infrastructure, but expect some rough edges and moving parts while the public
release settles. Feedback and issues are welcome.

## License

Danbyte is licensed under the **Apache License, Version 2.0** — see
[LICENSE](LICENSE) and [NOTICE](NOTICE). You may use, modify, and distribute
it (including commercially) under the terms of that license.
