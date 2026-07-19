# Outposts — distributed monitoring engines

Danbyte's monitoring (ICMP/TCP/SNMP checks, prefix sweeps, SNMP discovery) runs
on the **core server's workers** by default. But a remote site with **no direct
path to the core** (a branch office, an isolated colo, a DMZ) can't be reached
from the centre — so it can't be pinged, swept, or polled.

An **Outpost** is a lightweight agent you install *at* that site. It monitors the
local network and reports results back to the core over an **outbound HTTPS**
connection — so it works through NAT and firewalls, and the core never has to
connect *into* the remote network.

## Engines

Every check runs on a **monitoring engine**:

- **Local (built-in)** — the core server's workers. Always present; anything not
  assigned to an Outpost runs here, so nothing changes if you never install one.
- **Outpost** — a remote engine. You create it in Danbyte, install the agent at
  the site, and assign it a scope.

Manage them in **Governance → Monitoring engines** (admin only).

## How an engine is chosen for a target

For each monitored IP, Danbyte resolves the engine **most-specific first**, and
each level **inherits** from the next when it has no engine of its own:

1. the IP's device **Location**, then its **parent locations** (a child location
   left on *Inherit* falls through to its parent),
2. the IP's **Site**,
3. the tenant **default engine** (set on the Monitoring engines page),
4. the built-in **Local** engine.

Assign an engine on the **Site** or **Location** edit form (the *Monitoring
engine* dropdown — *Inherit* follows the level above). So "everything at Site
AMS-02" is one setting; a single rack row (a child location) can override it,
and anything left on *Inherit* rolls up to the site, then the tenant default.

## The agent repo + staying compatible

The agent lives in its **own repo, `danbyte-outpost`**
(`github.com/danbyte-net/danbyte-outpost`), so sites can install and upgrade it
independently. This monorepo stays the **source of truth for `danbyte_checks/`**
(the shared check engine); the agent repo vendors it and re-syncs
(`scripts/sync-checks.sh`) before a release.

**The rule that keeps remotes working:** an Outpost and the core are on
**separate upgrade schedules** — a branch office may run a months-old agent
against a freshly-upgraded core. So:

- **Add a check kind → the remote must be able to run it.** Because the engine is
  shared, add the checker to `danbyte_checks/` here, then sync + release the
  agent. Until a remote upgrades, that kind returns **`unknown`** there (handled
  in the agent's `run_check`), never a crash — the core can ship the kind before
  every remote supports it.
- **The wire protocol is additive.** New fields on hello/work/results are
  optional; unknown fields are ignored. A breaking change bumps
  `PROTOCOL_VERSION` (the agent sends it in `hello`) and the core must keep
  serving older-protocol Outposts.

Full contract: `docs/COMPATIBILITY.md` in the danbyte-outpost repo. **Whenever you
extend the monitoring engine, check that doc.**

## Transports — which way traffic flows

Sites differ in what their firewall allows, so an Outpost's **transport** is set
per engine. The agent and the check code are identical; only the channel changes.

- **HTTPS (Outpost dials out, 443)** — the Outpost opens an outbound connection
  to Danbyte, pulls its work, and pushes results. For NAT'd branch offices that
  can reach out but can't be reached in. Authenticated by the install **token**.
  *(Shipped.)*
- **SSH (Danbyte dials in, 22)** — for locked-down / airgapped sites where the
  *only* permitted flow is `Danbyte → host` on SSH. Danbyte connects out to the
  Outpost over SSH each cycle and runs `danbyte-outpost once` (work in on stdin,
  results out on stdout) — the site never opens a connection to Danbyte. Set the
  host / user / SSH key on the engine's detail dialog; Danbyte drives it on a
  timer (`drive_outposts`). Pin the host's public key (`ssh_host_key`, from
  `ssh-keyscan -t ed25519 <host>`) to verify the server — blank falls back to
  trust-on-first-use with a logged warning. *(Shipped.)*

Both channels are encrypted (TLS for HTTPS, SSH for SSH). A third option —
**HTTPS dial-in** (Danbyte → Outpost:443, the Outpost running a small listener) —
is possible where 443-inbound is allowed but SSH isn't; SSH is the airgapped
default, so HTTPS-in is a later add if a site needs it. You pick the transport
when you add the Outpost.

## Getting the agent — the Danbyte package store

The Danbyte instance is a **version store** for the Outpost, so remote hosts only
ever pull from Danbyte (never GitHub/PyPI) — which is what makes airgapped
installs work. On the **Monitoring engines** page an admin adds Outpost builds
four ways:

- **From your repo (dropdown)** — set the agent repo once (**Outpost repo** field,
  with an optional token for a private repo); the package store then lists the
  repo's releases in a dropdown. Pick one → Danbyte fetches that release's
  CI-built binary and serves it. The easiest path.
- **Fetch built binary** — paste a repo URL + tag (a `…/tree/v1.2.0` URL
  auto-fills the ref); Danbyte downloads that release's binary asset.
- **Upload a file** — a built single-binary or wheel/tarball.
- **Source install (git)** — a git URL + ref; the host does
  `pip install git+url@ref` (needs Python + git access on the host, so not for
  airgapped or private repos).

A bare binary installs with no Python on the host (download + `chmod +x`); a
wheel/git release installs into a venv.

Each becomes a named **version** (e.g. `1.4.0`), one of which is the default.
Enrolling an Outpost shows a version-pinned install one-liner pointed at Danbyte
*itself* serving that exact build:

```bash
curl -fsSL https://<danbyte>/api/outpost/install.sh | sudo sh -s -- --token=<TOKEN>
```

The generated script writes a systemd unit wired to this instance + the token and
starts it. It adapts to the release kind:

- a **single binary** (built by the agent repo's release CI) → downloaded and
  `chmod +x`ed, **no Python needed on the host**;
- a **wheel/sdist** → installed into a venv under `/opt` with `pip`;
- a **git** release → a source install (`pip install git+url@ref`).

File/binary artifacts are served from Danbyte (`/api/outpost/download/<version>/`,
token or admin auth), so you can pin a version per site, roll out upgrades
centrally, and stay fully airgapped. Manage versions under **Governance →
Monitoring engines → Outpost versions**. *(Shipped.)*

## Installing an Outpost — step by step

1. **Upload a build** (once): Governance → Monitoring engines → *Outpost
   versions* → upload a wheel/sdist, or add a git repo + ref. Mark one default.
2. **Add the Outpost** and pick its transport (HTTPS-pull or SSH).
3. **Enroll** it → copy the one-liner (the token is shown **once**).
4. On a host *at the site*, run the one-liner as root. It installs + starts the
   agent, which immediately dials out and begins pulling work.
5. **Assign** it to a site or location (on their forms) → everything in that
   scope is now monitored by the Outpost. Watch it go healthy on the engine's
   detail dialog.

   *SSH transport:* skip steps 3–4's one-liner — instead set the host/user/key on
   the engine's detail dialog; Danbyte installs & drives it over SSH.

## Installing

The Outpost's only hard dependency is the Danbyte instance it talks to — so the
**Danbyte instance serves the installer and the binary**, and airgapped hosts
never need GitHub or PyPI. Three ways to get it on a host:

1. **Danbyte-served (default).** The enroll dialog gives a copy-paste one-liner
   pointed at *this* instance:

   ```bash
   danbyte-outpost run --url=https://danbyte.example.com --token=<TOKEN>
   ```

   The install script + binary are fetched from `https://<danbyte>/outpost/…`, so
   443-only hosts install fine.
2. **Danbyte-pushed over SSH (airgapped).** For an SSH-transport engine, Danbyte
   pushes the binary and installs it over the allowed `Danbyte → host:22` channel
   — nothing to run at the site.
3. **Offline tarball.** A downloadable archive for a fully-isolated host (carry it
   in), or for building from the public repo.

## Installing an Outpost

1. **Governance → Monitoring engines → Add Outpost**, give it a name.
2. It's **enrolled** automatically — copy the one-time `OUTPOST_URL` +
   `OUTPOST_TOKEN` (shown once; **Rotate** issues a new token and revokes the
   old one).
3. Install the agent on a host at the site (from the **danbyte-outpost** repo, or
   the package-store one-liner above) with those two values. It connects
   outbound, appears **healthy** on the engines page, and starts running its
   assigned checks.

The token only **identifies** the Outpost — it doesn't encode the worklist. What
to monitor is the sites/locations you assign to it, resolved live, so adding a
device is picked up on the next poll with no re-enrollment.

> **One tenant per engine.** An Outpost only ever sees its own tenant's targets
> and credentials. A colo serving two tenants runs two Outposts.

## Status

- **Phase 0 (shipped)** — the control plane: engines, the built-in local engine,
  site/location/tenant assignment, the settings UI.
- **Phase 1 (shipped, HTTPS pull)** — the agent protocol: `/api/outpost/{hello,
  work,results}` (Bearer-token auth), the `dispatch()` split (local → RQ, remote
  left for the Outpost to pull, claimed so nothing double-runs), and results
  ingested through the *same* path as the core (`worker.ingest_results`).
- **Shared engine (shipped)** — the checkers are a standalone `danbyte_checks`
  package the core *and* the Outpost import, so **every kind (ICMP/TCP/UDP/HTTP/
  SNMP/SSH/Telnet) runs identically on both** — no drift. Verified end-to-end.
- **SSH transport (shipped)** — Danbyte drives airgapped Outposts over SSH
  (`danbyte-outpost once`, driven by `drive_outposts` on a timer); the SSH
  host/user/key are set on the engine.
- **Package store (shipped)** — admins upload an Outpost build (file or git ref)
  as a named version; Danbyte serves it and generates the version-pinned
  installer, so airgapped hosts pull only from Danbyte.
- **Agent auto-update (shipped)** — mark a version the **golden image** (the
  default release) and toggle **Auto-update** on an Outpost. On its heartbeat the
  core tells an auto-updating agent to move to the golden version if it differs;
  the (binary) agent downloads it, atomically swaps its own executable, and exits
  so systemd restarts on the new binary. Roll out an upgrade fleet-wide by making
  a new version golden.
- **Site/location SNMP credentials (shipped)** — `SnmpProfileBinding` now scopes
  to a site or location, so a site's Outpost polls its devices with site-scoped
  credentials (resolver: device → role → type → location → site → tenant default).
- **SNMP discovery over the Outpost (shipped)** — the agent pulls
  `GET /api/outpost/snmp-work` (its devices + scoped creds), runs the *same*
  `danbyte_checks.snmp_facts.fetch_snmp` the core runs, and posts back to
  `POST /api/outpost/snmp` → persisted through `persist_snmp_result`, the same
  path as a local poll. Runs on a slower cadence (default 900 s) than checks.
- **Subnet discovery over the Outpost (shipped)** — the agent pulls
  `GET /api/outpost/sweep-work` (its site's discovery-enabled prefixes),
  ICMP-sweeps each locally with the shared `danbyte_checks.sweep.sweep_cidr`, and
  posts live IPs to `POST /api/outpost/discovered` → `_create_for_alive`, the same
  path a local sweep uses (default 600 s). The core's `run_discovery` leaves
  remote-engine prefixes for their Outpost. So an Outpost now does **everything
  the core does** — checks, SNMP discovery, and subnet sweeps — for its scope.
  **Discover now** on a prefix served by an Outpost routes to *that* Outpost
  (the core can't reach the remote subnet): it flags the prefix + pokes the
  engine (`sweep_requested_at`), the agent sees `sweep_pending` on its next
  `/work` poll (~15 s) and sweeps immediately, and the button spinner clears when
  the prefix's `last_discovered_at` advances.
- **SSH host-key pinning (shipped)** — pin `ssh_host_key` on the engine and
  Danbyte verifies the server on every SSH connection.
- **Single-binary packaging (shipped)** — the agent repo's release CI builds a
  single-file binary on a tag; upload it to the package store and Danbyte's
  installer drops it with no Python on the host.
- **Engine health / dead-Outpost detection (shipped)** — the dispatcher's
  every-minute sweep flags a remote engine with assigned checks that hasn't
  polled within ~3× its interval (min 3 min): a red **"engine unreachable — N
  checks stalled"** banner appears on the Monitoring pages, and the tenant's
  notification channels get an *engine unreachable* event (and a *recovered*
  event when it comes back). Engines with no assigned checks never alert.
