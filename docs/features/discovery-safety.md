---
icon: lucide/shield-check
---

# Discovery: scope and safety

What a profile may reach, who said it may, what is always left alone, what
is recorded, who may do what, and what leaves the deployment. A *tenant
admin* below is someone with `users.manage` or *change* on users in the
tenant; a *deployment admin* is a superuser or holds that grant without
tenant narrowing.

!!! info "Where to find it"
    - Profiles: the **Discovery** tab of the **Monitoring** page; each
      profile's **Hosts** (or **Addresses**) tab previews its scope.
    - **Deny subnets**: the **Host discovery** section (**Monitoring** page →
      **Settings** tab).
    - **Do not scan**: the edit form of a device, VM, IP address or prefix.
    - A monitoring policy's **Discovery** section: the policy's menu on
      **Monitoring** → **Configuration**.

## Profile fields

| Field | Values | Default |
|---|---|---|
| **Name** | unique in the tenant | - |
| **Kind** | *Package inventory* or *Service scan*; fixed once created | Package inventory |
| **Description** | free text | - |
| **Enabled** | a disabled profile never runs | off |
| **Runs on** | *Server*, one Outpost, or *The host's Outpost* ([On an Outpost](discovery-outposts.md)) | Server |
| **Scope** | [below](#scope) | empty: reads nothing |
| **Every** | hours between scheduled runs, 0 to 2160; 0 means **Run now** only | 24 |
| **Window from**, **Window to** | daily start window, server time; an end before the start spans midnight; both empty means any time | empty |
| **Ports** | service scan: ports and ranges, at most 1,024 | the [default list](service-discovery.md#the-default-port-list) |
| **Connects per second** | service scan: 1 to the deployment cap | 20 |
| **Engine**, **Version probes**, **Timing** | service scan: *Built-in* or *nmap* ([the nmap engine](service-discovery.md#the-nmap-engine)) | Built-in, 2, Normal (-T3) |
| **Hosts at once** | hosts (or addresses) read in parallel, 1 to 16 | 4 |
| **Per-host timeout** | package inventory: seconds per host, 10 to 600 | 60 |
| **Credential** | package inventory: a shared credential to pin ([which login](discovery-credentials.md#which-login-a-host-gets)) | *Host's own, then matching shared* |
| **Authorisation** | who authorised it, at most 2,000 characters ([below](#authorisation)) | empty: never runs |

## Scope

A profile's scope is the union of what it names. Nothing outside it is
contacted, and no range is typed at run time.

| Kind | Package inventory reads a host when | A service scan scans an address when |
|---|---|---|
| **Sites** | it sits at the site | its own site, or its device's or VM's, is the site |
| **Prefixes** | its primary address (a device's out-of-band address when it has no primary) is in the prefix, same VRF | it is in the prefix or a prefix inside it, same VRF |
| **Devices**, **Virtual machines** | it is named | it is assigned to the device or VM (directly or through an interface), or is its primary or out-of-band address |
| **Regions**, **VRFs**, **Platforms**, **Device types**, **Device roles** | a monitoring policy on that object would cover its primary (or out-of-band) address | a monitoring policy on that object would cover the address |
| **Everything in this tenant** | always | always |

The middle row - the **monitoring policy kinds** - is decided by the same
code the monitoring resolver uses for a policy, so a *Device role: Server*
profile reads exactly the devices a *Device role: Server* policy puts checks
on. A region reaches every site below it; a VRF matches the address's VRF;
platform, device type and role match the device and therefore never a VM. A
host with no address is reached only by name, by its site, or by the whole
tenant.

**Everything in this tenant** is never implied by an empty scope. Ticking it
asks *Everything in this tenant?* and needs **Scope to everything**; the API
refuses it without `"confirm_global": true`. It includes hosts and addresses
added later.

### Copying a monitoring policy's scope

**Use a monitoring policy's scope** in the profile dialog lists the policies
you may view and **copies** the chosen policy's scope into the profile, where
it shows as the profile's own (a role, a region, a site, or the whole
tenant). It is a copy on purpose: editing the policy later must never widen
what a profile reads without a new authorisation. A policy's filters (tags,
name, interface, hardware) and its IP target are not part of a profile's
scope and are not copied; a toast says so. A VRF policy on the Global VRF
names nothing to copy.

From the other side, a monitoring policy's menu has a **Discovery** section:
the profiles whose own scope names the same object (*No profile names this*
when none) and **New discovery profile from this scope**, which opens the
profile dialog with the scope copied (needs *add* on Discovery profiles).
Saving a monitoring policy never starts or schedules a scan.

### Who may name what

- Every member of a scope must be an object you may view, in the tenant.
- Someone whose view of devices or VMs (and, for a service scan, IP
  addresses) is limited to some sites cannot add the whole tenant, a VRF, a
  platform, a device type or a device role: those reach beyond the sites. A
  region they may add only when every site in it is theirs.
- The **Hosts** / **Addresses** tab resolves the scope as you may see it,
  without contacting anything, and says why a host would be left alone.

## Authorisation

Reading hosts or scanning ports can be against policy, a contract or the law
unless someone with the authority said yes. A profile therefore records it:

- Saving a statement in **Authorisation** records you as the authoriser,
  with the time. The profile page shows the statement, **Recorded by** and
  **Recorded**; the change log keeps every version.
- The profile stops running - *Not authorised* - until someone records a
  statement again, when an edit without a new statement in the same save:
    - changes the scope (any kind, the whole-tenant choice included);
    - for a service scan, changes the ports or the **Engine** (*Built-in*
      ↔ *nmap*), or raises nmap's **Version intensity** or **Timing**:
      each changes what is sent to the hosts (lowering them does not
      clear it);
    - changes **Runs on**, or the Outpost it names: another vantage point
      reaches other networks;
    - empties the statement.
- A profile without an authorisation never runs, on schedule or by hand.

Changing the schedule, the rate, the engine, **Hosts at once**, the timeout
or the pinned credential keeps the authorisation.

## When a run starts

A run is refused (409, with the reason under the profile's name) unless
Discovery is on for the deployment and the tenant, the profile is
**Enabled** and authorised, a profile on *An Outpost* names one, the time is
inside its window - **Run now** included - and the profile has no run
queued or running.

When a worker picks the run up it trusts nothing but the run's id: it reads
the profile again and stops the run as *Skipped* if any of those changed, or
if a **Run now** run's starter lost the **scan** permission or their account.
The scope is resolved then, inside the profile's tenant, so a host that left
the tenant, became exempt or went into maintenance since is not contacted.

**Run now** by a person reads only the hosts (or addresses) that person may
view, with the credentials they may view. A scheduled run reads the whole
scope its authorisation covers.

## What is left alone

Per host or address, in this order, a reason not to contact it. Each is a
row on the run with no connection made:

| Result | Package inventory | Service scan |
|---|---|---|
| **No address** | the host has no primary (or out-of-band) address, or it is not valid | the address is not valid |
| **Exempt** | the host, its address, the address's prefix or any prefix around it in the same VRF is marked [Do not scan](#do-not-scan) | the address, its prefix, a prefix around it, or its device or VM is marked |
| **Deny subnet** | the address is in a [discovery deny subnet](#deny-subnets) (any VRF) or a [monitoring deny subnet](monitoring.md) of its VRF | the same |
| **Blocked target** | a link-local address, always; or the server's target policy refuses it ([below](#the-target-policy)) | the same |
| **In maintenance** | the host is in an open [maintenance event](maintenance.md) | its device or VM is |
| **No credential** | no login on a transport that is on ([which login](discovery-credentials.md#which-login-a-host-gets)) | - |
| **Host key not accepted** | only SSH logins, and no accepted SSH host key ([host keys](discovery-credentials.md#host-keys)) | - |

A run reads at most 4,096 hosts or addresses; the rest are not contacted and
the run says so. On a profile that runs on Outposts, the Outpost rows come
after these ([On an Outpost](discovery-outposts.md#what-a-host-row-says)).

### Do not scan

A device, VM, IP address or prefix can be marked exempt from discovery:
nothing in Discovery contacts it, whatever a profile says. A prefix covers
every address inside it, in its VRF.

- The edit form of a device, VM, IP address or prefix has **Do not scan**,
  shown while Discovery is on to users who may change the object; it is saved
  with the form.
- An address inside an exempt prefix shows *Exempt through 10.0.0.0/24*
  read-only; change it on the prefix. A prefix you may not view is named
  *a prefix*.
- A profile's **Hosts** / **Addresses** tab has **Exempt** and **Include**
  per row.
- Each needs *change* on the object, site scope included, and is in the
  object's change log like any edit.
- The device, VM, IP address and prefix APIs return `scan_exempt` read-only
  (an address also `scan_exempt_via`); `POST /api/discovery/exempt/` sets it
  ([API](discovery-api.md#do-not-scan)).

### Deny subnets

**Deny subnets** holds up to 500 CIDRs, one per line, in any VRF, that
nothing in the tenant's Discovery ever contacts. Tenant admins change them;
whoever may view profiles reads them. The monitoring deny subnets apply as
well, each in its own VRF.

### The target policy

Link-local addresses (`169.254.0.0/16`, `fe80::/10`, IPv4-mapped forms
included; the cloud metadata endpoint is among them) are never a Discovery
target, on the server or on an Outpost, whatever `DANBYTE_SSRF_ALLOWLIST`
says: the host is *Blocked target* with *Link-local (cloud metadata)
addresses are never discovered.*, and no work for it goes to an Outpost.

On the server, the check engine's target policy then applies to every
other address Discovery would contact:

- the unspecified address is always refused;
- loopback, private, reserved and multicast addresses are refused too when
  `DANBYTE_CHECK_BLOCK_INTERNAL` is on;
- `DANBYTE_SSRF_ALLOWLIST` lets its CIDRs through.

On an Outpost the Outpost's own policy applies instead: link-local and the
unspecified address refused, internal ranges allowed - reaching them is what
an Outpost is for ([Settings](../reference/settings.md#check-engine-targets-central-runner-ssrf)).

## Schedules and limits

The `danbyte-inventory` timer runs every 15 minutes. It queues each enabled,
authorised profile with **Every** above 0 whose last run started at least
that many hours ago and whose window is open, skips a profile with a run
still open, gives up runs that did not finish within six hours, expires
Outpost work nobody picked up, and deletes packages removed more than 30
days ago ([Settings](discovery-settings.md#queue-and-timer)).

| Limit | Value | Page |
|---|---|---|
| Hosts or addresses per run | 4,096 | - |
| Hosts at once | 1 to 16 | - |
| Per-host timeout (inventory) | 10 to 600 s | [Package inventory](discovery-packages.md#limits) |
| Logins per host | 3 | [Credentials](discovery-credentials.md#which-login-a-host-gets) |
| Connects per second (scan) | 1 to `DANBYTE_DISCOVERY_SCAN_MAX_RATE` (default 200, at most 2000) | [Service scan](service-discovery.md#safety-limits) |
| Ports per profile | 1,024 | [Service scan](service-discovery.md#safety-limits) |
| A run's lifetime | 6 h | - |

## What is recorded

| In the change log | Not in the change log (machine data) |
|---|---|
| Profiles, every change, with each version of the authorisation | Packages and OS facts |
| A run being queued, with who started it | A run's status and counts as it goes, its host results |
| The deployment switch, the tenant's Discovery switch | Observed services |
| Discovery settings: deny subnets, transports, nmap | Outpost work items |
| **Do not scan** changes, on the object | **Ignore** decisions (kept with who decided and when) |
| SSH host keys: a key first observed, and every acceptance, in bulk or on first use (as the starter, with the run as the cause) | |
| Running versions and installs Discovery writes, cause *Package inventory* | An install's observed version and last seen |
| Everything accepted from **Findings**: services, installs, applications, platforms, mappings | |

A run keeps at most 50 messages, and none names a secret; per-host reasons
are on its host rows, which read with the host's own view. The server log
gets warnings for failures, never a secret. Vulnerability matches are
computed and kept in their own history ([match
history](vulnerabilities.md#match-history)).

## Permissions

Discovery profiles are the RBAC type **Discovery profiles** (slug
`inventoryprofile`, group *Integrations*), with the extra verb **scan**. No built-in group holds
*scan*: grant it to the people who may start runs.

| Action | Needs |
|---|---|
| See the Discovery tab, profiles, runs | *view* on Discovery profiles; run host rows only for hosts (or addresses) you may view |
| Create, change, delete a profile | *add* / *change* / *delete* on Discovery profiles, and *view* on every scope member ([who may name what](#who-may-name-what)) |
| Copy a monitoring policy's scope | *add* or *change* on Discovery profiles, and *view* on the policy |
| Pin a shared credential | *view* on that shared credential |
| **Run now**, package inventory | **scan** on the profile and *view* on device credentials |
| **Run now**, service scan | **scan** on the profile |
| **Run now** with **Accept new host keys** | also *change* on SSH host keys |
| The **Hosts** / **Addresses** tab | *view* on the profile; rows you may view |
| A profile's or run's **Host keys** | *view* on SSH host keys |
| **Accept N keys** | *change* on SSH host keys, site scope included |
| List Outposts for **Runs on** | *view* on Discovery profiles |
| A host's **Packages** tab, package and OS-build matches | *view* on the host and on installed software |
| **Open ports** | *view* on IP addresses; rows of addresses you may view |
| **Findings**: service-scan rows | *view* on IP addresses |
| **Findings**: inventory rows | *view* on installed software; host rows for hosts you may view |
| Accept or ignore *Add service* | *add* on services, on that host |
| Accept or ignore *Add software* | *add* on installed software on that host; *add* on applications not limited to sites when the application is new |
| Accept or ignore *Map to CPE* | *change* on the application, and vulnerability data on |
| Accept or ignore *Set platform* | *change* on the host; *add* on platforms not limited to sites to create one; *change* on a platform to map it |
| Accept or ignore *Add application* / *Link packages* | *add* on applications not limited to sites / *change* on the application |
| **Do not scan** | *change* on the object |
| Read **Host discovery** (transports, nmap, deny subnets) | tenant admin, or *view* on Discovery profiles |
| Change transports, nmap, deny subnets | tenant admin |
| The tenant's **Discovery** switch | tenant admin |
| **This deployment** | deployment admin; nobody while `DANBYTE_DISCOVERY_ENABLED` is set |

Accepting is checked on what is created, site scope included: a row you may
not create is refused with the reason and nothing of it stays.

## Site-limited users and tenant isolation

- Every query runs inside the active tenant first. A profile's scope members,
  its pinned credential and its Outpost must be in the tenant; ids from
  another tenant are *not found*.
- A run resolves its scope inside the profile's tenant when it starts. An
  Outpost is handed work only for its own tenant, and what it posts back
  counts only for work it claimed.
- A site-limited user sees run rows, findings, keys and packages only for
  hosts and addresses they may view, accepts keys only in their sites, and
  cannot widen a scope beyond their sites ([who may name what](#who-may-name-what)).
- **Run now** by a site-limited user reads only their hosts with their
  credentials. A scheduled run of the same profile reads its whole scope:
  grant *change* on profiles only to people trusted with that scope.

## Privacy

What leaves the deployment, and to whom:

| Recipient | What | When |
|---|---|---|
| The hosts in scope | the fixed commands, the credential for that host, or the service-scan probes | each run |
| OSV (`api.osv.dev`) | package names and the distribution releases they are installed on (`Debian:12` + `openssl`) | vulnerability data in server mode (the server asks) or browser mode (an admin's browser asks) |
| Microsoft (`api.msrc.microsoft.com`) | month ids (`2026-Nov`) | vulnerability data in server mode, after Discovery has read a Windows host |

Nothing else. Versions, host names, addresses, banners, OS facts and
credentials never leave the deployment, and Discovery itself contacts no
third party. In upload mode nothing leaves at all. Accepting a *Map to CPE*
finding creates a product mapping, which the vulnerability data then fetches
from NVD by product name like any mapping ([what is
contacted](vulnerabilities.md#what-is-contacted)). The VEX in the
[SBOM](sbom.md) leaves package and OS-build matches out: the SBOM does not
list those packages, and its operating system is the documented platform.
