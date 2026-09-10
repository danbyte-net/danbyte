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

## Not yet

Danbyte only **reads** today. Provisioning hosts, templates, macros and host
groups from Danbyte's inventory, maintenance-window sync and acknowledgement
write-back are planned; nothing is written to Zabbix in this release.
