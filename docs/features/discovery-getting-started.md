---
icon: lucide/play
---

# Discovery: getting started

Two walkthroughs from a fresh install: a **package inventory** of Linux hosts
and a **service scan** of a prefix. Both start with the same two switches.
What each field means in full is in [Scope and safety](discovery-safety.md#profile-fields).

!!! info "Where to find it"
    - **Host discovery** settings: **Monitoring → Settings**
      (`/monitoring/settings`), section **Host discovery**.
    - **Discovery** card: **Settings → Integrations**.
    - Profiles: **Monitoring → Discovery** (`/discovery`), tab **Profiles**.
    - A device's own credentials: its **Access** tab, **Credentials** card. A
      VM's: its **Monitoring** tab, **Credentials** card.
    - Shared credentials: **Settings → Devices & polling → Credentials**.
    - A host's recorded SSH keys: the **SSH host keys** panel on a device's
      **Certificates & keys** tab, a VM's **Certificates** tab.

## Before you start

- The background workers (`danbyte-workers`) run and listen on the
  `discovery` queue. The shipped unit and compose file do; a custom worker
  command must add it ([Settings](discovery-settings.md#queue-and-timer)).
- The timer `danbyte-inventory` runs, for scheduled runs. **Run now** works
  without it.
- You know who may authorise reading or scanning the hosts. A profile does
  not run without that statement.

## 1. Allow Discovery on the deployment

A deployment admin (a superuser, or an admin grant without tenant narrowing)
switches on **This deployment** in **Host discovery**. The switch shows even
while the tenant switch is still off, and the line under it says who last
changed it and when.

When the server environment sets `DANBYTE_DISCOVERY_ENABLED`, the switch is
greyed out and reads *Locked on by the deployment* or *Locked off by the
deployment*; change the variable instead
([Settings](discovery-settings.md#environment-variables)).

## 2. Turn it on for the tenant

A tenant admin switches on the **Discovery** card. While step 1 is missing the
card says *Off for this deployment* and a toast says so when you switch it on.
Once both are on, the card's **Discovery** button opens the Discovery page, and
**Host discovery** shows the transports, **nmap** and **Deny subnets**.

With either switch off, every Discovery page and API answers *not found*, no
schedule runs, and existing package matches resolve.

## A. A first package inventory (Linux)

### A1. Check the transports

In **Host discovery**, **SSH key login** and **SSH password login** are on by
default and **WinRM over HTTPS** is off. Leave them, or switch off what your
policy forbids. **SSH password login** off stops every password login,
Linux and Windows, a host's own and shared ones.

### A2. Give each host a login

Make an ordinary account on the hosts - no root, no sudo
([least privilege](discovery-packages.md#least-privilege)) - and give
Danbyte its key. Then either:

- add a credential of kind **SSH key** (or **SSH password**) to each device
  or VM on its **Credentials** card, or
- add one **shared credential** under **Credentials** for many hosts: kind,
  **User name**, the key, and a **Scope** (**Devices**, **Virtual
  machines**, then **Roles**, **Device types**, **Platforms**, **Sites**,
  **Tags**, or **All hosts**). The dialog counts the hosts it matches.

**User name** is required on an SSH credential; nothing guesses `root`.

Which login a host gets when it has several is on
[Credentials and host keys](discovery-credentials.md#which-login-a-host-gets).

### A3. Create the profile

On the Discovery page's **Profiles** tab, press **Add profile** (needs *add*
on Discovery profiles; each row's pencil and bin edit and delete it, and the
selection bar enables, disables or deletes the ticked profiles):

1. **Name**.
2. **Kind**: *Package inventory*. It cannot be changed later.
3. Tick **Enabled**. A new profile is disabled until you do.
4. **Runs on**: *Server* (an Outpost is for hosts the server cannot reach,
   see [On an Outpost](discovery-outposts.md)).
5. **Scope**: pick **Devices**, **Virtual machines**, **Sites** or
   **Prefixes** - or copy a monitoring policy's scope with **Use a monitoring
   policy's scope**. An empty scope reads nothing.
6. **Every**: hours between scheduled runs; `0` for **Run now** only.
   **Window from** / **Window to** limit when runs may start (server time).
7. **Hosts at once** (default 4) and **Per-host timeout** (default 60 s).
8. **Credential**: leave *Host's own, then matching shared*, or pin one shared
   credential (an SSH key, SSH password or WinRM certificate).
9. **Authorisation**: who approved reading these hosts, and the reference
   (a ticket, a change number). Saving records you and the time.
10. **Create**. The profile's page opens.

### A4. Check what it would read

The profile's **Hosts** tab resolves the scope now, without contacting
anything: each host, its address, the credential it would use and a result
such as *Ready*, *No credential* or *Host key not accepted*. Fix *No
credential* rows with step A2.

### A5. Accept the hosts' SSH keys

Danbyte sends a credential only to a host whose SSH host key a person
accepted. On a fresh install no key is accepted, so:

1. Press **Run now**, then **Run now** in the dialog. Every host ends
   *Host key not accepted*, and the run reads the key each one presents (a
   key exchange, no login). The run status is *Nothing read*.
2. Open the profile's (or the run's) **Host keys** tab. It lists each key
   with its SHA256 fingerprint.
3. Compare each fingerprint with the host's own, for example on the host:
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.
4. Tick the ones that match and press **Accept N keys** (needs *change* on
   SSH host keys).

You can also paste a host's public key beforehand on its **SSH host keys**
panel (**Add host key**), or tick **Accept new host keys** in the **Run now** dialog; that
trusts whatever answers first and is not advised
([accept on first use](discovery-credentials.md#accept-new-host-keys-on-first-use)).

### A6. Run it

Press **Run now** again (needs the **scan** permission on the profile and
*view* on device credentials; no built-in role holds *scan*). The button
reads *Running…* until the run ends. A run outside the profile's window is
refused with *Outside the profile's window.*

### A7. Read the run page

The run opens on its **Overview** tab:

- A summary line by reason: *12 read, 3 without a credential, 1 unreachable*,
  with **Shared credentials** or **Review host keys** when those are the
  reason.
- **Run**: status, who started it, where it ran, when it was queued and
  finished, how long it took, and the authorisation it ran under (the
  statement and who recorded it, as they were when the run was queued).
- **Counts** (**Hosts**, **Read**, **Packages**, **Changed hosts**), **Not
  read** (hosts by reason), and **Messages** when the run has any.

**Hosts** has one row per host: **Result**, **Read by** (*Server* or the
Outpost), **Credential** (*Host's own* or *Shared · name*), **Transport**
(hover the info icon for each transport tried and why), **Packages**,
**Changes**, **Detail**. **Host keys** follows. A link can open a tab
directly with `?tab=hosts` (or `keys`, `findings`, `services`).

Every status is explained on [Troubleshooting](discovery-troubleshooting.md).
*Nothing read* means no host was logged in to because each was left alone
before a login (no credential, no accepted key, no address, a rule): nothing
failed, there was nothing to read with.

### A8. Find the packages and CVEs

- The host's **Packages** tab lists every package, with the OS release above
  the list, the **Application** a package belongs to and its **CVEs**.
- The host's **Vulnerabilities** tab shows the matches, **Via: Package**.
- **Findings** on the Discovery page may propose *Set platform*, *Add
  application* or *Link packages* ([what they do](discovery-packages.md#what-a-read-feeds)).

CVEs show only when [vulnerability data](vulnerabilities.md) is on and holds
advisories for the packages read. What that takes depends on its update
source:

| Update source | After a read | The Packages tab says, until then |
|---|---|---|
| Server | Nothing. The server fetches advisories for packages no host had before right after the run (one background job) and the rest daily. | *Advisory fetch queued* |
| Browser | A deployment admin runs **Sync now** from their browser. | *Vulnerability data for these packages has not been fetched*, with **Sync now** for a deployment admin |
| Upload | A deployment admin imports the OSV archive of each distribution (`Debian/all.zip`, `Ubuntu/all.zip`, `Alpine/all.zip`, `Rocky Linux/all.zip`, `AlmaLinux/all.zip`, `Red Hat/all.zip`) as **OSV advisories**. | *Vulnerability data for these packages has not been imported*, with **Import OSV file** |

While an update runs the line reads *Vulnerability data is updating*. The
line goes once a fetch covers the packages.

## B. A first service scan

A service scan sends no credential, so it needs no login and no host key.

### B1. Create the profile

Steps 1 and 2 above done, press **Add profile**:

1. **Name**, **Kind** *Service scan*, tick **Enabled**, **Runs on** *Server*.
2. **Scope**: a prefix, a site, devices or VMs. The scan reaches the IPAM
   addresses of what you name, never a range you type.
3. **Ports**: empty for the [default list](service-discovery.md#the-default-port-list)
   of 43 ports, or your own (`22, 80, 8000-8100`, at most 1,024).
4. **Connects per second**: start low; 20 is the default.
5. **Engine**: *Built-in*. *nmap* is offered once a tenant admin switched on
   **nmap** in **Host discovery** ([the nmap engine](service-discovery.md#the-nmap-engine)).
6. **Hosts at once** and the schedule as for an inventory.
7. **Authorisation**: who authorised scanning these addresses. A later change
   to the scope, the ports, the engine or **Runs on**, or a higher nmap
   intensity or timing, clears it.
8. **Create**.

!!! warning "Scan only what you may scan"
    Old printers, OT and ICS equipment and some embedded devices misbehave
    even on a connect scan. Leave them out of the scope or mark them
    [Do not scan](discovery-safety.md#do-not-scan) first.

### B2. Check and run

The **Addresses** tab lists every address in scope and what would be left
alone. **Run now** asks once and starts; the **scan** permission is all it
needs.

### B3. Read the results

The run page opens on **Overview**: the run, its counts (the ports, rate
and parallelism it used among them) and the addresses not scanned, by
reason. **Addresses** has one row per address, with its open-port count;
**Findings** lists the proposals; **Open ports** lists each port with its
banner and the product named.

On **Findings**, **Accept** creates what a row proposes (*Add service*, *Add
software*, *Map to CPE*), and **Ignore** hides it until the evidence changes
([Findings](service-discovery.md#findings)). A banner never creates a CVE
match: for CVEs, run a package inventory on the host.
