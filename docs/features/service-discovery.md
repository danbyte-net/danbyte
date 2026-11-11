---
icon: lucide/radar
---

# Discovery: service scan

A **service scan** connects to TCP ports of addresses already in IPAM, reads
what answers - a greeting, a web server's `Server` header and page title, a
TLS certificate, an SSH host key - and names the product and version where
it can. What it finds goes to a **review queue**: add the service, add the
installed software, map the product to a CPE. Nothing is created until a
person accepts it ([#451](https://github.com/danbyte-net/danbyte/issues/451)).

It is a second kind of [discovery profile](discovery.md), beside package
inventory, under the same switches, authorisation, deny subnets, exempt
flags, maintenance events and windows. It logs in nowhere and sends no
credential.

!!! warning "Scanning needs permission"
    Port scans can be against policy, a contract or the law unless someone
    with the authority over those addresses agreed. Old printers, OT and ICS
    equipment and some embedded devices can misbehave even on a connect
    scan: exempt them (below) or leave their prefixes out of the scope, and
    start with a low rate.

## Turn it on

Exactly as for package inventory ([Turn it on](discovery.md#turn-it-on)):
the deployment allows discovery, a tenant admin turns the Discovery
integration on, and a profile records who authorised it. Then **Add
profile** on the **Discovery** tab of the Monitoring page, **Kind** *Service
scan*. Its settings (nmap, deny subnets) are in **Host discovery** under
**Monitoring → Settings**.

| Field | Meaning |
|---|---|
| Scope | The same kinds as an inventory profile ([Scope](discovery.md#scope)). The scan's targets are the **IP addresses in IPAM**: every address in a named prefix (or a prefix inside it, same VRF), every address of a named site (its own site, or its device's or VM's), every address of a named device or VM (assigned directly or through an interface, primary and out-of-band), every address a monitoring policy on a named region, VRF, platform, device type or role would cover (decided by the monitoring resolver, so the policy and the scan agree), or - only when chosen and confirmed - every address in the tenant. A monitoring policy's scope can be copied in with **Use a monitoring policy's scope**; it is a copy, never a link, so editing the policy does not widen the scan. Nothing outside IPAM is scanned, and no range is typed at run time. |
| Ports | Ports and ranges (`22, 80, 8000-8100`), at most 1,024. Empty means the default list below. |
| Connects per second | New TCP connections per second for the whole run. Default 20; the deployment caps it (`DANBYTE_DISCOVERY_SCAN_MAX_RATE`, default 200). |
| Hosts at once | Addresses scanned in parallel, 1 to 16. Default 4. |
| Every, Window | As for package inventory. |
| Authorisation | Who authorised scanning this scope. Changing the scope **or the ports** without a new statement clears it, and the profile stops running. |

The kind is fixed once the profile is created.

**Run now** needs the `scan` permission on the profile, nothing else: a
service scan reads no credential. A run started with Run now scans only the
addresses the person who pressed it may view.

## What is sent to a host

These are the only packets Danbyte's own engine sends
(`danbyte_checks/service_scan.py`), from the Danbyte server's workers:

1. A TCP connect (a normal three-way handshake from an unprivileged process;
   no raw packets, no SYN scan, no root) to each port of the list. At most
   8 ports of one address at once, each connect paced by the run's rate, a
   1.5 s connect timeout, no retries.
2. On an open port, by its number:
    - **TLS ports** (443, 465, 636, 993, 995, 5986, 6443, 8443, 9443): a TLS
      handshake (TLS 1.2 or later) that reads the certificate the server
      presents. The scan does not verify it - it records the public facts
      (subject, issuer, names, expiry, fingerprint); the
      [certificate inventory](../monitoring/certificates.md) judges it. When
      the certificate is already in that inventory, the row links to it.
    - **HTTP and HTTPS ports** (80, 3000, 5985, 8000, 8008, 8080, 8081,
      8888, 9090, 9200; and 443, 5986, 6443, 8443, 9443 over TLS): one
      request, exactly:

        ```http
        GET / HTTP/1.1
        Host: <the address>
        User-Agent: Danbyte-Discovery/1.0 (service scan)
        Accept: */*
        Connection: close
        ```

        Danbyte reads the status, `Server`, `X-Powered-By`, `Location` and
        the page `<title>` from at most 64 KB, for at most 5 s. A redirect is
        recorded, **never followed**. No other path, no cookies, no
        credentials.
    - **Every other port**: nothing. Danbyte waits up to 2 s for the greeting
      the server sends by itself (SSH, FTP, SMTP, POP3, IMAP, MySQL, telnet)
      and reads at most 2 KB.
    - **An SSH greeting**: the server's host key, read with a key exchange
      only - no login - and filed as *observed* in the
      [SSH host-key inventory](../monitoring/ssh-host-keys.md); nobody's key
      is accepted by a scan.
3. Close.

No logins, no protocol commands, no payloads, nothing else. Never: exploit,
brute-force, default-credential, fuzzing, denial-of-service or other
intrusive checks; never a third-party lookup of what was found.

So that security teams can recognise the traffic: it comes from the
Danbyte server's address (its workers), the HTTP requests carry the
User-Agent above, and the pattern is a paced connect sweep of the port list.

### The default port list

| Port | Service | Port | Service | Port | Service |
|---|---|---|---|---|---|
| 21 | ftp | 445 | microsoft-ds | 3389 | rdp |
| 22 | ssh | 465 | smtps | 5432 | postgresql |
| 23 | telnet | 514 | shell | 5672 | amqp |
| 25 | smtp | 587 | submission | 5900 | vnc |
| 53 | domain | 636 | ldaps | 5985 | winrm |
| 80 | http | 873 | rsync | 5986 | winrm-https |
| 88 | kerberos | 993 | imaps | 6379 | redis |
| 110 | pop3 | 995 | pop3s | 6443 | kubernetes-api |
| 111 | rpcbind | 1433 | ms-sql | 8000 | http-alt |
| 135 | msrpc | 1521 | oracle | 8080 | http-proxy |
| 139 | netbios-ssn | 2049 | nfs | 8443 | https-alt |
| 143 | imap | 2375 | docker | 9090 | http-alt |
| 389 | ldap | 3000 | http-alt | 9200 | elasticsearch |
| 443 | https | 3306 | mysql | 11211 | memcached |
| | | | | 27017 | mongodb |

UDP is not scanned. SNMP stays with [SNMP discovery](snmp-discovery.md).

## Which addresses are left alone

When a run starts - never when it was queued - the scope is resolved again
inside the profile's tenant, and an address is not contacted when:

| Result | Why |
|---|---|
| Exempt | The address, its prefix, a prefix around it, or its device or VM is *exempt from discovery* ([how](discovery.md#exempting-a-host-address-or-prefix)). |
| Deny subnet | The address is in a discovery deny subnet (any VRF) or a monitoring deny subnet of its VRF. |
| Blocked target | The server's target policy refuses it: link-local and cloud-metadata addresses always, internal ranges where `DANBYTE_CHECK_BLOCK_INTERNAL` is on unless they are in `DANBYTE_SSRF_ALLOWLIST`. |
| In maintenance | Its device or VM is in an open [maintenance event](maintenance.md). |

A run scans at most 4,096 addresses. Each run's **Addresses** tab lists
every address it considered and what happened; its **Overview** states the
ports, the rate and the parallelism it used, and who started it. Starting a
run is in the change log.

## Safety limits

| Limit | Value |
|---|---|
| Connects per second, per run | the profile's (default 20), never above `DANBYTE_DISCOVERY_SCAN_MAX_RATE` (default 200, at most 2000) |
| Addresses at once | the profile's Hosts at once, 1 to 16 |
| Ports at once per address | 8 |
| Ports per profile | 1,024 |
| Addresses per run | 4,096 |
| Connect timeout | 1.5 s, no retries |
| Greeting | 2 s, 2 KB |
| HTTP answer | 5 s, 64 KB |
| TLS handshake | 4.5 s |
| Kept per port | 512 characters of banner, control characters removed; 200 of a page title |

A host that trickles bytes, floods, or sends binary junk costs at most these
deadlines and caps; what it sends is stored as plain text and never
interpreted.

## How a product is named

Two fingerprint sources, in this order:

1. **Danbyte's own rules** for the servers seen most (OpenSSH, Dropbear,
   nginx, Apache, IIS, lighttpd, Caddy, vsftpd, ProFTPD, Postfix, Exim,
   Dovecot) and the MySQL/MariaDB handshake.
2. **[Rapid7 Recog](https://github.com/rapid7/recog)** fingerprint data
   (BSD-2-Clause), for SSH, FTP, SMTP, POP3, IMAP and telnet greetings, the
   HTTP `Server` and `X-Powered-By` headers and page titles.

Each observation records the source (*Danbyte rule*, *Recog*, *Banner* when
the protocol was recognised but not the product, *Port number* when only
the port told), the rule that matched, and a confidence:

| Confidence | When |
|---|---|
| High | a fingerprint named the product and its version |
| Medium | a fingerprint named the product without a version, or the protocol was recognised |
| Low | only the port number |

What a banner can and cannot tell: it shows the **upstream** version
(`OpenSSH_9.6p1`), not the distro's patch level, so a Debian or Ubuntu
build with backported fixes looks vulnerable when it is not. Hidden
versions (`server_tokens off`), proxies and load balancers hide the real
server. Banner results therefore **never create vulnerability matches**;
for CVEs use [package inventory](discovery.md).

### The Recog data

Danbyte ships Recog's data, converted, not its code:

- Pinned to tag **v3.3.2**, commit `1714aaed118861b4567bb6754920b4b929f59380`.
  `danbyte_checks/data/RECOG-NOTICE` holds the SHA-256 of each source file
  and of the converted `recog.json`, and the licence.
- `scripts/recog_build.py` converts it at build time. It refuses a source
  file whose hash is not the pinned one and any file with a DOCTYPE or
  ENTITY declaration, so no XML parser runs in a deployment.
- Recog's patterns are regular expressions applied to text a host sends.
  The build drops every pattern that does not compile under Python, does
  not reproduce its own examples, or is slow on hostile 512-character input
  (Python's regular expressions have no timeout). Three of 1,532 were
  dropped. At run time every pattern sees at most 512 characters.
- Updating: change the pin in the script after reading the upstream diff,
  download the files of the new commit, run the script, review the dropped
  list and the JSON diff, run the discovery tests, update `RECOG-NOTICE` and
  this section.

## The nmap engine

A service-scan profile can use **nmap** instead of the built-in engine,
for better service and version recognition. It is optional: everything
above works with nothing installed.

**Turn it on.** Install nmap yourself, under its own licence, on the
Danbyte server (`apt install nmap` on Debian and Ubuntu). Danbyte never
installs or bundles it. It looks for the binary once per process, when it
is first asked: `NMAP_BINARY` (an absolute path) when set, else `nmap` on
the service user's PATH. The **nmap** switch in **Host discovery** under
**Monitoring → Settings** shows
what it found - *nmap 7.98 at /usr/bin/nmap*, or *Not found* - and a tenant
admin can switch it on only when one was found. Restart the web and worker
units after installing it. `DANBYTE_DISCOVERY_NMAP_ALLOWED=False` forbids it
for every tenant (*Forbidden by the deployment*).

Then a service-scan profile's **Engine** can be *nmap*, with **Version
probes** (`--version-intensity`, 0 to 5, default 2) and **Timing** (`-T2`
polite, `-T3` normal, `-T4` aggressive; default `-T3`). When a run starts
Danbyte checks again that the deployment allows nmap, the binary is there,
the switch is on and the worker is not running as root; otherwise the run
fails without starting nmap.

**What runs.** Danbyte builds the whole argument list itself
(`danbyte_checks/nmap.py`), from fixed flags and bounded numbers; nothing a
person types reaches it:

```
nmap -sT -sV --version-intensity <0-5> --unprivileged -Pn -n
     -p <the profile's ports> -T<2-4> --max-rate <connects per second>
     --max-retries 1 --host-timeout 300s --max-hostgroup <hosts at once>
     -oX - <IP addresses>
```

- Targets are the scan's IPAM addresses, each checked to be an IP literal
  and written in canonical form - never a host name or other text.
- `-sT`: TCP connect only. No SYN scan, no OS detection (`-O`), no `-A`,
  and **no NSE scripts at all** in this version - nothing that could brute
  force, exploit or send what was found to a third party.
- `-sV` sends nmap's own service probes to open ports, more than the
  built-in engine's single greeting read or GET: expect more traffic per
  open port, especially at higher version-probe settings.
- It runs without a shell (an argument list), as the unprivileged service
  user (refused as root), in a fresh temporary directory, with a minimal
  environment and standard input closed. At most 32 MB of output is read;
  nmap is killed with its process group after 300 s per batch of addresses
  (at most 5 h).
- The XML is read with the standard library. The only DOCTYPE accepted is
  nmap's own bare `<!DOCTYPE nmaprun>`; any other, and any ENTITY
  declaration, is refused. Only open TCP ports of the addresses that were
  asked for are kept.

Results are the same observed services, source *nmap*: the service name,
product and version nmap reports, its first application or OS CPE
(converted to CPE 2.3), and a confidence from how nmap decided - *High* for
a probed match with a version, *Medium* for a probed match without one,
*Low* when nmap only guessed from the port number. They feed the same
review queue and, like banners, never create vulnerability matches.

**Licence.** Nothing of nmap is bundled with Danbyte: no binary, no data
files, no code. Danbyte runs a binary the administrator installed and reads
the results the administrator asked for. nmap's data files (such as
`nmap-service-probes`) are never read by Danbyte's own engine. nmap is
distributed under the Nmap Public Source License; using it is between you
and its authors.

**Outposts** do not run nmap: service scans run on the server only.

### nmap on an Outpost

On an Outpost, the nmap is the Outpost's: the agent looks for
`OUTPOST_NMAP_BINARY` (else `nmap` on its PATH) when it starts, refuses to
use it when the agent runs as root, and says in its hello which version it
found. The nmap switch in Host discovery can be turned on when the server or
any Outpost has one; the Runs on picker says per Outpost whether it has.

## The review queue

**Findings** on the Discovery tab of the Monitoring page (and on each service-scan profile and
run) lists what the current observations propose. Its columns read left to
right: host and address, port, the proposal (kind, product and version),
confidence, source, the evidence (banner excerpt or rule, the full evidence
of every port on hover), when it was last seen, and the actions:

| Proposal | When | Accept creates | Needs |
|---|---|---|---|
| Add service | the address's device or VM has no service on that port and the scan recognised the service or product | a [Service](../dcim/services.md) on the host, on that address and port | *add* on services |
| Add software | a fingerprint named a product and the host has no install of an application of that name | an [installed software](applications.md) row (source *Discovery*, the banner's version), and the application when the tenant has none of that name | *add* on installed software; *add* on applications for a new one |
| Map to CPE | the product has a CPE and the tenant's application of that name has no product mapping | a [product mapping](vulnerabilities.md) through the vulnerability data's own bulk create | *change* on the application; vulnerability data on |

- Everything accepted is an ordinary object, in the change log as you.
  Permissions are checked on what is created, site scope included; a row you
  may not create is refused and nothing of it stays.
- An install that already exists is never changed: a banner's version never
  overwrites one someone recorded or inventoried.
- Select several rows of the same proposal to accept them together.
- **Ignore** hides a finding until the observation changes (product,
  version, CPE or service name); **Show ignored** lists them again.
- An open port on an address with no device or VM, or a port nothing
  recognised, proposes nothing; it is listed under **Open ports** only.

The same queue holds the package inventory's proposals - **Set platform**,
**Add application** and **Link packages** - with the OS release or the
packages as evidence; see [What a read
feeds](discovery.md#what-a-read-feeds). They need *view* on installed
software rather than on IP addresses.

## What is stored

Each open port is one **observed service** row: address (and its device or
VM), port, service name, banner excerpt, product, vendor, version, CPE
guess, source, rule, confidence, the HTTP and TLS facts, first and last
seen, and *closed* when a later scan found the port closed (it is current
again when it opens). Observed services are machine data, not
change-logged, and read with *view* on the address.

## Where it runs

On the Danbyte server's workers, on the RQ queue `discovery`, like package
inventory - or, with **Runs on**, on an Outpost: one named Outpost, or the
Outpost each address is bound to (device, location, prefix, site, the
tenant default). The server resolves the addresses and every rule above;
the Outpost runs the same scan (`danbyte_checks.service_scan`, the same
probes, rates and fingerprints) from its own network and posts the open
ports back. No credential is sent. The Outpost applies its own target
policy, not the server's internal-range block. The rate is per Outpost: each
one paces its own connects to the profile's rate.

An address whose Outpost is offline, runs an agent older than **0.10.0**, or
(for the nmap engine) has no nmap it may run, is left alone with a host
result that says so; it is never scanned from the server instead. See
[Discovery on an Outpost](discovery.md#on-an-outpost) for the rules, and
[Outposts](../monitoring/outposts.md#discovery-on-an-outpost) for the agent.

What an Outpost posts back is checked: only the address and the ports it was
given, the same caps on banners and fields as the built-in probes, CPEs in
2.3 form; an answer that is not one of those fails the address.

## Permissions

| Action | Needs |
|---|---|
| Create, change, delete a service-scan profile | as for inventory profiles: *add* / *change* / *delete* on Discovery profiles, *view* on the scope |
| Run now | the **scan** verb on the profile |
| Open ports, findings | *view* on IP addresses (rows of addresses you may view) |
| Accept, ignore | what accepting creates (table above) |

## API

| Endpoint | |
|---|---|
| `/api/discovery/profiles/` | `kind` (`inventory`, `service_scan`; fixed once created), `ports`, `connects_per_second`, `rate_cap` (read-only), `scan_engine` (`builtin`, `nmap`), `nmap_version_intensity` (0-5), `nmap_timing` (2-4); `?kind=` filters |
| `GET`, `PATCH /api/discovery/settings/` | `nmap`: `{available, enabled, path, version, label, reason}`; `PATCH {"nmap": true}` (tenant admin, only while available) |
| `GET /api/discovery/runs/` | `kind` on each run; `?kind=` filters |
| `GET /api/discovery/services/` | Observed services (`?run=`, `?profile=`, `?ip_address=`, `?device=`, `?virtual_machine=`, `?confidence=`, `?search=`, `?current=false` for closed ones too) |
| `GET /api/discovery/findings/` | Proposals (`?kind=service,software,cpe`, `?ignored=true`, and the filters above); `totals` by kind |
| `POST /api/discovery/findings/accept/` | `{ids: [...]}` of `service:` and `software:` findings; answers `created` and `refused` |
| `POST /api/discovery/findings/ignore/` | `{ids: [...], ignore: true|false}` |
