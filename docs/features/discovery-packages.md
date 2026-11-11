---
icon: lucide/package-search
---

# Discovery: package inventory

A package inventory logs in to a device or VM, reads its OS release and every
installed package, and keeps them on the host. This page is the reference:
the exact commands, what is stored, the limits, and what a read feeds.
Windows hosts have their own page, [Windows hosts](discovery-windows.md);
logins and host keys are on [Credentials and host keys](discovery-credentials.md).

!!! info "Where to find it"
    - A host's packages: the **Packages** tab of a device or VM.
    - Its CVE matches: the **Vulnerabilities** tab, **Via: Package**.
    - Proposals a read raises: **Monitoring → Discovery → Findings**
      (`/discovery/findings`).
    - An application's package names: the application's edit form,
      **Package names**.

## What runs on the host

These are the only commands. They are constants in the code
(`danbyte_checks/inventory.py`, `danbyte_checks/inventory_windows.py`); no
name, address or other value you enter is ever placed in one, and a command
that is not in the list is refused before it is sent.

| Step | Command |
|---|---|
| The release | `cat /etc/os-release`; when that fails or is empty, `cat /usr/lib/os-release` |
| Debian, Ubuntu | `dpkg-query -W -f='${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\t${Architecture}\t${db:Status-Abbrev}\n'` |
| RPM distributions | `rpm -qa --qf '%{NAME}\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\t%{ARCH}\t%{SOURCERPM}\n'` |
| Alpine | `cat /lib/apk/db/installed` |
| No os-release at all | `cmd /c ver`; only an answer of the exact form `Microsoft Windows [Version 10.0.20348.2849]` goes on to the [Windows script](discovery-windows.md#what-is-read) |

The package reader follows `ID`, then each word of `ID_LIKE`, in os-release:

| os-release `ID` or `ID_LIKE` | Reader | CVE matching |
|---|---|---|
| `debian`, `ubuntu` | dpkg | per release (`Debian:12`, `Ubuntu:24.04:LTS`) |
| `alpine` | apk | per release (`Alpine:v3.22`) |
| `rhel`, `rocky`, `almalinux` | rpm | per major release (`Red Hat:enterprise_linux:9`, `Rocky Linux:9`, `AlmaLinux:9`) |
| `opensuse-leap` | rpm | per release (`openSUSE:Leap 15.6`) |
| `fedora`, `centos`, `ol`, `suse`, `sles`, `opensuse` (Tumbleweed), `amzn` | rpm | none: OSV has no advisories Danbyte can use for them (no ecosystem for Fedora, CentOS, Oracle Linux, Amazon Linux; SUSE Linux Enterprise 15 is split into per-module streams). The packages are read, and the host's result, the run's counts (*without an advisory source*) and the Packages tab say *No advisory source for …* |
| anything else | none | the host is *Unsupported* (*No package reader for …*) |

A distribution that sets `ID_LIKE=debian` (or `rhel`, …) is read with that
reader. For CVE matching only the `ID` itself counts: a derivative keeps its
packages without a release.

An SSH command runs through the remote account's login shell - that is how
SSH works. The format strings are single-quoted so that shell has nothing to
expand, standard input is closed and standard error is discarded. Nothing the
host sends is executed or evaluated; it is parsed by strict parsers that skip
any line that does not fit. Nothing runs on the Danbyte server, so the
monitoring [exec check](monitoring.md#check-types) switch does not apply.

### Least privilege

An ordinary account is enough: os-release, `dpkg-query`, `rpm -q` and the apk
database are readable without root, and Danbyte never runs `sudo`. Give the
account a key and nothing else it does not need. An SSH credential must
name its **User name**: one saved without it is skipped (*The credential has
no user name.*), never tried as `root`.

## Limits

| Limit | Value |
|---|---|
| One host, from connect to the last line | the profile's **Per-host timeout**, 10 to 600 s (default 60) |
| SSH connect / login | 15 s / 30 s, within the per-host timeout |
| Output of one command | 16 MB; more fails the host |
| Packages kept from one host | 20,000; the host's row says *Only the first 20000 packages were kept.* |
| Hosts in one run | 4,096; the run says *More than 4096 hosts in scope; the rest were not read.* |
| Hosts read at once | the profile's **Hosts at once**, 1 to 16 (default 4) |
| Names, versions | at most 128 characters; names and versions must match the package manager's own character rules |
| Logins tried per host | 3 ([which ones](discovery-credentials.md#which-login-a-host-gets)) |

Only installed packages are kept: a Debian package whose status is not
installed (removed with its configuration left, half-installed) is skipped,
and so are RPM's `gpg-pubkey` entries.

## What is stored

For each host read, Danbyte keeps one row of **OS facts** and one row per
**package**. Both are machine data: written in bulk, never in the change log.

**OS facts:** os-release `ID`, `ID_LIKE`, `VERSION_ID`, the codename and
`PRETTY_NAME`; the package manager; the transport that read it and when; and
the OSV ecosystem its packages are advised under (blank for the distributions
above without one). Windows adds its own facts ([Windows hosts](discovery-windows.md#what-is-stored)).

**Packages:** name, version, architecture, the source package and its
version, the package URL (purl), the ecosystem, and first and last seen. The
purl carries the distribution: `pkg:deb/debian/libssl3@3.0.15-1~deb12u1?arch=amd64&distro=bookworm`,
`pkg:rpm/rocky/openssl@1%3A3.0.7-27.el9?arch=x86_64&distro=rocky-9`
(RPM versions carry the epoch, `0:` when the package has none).

Each successful read replaces the host's list:

- a package missing from the read gets a removed date and is deleted 30 days
  later by the timer; one that comes back is current again;
- a host that could not be read (refused, unreachable, timed out) keeps its
  last list and facts;
- a host whose packages or OS facts changed is re-matched.

Packages are not [installed software](applications.md). A Linux host has
well over a thousand, so they stay on the **Packages** tab; the packages that
are an application you track become installs
([below](#applications-from-packages)).

### The Packages tab

The tab appears on a device or VM once it has current packages, while
Discovery is on, for someone with *view* on the host and on installed
software.

Above the list: the release name, the ecosystem, Windows facts when it is a
Windows host, the transport and when it was read. Then a line when
[advisories are missing](discovery-troubleshooting.md#packages-but-no-vulnerabilities).

| Column | Shows |
|---|---|
| Package, Version, Arch | As the package manager reports them. |
| Source | The source package (Debian, Ubuntu) or origin (Alpine) the advisories name. |
| Application | The application whose **Package names** take this package, linked. Blank without *view* on applications. |
| CVEs | Open matches through this package that no exception covers, as a count on the worst severity's badge; it opens the host's Vulnerabilities tab narrowed to the package. Blank while vulnerability data is off. |
| Publisher | Windows programs. |
| First seen, Last seen | When a read first and last found it. |

## What a read feeds

After the read hosts are stored, three steps run for them - the same for a
server run and for a run on an Outpost. A step that fails is logged and never
fails the run.

### The running version

The host's **software version** is set from its facts, with source
**Discovery**:

| OS | Version written | End-of-life cycle it implies |
|---|---|---|
| Debian | `13` (os-release `VERSION_ID`) | `13` |
| Ubuntu | `22.04` | `22.04` |
| RHEL, Rocky Linux, AlmaLinux | `9.4` | `9` |
| Alpine | `3.22.1` | `3.22` |
| Windows | `10.0.20348.2849` (NT version, build and UBR; `6.3.9600.22824` on Server 2012 R2) | none |

A version a person typed or imported is never overwritten. Discovery ranks
above SNMP, virtualization and Oxidized, so its value replaces theirs and
theirs never replaces it ([where the running version comes
from](lifecycle.md#where-the-running-version-comes-from)). Version changes
are in the change log with the cause *Package inventory*; the run's counts
say *N OS versions set*.

### Platform proposals

A read never changes a host's platform. When the facts do not fit the
platform - none, a generic one such as *Linux 6.x/2.6 Kernel*, or *Debian 12*
on a host that now reports 13 - **Findings** gets a **Set platform** row for
that host (*Set platform to Debian 13*). A device without its own platform is
judged by its device type's.

The platform it proposes is the first of:

1. a tenant platform mapped to the same end-of-life product and cycle
   (debian / 13);
2. one named *Debian 13*, or with that slug;
3. a per-OS one named *Debian* that does not name another release;
4. otherwise a new platform *Debian 13*, created on **Accept**.

| os-release `ID` | Platform name | Release parts | End-of-life product |
|---|---|---|---|
| `debian` | Debian | 1 (`13`) | `debian` |
| `ubuntu` | Ubuntu | 2 (`22.04`) | `ubuntu` |
| `rhel` | Red Hat Enterprise Linux | 1 | `rhel` |
| `rocky` | Rocky Linux | 1 | `rocky-linux` |
| `almalinux` | AlmaLinux | 1 | `almalinux` |
| `centos` | CentOS | 1 | `centos`, then `centos-stream` |
| `ol` | Oracle Linux | 1 | `oracle-linux` |
| `fedora` | Fedora | 1 | `fedora` |
| `amzn` | Amazon Linux | 1 | `amazon-linux` |
| `alpine` | Alpine Linux | 2 (`3.22`) | `alpine-linux`, then `alpine` |
| `sles` | SUSE Linux Enterprise Server | 1 | `sles` |
| `opensuse-leap` | openSUSE Leap | 2 | `opensuse` |

Another distribution is named from its `PRETTY_NAME` without numbers and gets
no end-of-life product. Windows hosts get no platform proposal: Microsoft's
products are not one name and release.

With [end-of-life data](end-of-life-data.md) on, a created platform is mapped
to the product and cycle (debian / 13), and so is a matched platform that is
named per release and not mapped yet - the same mapping the platform page's
**Map** writes. A per-OS platform (*Debian*) is not mapped: a platform has
one cycle, so it cannot carry 12 and 13 at once. Name platforms per release
to get end of life per host; the host's OS bar and *End of life* columns then
read the cycle's dates.

A platform that already fits (*Debian*, *Debian 13*, or one mapped to
debian / 13) raises no row.

| Action | Needs | Does |
|---|---|---|
| **Accept** | *change* on the host; to create the platform, *add* on platforms not limited to sites; to map an existing one, *change* on it | Puts the host on the platform, creating and mapping it as proposed. Change-logged. |
| **Ignore** | *change* on the host | Hides the row until the OS, its release or the host's platform changes. |

### Applications from packages

An application's **Package names** say which packages are it - *nginx* ←
`deb:nginx`, `deb:nginx-*`, `rpm:nginx` ([the syntax](applications.md#package-names)).
After every read, and right after an application's package names change,
the installs follow the packages:

| Situation | What happens |
|---|---|
| A read host has the package, no install of the application | An install is created, source **Discovery**, at the package's upstream version (`1.26.3` from `1:1.26.3-3+deb13u1`; the epoch and the distribution revision are cut), with *last seen*. Its end-of-life cycle comes from that version like any install's. |
| A Discovery install exists | Its version follows the package. |
| A person's install exists (manual, import, a group) | Never written over. Its **observed version** is kept current, and the Software tab shows *Discovery reads 1.26.3* when the two differ. |
| The package is gone from a host that was read | The Discovery install it made is deleted, and comes back if the package does. A person's install only loses its observed version. |

Two packages of one application on one host give one install, from the
closest name match. An install that a service-scan finding created is
adopted by the package and follows it from then on. Creates, version changes
and deletes are in the change log with the cause *Package inventory*; the
observed version and last seen are bookkeeping and are not. The run's counts
say *N installs updated*.

Windows programs take part too: a `generic:Mozilla Firefox*` entry makes
installs from a Windows host's programs.

**Findings** proposes the links for well-known server software. The list is
data in `discovery/known_software.py` and names only packages the
distributions ship: nginx, Apache HTTP Server, PostgreSQL, MySQL, MariaDB,
Redis, Memcached, MongoDB, Docker Engine, containerd, HAProxy, OpenSSH server,
BIND, Samba, PHP, Node.js, Python, OpenJDK, Apache Tomcat, RabbitMQ,
Elasticsearch, Grafana, Prometheus, Zabbix server, Zabbix agent, Keepalived,
FRRouting, OpenVPN, WireGuard tools, Squid, Postfix and Dovecot.

| Finding | When | Accept | Needs | Ignore |
|---|---|---|---|---|
| **Add application** (*Application nginx found on 12 hosts*) | Hosts have the software and the tenant has no application of that name | Creates the application with its package names - and, with end-of-life data on, its end-of-life product when the catalog has it. The installs follow. | *add* on applications, not limited to sites | Hidden until someone shows it again |
| **Link packages** (*Link packages to nginx (12 hosts)*) | The tenant has an application of that name that names no packages | Sets its package names | *change* on the application | Hidden until someone shows it again |

One row per software, not per host; the row lists up to 20 hosts as evidence.
A package some application already names raises no row.

## CVE matches

Inventoried packages are matched against OSV advisories with no product
mapping needed, and show as **Via: Package**. The rules are on [Known
vulnerabilities: distro packages](vulnerabilities.md#distro-packages); in short:

- each package is tested under the name its distribution's advisories use:
  the source package for Debian and Ubuntu (`libssl3` is advised as
  `openssl`), the origin for Alpine, the package itself for RPM;
- only against the entry for the host's own release, so a Debian 12 host is
  compared with Debian 12's fixed version, backports included;
- when an application names the host's package and is also mapped to a CPE,
  the package decides: an application match the distribution's advisory
  covers is not made ([a package and its application report a record
  once](vulnerabilities.md#distro-packages));
- exceptions, priorities, the compliance rule and notifications work as for
  any match; an exception for a package match is per host or tenant-wide;
- matches read with *view* on installed software as well as on the host;
- they exist only while Discovery is on for the tenant: switching it off
  resolves them.

Windows programs (`generic` packages) are never matched against OSV, which
has no ecosystem for them. Windows CVEs come from the OS build instead
([Windows hosts](discovery-windows.md#matching-against-microsofts-data)).

How the advisories arrive depends on the vulnerability data's update source
([Getting started](discovery-getting-started.md#a8-find-the-packages-and-cves)).
In server and browser mode, OSV is asked for the distinct package names
across every tenant - a deb or apk package per release (`Debian:12` +
`openssl`), an RPM package by its package URL - never a version, host or
address. In upload mode nothing leaves the server.
