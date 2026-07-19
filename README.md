<div align="center">

# Danbyte

**A customizable IPAM / DCIM platform — one place for your IP space, your physical gear, and how it all connects.**

[![Version](https://img.shields.io/github/v/tag/danbyte-net/danbyte?label=version&color=0ea5e9)](https://github.com/danbyte-net/danbyte/releases)
[![Docs](https://img.shields.io/badge/docs-read-0ea5e9)](docs/index.md)
[![Django](https://img.shields.io/badge/Django-5.2_LTS-092e20)](https://www.djangoproject.com/)
[![Python](https://img.shields.io/badge/Python-3.13-3776ab)](https://www.python.org/)

<!-- SCREENSHOT: hero — the dashboard in dark mode. See "Screenshots wanted" at the bottom. -->
<!-- ![Danbyte dashboard](docs/assets/readme/hero.png) -->

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

## Highlights

- **IPAM** — subnets with automatic utilization, IP addresses, VLANs, VRFs,
  route targets, and aggregates. Overlap-aware, with per-VRF uniqueness.
- **DCIM** — devices, racks with elevations, interfaces, cabling (front/rear
  ports, patch panels, modules), power panels & feeds.
- **Floor plans** — draw a room or site as a grid, drop devices, racks, and
  cameras (with field-of-view cones) onto it, and nest plans inside each other.
- **Topology map** — an interactive graph of how everything connects.
- **Lifecycle management** — record vendor EoS / EoL dates on hardware types
  and OS platforms; Danbyte draws a lifetime bar and flags what's aging out,
  right in the device table.
- **Monitoring** — multi-protocol health checks for addresses and prefixes,
  with a live status pipeline.
- **Compliance & governance** — configuration rules, a full change log,
  per-object journals, and an audit trail.
- **NetBox import** — migrate an existing NetBox instance over its API, with a
  live-progress UI and a safe dry-run preview (including floor plans from the
  netbox-map plugin).
- **Made yours** — tags and custom fields on everything, granular
  role-based permissions, and optional per-site scoping for multi-team setups.

<div align="center">

<!-- SCREENSHOT: a 2x2 or side-by-side of the canonical list page + a detail page. -->
<!-- ![Prefixes list](docs/assets/readme/prefixes.png) ![Device detail](docs/assets/readme/device.png) -->

</div>

## Quick start

Every release ships a **self-contained bundle** — Python, Node, all
dependencies, and the prebuilt frontend baked in. On a fresh Ubuntu/Debian box,
one command installs everything (service user, database, secrets, nginx + TLS):

```bash
curl -fsSLO https://github.com/danbyte-net/danbyte/releases/latest/download/danbyte-<version>-linux-x86_64.tar.gz
tar xzf danbyte-<version>-linux-x86_64.tar.gz
cd danbyte-<version>-linux-x86_64
sudo ./install.sh --host danbyte.example.com
```

It prints the generated admin password when it finishes — open
`https://danbyte.example.com/`, sign in as `admin`, and change it under
**User → Preferences**.

> **Requirements:** Linux, PostgreSQL 15+ (17/18 recommended), and Redis.
> Everything else is bundled — a fresh box needs nothing else, and the bundle
> works fully offline.

Building from source or setting up a dev checkout? See the
**[installation guide](docs/getting-started/installation.md)**.

## Tech stack

Python 3.13 · Django 5.2 LTS · Django REST Framework · PostgreSQL · Redis + RQ
workers · a React / TanStack single-page frontend, served behind nginx and run
as rootless systemd services.

## Documentation

The full docs live in **[`docs/`](docs/index.md)** — installation, every
feature, the data model, the API, and the architecture notes. A few good
starting points:

- [Installation](docs/getting-started/installation.md)
- [IPAM objects](docs/features/ipam-objects.md) · [Device catalog](docs/dcim/device-catalog.md)
- [NetBox import](docs/features/netbox-import.md)
- [Permissions & access](docs/features/permissions.md)

## Status

Danbyte is preparing its **first public preview**. It's already running real
infrastructure, but expect some rough edges and moving parts while the public
release settles. Feedback and issues are welcome.

## License

Danbyte is licensed under the **Apache License, Version 2.0** — see
[LICENSE](LICENSE) and [NOTICE](NOTICE). You may use, modify, and distribute
it (including commercially) under the terms of that license.

---

<details>
<summary><b>Screenshots wanted</b> (for whoever fills these in)</summary>

The placeholders above are marked with `<!-- SCREENSHOT: ... -->`. The shots
that would sell the project fastest, in priority order:

1. **Dashboard**, dark mode — the hero image.
2. **Prefixes list page** — the canonical dense table with the filter rail.
3. **A device detail page** — showing the rack elevation + interfaces.
4. **A floor plan** — with a few device/camera tiles placed.
5. **The topology map** — an interesting connected graph.
6. **NetBox import** — the live-progress run panel mid-import.

Drop them in `docs/assets/readme/` and uncomment the matching `![...]` lines.
1600px-wide PNGs look crisp on GitHub; dark mode reads best for the hero.

</details>
