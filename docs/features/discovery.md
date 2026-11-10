---
icon: lucide/scan-search
---

# Discovery: package inventory

Danbyte can log in to your Linux devices and VMs over SSH, read what is
installed, and match those exact package versions against the
[vulnerability data](vulnerabilities.md). A Debian, Ubuntu, RHEL-family or
Alpine host then gets CVE results from its own distro's advisories, with
backported fixes counted - something a version banner can never tell
([#451](https://github.com/danbyte-net/danbyte/issues/451)).

It uses the SSH credentials you already keep on each host and reads only.
Nothing is installed on the host, nothing is written there, and no command
runs that is not listed on this page.

!!! note "What comes later"
    This is the Linux part of built-in discovery. Reading Windows hosts, a
    service scan of your own address space and an optional nmap adapter are
    planned as separate switches on the same card. They are not here yet.

## Turn it on

Three things must all be true before Danbyte contacts any host:

1. **The deployment allows it.** Set `DANBYTE_DISCOVERY_ENABLED=True` in the
   environment of the web, worker and timer units and restart them (see
   [Settings](../reference/settings.md#discovery)). It is off by default.
2. **The tenant turns it on.** A tenant admin switches on **Discovery** under
   **Settings → Integrations**. While the deployment switch is off the card
   says *Off for this deployment*.
3. **A profile is authorised.** An inventory profile names what to read. It
   runs only after someone has written down who authorised it - see
   [Authorisation](#authorisation).

With any of the three off, the pages and the API answer *not found*, the
schedule queues nothing, and package matches are resolved.

## Inventory profiles

**Discovery** in the sidebar (or **Profiles** on the integration card) lists
the tenant's inventory profiles. A profile has:

| Field | Meaning |
|---|---|
| Scope | Sites, prefixes, devices and VMs. A host is read when it is named, sits at a named site, or its primary address (a device's out-of-band address when it has no primary) is in a named prefix of the same VRF. |
| Every | Hours between scheduled runs. `0` means Run now only. Default 24. |
| Window | A daily start and end time, server time, that runs may start in. An end before the start spans midnight. Empty means any time. |
| Hosts at once | How many hosts one run reads in parallel, 1 to 16. Default 4. |
| Per-host timeout | Seconds for one host from connect to the last line, 10 to 600. Default 60. |
| Authorisation | The recorded statement of who authorised reading this scope. |

A profile page shows the scope as it resolves right now on its **Hosts**
tab - each host, its address, the credential it would use and why it would
be left alone - without contacting anything. Its **Runs** tab lists the
runs; a run's page lists every host it considered.

**Run now** queues a run at once. It needs the `scan` permission on the
profile (see [Permissions](#permissions)); while a run is queued or running
the button reads *Running…*.

## Authorisation

Logging in to hosts can be against policy, a contract or the law unless
someone with the authority said yes. So a profile records it:

- Saving a statement in **Authorisation** records you as the authoriser,
  with the time. The profile page shows the statement, the name and the
  time, and the change log keeps every version.
- Changing the scope (sites, prefixes, devices, VMs) without saving a new
  statement in the same edit clears the authorisation. The profile stops
  running until someone records it again.
- A profile without an authorisation never runs, on schedule or by hand.

## Which hosts are read

When a run starts - never when it was queued - Danbyte resolves the scope
inside the profile's tenant again, and leaves a host alone, without
connecting, when one of these applies. Each is a result on the run's host
list:

| Result | Why |
|---|---|
| No address | The host has no primary (or out-of-band) address. |
| Exempt | The host, its address or a prefix around it is exempt from discovery (below). |
| Deny subnet | The address is in one of the tenant's discovery deny subnets (any VRF) or a [monitoring deny subnet](monitoring.md) of its VRF. |
| Blocked target | The server's target policy refuses it: link-local and cloud-metadata addresses always, internal ranges where `DANBYTE_CHECK_BLOCK_INTERNAL` is on. |
| In maintenance | The host is in an open [maintenance event](maintenance.md). |
| No SSH credential | The host has no device credential of kind *SSH key* or *SSH password*, or its secret cannot be read. A key login is preferred when it has both. |
| Host key not accepted | No SSH host key has been accepted for the host. |

A run started with **Run now** also reads only the hosts the person who
pressed it may view, with credentials they may view. A scheduled run reads
the whole scope its authorisation covers. A run reads at most 4,096 hosts.

### Exempting a host, address or prefix

A device, VM, IP address or prefix can be marked *exempt from discovery*;
nothing in discovery contacts it, whatever a profile says. A prefix exempts
every address inside it. On a profile's **Hosts** tab, **Exempt** and
**Include** set it for a device or VM (they need *change* on it); the API
sets it on all four:

```http
POST /api/discovery/exempt/
{"kind": "device|virtual_machine|ipaddress|prefix", "id": "<uuid>", "exempt": true}
```

The change is in the object's change log like any edit.

### Deny subnets

**Deny subnets** on the Discovery page holds CIDRs, any VRF, that nothing in
the tenant's discovery ever contacts. Tenant admins change them; the
monitoring deny subnets apply as well.

## Host keys and credentials

An inventory run sends a credential to the host, so a host that is not who
it claims to be could collect it. Danbyte therefore reads a host only when
its SSH host key is one a person **accepted**: uploaded, or observed and
then accepted, in the [SSH host-key inventory](../monitoring/ssh-host-keys.md).
The key is checked during the SSH handshake, before any credential is sent.

When a host has no accepted key, or presents a different one, the run marks
it *Host key not accepted* and records the key it presented as *observed*
(that takes a key exchange only, no login). Accept it on the host-key list
once you have checked the fingerprint; the next run reads the host.

Credentials are the host's own [device credentials](device-access.md), now
on VMs as well as devices. The secret is read from the secret store when the
run connects, held in memory for that connection, and never written to the
run, its host results or the log. Nothing in the run's API answers carries
it.

The SSH connection uses only that credential: no ssh-agent, no keys or
config from the server account, no GSS or host-based login.

## What is run on the host

These are the only commands. They are constants in the code
(`danbyte_checks/inventory.py`); no part of a name, address or any other
value you enter is ever placed in one.

| Step | Command |
|---|---|
| The distro | `cat /etc/os-release` (or `cat /usr/lib/os-release` when the first fails) |
| Debian, Ubuntu | `dpkg-query -W -f='${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\t${Architecture}\t${db:Status-Abbrev}\n'` |
| RHEL, Rocky, AlmaLinux, Fedora, SUSE, Amazon | `rpm -qa --qf '%{NAME}\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\t%{ARCH}\t%{SOURCERPM}\n'` |
| Alpine | `cat /lib/apk/db/installed` |

Which package reader runs follows `ID` and `ID_LIKE` in os-release. A host
of another distro is marked *Unsupported*.

An SSH command runs through the remote account's login shell - that is how
SSH works. The commands are written so that shell has nothing to expand
(the format strings are single-quoted), and Danbyte never builds one from
your data. This is not the monitoring [exec check](monitoring.md#check-types):
nothing runs on the Danbyte server, so its switch does not apply.

### Least privilege

An ordinary account is enough: os-release, `dpkg-query`, `rpm -q` and the
apk database are readable without root. Danbyte never runs `sudo`. Give the
account a key login, and nothing else it does not need.

### Limits

- Each command's output is capped at 16 MB; a host that answers more is
  marked *Failed*.
- A host gets the profile's per-host timeout from connect to last line.
- At most 20,000 packages are kept from one host.
- Standard input is closed and standard error discarded; nothing the host
  sends is executed or evaluated, only parsed. A line that does not fit the
  expected shape is skipped, and so are packages that are not installed
  (`rc`, half-installed).

## What is stored

For every host read, Danbyte keeps:

- **The distro** from os-release: ID, version, codename, name, and the OSV
  ecosystem it maps to (`Debian:12`, `Ubuntu:24.04:LTS`, `Alpine:v3.22`,
  `Rocky Linux:9`, `AlmaLinux:9`, `Red Hat:enterprise_linux:9`). Another
  distro keeps an empty ecosystem.
- **Every installed package**: name, version, architecture, source package
  and its version, a package URL, and when it was first and last seen.

Each read replaces the host's list. A package missing from a read is marked
removed and deleted 30 days later; one that comes back is current again. A
host that could not be read (login refused, timeout) keeps its last list.
Packages are machine data and are not change-logged; profiles and the deny
subnets are.

Packages are not [installed software](applications.md) rows: a Linux host
has well over a thousand, and the Software tab and SBOM stay for what you
model. They show on the host's **Packages** tab, which appears once
something has been read and you may view installed software.

## Vulnerabilities

Inventoried packages are a third source for [vulnerability
matching](vulnerabilities.md#how-matching-works), next to platforms and
applications, shown as **Via: Package** on the Vulnerabilities tab and page:

- Each package is tested under the name its distro's advisories use: the
  **source package** for Debian and Ubuntu (`libssl3` is advised as
  `openssl`), the origin for Alpine, the binary package for RPM distros.
- The test uses the host's release, so a Debian 12 host is compared with
  Debian 12's fixed version only ([distro
  packages](vulnerabilities.md#distro-packages)).
- Exceptions, priorities, the compliance rule and notifications work as for
  any match. A package match has no catalog subject, so an exception for it
  is per host or tenant-wide.
- Package matches read with *installed software* view as well as the host's
  view, like the Packages tab.
- Turning Discovery off resolves the tenant's package matches.

The vulnerability store fetches advisories for the packages it finds:

- **Server and browser mode** ask OSV by `{ecosystem, name}` per release the
  packages are installed on, in batches of 1,000 - a host with 2,000
  packages is a couple of requests.
- **Upload mode**: upload the per-ecosystem OSV archive for your distros
  (`Debian/all.zip`, `Ubuntu/all.zip`, `Alpine/all.zip`, `Rocky Linux/all.zip`
  …, from the OSV bucket); the store keeps only the records naming a package
  someone has.

### What is sent where

Package names and the distro releases they are installed on go to OSV (in
server or browser mode) - the same as for mapped products. Versions, host
names, addresses and credentials never leave the deployment. The VEX in the
[SBOM](sbom.md) leaves package matches out: the SBOM does not list those
packages.

## Where it runs

Runs go to the RQ queue `discovery` on the Danbyte workers, so a long run
never holds up vulnerability recomputes on `low`. The timer
`danbyte-inventory` (every 15 minutes; `run_scheduler` in a container)
queues the profiles that are due and inside their window, gives up runs
whose worker died after six hours, and purges long-removed packages.

The collector is written without Django in `danbyte_checks`, so Outposts
can run the same code later; today every run is on the server, and the
check runner's target policy applies to every host it logs in to.

!!! note "Custom worker units"
    The shipped worker unit and compose file listen on `discovery`. A
    worker drop-in or compose override that replaces the worker command must
    add `discovery` to its queue list, or runs stay queued.

## Permissions

| Action | Needs |
|---|---|
| See profiles, runs and a run's hosts | *view* on Inventory profiles; host rows only for hosts you may view |
| Create, change, delete profiles | *add* / *change* / *delete* on Inventory profiles, and *view* on every site, prefix, device and VM in the scope |
| Run now | the **scan** verb on the profile, plus *view* on device credentials |
| A host's packages, package matches | *view* on the host and on installed software |
| Exempt a host, address or prefix | *change* on it |
| Deny subnets | tenant admin to change; tenant admins and profile viewers read |
| The Discovery switch | tenant admin |

No built-in group holds *scan*: grant it to the people who may start runs.
Inventory profiles are tenant-wide; a site role can scope a profile only to
what it can see.

## API

| Endpoint | |
|---|---|
| `GET /api/discovery/status/` | The deployment switch, the tenant toggle, and whether both are on |
| `GET`, `PATCH /api/discovery/settings/` | `deny_subnets` |
| `/api/discovery/profiles/` | Inventory profiles, CRUD (`?enabled=`, `?search=`) |
| `POST /api/discovery/profiles/<id>/run/` | Run now (202 with the run; 409 when one is open or the profile cannot run) |
| `GET /api/discovery/profiles/<id>/hosts/` | The scope as it resolves now |
| `GET /api/discovery/runs/` | Runs (`?profile=`, `?status=`) |
| `GET /api/discovery/runs/<id>/hosts/` | A run's per-host results (`?status=`) |
| `POST /api/discovery/exempt/` | Set *exempt from discovery* |
| `GET /api/devices/<id>/packages/`, `/api/virtual-machines/<id>/packages/` | A host's current packages (`?search=`) and its distro (`os`) |
