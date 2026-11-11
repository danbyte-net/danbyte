---
icon: lucide/radio-tower
---

# Discovery on an Outpost

For hosts the Danbyte server cannot reach, a profile can run on an
[Outpost](../monitoring/outposts.md) - the agent at that site - instead of
the server. Both kinds run there: package inventory over SSH and service
scans, with the built-in engine or the Outpost's own nmap.

!!! info "Where to find it"
    - **Runs on** in the profile dialog; under it, the picked Outpost's state
      (*Ready*, *Offline*, *Cannot run this*, *No Outpost*) and the reason.
    - Where a run went: **Ran on** on the run's **Overview**, and **Read by**
      on each host row.
    - Outposts, their agent version and rollout: **Governance → Monitoring
      engines**.

## Runs on

| **Runs on** | Hosts go to |
|---|---|
| *Server* (default) | the Danbyte workers |
| an Outpost by name | that Outpost, for every host in scope |
| *The host's Outpost* | the Outpost each host is bound to by the [monitoring engine bindings](../monitoring/outposts.md#how-an-engine-is-chosen-for-a-target): for a package inventory the device, its location, its site, the tenant default; for a service scan the address's device, location, prefix, site, the tenant default |

Changing **Runs on**, or the Outpost it names, clears the profile's
[authorisation](discovery-safety.md#authorisation): another vantage point
reaches other networks, through other firewalls.

## How a run on Outposts goes

1. **On the server.** The run starts on the server exactly as a server run:
   the scope, **Do not scan**, deny subnets, maintenance, the authorisation,
   the window, the starter's view, the logins and the host keys to pin are
   resolved there. Each host that passes is queued for its Outpost as one
   work item. The item names its credentials by id; it holds no secret.
2. **The Outpost claims** its items over its authenticated channel, a batch
   of one run at a time. The run, the profile, the switches and the
   starter's **scan** permission are checked again (not the window: a run
   that started inside it may finish after it). A service scan whose ports
   changed since the run started is refused.
3. **The Outpost reads** each host with the same shared code the server runs
   (`danbyte_checks`: the same fixed commands and parsers, the same probes,
   rates and fingerprints, the same nmap argument builder) and posts the
   results back.
4. **The server checks and stores** them with the same code as a server run;
   the version, installs and advisory fetch follow as after a server read.
5. **The run finishes** when no item is open. While it waits, the run is
   *Running* and its page says how many hosts are still out.

## What a host row says

A host is **never read from the server instead** when its Outpost cannot take
the work. It gets a row that says why, and the run moves on:

| Result | Why | What to do |
|---|---|---|
| **No Outpost** | *The host's Outpost*, and the host is bound to the server or to another system such as Zabbix; or the named Outpost was deleted | Bind the host to an Outpost, or read it with a server profile |
| **Outpost offline** | The Outpost is disabled, has not been seen within the tenant's "offline after" setting (else three poll intervals, at least three minutes), or did not pick the work up within 30 minutes | Bring the Outpost back; run again |
| **Outpost cannot run it** | The agent does not offer this kind of work (the row names its version and the one it needs), the Outpost is driven over SSH (Danbyte dials in) rather than dialling out, or an nmap profile and the Outpost has no nmap it may run (the reason follows) | Update the agent; use a dial-out Outpost; [give it nmap](#nmap-on-an-outpost) |
| **Timed out** | The Outpost claimed the work and did not report it by its deadline | Check the Outpost's log and reach to the host |
| **Failed** | *The Outpost's answer was refused: …* - what it posted did not pass the server's checks | Update the agent; report it if it persists |

A run where no host could be handed to an Outpost, and nothing else went
wrong, ends **Skipped**. Unclaimed work is given up by the
`danbyte-inventory` timer, so allow up to 45 minutes before an offline
Outpost's hosts show.

### Why there is no fallback

An Outpost exists because the server sees the network from another place, or
not at all. Reading from the server would reach other hosts, through other
firewalls, under an authorisation given for the Outpost's vantage point. So a
host whose Outpost cannot take the work is left alone, and moving a profile
between the server and Outposts needs a new authorisation.

## Credentials on an Outpost

A package inventory on an Outpost logs in over **SSH only** (key, then
password, as the transport switches allow). Credentials reach the Outpost the
way its SNMP credentials already do:

- only in the answer to the Outpost's authenticated claim, never in the
  queued work, for its own tenant only;
- re-read by id when it claims: a host credential must still belong to the
  host, a shared one must still be enabled; an unreadable secret leaves the
  host *No credential*;
- handed out once per host; the answer is sent with `Cache-Control:
  no-store`;
- kept by the agent in memory for the connection and dropped when the host
  is done; never written or logged.

What an Outpost posts back is checked like untrusted input: only hosts it
claimed and has not reported, the address and ports it was given, packages
whose names and versions pass the parsers' rules, strings capped, CPEs in
2.3 form, host keys whose fingerprint the server computes itself. Anything
else fails that host with the reason; a result for another Outpost's or
another tenant's work writes nothing.

[Accept new host keys](discovery-credentials.md#accept-new-host-keys-on-first-use)
works on an Outpost too: the key the Outpost met is accepted by the server,
as you, with the run as the cause.

## What an Outpost does not do

- **WinRM.** WinRM certificates are never sent to an Outpost. A host with only
  a WinRM login is *No credential* there, and its row says *Outposts read
  over SSH only* for WinRM.
- **The server's internal-range block.** The Outpost applies its own target
  policy: the unspecified address is refused, internal ranges are allowed.
  Link-local (cloud metadata) addresses are refused by the server before
  any work is queued for an Outpost.
- **nmap as root** ([below](#nmap-on-an-outpost)).
- **SSH-transport Outposts** run no discovery.

## nmap on an Outpost

On an Outpost the nmap is the Outpost's own. The agent looks for it when it
starts: `OUTPOST_NMAP_BINARY` (or `--nmap`, or `nmap_binary` in its
configuration file) when set, else `nmap` on its PATH. It refuses to use it
when the agent runs as root, and says in its hello which version it found or
why it has none.

The Danbyte-generated installer's unit runs the agent as root, so as
installed an Outpost offers the built-in scan only. For nmap, the agent must
run as an unprivileged account that can read its environment file; ICMP
checks then need `net.ipv4.ping_group_range` to cover that account's group.

On the server side, the tenant's **nmap** switch can be turned on while the
server or any of the tenant's Outposts has an nmap; the deployment switch
`DANBYTE_DISCOVERY_NMAP_ALLOWED` applies to Outposts too. The **Runs on**
picker says per Outpost whether it has one. A host whose Outpost has none is
*Outpost cannot run it*.

## Which agent version

Discovery needs an agent that offers it in its hello: **Outpost 0.10.0** or
later. An older agent gets no discovery work - checks, SNMP and sweeps keep
working - and its hosts say *Outpost cannot run it* with the version they
need. Upload the new agent under **Outpost versions** and roll it out to the
sites that need it. The upgrade notes list this step once a profile runs on
an Outpost whose agent does not offer discovery.

The agent side - the hello capabilities and the two work endpoints - is on
[Outposts: discovery on an Outpost](../monitoring/outposts.md#discovery-on-an-outpost).

## Rates and batches

- A service scan's **Connects per second** applies per Outpost: each paces
  its own connects to the profile's rate.
- An Outpost claims a batch sized to the work: for a package inventory twice
  **Hosts at once** hosts, for a built-in scan about ten minutes of connects
  at the run's rate (at most 256 addresses), for nmap twice **Hosts at
  once** addresses. It comes back for the rest when the batch is done.
