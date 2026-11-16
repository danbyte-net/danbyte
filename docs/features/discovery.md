---
icon: lucide/scan-search
---

# Discovery

Discovery finds out what runs on the devices and VMs you already document,
so [vulnerability matching](vulnerabilities.md) and
[end-of-life data](end-of-life-data.md) work from facts instead of guesses
([#451](https://github.com/danbyte-net/danbyte/issues/451)). It is off until a
deployment admin and a tenant admin both turn it on, and a profile runs only
after someone has written down who authorised it.

!!! info "Where to find it"
    - **Profiles, runs, Findings, Open ports**: **Monitoring → Discovery** in
      the sidebar (`/discovery`), with the tabs **Profiles**, **Findings**
      (`/discovery/findings`) and **Open ports** (`/discovery/services`).
      Profile and run pages are under `/discovery/…`.
    - **Switches, transports, nmap, deny subnets**: the **Host discovery**
      section of **Monitoring → Settings** (`/monitoring/settings`, under
      *Setup*; also **Settings → Monitoring**).
    - **The tenant switch**: the **Discovery** card under **Settings →
      Integrations**.
    - **Results on a host**: the **Packages** and **Vulnerabilities** tabs of
      a device or VM.

## What it is, and what it is not

Discovery **reads and observes**. It logs in with a credential you gave it and
runs a fixed list of read-only commands, or it connects to TCP ports and reads
what the server says by itself. It never:

- runs `sudo` or writes anything on a host;
- runs a command that is not in the [published list](discovery-packages.md#what-runs-on-the-host);
- tries passwords, default credentials or exploits, fuzzes, floods, or sends
  any other intrusive check;
- looks up what it found with a third party.

The [nmap engine](service-discovery.md#the-nmap-engine) is the one place
Danbyte starts a program it did not write, and it runs with a fixed argument
list, a connect scan and no scripts.

## The two kinds of profile

A **discovery profile** says what to read, when, and who authorised it. Each
profile is one of two kinds, fixed when it is created:

| | Package inventory | Service scan |
|---|---|---|
| Targets | Devices and VMs, at their primary address (a device's out-of-band address when it has no primary) | Every IPAM address in scope, whether or not it belongs to a device or VM |
| How | Logs in over SSH (key or password) or WinRM over HTTPS (client certificate) | TCP connect to a port list, one greeting read or one `GET /` per open port |
| Needs | A credential and an accepted SSH host key (or a trusted WinRM certificate) | Nothing but network reach |
| Gives | The OS release, every installed package (Linux), the build, hotfixes and programs (Windows) | Open ports, the product and version a banner names, TLS certificate facts, SSH host keys |
| Feeds | CVE matches, the running version, platform and application proposals, installs | Proposals only: add a service, add installed software, map a CPE |
| Reference | [Package inventory](discovery-packages.md), [Windows hosts](discovery-windows.md) | [Service scan](service-discovery.md) |

Neither is the **address discovery** sweep. That one pings the addresses of
enrolled prefixes and records the ones that answer as new IPs in IPAM; it
logs in nowhere, has no profiles and has its own switch
([Monitoring: Address discovery](monitoring.md#address-discovery)). Discovery
reads only hosts and addresses that are already in IPAM.

## How the data flows

| Step | Package inventory | Service scan |
|---|---|---|
| 1. Resolve | The profile's scope becomes a list of hosts, inside the profile's tenant, when the run starts. Exempt hosts, deny subnets, maintenance and the target policy remove hosts before any connection ([Scope and safety](discovery-safety.md)). | The same, for addresses. |
| 2. Read | Fixed commands over SSH or WinRM. | Connect, read the greeting, close. |
| 3. Store | **OS facts** (one row per host) and **packages** (one row per package), as machine data. | **Observed services** (one row per open port). |
| 4. Feed | The host's **running version**; **installs** of applications whose package names match; **findings** (*Set platform*, *Add application*, *Link packages*). | **Findings** (*Add service*, *Add software*, *Map to CPE*). |
| 5. Match | **Vulnerability matches** *Via: Package* (Linux, from OSV advisories) and *Via: OS build* (Windows, from Microsoft's data). | None. A banner never creates a CVE match. |

Nothing in steps 4 and 5 changes your documented data without a person,
except two things Discovery owns: the running version it writes with source
**Discovery**, and the installs it creates for applications that name their
packages. Everything a person accepts from **Findings** is a normal object in
the change log.

Terms used across these pages:

| Term | Meaning |
|---|---|
| OSV | The Open Source Vulnerabilities database (`osv.dev`). Its Debian, Ubuntu, Alpine, Rocky Linux, AlmaLinux and Red Hat advisories list the fixed package version per distribution release. |
| CPE | Common Platform Enumeration, NVD's naming of products (`cpe:2.3:a:f5:nginx`). |
| purl | A package URL (`pkg:deb/debian/openssl@3.0.15-1~deb12u1`), the standard name of one package version. |
| UBR | Update Build Revision, the last part of a Windows build (`2849` in `10.0.20348.2849`). It moves with each monthly update. |

## What it needs from you

1. A deployment admin allows Discovery for the deployment, and a tenant admin
   turns it on for the tenant ([Getting started](discovery-getting-started.md)).
2. For package inventory: a login per host - the host's own credential or a
   [shared credential](discovery-credentials.md) - and each host's SSH key
   reviewed and accepted.
3. A profile with a scope and a written **Authorisation**: who said yes to
   reading those hosts.
4. For CVE results: [vulnerability data](vulnerabilities.md) turned on, and
   in upload or browser mode someone who fetches the advisories after a read.
5. For a host Danbyte cannot reach: an [Outpost](discovery-outposts.md) at
   that site.

## These pages

| Page | What it answers |
|---|---|
| [Getting started](discovery-getting-started.md) | From a fresh install to a first package list and a first scan, step by step. |
| [Package inventory](discovery-packages.md) | The exact commands, what is stored, limits, the Packages tab, versions, platforms, applications. |
| [Windows hosts](discovery-windows.md) | SSH and WinRM on Windows, what is read, matching against Microsoft's data. |
| [Service scan](service-discovery.md) | Ports, probes, fingerprints, Findings, the nmap engine. |
| [Credentials and host keys](discovery-credentials.md) | Which login a host gets, host-key review, accept on first use. |
| [Scope and safety](discovery-safety.md) | Scope kinds, authorisation, every skip rule, limits, permissions, privacy. |
| [On an Outpost](discovery-outposts.md) | Running a profile from an Outpost, and what it never does. |
| [Settings](discovery-settings.md) | Every environment variable and switch, the queue and the timer, upgrade notes. |
| [API](discovery-api.md) | Every endpoint, its permission and its fields. |
| [Troubleshooting](discovery-troubleshooting.md) | Every run and host status, and the common situations. |

## Sections that moved

These pages used to be two long pages. Old links land here; follow the one
you need.

| Old section | Now |
|---|---|
| <span id="turn-it-on"></span>Turn it on | [Getting started](discovery-getting-started.md#1-allow-discovery-on-the-deployment) |
| <span id="run-results"></span>Run results | [Troubleshooting](discovery-troubleshooting.md#run-statuses) |
| <span id="inventory-profiles"></span>Inventory profiles | [Scope and safety: profile fields](discovery-safety.md#profile-fields) |
| <span id="scope"></span>Scope | [Scope and safety: scope](discovery-safety.md#scope) |
| <span id="authorisation"></span>Authorisation | [Scope and safety: authorisation](discovery-safety.md#authorisation) |
| <span id="which-hosts-are-read"></span>Which hosts are read | [Scope and safety: what is left alone](discovery-safety.md#what-is-left-alone) |
| <span id="exempting-a-host-address-or-prefix"></span>Exempting a host, address or prefix | [Scope and safety: Do not scan](discovery-safety.md#do-not-scan) |
| <span id="deny-subnets"></span>Deny subnets | [Scope and safety: deny subnets](discovery-safety.md#deny-subnets) |
| <span id="credentials-and-host-keys"></span>Credentials and host keys | [Credentials and host keys](discovery-credentials.md) |
| <span id="transports"></span>Transports | [Credentials and host keys: transports](discovery-credentials.md#transports) |
| <span id="what-is-run-on-the-host"></span>What is run on the host | [Package inventory: what runs on the host](discovery-packages.md#what-runs-on-the-host) |
| <span id="what-is-stored"></span>What is stored | [Package inventory: what is stored](discovery-packages.md#what-is-stored) |
| <span id="what-a-read-feeds"></span>What a read feeds | [Package inventory: what a read feeds](discovery-packages.md#what-a-read-feeds) |
| <span id="the-running-version"></span>The running version | [Package inventory: the running version](discovery-packages.md#the-running-version) |
| <span id="the-platform"></span>The platform | [Package inventory: platform proposals](discovery-packages.md#platform-proposals) |
| <span id="applications-from-packages"></span>Applications from packages | [Package inventory: applications from packages](discovery-packages.md#applications-from-packages) |
| <span id="vulnerabilities"></span>Vulnerabilities | [Package inventory: CVE matches](discovery-packages.md#cve-matches) |
| <span id="windows-builds"></span>Windows builds | [Windows hosts: Microsoft's data](discovery-windows.md#matching-against-microsofts-data) |
| <span id="what-is-sent-where"></span>What is sent where | [Scope and safety: privacy](discovery-safety.md#privacy) |
| <span id="where-it-runs"></span>Where it runs | [Settings: queue and timer](discovery-settings.md#queue-and-timer) |
| <span id="on-an-outpost"></span>On an Outpost | [On an Outpost](discovery-outposts.md) |
| <span id="permissions"></span>Permissions | [Scope and safety: permissions](discovery-safety.md#permissions) |
| <span id="api"></span>API | [API](discovery-api.md) |
