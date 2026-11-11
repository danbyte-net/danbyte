---
icon: lucide/sliders-horizontal
---

# Discovery: settings

Every switch and environment variable that changes what Discovery does,
where it runs in the background, and what an existing install needs after an
upgrade. Profile fields are on [Scope and safety](discovery-safety.md#profile-fields).

!!! info "Where to find it"
    - **This deployment**, the transports, **nmap**, **Deny subnets**: the
      **Host discovery** section of **Monitoring → Settings**
      (`/monitoring/settings`, under *Setup*; also **Settings →
      Monitoring**).
    - The tenant switch: the **Discovery** card under **Settings →
      Integrations**.
    - The timer's last run: **Jobs → Scheduled tasks**, row *Package
      inventory*.

## Switches in Danbyte

| Switch | Scope | Default | Who changes it | Effect |
|---|---|---|---|---|
| **This deployment** | deployment | off | deployment admin; nobody while `DANBYTE_DISCOVERY_ENABLED` is set | Whether any tenant may use Discovery. Every change is in the change log; the section shows the last one. |
| **Discovery** card | tenant | off | tenant admin | Discovery for this tenant. **Host discovery** shows it read-only (*On* / *Off*) with a link to **Integrations**. |
| **SSH key login** | tenant | on | tenant admin | [Transports](discovery-credentials.md#transports) |
| **SSH password login** | tenant | on | tenant admin | Off stops every password login. |
| **WinRM over HTTPS** | tenant | off | tenant admin | Only while the deployment allows it and the server can run it. |
| **nmap** | tenant | off | tenant admin | Service scans may use nmap; only while the server or an Outpost has one and the deployment allows it. |
| **Deny subnets** | tenant | empty | tenant admin | Up to 500 CIDRs nothing in Discovery contacts. |

Discovery is on for a tenant only while both the deployment switch and the
tenant switch are on. Then the **Host discovery** section shows the tenant
settings; before that it shows the two switches and *Off for this
deployment* or *Off for this tenant*. Switching either one off hides every
Discovery page (the API answers *not found*), stops schedules, and resolves
the tenant's package and OS-build matches; switching it back on re-matches.
The settings save as they change.

## Environment variables

Set them in the environment of the web, worker and timer units (or the
compose services), then restart them.

| Variable | Default | Values | Effect |
|---|---|---|---|
| `DANBYTE_DISCOVERY_ENABLED` | unset | unset or empty; `true`, `1`, `yes`, `on`; anything else | Unset: the deployment switch is the stored **This deployment** setting. A true value locks it on (*Locked on by the deployment*); any other value, `False` included, locks it off (*Locked off by the deployment*). The API refuses changes with 409 while it is set. |
| `DANBYTE_DISCOVERY_WINRM_ALLOWED` | `True` | `false`, `0`, `no`, `off` forbid | Forbids WinRM for every tenant; **WinRM over HTTPS** shows *Forbidden by the deployment*. |
| `DANBYTE_DISCOVERY_WINRM_CA_BUNDLE` | the system CA bundle | path of a PEM file | The CA bundle WinRM server certificates are verified against. Point it at a bundle that holds your internal CA. |
| `DANBYTE_DISCOVERY_ALLOW_FIRST_USE_KEYS` | `True` | `false`, `0`, `no`, `off` forbid | Removes **Accept new host keys** from **Run now** everywhere; the API refuses it. Scheduled runs never use it either way. |
| `DANBYTE_DISCOVERY_SCAN_MAX_RATE` | `200` | a number; clamped to 1 to 2000 | The cap on a service scan's **Connects per second**, whatever a profile asks. A value that is not a number stops the service at start. |
| `DANBYTE_DISCOVERY_NMAP_ALLOWED` | `True` | `false`, `0`, `no`, `off` forbid | Forbids the nmap engine for every tenant, on the server and on Outposts; **nmap** shows *Forbidden by the deployment*. |
| `NMAP_BINARY` | unset | an absolute path | The nmap the administrator installed. Unset: `nmap` on the service user's PATH. Looked up once per process. Danbyte never installs nmap. |
| `DANBYTE_VULN_MSRC_MONTHS` | `12` | a number; clamped to 1 to 36 | How many months of Microsoft's data the server fetch reads ([details](../reference/settings.md#microsoft-data-window-danbyte_vuln_msrc_months)). |
| `DANBYTE_CHECK_BLOCK_INTERNAL` | `False` | `True` blocks | Also refuses loopback, private, reserved and multicast targets on the server ([the target policy](discovery-safety.md#the-target-policy)). |
| `DANBYTE_SSRF_ALLOWLIST` | empty | comma-separated CIDRs | Addresses let through the target policy either way. |

On an Outpost, `OUTPOST_NMAP_BINARY` (or `--nmap`) names the agent's own nmap
([On an Outpost](discovery-outposts.md#nmap-on-an-outpost)).

## Queue and timer

| Piece | What it does |
|---|---|
| RQ queue `discovery` | Every run. Kept off `low` so a long run never holds up vulnerability recomputes; a job may take up to 6 hours. The shipped `danbyte-workers` unit (`rqworker-pool default high low discovery`) and the compose worker listen on it. |
| `danbyte-inventory.timer` → `manage.py inventory_dispatch` | Every 15 minutes (`run_scheduler` in a container). Queues the profiles that are due and inside their window, gives up runs whose worker died (older than 6 hours), expires Outpost work nobody picked up within 30 minutes or did not report in time, and deletes packages removed more than 30 days ago. It queues nothing while the deployment switch is off, but still purges and gives up. Its last run is the *Package inventory* row under **Jobs → Scheduled tasks**. |
| RQ queue `low` | What a read feeds into vulnerability data: re-matching the hosts whose packages or OS facts changed, the advisory fetch for new packages (server mode), the install sync after an application's package names change. |

When Redis is down, **Run now** still creates the run and marks it failed
with *The background workers are not reachable.*

## Upgrade notes

Discovery arrived in 0.20.

- **Workers.** The shipped worker unit and compose file listen on
  `discovery`. A worker drop-in or compose override that replaces the worker
  command must add `discovery` to its queue list, or runs stay *Queued*.
- **Timer.** `danbyte-inventory` is a new timer. The upgrader turns on a
  release's new timers; an install that manages its units by hand must
  enable it (`make install-services` links and enables every timer) for
  scheduled runs.
  **Run now** works without it, but then unclaimed Outpost work never
  expires and removed packages are never purged.
- **Outposts.** Profiles that run on Outposts need agent 0.10.0 or later
  there ([On an Outpost](discovery-outposts.md#which-agent-version)); the
  upgrade notes show this step while one does not offer discovery.
- **Nothing is on by default.** Both switches start off, profiles start
  disabled, and nothing is contacted until a profile is authorised.
- **nmap and WinRM** need nothing unless you use them: install nmap and
  restart the web and worker units; for WinRM, put your CA in the server's
  trust store or `DANBYTE_DISCOVERY_WINRM_CA_BUNDLE`.
