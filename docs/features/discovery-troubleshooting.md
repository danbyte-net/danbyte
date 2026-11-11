---
icon: lucide/life-buoy
---

# Discovery: troubleshooting

Every status a run or a host can end in, what it means and what fixes it,
then the situations people run into most. The messages in *italics* are the
ones the run page shows.

!!! info "Where to find it"
    - A run's status, summary line and **Messages**: the run page (from
      **Recent runs** on the **Discovery** tab, or a profile's **Runs** tab).
    - Each host's result and message: the run's **Hosts** (or **Addresses**)
      tab; hover **Transport** for every login tried.
    - Before a run: the profile's **Hosts** / **Addresses** tab and the reason
      under the profile's name.
    - Background jobs and the *Package inventory* timer: **Jobs**.

## Run statuses

| Status | Meaning | What to do |
|---|---|---|
| **Queued** | Waiting for a worker. | If it stays queued, no worker listens on the `discovery` queue ([Settings](discovery-settings.md#queue-and-timer)). |
| **Running** | Hosts are being read. A run on Outposts stays running until each Outpost reported or its work expired; the run page counts the hosts still out. | Wait. A run that has not finished after 6 hours is given up as *Failed*. |
| **OK** | Every host was read, or left alone on purpose (exempt, deny subnet, maintenance). | - |
| **Partial** | Some hosts were read, some not. | Look at the host rows that are not *OK*. |
| **Nothing read** | No host was logged in to, because each was left alone before a login - no credential, no accepted host key, no address, a blocked target. Nothing failed: there was nothing to read with. The summary line says why by reason (*61 without a credential*) and links to **Shared credentials** or **Review host keys**. | Give the hosts a login, accept their keys ([below](#nothing-read)). |
| **Failed** | Logins or scans were tried and none succeeded, or the run could not start: *The background workers are not reachable.*, *The run did not finish; given up.*, *The port list is not valid: …*, an nmap refusal. | Read **Messages** and the host rows. |
| **Skipped** | The run did not go ahead, because something changed after it was queued: *Discovery is off.*, *The profile is disabled.*, *Record who authorised this profile before it runs.*, *Outside the profile's window.*, *The person who started it no longer has an account.*, *The person who started it may no longer run this profile.* A run on Outposts is also *Skipped* when no host could be handed to an Outpost. | Fix the reason and run again. |

**Run now** itself is refused, with the reason under the profile's name and in
a toast, when the profile is disabled, not authorised, outside its window,
already running, set to *An Outpost* without one, or Discovery is off.

## Host statuses

| Result | Meaning | What to do |
|---|---|---|
| **Ready** | (Hosts tab only) Would be read on the next run. | - |
| **OK** | Read. The row says how many packages, and how many were added, removed or changed; a service scan, how many ports were open. | - |
| **Login refused** | The host refused the credential (*The host refused the credential.*, *The host refused the client certificate.*), or Danbyte could not use it (*The stored SSH key could not be loaded.*, *The credential holds no password or key.*). | Check the user name, the key on the host, the passphrase. A refused password stops there unless the shared credential has **Try the next if refused**. |
| **Host key not accepted** | *No accepted SSH host key.* - nobody accepted a key for this host yet; or *The host key does not match an accepted key.* - it presents another key than the accepted one. The presented key was recorded. | Review and accept it under **Host keys**. A key that differs from an accepted one: find out why (reinstall, rotation, interception) before accepting it on the host's **SSH host keys** panel. |
| **Certificate not trusted** | WinRM: *The host's TLS certificate is not trusted for its name.* | [Below](#certificate-not-trusted). |
| **Unreachable** | The connection failed (the row names the error), or *WinRM over HTTPS is not reachable.* | Check routing, the firewall, the port on the credential, and whether an [Outpost](discovery-outposts.md) should read it. |
| **Timed out** | *No answer within 60 s.* - the host did not finish in the per-host timeout. On an Outpost: *The Outpost did not report back in time.* | Raise **Per-host timeout**; lower **Hosts at once** on a busy network. |
| **Unsupported** | *No package reader for …* (a distribution without dpkg, rpm or apk), *The host has no readable os-release.* (and not Windows), *The host's os-release names no ID.*, or WinRM cannot run here. | See [supported distributions](discovery-packages.md#what-runs-on-the-host). |
| **Failed** | The read started and could not finish: *The dpkg package list could not be read.*, *The host's answer is larger than 16 MB.*, *PowerShell could not read the inventory.*, *The host's answer is not JSON.*, *Its packages could not be stored.*, *WinRM refused the request.*, *The host answered with a redirect.*; on an Outpost *The Outpost's answer was refused: …* or *Not run: …*; in a scan *Not scanned.* or *Not in the nmap output.* | Read the message. For PowerShell, run the [script](discovery-windows.md#what-is-read) as the same account. |
| **No credential** | *No login for this host on a transport that is on.*, *The credential has no user name.* (an SSH credential saved without one: add it), or *The credential's secret cannot be read.* | [Below](#no-credential). |
| **No address** | *No primary address.* (and no out-of-band address on a device), or the address is not valid. | Give the host a primary address. |
| **Exempt** | The host, its address or a prefix around it is marked **Do not scan**. | Intended. Clear **Do not scan** to include it. |
| **Deny subnet** | The address is in a discovery or monitoring deny subnet. | Intended. Edit the deny subnets. |
| **In maintenance** | The host is in an open maintenance event. | Intended. It is read on the next run after the event. |
| **Blocked target** | *Link-local (cloud metadata) addresses are never discovered.*, or *The server's target policy refuses this address.* - internal while `DANBYTE_CHECK_BLOCK_INTERNAL` is on. | A link-local address is never read: give the host another address. For an internal one, add the range to `DANBYTE_SSRF_ALLOWLIST`, or run the profile on an Outpost. |
| **No Outpost** | The host is bound to no Outpost, or the named one was deleted. | [On an Outpost](discovery-outposts.md#what-a-host-row-says) |
| **Outpost offline** | The Outpost is disabled, not seen recently, or did not pick the work up within 30 minutes. | Bring it back; run again. |
| **Outpost cannot run it** | The agent is too old, the Outpost is driven over SSH, or it has no nmap it may run. | [Which agent version](discovery-outposts.md#which-agent-version) |

## Common situations

### Nothing read

Nobody was logged in to, and nothing failed. On a first run this is normal:
the hosts have no accepted host keys yet, and the run read the keys they
present. Open **Host keys**, check the fingerprints, **Accept N keys**, run
again ([Getting started](discovery-getting-started.md#a5-accept-the-hosts-ssh-keys)).
If the summary says *without a credential*, see the next section.

### No credential

The host has no login Danbyte may use:

- no device credential of kind **SSH key**, **SSH password** or **WinRM
  certificate** on it, and no shared credential whose scope matches it (an
  empty scope matches nothing unless **All hosts** is on; a scope naming
  device types never matches a VM);
- the matching credential's transport is switched off (hover **Transport**:
  *Switched off*), or it is a WinRM certificate on an Outpost;
- **Run now** by someone who may not view that credential: a scheduled run
  would use it;
- the secret store cannot read the secret (*The credential's secret cannot be
  read.*).

A host left as *No credential* still has its SSH key read, so it shows under
**Host keys** for later.

### Host key not accepted

See the host status above. When every host of a run says it, the run is
*Nothing read*. Accepting on first use is possible (**Accept new host keys**
on **Run now**) and [not advised](discovery-credentials.md#accept-new-host-keys-on-first-use).

### Certificate not trusted

The WinRM listener's certificate did not verify:

- It must name the address's **DNS name** in IPAM, or the IP address when the
  address has no DNS name. A certificate for `srv01.example.net` fails when
  IPAM has no DNS name on the address.
- Its issuing CA must be in the Danbyte server's trust store, or in the file
  `DANBYTE_DISCOVERY_WINRM_CA_BUNDLE` names. Restart the web and worker units
  after changing it.
- It must be valid now and chain completely.

### Packages but no vulnerabilities

Work down the list:

| Check | Fix |
|---|---|
| Vulnerability data is off | A deployment admin turns it on ([Known vulnerabilities](vulnerabilities.md#turn-it-on)). |
| The Packages tab says *Advisory fetch queued* (server mode) | Wait for the background fetch, or the daily refresh. *Vulnerability data is updating* means one is running. |
| *Vulnerability data for these packages has not been fetched* (browser mode) | A deployment admin presses **Sync now**. |
| *… has not been imported* (upload mode) | Import the distribution's OSV archive (**Import OSV file**). |
| *No advisory source for …* | The distribution has no OSV advisories Danbyte uses (Fedora, CentOS, Oracle Linux, SUSE Linux Enterprise, openSUSE Tumbleweed, Amazon Linux, derivatives): its packages are read and never matched ([supported distributions](discovery-packages.md#what-runs-on-the-host)). |
| The host is Windows | Windows CVEs come from the OS build, not packages ([Windows hosts](discovery-windows.md#matching-against-microsofts-data)); *OS build not matched* says why not. |
| You see packages but not the Vulnerabilities tab's package rows | Package matches need *view* on installed software. |
| Matches exist but are hidden | An exception covers them; tick *Excepted* on the Vulnerabilities tab. |
| The packages are genuinely fixed | A Debian or Ubuntu backport is fixed even when the upstream version looks old. |

### A fetch failed

The vulnerability data's last run (on the **Vulnerability data** card) ends
*failed* with the products or batches that did not arrive; what did arrive
is kept. In server mode the next start within 20 hours resumes it. Check
that the server may reach OSV (and Microsoft, for Windows), or a mirror you
set ([what is contacted](vulnerabilities.md#what-is-contacted)).

### An Outpost says it needs a newer version

*Outpost X runs agent 0.9.0 that cannot run package inventory; it needs
0.10.0 or later.* The agent's hello does not offer discovery. Upload a newer
agent under **Outpost versions** and roll it out; checks keep working
meanwhile ([On an Outpost](discovery-outposts.md#which-agent-version)).
*… has no nmap it may run (the agent runs as root)* is about nmap only
([nmap on an Outpost](discovery-outposts.md#nmap-on-an-outpost)).

### A platform is not proposed

There is no **Set platform** row when:

- the host is Windows (never proposed);
- the current platform already fits - its name names the OS and no other
  release (*Debian* fits Debian 13), or it is mapped to the same end-of-life
  product and cycle; a device without its own platform is judged by its
  device type's;
- the read gave no version (`VERSION_ID` empty);
- someone ignored it, and the OS, release and platform have not changed
  since (**Show ignored**);
- you may not view installed software, or the host.

### A finding keeps coming back

- **Ignore** is remembered against the evidence. A service-scan finding
  comes back when the port's service name, product, version or CPE changes;
  a *Set platform* row when the OS, its release or the host's platform
  changes. *Add application* and *Link packages* stay hidden until someone
  shows them again.
- An **Accept** that was refused leaves the row: read the toast (*… refused:
  application.add required.*) and get the permission, or ask someone who has
  it.
- *Add software* returns while no install of an application of that exact
  name exists on the host - an install under another application name does
  not count. Rename the application or accept the row.
- *Set platform* returns after you put the host on a per-OS platform that is
  mapped to another cycle: a platform has one cycle; name platforms per
  release.

### A profile does not run on schedule

Check, in order: **Enabled**; **Authorisation** recorded (*Not authorised*
shows on the page); **Every** above 0; the window; Discovery on for both
switches; the `danbyte-inventory` timer's last run under **Jobs → Scheduled
tasks**; a previous run still open (one run per profile at a time).

### A switch is greyed out

- **This deployment**: you are not a deployment admin, or
  `DANBYTE_DISCOVERY_ENABLED` is set (*Locked … by the deployment*).
- **WinRM over HTTPS**: *Forbidden by the deployment* or *Not available in
  this build* (hover for the reason).
- **nmap**: *Not found* - install nmap or set `NMAP_BINARY`, then restart the
  web and worker units; *Forbidden by the deployment*.
- The transports, nmap and deny subnets: only tenant admins change them.
