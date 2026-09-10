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
   like every other integration. Switching it on reveals the **Zabbix** page
   under *Integrations* in the sidebar; switching it off hides the page and
   404s the API, so a disabled integration is invisible rather than merely
   inert.
2. Create an **API token** in Zabbix (*Users → API tokens*) and give it an
   expiry. A username and password is not enough: a token can be revoked on its
   own and is what Zabbix's own guidance points at.
3. On the **Zabbix** page, add the connection - frontend URL, token, TLS
   verification - and press **Test**. It reports the Zabbix version and how
   many hosts the token can see, which is the fastest way to notice a token
   scoped to nothing.
4. Create a **monitoring engine** of kind *Zabbix*, and **link it to the
   connection** on the connection's form. The link is explicit: an engine reads
   through the connection it is attached to and no other, so a second Zabbix
   server can never quietly answer for the first. An engine linked to nothing
   is not usable, which is the honest answer rather than a guess. Then bind it,
   exactly as you
   would an Outpost. The binding decides *where* a target's checks are
   answered, and the most specific one wins: **device → location → prefix →
   site**. A device binding is what lets one host be answered by Zabbix without
   moving the building it sits in - it lives on the device form, under
   *Monitoring*.
5. On the device's IP, **add a check** of kind *Zabbix*. That is the whole
   statement "I want Zabbix watching this": it is an ordinary check, so it
   carries an interval, history, alert rules and silences like any other, and
   it is also what puts the device in scope for provisioning. Checks are added
   from an **IP's** detail page - a device's monitoring panel is a read-only
   roll-up of its addresses.

A target keeps its other checks. A Zabbix engine answers *Zabbix* checks; an
ICMP ping on the same device still runs on Danbyte's own workers, so pointing a
device at Zabbix never silently switches the rest of its monitoring off.

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

The three rows on the right are Danbyte's own check states, and the picker
shows them as the statuses you have named them - so if a status in your catalog
[speaks for *Down*](../features/catalogs-and-settings.md#naming-a-monitoring-check-state)
under the name *Critical*, you map Disaster onto *Critical*, in its colour. The
other three states never appear here: *Unknown* is what a host with no answer
gets, and *Stale* and *Skipped* are Danbyte's own bookkeeping, not something a
Zabbix severity can mean.

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

Deliberately little: **name, interface addresses, host group, serial** and the
**templates your rules ask for**. Nothing about items or triggers - those are
Zabbix's to own, and two systems editing one field is how both stop being
trusted. An update only ever carries fields whose value actually differs.

Host groups come from the same rules templates do, and are created on demand.
With no rule, a host lands in a group named after its **site** - which is what
every host got before rules existed, and still the right default.

### Templates and host groups

A Zabbix host with no template is an empty host: Zabbix shows it and it
collects nothing. Which template a device wants is a question about **what the
device is** - its role, its platform, its model, who made it - which is the
question Danbyte exists to answer, so the mapping lives on the Zabbix page as a
short list of rules.

Rules **stack**. "Every device gets ICMP Ping", "switches also get Generic by
SNMP" and "Cisco also gets Cisco IOS by SNMP" are three rules rather than one
list per model, and a device gets the union of every rule that matches it.
Duplicates collapse.

The rule form lists **the templates your server actually has** - Danbyte reads
them from Zabbix when you open it - so a name is picked rather than typed. What
gets stored is the template's technical name, not its id: an id means nothing on
the next Zabbix server, and the name survives a display rename. If Zabbix cannot
be reached the field falls back to typing names, because being unable to reach
the server is no reason to refuse to edit a rule - and a name Zabbix does not
have is **reported back** when the write happens, never invented and never
silently dropped.

A rule can also name **host groups**. Groups are how Zabbix scopes
permissions, dashboards and actions, so which groups a host belongs in is the
same kind of question as which templates it carries - and it was the last thing
here still hard-coded.

Danbyte only ever **adds** a template or a group. A template somebody linked by
hand is theirs, a group somebody put a host in is theirs, and a rule that stops
matching is not a reason to strip a host of its monitoring. The site fallback
applies only to a host Danbyte is **creating**: it is a sensible default for a
new host, not an opinion to impose on one that already exists.

!!! tip "Zabbix's refusals are usually the answer"
    Zabbix will not link two templates that define the same item key - the
    stock SNMP templates already include ICMP Ping, so asking for both is a
    conflict. When a write is refused, Danbyte shows you **what Zabbix said**,
    because that sentence is the rule to fix.

### SNMP interfaces and credentials

Zabbix will not link an SNMP template to a host that has nowhere to poll
through. So when a device resolves to an
[SNMP profile](../features/monitoring.md), Danbyte gives its host an **SNMP
interface** - on create, and on an existing host at the moment its first SNMP
template needs one. Only ever added: an interface somebody configured is
theirs.

The interface names `{$SNMP_COMMUNITY}` rather than carrying a community
string, which is how Zabbix's own templates are built. The secret lives in the
macro, so the interface is readable by anyone with Zabbix access without
leaking anything.

Whether Danbyte fills that macro in is **its own switch, off by default**.
Creating a host is inventory; handing over a community string is handing a
credential to another system, and one is not the other. With **Send SNMP
credentials** on, Danbyte writes the profile's community (or, for v3, the auth
and priv passphrases) as Zabbix **secret macros** - encrypted at rest and never
readable back through the API - and only where the macro is **absent**. A value
that is already there was set by somebody, and a secret macro's value never
comes back, so presence is the only honest question to ask.

With the switch off you still get the interface, naming a macro you can fill in
by hand.

### Running the pass

**Sync** on the Zabbix page runs it once. **Sync automatically** runs it on a
timer - a separate switch, because *when it runs* and *what it does with what
it finds* are two decisions:

| | |
|---|---|
| Auto-sync + **Review** | The queue stays fresh on its own; you approve. |
| Auto-sync + **Auto** | Hands-off. |
| No auto-sync | Nothing happens until you press Sync. |

The interval is per connection (5 minutes to 24 hours, default hourly). The
beat itself ticks every minute but only enqueues connections whose own interval
has elapsed - a Zabbix API is single-threaded per frontend node, and a minute
is far too often to be walking somebody's whole host list.

A pass records **when it ran and what it found**, and a pass that *fails*
records that too - so a broken connection backs off to its interval instead of
being re-queued every minute forever. It appears on **Jobs** as *Zabbix sync*
like every other scheduled task, so when it stops you can see that it stopped.

The tenant switch is re-checked **inside the job**, not only when it was
queued: a toggle flipped in between wins, or Danbyte writes hosts into a Zabbix
somebody just switched off.

### Working the queue

The **Zabbix** page shows what a sync pass proposed. Each row says what would
be written and why; **Apply** does that one write, **Dismiss** keeps it from
being raised again. *Needs a decision* rows carry no Apply button at all -
they are resolved by fixing the ambiguity in Zabbix or in Danbyte, and
**Apply all** skips them rather than guessing.

A proposal that stops being true is dropped on the next pass: a change nobody
has looked at, for something that has since been done by hand, is worse than
no proposal.

### Removing hosts

A third switch, also off, with a grace period - and Danbyte will only ever
consider a host **it created itself**. A host somebody else made is theirs, and
Danbyte losing interest in it is not a reason to delete it. A host that comes
back into scope has its clock reset rather than resumed.

If Danbyte cannot read the host list, it proposes **nothing** - neither
creations nor removals. It cannot say a host is unwanted when it could not see
what is there.

## Not yet

Zabbix proxies mapped to sites, maintenance-window sync and acknowledgement
write-back are planned.
