---
icon: lucide/radar
---

# Discovery: service scan

A **service scan** connects to TCP ports of addresses already in IPAM, reads
what answers - a greeting, a web server's `Server` header and page title, a
TLS certificate, an SSH host key - and names the product and version where it
can. What it finds goes to **Findings** for review: add the service, add the
installed software, map the product to a CPE. Nothing is created until a
person accepts it ([#451](https://github.com/danbyte-net/danbyte/issues/451)).

It is the second kind of [discovery profile](discovery.md), under the same
switches, authorisation, deny subnets, **Do not scan** flags, maintenance
events and windows ([Scope and safety](discovery-safety.md)). It logs in
nowhere and sends no credential. To set one up, see [Getting
started](discovery-getting-started.md#b-a-first-service-scan).

!!! info "Where to find it"
    - Profiles, **Findings**, **Open ports**: the **Discovery** tab of the
      **Monitoring** page. A service-scan profile and each of its runs also
      have **Findings** and **Open ports** tabs.
    - The **nmap** switch: the **Host discovery** section (**Monitoring**
      page → **Settings** tab).

!!! warning "Scanning needs permission"
    Port scans can be against policy, a contract or the law unless someone
    with authority over those addresses agreed. Old printers, OT and ICS
    equipment and some embedded devices can misbehave even on a connect
    scan: mark them **Do not scan** or leave their prefixes out of the
    scope, and start with a low rate.

## What is sent to a host

These are the only packets the built-in engine sends
(`danbyte_checks/service_scan.py`), from the Danbyte workers or the Outpost
that runs the profile:

1. **A TCP connect** to each port of the list: a normal three-way handshake
   from an unprivileged process - no raw packets, no SYN scan, no root. At
   most 8 ports of one address at once, every connect paced by the run's
   rate, a 1.5 s connect timeout, no retries.
2. **On an open port**, by its number:
    - **TLS ports** (443, 465, 636, 993, 995, 5986, 6443, 8443, 9443): a TLS
      handshake (TLS 1.2 or later), within 4.5 s, that reads the certificate
      the server presents. It is not verified: the scan keeps its public
      facts (subject and issuer names, DNS names, expiry, SHA-256
      fingerprint, self-signed or not), and the [certificate
      inventory](../monitoring/certificates.md) judges certificates. A row
      links to the certificate when the inventory already holds it. A TLS
      port that does not complete a handshake is connected to once more
      without TLS and treated as the other ports below.
    - **HTTP and HTTPS ports** (80, 3000, 5985, 8000, 8008, 8080, 8081, 8888,
      9090, 9200; and 443, 5986, 6443, 8443, 9443 over TLS): one request,
      exactly:

        ```http
        GET / HTTP/1.1
        Host: <the address>
        User-Agent: Danbyte-Discovery/1.0 (service scan)
        Accept: */*
        Connection: close
        ```

        Danbyte reads the status, `Server`, `X-Powered-By`, `Location` and the
        page `<title>` from at most 64 KB within 5 s. A redirect is recorded,
        never followed. No other path, no cookies, no credentials.
    - **Every other port**: nothing is sent. Danbyte waits up to 2 s for the
      greeting the server sends by itself (SSH, FTP, SMTP, POP3, IMAP, MySQL,
      telnet) and reads at most 2 KB, up to the first line end.
    - **An SSH greeting**: the server's host key, read with a key exchange
      only - no login - and filed as *observed* in the [SSH host-key
      inventory](../monitoring/ssh-host-keys.md) when the address belongs to
      a device or VM. A scan never accepts a key.
3. **Close.**

No logins, no protocol commands, no payloads. Never exploit, brute-force,
default-credential, fuzzing, denial-of-service or other intrusive checks;
never a third-party lookup of what was found.

So that security teams can recognise the traffic: it comes from the Danbyte
server's address (or the Outpost's), the HTTP requests carry the User-Agent
above, and the pattern is a paced connect sweep of the port list.

### The default port list

An empty **Ports** field scans these 43 ports. UDP is not scanned; SNMP stays
with [SNMP discovery](snmp-discovery.md).

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

Your own list takes ports and ranges (`22, 80, 8000-8100`), 1 to 65535, at
most 1,024 ports in all.

## Safety limits

| Limit | Value |
|---|---|
| Connects per second, per run | the profile's **Connects per second** (default 20), never above `DANBYTE_DISCOVERY_SCAN_MAX_RATE` (default 200, at most 2000). On Outposts each Outpost paces its own connects to that rate. |
| Addresses at once | the profile's **Hosts at once**, 1 to 16 |
| Ports at once per address | 8 |
| Ports per profile | 1,024 |
| Addresses per run | 4,096 |
| Connect timeout | 1.5 s, no retries |
| TLS handshake | 4.5 s |
| Greeting | 2 s, 2 KB |
| HTTP answer | 5 s, 64 KB |
| Kept per port | 512 characters of banner, control characters removed; header values 200; a page title 200 |

A host that trickles bytes, floods, or sends binary junk costs at most these
deadlines and caps. What it sends is stored as plain text and never
interpreted.

## How a product is named

Each piece of evidence (the SSH, FTP, SMTP, POP3, IMAP or telnet greeting;
the HTTP `Server` and `X-Powered-By` headers; the page title) is tried
against two fingerprint sources, in this order:

1. **Danbyte's own rules** for the servers seen most: OpenSSH, Dropbear,
   nginx, Apache HTTP Server, IIS, lighttpd, Caddy, vsftpd, ProFTPD, Postfix,
   Exim and Dovecot, plus the MySQL and MariaDB handshake packet.
2. **[Recog](https://github.com/rapid7/recog)** fingerprint data by Rapid7
   (BSD-2-Clause licence).

Each open port records the source - *Danbyte rule*, *Recog*, *nmap*,
*Banner* (the protocol was recognised, not the product) or *Port number*
(only the port told) - the rule that matched, a CPE 2.3 guess, and a
confidence:

| Confidence | When |
|---|---|
| High | a fingerprint named the product and its version |
| Medium | a fingerprint named the product without a version, or the protocol was recognised |
| Low | only the port number |

### Why a banner never makes a CVE match

A banner shows the **upstream** version (`OpenSSH_9.6p1`), not the
distribution's patch level, so a Debian or Ubuntu build with backported fixes
looks vulnerable when it is not. Hidden versions (`server_tokens off`),
proxies and load balancers hide the real server. Service-scan results
therefore **never create vulnerability matches**. For CVEs, run a [package
inventory](discovery-packages.md) on the host. A *Map to CPE* finding you
accept maps an application, whose installs are then matched like any other.

### The Recog data

Danbyte ships Recog's data, converted; no Recog code.

- Pinned to tag **v3.3.2** (released 2026-10-12), commit
  `1714aaed118861b4567bb6754920b4b929f59380`. The files used are the SSH,
  FTP, SMTP, IMAP, POP and telnet banner databases, HTTP servers, HTTP
  `X-Powered-By` and HTML titles.
- `danbyte_checks/data/RECOG-NOTICE` holds the licence, the SHA-256 of each
  source file and of the converted `recog.json`.
- `scripts/recog_build.py` converts it at build time. It refuses a source
  file whose hash is not the pinned one and any file with a DOCTYPE or ENTITY
  declaration, so no XML parser runs in a deployment.
- Recog's patterns are regular expressions applied to text a host sends. The
  build drops every pattern that does not compile under Python, does not
  reproduce its own examples, or is slow on hostile 512-character input
  (Python's regular expressions have no timeout). 1,529 are kept and 3 were
  dropped. At run time a pattern sees at most 512 characters.
- **Updating**: read the upstream diff, change the tag, commit and file
  hashes in the script, download the files of the new commit, run
  `python3 -I scripts/recog_build.py <dir>`, review the dropped list and the
  JSON diff, run `manage.py test discovery`, and update `RECOG-NOTICE` and
  this section.

## What is stored

Each open port is one **observed service**: address (and its device or VM),
port, service name, banner excerpt, product, vendor, version, CPE guess, an
OS guess, source, rule, confidence, the HTTP and TLS facts, first and last
seen. A port a later scan of the address found closed is marked closed; it
is current again when it opens. Observed services are machine data, not in
the change log, and read with *view* on the address.

**Open ports** lists the current ones (on a profile or run, the ones it
found).

## Findings

<span id="the-review-queue"></span>**Findings** lists what the current observations propose, with the host and
address, port, the proposal, confidence, source, the evidence (banner
excerpt or rule) and when it was last seen. The same list holds the package
inventory's proposals - *Set platform*, *Add application*, *Link packages* -
described on [Package inventory](discovery-packages.md#what-a-read-feeds).

| Proposal | When | **Accept** creates | Needs |
|---|---|---|---|
| **Add service** | the address's device or VM has no service on that port, and the scan recognised the service or the product | a service on the host, on that address and port | *add* on services, on that host |
| **Add software** | a fingerprint named a product and the host has no install of an application of that name | an [installed software](applications.md) row, source *Discovery*, at the banner's version - and the application when the tenant has none of that name | *add* on installed software; *add* on applications, not limited to sites, for a new one |
| **Map to CPE** | vulnerability data is on, the product has a CPE guess, and the tenant's application of that name has no product mapping and no CPE or package URL template | a [product mapping](vulnerabilities.md#map-your-products), through the vulnerability data's own bulk create | *change* on the application |

- Everything accepted is an ordinary object, in the change log as you.
  Permissions are checked on what is created, site scope included; a row you
  may not create is refused with the reason and nothing of it stays.
- An existing install is never changed: a banner's version never overwrites
  one someone recorded or a package inventory keeps.
- Tick several rows of the same proposal and press **Accept N · kind** to
  accept them together.
- **Ignore** hides a finding until the observation changes (its service
  name, product, version or CPE); **Show ignored** lists them again, and
  **Show** on a row brings it back. Ignoring needs what accepting needs.
- An open port on an address with no device or VM, or a port nothing
  recognised, proposes nothing; it shows under **Open ports** only.

*Nothing to review* means there is no open proposal you may see.

## The nmap engine

A service-scan profile can use **nmap** instead of the built-in engine, for
better service and version recognition. It is optional: everything above
works with nothing installed.

**Turning it on**

1. Install nmap on the Danbyte server yourself, under its own licence
   (`apt install nmap` on Debian and Ubuntu). Danbyte never installs or
   bundles it.
2. Danbyte looks for it once per process, at the first ask: `NMAP_BINARY`
   (an absolute path) when set, else `nmap` on the service user's PATH. It
   must be a file the service user can execute and must answer
   `nmap --version` like nmap. Restart the web and worker units after
   installing it.
3. In **Host discovery**, the **nmap** row shows what was found - *nmap 7.98
   at /usr/bin/nmap*, *Not found*, or *Forbidden by the deployment* when
   `DANBYTE_DISCOVERY_NMAP_ALLOWED=False`. A tenant admin switches it on;
   that is possible only while the server or one of the tenant's Outposts
   has an nmap.
4. In the profile, **Engine** *nmap*, with **Version probes**
   (`--version-intensity`, 0 to 5, default 2) and **Timing** (*Polite
   (-T2)*, *Normal (-T3)*, *Aggressive (-T4)*; default -T3).

When a run starts, Danbyte checks again that the deployment allows nmap, the
binary is still there, the tenant's switch is on and the worker does not run
as root; otherwise the run fails without starting nmap, with the reason
(*Refusing to run nmap as root.*, *nmap: Not found.*).

**What runs.** Danbyte builds the whole argument list itself
(`danbyte_checks/nmap.py`) from fixed flags and bounded numbers; nothing a
person types reaches it:

```
nmap -sT -sV --version-intensity <0-5> --unprivileged -Pn -n
     -p <the profile's ports> -T<2-4> --max-rate <connects per second>
     --max-retries 1 --host-timeout 300s --max-hostgroup <hosts at once>
     -oX - <IP addresses>
```

- Targets are the scan's IPAM addresses, each checked to be an IP literal
  and written in canonical form - never a host name or other text. `-n`: no
  DNS lookups.
- `-sT`: TCP connect only. Never a SYN scan (`-sS`), OS detection (`-O`) or
  `-A`, and **no NSE scripts at all** in this version - nothing that could
  brute-force, exploit or send what was found to a third party.
- `-sV` sends nmap's own service probes to open ports, more than the
  built-in engine's single greeting read or `GET`: expect more traffic per
  open port, more at higher **Version probes**.
- It runs without a shell, as the unprivileged service user (refused as
  root), in a fresh temporary directory, with a minimal environment and
  standard input closed. At most 32 MB of output is read. The whole scan has
  a deadline of one minute plus 300 s per batch of **Hosts at once**
  addresses, at most 5 h; past it nmap is killed with its process group.
- The XML is read with the standard library. The only DOCTYPE accepted is
  nmap's own bare `<!DOCTYPE nmaprun>`; any other, and any ENTITY
  declaration, is refused. Only open TCP ports of the addresses asked for
  are kept.

Results are the same observed services, source *nmap*: the service name,
product and version nmap reports, its first application or OS CPE
(converted to CPE 2.3), and a confidence from how nmap decided - *High* for a
probed match with product and version, *Medium* for a probed match without
them, *Low* when nmap only went by the port number. nmap results carry no TLS
certificate facts or SSH host keys. They feed the same **Findings** and, like
banners, never create vulnerability matches.

**Licence.** Nothing of nmap is bundled with Danbyte: no binary, no data
files, no code. Danbyte runs a binary the administrator installed and reads
the results the administrator asked for; Danbyte's own engine never reads
nmap's data files (such as `nmap-service-probes`). nmap is distributed under
the Nmap Public Source License; using it is between you and its authors.

On an Outpost the nmap is the Outpost's own ([On an
Outpost](discovery-outposts.md#nmap-on-an-outpost)).

## Older links

<span id="turn-it-on"></span>
<span id="which-addresses-are-left-alone"></span>
<span id="where-it-runs"></span><span id="nmap-on-an-outpost"></span>
<span id="permissions"></span><span id="api"></span>
Setting up a scan is on [Getting started](discovery-getting-started.md#b-a-first-service-scan);
what is left alone, and permissions, on [Scope and safety](discovery-safety.md);
running on an Outpost on [On an Outpost](discovery-outposts.md); the
endpoints on [API](discovery-api.md#service-scans-and-findings).
