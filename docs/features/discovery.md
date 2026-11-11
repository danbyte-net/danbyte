---
icon: lucide/scan-search
---

# Discovery: package inventory

Danbyte can log in to your Linux and Windows devices and VMs, read what is
installed, and match exact Linux package versions against the
[vulnerability data](vulnerabilities.md). A Debian, Ubuntu, RHEL-family or
Alpine host then gets CVE results from its own distro's advisories, with
backported fixes counted - something a version banner can never tell
([#451](https://github.com/danbyte-net/danbyte/issues/451)). A Windows host
gets its OS build, hotfixes and installed programs on record.

It uses the credentials you already keep on each host, or [shared
credentials](device-access.md#shared-credentials), and reads only. Nothing
is installed on the host, nothing is written there, and no command runs
that is not listed on this page.

!!! note "Service scans"
    A second kind of profile scans TCP ports of your IPAM addresses and
    proposes services and installed software for review, with the built-in
    engine or an nmap you installed: see
    [Discovery: service scan](service-discovery.md). Windows CVEs from
    Microsoft's advisories (by OS build) are [here](#windows-builds).

## Turn it on

Three things must all be true before Danbyte contacts any host:

1. **The deployment allows it.** A deployment admin switches on **This
   deployment** on the **Discovery** card under **Settings → Integrations**.
   It is off by default, and every change is in the change log (who, when);
   the card shows the last one. Tenant admins see the switch but cannot
   change it. A deployment that sets `DANBYTE_DISCOVERY_ENABLED` in the
   environment of the web, worker and timer units decides there instead:
   `True` shows *Locked on by the deployment*, any other value *Locked off
   by the deployment*, and nobody can change it on the card (see
   [Settings](../reference/settings.md#discovery)).
2. **The tenant turns it on.** A tenant admin switches on **Discovery**
   itself on the same card. While the deployment switch is off the card
   says *Off for this deployment*.
3. **A profile is authorised.** An inventory profile names what to read. It
   runs only after someone has written down who authorised it - see
   [Authorisation](#authorisation).

With any of the three off, the pages and the API answer *not found*, the
schedule queues nothing, and package matches are resolved.

## Run results

| Run status | Meaning |
|---|---|
| OK | Every host was read, or left alone on purpose (exempt, deny subnet, maintenance). |
| Partial | Some hosts were read, some not. |
| Nothing read | No host was logged in to, because each was left alone before a login - no credential, no accepted host key, no address. Nothing failed; the run page says why by reason ("61 without a credential") and links to what fixes it. |
| Failed | Logins were tried and none read (refused, unreachable, timed out). |
| Skipped | The run did not start: Discovery, the profile or its authorisation changed after it was queued. |

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
| No credential | No login for the host on a transport that is on: no device credential of a fitting kind (*SSH key*, *SSH password*, *WinRM certificate*), no shared credential pinned on the profile or matching the host, or the secret cannot be read. |
| Host key not accepted | Only SSH logins, and no SSH host key has been accepted for the host. |
| Certificate not trusted | WinRM: the host's TLS certificate did not verify for its name. |

A host left alone as *No credential* or *Host key not accepted* (and
past every rule above it) still has its SSH host key read - a key exchange,
no login - so the key shows under **Host keys** for review.

A run started with **Run now** also reads only the hosts the person who
pressed it may view, with credentials they may view. A scheduled run reads
the whole scope its authorisation covers. A run reads at most 4,096 hosts.

### Exempting a host, address or prefix

A device, VM, IP address or prefix can be marked *exempt from discovery*;
nothing in discovery contacts it, whatever a profile says. A prefix exempts
every address inside it. While Discovery is on, the edit form of a device,
VM, IP address or prefix has **Do not scan** under *Discovery* (shown to
users who may change the object; not offered in plan mode); it is saved with
the form. An address inside an exempt prefix says *Exempt through
10.0.0.0/24* there, read-only - change it on the prefix (a prefix you may
not view is named *a prefix*). On a profile's **Hosts** tab, **Exempt** and
**Include** set it for a device or VM. Both need *change* on the object,
site scope included. The device, VM, IP address and prefix APIs return the
flag read-only as `scan_exempt` (an address's detail also has
`scan_exempt_via`: `{id, cidr}` of the exempt prefix covering it, or null);
a `PATCH` does not change it. The API sets it on all four:

```http
POST /api/discovery/exempt/
{"kind": "device|virtual_machine|ipaddress|prefix", "id": "<uuid>", "exempt": true}
```

The change is in the object's change log like any edit.

### Deny subnets

**Deny subnets** on the Discovery page holds CIDRs, any VRF, that nothing in
the tenant's discovery ever contacts. Tenant admins change them; the
monitoring deny subnets apply as well.

## Credentials and host keys

An inventory run sends a credential to the host, so a host that is not who
it claims to be could collect it. Danbyte therefore reads a host only when
its SSH host key is one a person **accepted**: uploaded, or observed and
then accepted, in the [SSH host-key inventory](../monitoring/ssh-host-keys.md).
The key is checked during the SSH handshake, before any credential is sent.

When a host has no accepted key, or presents a different one, the run marks
it *Host key not accepted* and records the key it presented as *observed*
(that takes a key exchange only, no login).

### Which login a host is read with

For each host, in this order (the [shared-credential
rule](device-access.md#which-login-a-host-gets)):

1. its own [device credential](device-access.md) - *SSH key* before *SSH
   password*;
2. the shared credential the profile pins, under **Credential** on the
   profile (optional);
3. the enabled [shared credentials](device-access.md#shared-credentials)
   whose scope matches the host, lowest weight first.

Only the first is tried unless it is refused and allows trying the next, at
most three per host. A run started with **Run now** uses only credentials
the person who pressed it may view. The run's host list says which login was
used - *Host's own* or *Shared · name* - never the secret. The secret is
read from the secret store when the run connects, held in memory for that
connection, and never written to the run, its host results or the log.

### Reviewing host keys

The profile's and each run's **Host keys** tab lists the keys hosts
presented that nobody accepted yet, with the fingerprint and when it was
first seen. Tick the ones you checked and press **Accept N keys**; the next
run reads those hosts. You need *change* on SSH host keys. A key that
differs from an accepted one for its host is marked **Differs from accepted
key** and cannot be accepted from this list.

### Accept new host keys on first use

**Run now** asks before it starts, with a box **Accept new host keys**,
unticked every time. Ticked, a host with **no accepted key at all** has the
key it presents on this run accepted, and the login goes ahead on that same
connection - pinned to that key, so a second handshake cannot swap it. It
is **not advised**: whoever answers on that first contact is trusted.
Reviewing fingerprints under **Host keys** is the safe way.

- A host that has an accepted key and presents a different one is refused,
  ticked or not; nothing is overwritten.
- It needs *change* on SSH host keys as well as *scan*, checked when you
  press it and again when the run starts; scheduled runs never do it.
- Each key accepted this way is change-logged as you, with the run named as
  the cause, and the host's row shows **Key accepted on first use**.
- `DANBYTE_DISCOVERY_ALLOW_FIRST_USE_KEYS=False` removes the option from the
  whole deployment ([Settings](../reference/settings.md#discovery)).

The SSH connection uses only that credential: no ssh-agent, no keys or
config from the server account, no GSS or host-based login.

## Transports

Danbyte reaches a host the most secure way first. Each transport is a
switch on the **Discovery** card (tenant admins), tried in this order for
every host, and the run's host list says which one read it - hover the
transport for why the others were skipped or what they answered:

| Transport | Default | How |
|---|---|---|
| **SSH key login** | on | SSH with a key, only to a host whose SSH host key was accepted. Linux and Windows (OpenSSH server). |
| **SSH password login** | on | The same with a password. Turning it off stops **every** password login - Linux and Windows, a host's own credentials and shared ones. |
| **WinRM over HTTPS** | off | WS-Management over HTTPS with a **client certificate** (credential kind *WinRM certificate*), for Windows hosts without SSH. |

When a host has more than one, the next is tried only when the transport
did not answer (SSH unreachable → WinRM), or after a refused SSH key (no
password was sent yet); a refused password stops there unless its shared
credential allows trying the next - so no account gets locked out.

WinRM, and what is never used:

- Only HTTPS (port 5986 unless the credential names one). There is no path
  for plain HTTP.
- The server certificate is always verified, against the Danbyte server's
  trust store (`DANBYTE_DISCOVERY_WINRM_CA_BUNDLE`, else the system bundle;
  install your internal CA there). The name checked is the address's
  **DNS name** in IPAM, else the address itself, so the WinRM listener's
  certificate must name one of them. A host whose certificate does not
  verify is *Certificate not trusted*.
- The client certificate is mapped to a **local** account on the host
  (WinRM certificate authentication maps to local accounts only). The
  certificate and key reach the TLS library through in-memory files, never
  disk.
- **Kerberos is not available in this build**: pywinrm needs `pykerberos`
  (or `pyspnego` with `gssapi`) and the system Kerberos libraries, none of
  which ships with Danbyte. NTLM, Basic, CredSSP, unverified TLS and
  unverified SSH host keys are never offered.
- `DANBYTE_DISCOVERY_WINRM_ALLOWED=False` forbids WinRM for every tenant
  ([Settings](../reference/settings.md#discovery)); the card then says
  *Forbidden by the deployment*.

A host with no accepted SSH host key can still be read over WinRM, whose
server certificate is verified instead.

## What is run on the host

These are the only commands. They are constants in the code
(`danbyte_checks/inventory.py`, `danbyte_checks/inventory_windows.py`); no
part of a name, address or any other value you enter is ever placed in one.

| Step | Command |
|---|---|
| The distro | `cat /etc/os-release` (or `cat /usr/lib/os-release` when the first fails) |
| Debian, Ubuntu | `dpkg-query -W -f='${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\t${Architecture}\t${db:Status-Abbrev}\n'` |
| RHEL, Rocky, AlmaLinux, Fedora, SUSE, Amazon | `rpm -qa --qf '%{NAME}\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\t%{ARCH}\t%{SOURCERPM}\n'` |
| Alpine | `cat /lib/apk/db/installed` |
| Windows? (only when both os-release reads fail) | `cmd /c ver` - a Windows host answers `Microsoft Windows [Version 10.0.20348.2849]` |
| Windows (over SSH, and the same script over WinRM) | `powershell -NoProfile -NonInteractive -EncodedCommand <base64>` |

Which package reader runs follows `ID` and `ID_LIKE` in os-release. A host
of another distro is marked *Unsupported*, and so is a host whose `ver`
answer is not exactly the Windows shape - PowerShell is never started
then.

The Windows command carries one fixed script, base64-encoded (UTF-16LE, as
PowerShell takes it), so the command line holds only letters, digits, `+`,
`/` and `=`, and neither cmd.exe nor PowerShell has anything to expand. The
script, as it is encoded:

```powershell
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$cv=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$os=$null; try { $os=Get-CimInstance Win32_OperatingSystem } catch {}
$hf=@(); try { $hf=@(Get-CimInstance Win32_QuickFixEngineering | ForEach-Object {
  [pscustomobject]@{ id=[string]$_.HotFixID; description=[string]$_.Description;
                     installed_on=[string]$_.InstalledOn } }) } catch {}
$pr=@()
foreach ($v in @(@('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','x64'),
                 @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','x86'))) {
  $a=$v[1]
  $pr+=@(Get-ItemProperty $v[0] -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName } |
    ForEach-Object { [pscustomobject]@{ name=[string]$_.DisplayName;
      version=[string]$_.DisplayVersion; publisher=[string]$_.Publisher; arch=$a } }) }
$fe=@(); try { $fe=@(Get-CimInstance Win32_ServerFeature | ForEach-Object { [string]$_.Name }) } catch {}
[pscustomobject]@{ schema=1; product_name=[string]$cv.ProductName; edition_id=[string]$cv.EditionID;
  display_version=[string]$cv.DisplayVersion; release_id=[string]$cv.ReleaseId;
  current_build=[string]$cv.CurrentBuildNumber; ubr=$cv.UBR;
  installation_type=[string]$cv.InstallationType; caption=…; version=…; architecture=…;
  hotfixes=$hf; programs=$pr; features=$fe } | ConvertTo-Json -Depth 4 -Compress
```

(laid out here for reading; the code holds it on one line, and
`caption`, `version` and `architecture` come from `Win32_OperatingSystem`
when it could be read). It reads the CurrentVersion registry key, the CIM
classes `Win32_OperatingSystem`, `Win32_QuickFixEngineering` (what
`Get-HotFix` reads) and `Win32_ServerFeature` (Windows Server roles and
features; empty elsewhere), and the 64- and 32-bit Uninstall keys - no
writes, no other cmdlets.

An SSH command runs through the remote account's login shell - that is how
SSH works. The commands are written so that shell has nothing to expand
(the format strings are single-quoted), and Danbyte never builds one from
your data. This is not the monitoring [exec check](monitoring.md#check-types):
nothing runs on the Danbyte server, so its switch does not apply.

### Least privilege

An ordinary account is enough: os-release, `dpkg-query`, `rpm -q` and the
apk database are readable without root. Danbyte never runs `sudo`. Give the
account a key login, and nothing else it does not need.

On Windows a standard user reads the registry keys and CIM classes above.
Over SSH, any account the OpenSSH server lets in; over WinRM the account the
client certificate maps to must be in **Remote Management Users** (not an
administrator).

### Limits

- Each command's output is capped at 16 MB; a host that answers more is
  marked *Failed*.
- A host gets the profile's per-host timeout from connect to last line.
- At most 20,000 packages (Windows: programs) are kept from one host, 2,000
  hotfixes and 1,000 features.
- The Windows answer must be the script's JSON document; anything else is
  *Failed*. Names and versions are stripped of control characters and
  capped.
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
- **Windows**: the product (`Windows Server 2022 Standard`), edition,
  release (`21H2`), build and UBR (kept as `10.0.20348.2849`), the
  installation type (Desktop Experience or Server Core), the OS
  architecture (`x64`, `arm64`, `x86`), the installed hotfixes (KB numbers)
  and server features, and how the host was read. The **Packages** tab
  shows the build, release, installation type, architecture and hotfix
  count above the list, and *N open OS-build CVEs* (or *OS build not matched*)
  for [Windows builds](#windows-builds).
- **Windows programs** from the Uninstall keys, as packages of type
  `generic` (`pkg:generic/windows/<name>@<version>?arch=x64`) with their
  publisher; `arch` is `x64` for the native key and `x86` for WOW6432Node.
  They are inventory only: **never matched** against OSV, which has no
  ecosystem for them, and the vulnerability store asks nothing about them.

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
- A read that changed a host's packages or its OS facts (a new UBR after
  patching, say) re-matches that host.

The vulnerability store fetches advisories for the packages it finds:

- **Server and browser mode** ask OSV by `{ecosystem, name}` per release the
  packages are installed on, in batches of 1,000 - a host with 2,000
  packages is a couple of requests.
- **Upload mode**: upload the per-ecosystem OSV archive for your distros
  (`Debian/all.zip`, `Ubuntu/all.zip`, `Alpine/all.zip`, `Rocky Linux/all.zip`
  …, from the OSV bucket); the store keeps only the records naming a package
  someone has.

### Windows builds

A Windows host's build and UBR are a fourth source, **Via: OS build**: they
are compared with the fixed builds in Microsoft's own monthly security
update data, per Windows release (Server 2016 to 2025, Desktop and Server
Core, Windows 10 and 11). See [Windows hosts (Microsoft
data)](vulnerabilities.md#windows-hosts-microsoft-data) for how a host is
placed among Microsoft's products, what happens when it cannot be, and what
is fetched. The same rules as for packages apply: *installed software* view,
host or tenant exceptions, gone while Discovery is off. A host whose release
is not in the table, or that reported no UBR, gets no OS-build match.
When a run reads a Windows release no Microsoft month was fetched for yet,
it asks the server fetch for that release at once (one job per run, server
mode only) instead of leaving it to the daily refresh.

Installed hotfixes (KB numbers) are shown but not used for matching: the
build is cumulative, and `Get-HotFix` misses updates the servicing stack
installs.

### What is sent where

Package names and the distro releases they are installed on go to OSV (in
server or browser mode) - the same as for mapped products. For Windows
hosts only month ids (`2026-Nov`) go to Microsoft (server mode); the build,
the release and the host stay on the deployment. Versions, host
names, addresses and credentials never leave the deployment. The VEX in the
[SBOM](sbom.md) leaves package and OS-build matches out: the SBOM does not
list those packages, and its operating system is the documented platform.

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
| Run now with *Accept new host keys* | also *change* on SSH host keys |
| A profile's or run's host keys to review | *view* on SSH host keys |
| Accept host keys from that list | *change* on SSH host keys |
| Pin a shared credential on a profile | *change* on the profile and *view* on the shared credential |
| A host's packages, package matches | *view* on the host and on installed software |
| Exempt a host, address or prefix | *change* on it |
| Deny subnets | tenant admin to change; tenant admins and profile viewers read |
| The Discovery switch | tenant admin |
| The transport switches | tenant admin |
| This deployment (the deployment switch) | deployment admin (superuser, or an unscoped admin grant); never while `DANBYTE_DISCOVERY_ENABLED` is set |

No built-in group holds *scan*: grant it to the people who may start runs.
Inventory profiles are tenant-wide; a site role can scope a profile only to
what it can see.

## API

| Endpoint | |
|---|---|
| `GET /api/discovery/status/` | The deployment switch (`deployment`: `enabled`, `source` `env` or `setting`, last change), the tenant toggle, and whether both are on |
| `PATCH /api/discovery/deployment/` | `{"enabled": true}`: the stored deployment switch. Deployment admins only; 409 while the environment locks it |
| `GET`, `PATCH /api/discovery/settings/` | `deny_subnets`, `transports` (`{ssh_key, ssh_password, winrm}`); `winrm.available` says whether WinRM can be switched on here |
| `/api/discovery/profiles/` | Inventory profiles, CRUD (`?enabled=`, `?search=`) |
| `POST /api/discovery/profiles/<id>/run/` | Run now (202 with the run; 409 when one is open or the profile cannot run). Body `{"accept_new_host_keys": true}` for first use. |
| `GET /api/discovery/profiles/<id>/host-keys/`, `/api/discovery/runs/<id>/host-keys/` | Host keys waiting for review |
| `POST /api/discovery/host-keys/accept/` | Accept observed host keys, `{ids: [...]}` |
| `GET /api/discovery/profiles/<id>/hosts/` | The scope as it resolves now |
| `GET /api/discovery/runs/` | Runs (`?profile=`, `?status=`) |
| `GET /api/discovery/runs/<id>/hosts/` | A run's per-host results (`?status=`) |
| `POST /api/discovery/exempt/` | Set *exempt from discovery* |
| `GET /api/devices/<id>/packages/`, `/api/virtual-machines/<id>/packages/` | A host's current packages (`?search=`) and its distro (`os`) |
