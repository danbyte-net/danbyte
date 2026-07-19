---
icon: lucide/import
---

# Import from NetBox

Migrate an existing **NetBox** instance into Danbyte over NetBox's REST API. The
importer pulls every supported object type, resolves cross-references, and writes
them into one Danbyte tenant. Re-running is safe: existing objects are skipped
unless you opt into updating them.

There are two ways to run it — the **UI** (best for most migrations) and the
**CLI** (for very large or air-gapped moves).

## From the UI

**Import → NetBox** (tenant admins only). The import runs in the background on
the job queue, so you can watch it progress and leave the page.

1. **Connect** — paste your NetBox URL and a (read-only is fine) API token.
   *Allow self-signed certificate* covers an internal NetBox with a private CA.
   **Test connection** shows the NetBox version and a count of the big object
   types, so you can see what's about to be pulled.
2. **Options** — **Dry run** (on by default) fetches and builds the whole graph
   in a transaction that's rolled back at the end: real counts, nothing saved.
   **Update existing objects** re-applies NetBox values to objects already in
   Danbyte — it **overwrites local edits**, so it's off by default.
3. **Run** — a progress bar tracks the current step (e.g. *devices · 12/58*), and
   a live table fills in per type: fetched / new / existing / updated / failed /
   skipped.
4. **Result** — totals, any notes, and a table of failures (one row per object
   that couldn't be created, with the reason). After a clean dry run, a
   **Run for real** button appears.
5. **Recent imports** lists past runs; click one to re-open its report.

**Failed vs skipped.** *Failed* means Danbyte tried to create the object and
couldn't — those rows appear in the failures table with the exact error.
*Skipped* means the importer deliberately left the row out: its parent didn't
make it into the import (e.g. a front port whose rear port is missing), or
there's nothing to create (a planned NetBox cable with no terminations yet).
Each skip reason is tallied in the notes with a few sample NetBox IDs, so an
all-skipped type is diagnosable straight from the report. If a whole endpoint
couldn't be fetched (timeout, TLS, permissions), that surfaces both as a note
and as a failure row for the type — it never disappears silently.

!!! note "Security"
    The NetBox URL is **SSRF-guarded** on the server — it must resolve to a
    public address, so the import can't be pointed at internal services or
    cloud-metadata endpoints. An internal NetBox (a `10.x` / `192.168.x`
    address) is reached by allow-listing it under **Settings → Deployment →
    Outbound connections** (deployment admins only — a tenant admin must not
    be able to widen the guard), or via the `DANBYTE_SSRF_ALLOWLIST` env var. The API token is encrypted at rest and
    **erased when the run finishes** — a migration credential shouldn't outlive
    the migration. (The CLI is unguarded: an operator running it already
    controls the server.)

## From the CLI

For a very large instance, or one only reachable from the server's shell:

```bash
cd /opt/danbyte/danbyte
sudo -u danbyte .venv/bin/python manage.py import_netbox \
    --url https://netbox.example.com \
    --token <NETBOX_API_TOKEN> \
    --tenant default \
    --report netbox-import.json
```

| Flag | Purpose |
|---|---|
| `--url` / `--token` | NetBox base URL + API token (required) |
| `--tenant` | Target Danbyte tenant slug (default: `default`, else the only tenant) |
| `--org` | Disambiguate the tenant by organization name |
| `--only` / `--skip` | Comma lists of types to include / exclude |
| `--insecure` | Skip TLS verification (self-signed NetBox) |
| `--dry-run` | Build everything, then roll back — a true preview |
| `--update-existing` | Re-apply NetBox values to existing rows (overwrites local edits) |
| `--with-images` | Download device-type front/rear images from NetBox media |
| `--report` | Write a JSON summary (per-type counts + every failure) to this path |

## How it works

- **One tenant.** Everything lands in a single Danbyte tenant (a hard isolation
  boundary). NetBox's own soft `tenant` label is kept on each object as
  `custom_fields.netbox_tenant`, and its NetBox id as `custom_fields.netbox_id`.
- **Dependency order.** Catalogs → geography → power → IPAM → devices →
  components → virtualization → IP addresses → services → cables → circuits →
  contacts → floor plans (netbox-map plugin, if present), then finalize passes
  that wire the relations which form cycles (interface LAG/parent/bridge,
  device/VM primary IP, virtual-chassis).
- **Idempotent.** Each object is matched on a natural key (cables on an existing
  termination); a re-run only fills gaps and counts the rest as *existed* — or,
  with **update existing**, re-applies NetBox's values and counts them
  *updated*.
- **Resilient.** Each object is its own savepoint. One bad row is recorded
  (type, name, NetBox id, reason) and the import continues.

**Prefix requirement.** Danbyte requires every IP to belong to a prefix. For
each NetBox IP the importer attaches it to the most-specific imported prefix
that contains it; if none exists it auto-creates one from the IP's own mask
(tagged `custom_fields.source = "netbox-import (auto)"`).

## Coverage

**Imported** — manufacturers, platforms, device/rack/IP roles, RIRs, cluster
types/groups, circuit types, providers & networks, contact roles/groups, route
targets, VRFs, regions, sites, locations, aggregates, ASNs, racks, **power
panels & feeds**, device types, **module types**, component templates, clusters,
VLAN groups, VLANs, prefixes, IP ranges, devices, virtual chassis, **module
bays, modules, device bays, inventory items**, interfaces (with LAG / parent /
bridge), console + **console-server** ports, power ports + **outlets**, rear /
front ports, **MAC addresses**, virtual machines & interfaces, IP addresses,
**services & templates**, FHRP groups **+ assignments**, cables (+ terminations),
circuits (+ terminations), contacts (+ assignments), and tags + custom-field
values on everything that carries them.

**Floor plans (netbox-map plugin).** If the source NetBox runs the
[netbox-map](https://github.com/danbyte-net/netbox-map) plugin, its
floorplans and tiles come along too: plans map to Danbyte floor plans
(a plan hung directly on a NetBox *site* lands in a per-site
"Imported floor plans" location), tile positions/sizes/labels are preserved,
device- and rack-linked tiles resolve to the imported objects,
`floorplan_link` tiles become nested-plan navigation, camera tiles keep their
field-of-view cone, and each distinct plugin `tile_type` is minted as a
tenant **floor tile type** (with a sensible icon). Background images are
downloaded on real runs (skipped during a dry run — file writes can't roll
back). A NetBox without the plugin just gets a note; nothing fails.

**Not imported yet** (Danbyte has the model, NetBox has the data — planned):
tunnels & IPSec profiles, L2VPNs, wireless LANs, config contexts / templates,
image attachments, journal entries, webhooks. A cable to a NetBox circuit
termination is skipped (Danbyte cables don't terminate on circuits).

**No Danbyte equivalent** (skipped by design): site groups, rack
reservations, 1:1 NAT links, VLAN translation, virtual disks, custom links,
saved filters, data sources / GitOps sync, scripts, event-rule DSLs.

## Reading the report

Every run — UI or CLI — produces the same per-type breakdown:

```
NetBox → Danbyte import  (tenant: default)
──────────────────────────────────────────────────────────────
TYPE                    FETCH    NEW  EXIST    UPD   FAIL
manufacturers              12     12      0      0      0
sites                       4      4      0      0      0
devices                    87     85      0      0      2
ip_addresses              512    509      0      0      3
──────────────────────────────────────────────────────────────
TOTAL                     ...

Failures (5):
  ✗ [devices] core-sw-01 (nb#123): <reason>
  …
```

Re-running after fixing the source data (or a Danbyte bug) picks up only the
rows that didn't make it the first time.
