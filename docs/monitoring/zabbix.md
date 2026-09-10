---
icon: lucide/activity
---

# Zabbix

Danbyte and Zabbix answer different questions. Danbyte knows what the estate
**is** - every device, role, type, site, interface and address. Zabbix knows
what it is **doing**. This is the join: an existing Zabbix answers for a scope's
monitoring status, and Danbyte's alerting, notifications and every health
surface work over it unchanged.

!!! note "Danbyte does not become a Zabbix frontend"
    No graphs, no history browser, no trigger editor - Zabbix is better at
    those. What Zabbix watches stays configured in Zabbix; Danbyte reads the
    verdict.

## Turning it on

1. **Settings → Integrations → Zabbix monitoring**. Off by default, per tenant,
   like every other integration.
2. Create an **API token** in Zabbix (*Users → API tokens*) and give it an
   expiry. A username and password is not enough: a token can be revoked on its
   own and is what Zabbix's own guidance points at.
3. Add the connection - frontend URL, token, TLS verification - and press
   **Test**. It reports the Zabbix version and how many hosts the token can
   see, which is the fastest way to notice a token scoped to nothing.
4. Create a **monitoring engine** of kind *Zabbix* and bind it to a site or
   location, exactly as you would an Outpost.

Zabbix **6.0 or newer**. Below that the API differs enough that Danbyte would
be guessing, and named API tokens do not exist.

!!! warning "An internal Zabbix has to be allow-listed"
    A tenant-configured URL is never a way to reach internal services, so
    outbound goes through the SSRF guard. Most Zabbix servers are on RFC1918,
    so a deployment admin adds it under **Settings → Security → Outbound
    connections** (or `DANBYTE_SSRF_ALLOWLIST`).

## Hybrid by construction

There is no "Zabbix mode". An engine is bound per **location → prefix → site →
tenant default**, so one site can be answered by Zabbix, another by Danbyte's
own engine and a third by an Outpost - per rack row if you want. Nothing else
changes.

## What it watches

Add a **check template of kind *Zabbix*** and target it the way you target any
other check - a policy over a site, a role, a device type. There is no separate
Zabbix assignment to learn: a Zabbix check is a check, and it carries the same
intervals, history, hysteresis and change log as an ICMP one.

Each target's address is matched to a Zabbix **host interface**, and that host's
live problems decide the status:

| Zabbix says | Danbyte records |
|---|---|
| No unresolved problems | **up** |
| Problems, by severity | mapped - see below |
| Host disabled in Zabbix | **unknown** |
| Host in a Zabbix maintenance window | **unknown** |
| No host has this address | **unknown** |
| Two hosts share this address | **unknown**, naming both |

Three of those deserve saying plainly:

- **Unknown is never down.** A target Zabbix has never heard of is not off - it
  is unmonitored, and conflating the two is how a monitoring system loses
  trust.
- **Danbyte does not argue with Zabbix's own switches.** A host somebody
  disabled, or put in maintenance, is deliberately quiet. Suppressed problems
  are skipped for the same reason.
- **Ambiguity resolves to nothing.** Two hosts on one address is a question for
  an operator; picking one would hide it behind a plausible answer.

### Severity mapping

Zabbix's six trigger severities map onto Danbyte's statuses. The defaults treat
Information and below as noise, and **worst wins** - one Disaster among a dozen
Warnings is a down host:

| Zabbix severity | Danbyte |
|---|---|
| Not classified, Information | up |
| Warning, Average | degraded |
| High, Disaster | down |

Editable per connection: where an estate draws the line between "worth a colour"
and "worth a page" is an operational decision.

## What you get for free

Because a Zabbix result goes through the same path an Outpost's does, all of
this behaves identically whether Danbyte watched the host or Zabbix did:
hysteresis, check history, alert rules, silences, flapping
suppression, escalation, every notification channel, the site map, topology,
faceplates and the dashboard.

## Turning it off

Flip the integration off and bound sites **fall back to the engine they would
otherwise have used** - the resolver skips an engine whose driver cannot answer,
and the engine-health sweep ignores it. Turning an integration off is a quiet
switch, not an outage.

## Provisioning - Danbyte's inventory into Zabbix

Danbyte already knows every device's name, address, site and serial, and
somebody has usually typed all four into Zabbix by hand. **Provisioning** on
the connection closes that.

It is **off by default**. Reading somebody's monitoring is one decision;
writing to it is another, and the second is never implied by the first.

| Mode | What it does |
|---|---|
| **Off** (default) | Danbyte writes nothing, and does not even read the host list. |
| **Review** | Proposes every change for you to read and approve. Nothing is written until you say so. |
| **Auto** | Applies the proposals as it makes them. The planning pass is identical, so what runs automatically is exactly what you would have approved. |

### What is in scope

The devices you already asked Zabbix to watch - anything with a **Zabbix check**
on one of this connection's engines. A check is the statement "I want Zabbix
watching this", so it drives provisioning too: one scope definition rather than
two that can disagree.

### Matching an existing host

Danbyte tries four ways, most-reliable first, and **stops at the first
unambiguous hit**:

1. **A stored link** - established once and kept, so a rename or a
   re-addressing on either side does not break the pairing.
2. **An interface address**.
3. **The inventory serial** - survives both a rename and a re-addressing,
   which is why it beats the name.
4. **The exact name** - last, because names collide and get reused.

Where a level finds **two** candidates, the answer is **no match**, raised as a
*needs a decision* item for you to resolve. A wrong pairing means reading one
host's problems believing they are another's, and nothing downstream would ever
flag it - a missing pairing is visible and fixable, a wrong one is neither.

### What Danbyte writes

Deliberately little: **name, agent interface address, host group and serial**.
Nothing about items, triggers or templates - those are Zabbix's to own, and two
systems editing one field is how both stop being trusted. An update only ever
carries fields whose value actually differs.

The host group is named after the device's **site**, created on demand, so
Zabbix's own permissions line up with the structure Danbyte already holds.

### Removing hosts

A third switch, also off, with a grace period - and Danbyte will only ever
consider a host **it created itself**. A host somebody else made is theirs, and
Danbyte losing interest in it is not a reason to delete it. A host that comes
back into scope has its clock reset rather than resumed.

If Danbyte cannot read the host list, it proposes **nothing** - neither
creations nor removals. It cannot say a host is unwanted when it could not see
what is there.

## Not yet

Templates and macros from Danbyte's roles and credentials, Zabbix proxies
mapped to sites, maintenance-window sync and acknowledgement write-back are
planned.
