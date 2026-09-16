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
   is not usable, which is the honest answer rather than a guess. On the engines page such an engine reads *via
   Zabbix* with a **Configure** link back here: there is no token to enrol and
   no agent to install, because Zabbix is the agent. Then bind it,
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

### Problems and reachability

Two things Zabbix knows that a Danbyte status cannot say on its own ride back
with every poll, at no extra API cost - they come from the same read the status
does:

- **Open problems.** How many Zabbix has raised on the host, and their names.
- **Reachability, per protocol.** Whether Zabbix can talk to the host over its
  agent, SNMP, IPMI or JMX interface at all - and, when it cannot, the error in
  Zabbix's own words.

The second is the one worth having. A host with no open problems reads
perfectly healthy while its SNMP interface polls nothing because the community
is wrong or absent, and nothing in Danbyte's own view would ever say so.

They appear as **chips beside the roll-up badge** on device and prefix lists
and on the device's Overview and Monitoring tab - a count for problems, a red
protocol chip for anything unreachable - and in full on an address's
**Monitoring** section, where the error text sits next to the protocol it
belongs to. Chips rather than columns: most targets carry neither, and two
mostly-empty columns would cost every list page width it has better uses for.

These chips come from the Zabbix *check*. A host Zabbix watches but Danbyte
has no Zabbix check on is covered by the next section.

### What Zabbix says about a device {#host-status}

"If it is in Zabbix, show it." With **Read host status** on - the default -
each linked host's open problems and reachability are read every few minutes
(**Every**, 5 by default) on a schedule of their own, so the **Zabbix** panel
appears on a device's Monitoring tab, on each of its addresses' Monitoring
tabs, and as a chip row on the device Overview - whether or not a Zabbix
check exists, and with provisioning off. Two calls per pass, read-only.

The panel shows Danbyte's word for the worst open problem (through the
connection's severity map), the host and connection, *Disabled* or
*Maintenance* when Zabbix has it so, a line per protocol Zabbix can or cannot
reach it on with Zabbix's own error, the first twenty problems with their
severity and age, when it was last read, and links to the host's *Problems* and *Latest data* in Zabbix (the host dashboard view is not used - it lists template dashboards and is empty for most templates).

It does **not** change Danbyte's status. A device can be green in Danbyte -
its ping answers - and carry a High problem here; both are true and both are
shown. Only a Zabbix check folds Zabbix's view into the status itself. A host
that has gone from Zabbix keeps its link and shows no problems; nothing is
removed on Danbyte's side by a read.

The API is `GET /api/zabbix/host-status/?device=<id>` (or `?ip=<id>`,
resolved through the address's device): one entry per linked host, empty
when the device is not linked, 404 while the integration is off.

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

Two answers, picked per connection, because two deployments want opposite
things.

**Devices with a Zabbix check** (the default) - anything with a Zabbix check on
one of this connection's engines. A check is the statement "I want Zabbix
watching this", so it drives provisioning too: one scope definition rather than
two that can disagree. Use it when Zabbix *is* the monitoring engine for those
devices.

**Every device the rules match** - the provisioning rules below decide, and the
checks are not consulted at all. This is the hybrid estate: **Danbyte** keeps
doing the pinging, discovery, TLS and port checks, and Zabbix's host list is
simply kept in step with Danbyte's inventory, because Danbyte is the source of
truth for what exists. Without this a rule scoped to *Every device* could only
ever reach the devices somebody had separately bound to a Zabbix engine and
given a Zabbix check - which is not what the rule says, and not what anyone
reading it expects.

A device with **no address** cannot become a host, since a Zabbix host is
reached at one. Those are left out and counted, and the sync says how many, so
a rule that looks like it under-matched is explained rather than mysterious.

!!! note "Binding an engine does not hand Zabbix your checks"
    A Zabbix engine answers only **Zabbix** checks. A device bound to one keeps
    running its ICMP, SNMP, TLS and port checks on Danbyte's own workers - the
    scheduler picks up everything the driver does not claim. So the hybrid
    arrangement needs no special mode: choose *Every device the rules match*,
    and leave your own checks alone.

The **In scope** table on the Zabbix page lists exactly this set, with the
address the host would get, the templates, groups and proxy the rules resolve
to, and one pill for where it has got to: *Linked*, *To review* or *No host*.
Derived state that nothing renders is state nobody can trust.

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
*not applicable* item for you to resolve. A wrong pairing means reading one
host's problems believing they are another's, and nothing downstream would ever
flag it - a missing pairing is visible and fixable, a wrong one is neither.

Every pairing a pass has made is in the **Linked hosts** table - the device,
the Zabbix host (a link straight to its dashboard in Zabbix), how it was
matched and who created it. **Unlink** is the one manual act: it says "that
pairing is wrong", touches nothing in Zabbix, and the next pass matches from
scratch.

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

### Proxies

A rule can also name the **proxy** a host is monitored through - and a rule
can now be scoped to a **site**, which is where a proxy belongs: "everything at
Aarhus goes through the Aarhus proxy" is one rule. The picker lists the proxies
the server actually has.

Unlike templates and groups, a proxy does not stack - a host has exactly one -
so the **most specific** rule that names one wins: site, then role, platform,
type, manufacturer, then the catch-all. And Danbyte only ever sets a proxy on a
host that is **on the server**. Moving a host between proxies is somebody's
decision, not a rule's; putting a server-polled host onto the proxy its site
names is finishing a setup.

A proxy Zabbix does not have is reported, never invented: a proxy is a process
somebody installed, and a record for one that does not exist would park the
host on a poller that will never poll it. The host is created on the server
instead, and the message says so.

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

The **Zabbix** page has four tabs: **Overview** (the connection and its
review queue - the part somebody comes back to), **Rules** (provisioning and
adoption rules), **Hosts** (what is in scope and which host each device is
paired with) and **Maintenance** (the windows mirrored into Zabbix). The
queue on Overview shows what a sync pass proposed. Every proposal names the
system that would change - *Create in Zabbix*, *Adopt into Danbyte* - because
a host group called "Danbyte estate" beside a bare "Create host" read as
creating something in Danbyte, which is the opposite of what it does. Each row
says what would be written and why; **Apply** does that one write, **Dismiss** keeps it from
being raised again. A row that cannot be applied yet says what it is waiting
for in place of Apply: an adoption with no default site, role or type shows
**Set defaults**, which opens the connection's form - and saving the form
updates the waiting proposals at once, so the row turns into an Apply
without another sync (a field a rule or the host itself decided is left as
it was); a *Not applicable* row
(two hosts on one address, say) is resolved in Zabbix or in Danbyte and the
proposal is re-made or dropped on the next pass. **Apply all** skips both
rather than guessing.

A proposal that stops being true is dropped on the next pass: a change nobody
has looked at, for something that has since been done by hand, is worse than
no proposal.

Dismissed proposals keep a second list, **Dismissed**, next to the queue;
**Restore** puts one back. A mis-click is not a permanent silence. Applying
a *Remove from Zabbix* proposal - alone or as part of **Apply all** - asks first,
because it deletes a host, its items and its history in Zabbix and Danbyte
cannot undo that.

### Removing hosts

A third switch, also off, with a grace period - and Danbyte will only ever
consider a host **it created itself**. A host somebody else made is theirs, and
Danbyte losing interest in it is not a reason to delete it. A host that comes
back into scope has its clock reset rather than resumed.

If Danbyte cannot read the host list, it proposes **nothing** - neither
creations nor removals. It cannot say a host is unwanted when it could not see
what is there.

## Two-way

Two switches on the connection, both off, each its own decision like every
other write.

### Maintenance windows

A **confirmed** maintenance or outage in Danbyte - any status that suppresses
alerts, with at least one device on its impact list - already owns a silence.
With **Sync maintenance windows** on, the same window is written into Zabbix as
a **maintenance period** over the hosts this connection has linked, with data
collection on: Zabbix keeps reading the host and suppresses the problems, so
Danbyte keeps showing a status while neither system pages anyone.

Schedule it once. Moving the window, adding a device, closing or deleting the
event all follow on the next pass, which runs when the event changes and on
the connection's interval regardless of provisioning. A device Zabbix does not
know is simply not in the period. The **Maintenance windows** table on the
Zabbix page is the receipt: each window, the hosts it covers, when it was
written, and Zabbix's own words when a write was refused.

Danbyte compares against what it last wrote, not against Zabbix: a period
somebody adjusted by hand in Zabbix stands until the Danbyte window changes.
One deleted by hand is noticed and written again, because the window still
wants it. And Danbyte removes only periods it created - never one it found.

### Acknowledgements

With **Write acknowledgements** on, acknowledging a Danbyte alert that Zabbix
raised acknowledges the open problems behind it - the ones the last poll saw
on the host - with the operator's name and note, so whoever reads either
screen sees that somebody has it. Clearing the acknowledgement clears it
there. The alert's *ack* badge says *· Zabbix* once the write landed, and
*· not in Zabbix* with the reason when it did not. An alert on a check Danbyte
runs itself is never Zabbix's business.

Both are jobs: the window or the acknowledgement in Danbyte is the decision
and never waits on Zabbix, and every switch - the tenant's, the connection's -
is re-checked when the job runs.

## Host inventory {#host-inventory}

Zabbix templates fill a host's **inventory** automatically - serial, model,
vendor, OS - and a Danbyte device record with a blank serial is the norm. With
**Read host inventory** on, what Zabbix's inventory says about a linked device
is recorded and any disagreement appears in that device's
[drift inbox](../features/snmp-discovery.md#drift-and-reconciliation), beside
anything Danbyte's own poll found, labelled *Zabbix* so you know which
observation it is.

It costs nothing: the inventory rides the host read the provisioning pass
already makes, so there is no extra call and no second schedule. It needs
provisioning in **Review** or **Auto** for the same reason - that pass is what
reads the hosts.

Nothing reaches the device until you **accept** the item, which needs the same
`device.change` permission the device form does. Two fields are offered: the
**name** and the **serial**. The model and OS are recorded but not proposed - a
device type is a catalog row you curate, and accepting one would mint a row
behind your back.

!!! note "Why this is worth having"
    Danbyte can walk SNMP itself, and a direct walk is better evidence than
    anything Zabbix can pass along - so where Danbyte polls a device, its own
    poll wins. This is for the devices it **cannot** poll: a site the core has
    no route to, kit whose credentials live in Zabbix. Those are exactly the
    devices a Zabbix engine exists for, and they had no observed state at all
    before.

A host **disabled** in Zabbix stops being an observation rather than becoming a
stale one, and turning the switch off withdraws the opinions rather than
leaving the last ones standing.

## Adopting Zabbix hosts

The other way in. With **Adopt hosts** on, every Zabbix host that **no device
of yours answers to** - by interface address, inventory serial, or name,
judged against the whole tenant rather than the provisioning scope - is
offered in the same review queue as an *Adopt into Danbyte* proposal. Applying it
makes the device: the host's visible name and serial, the address from its
SNMP interface (or the agent's), the **site** from the first host group that
names one of your sites - the reverse of what provisioning writes, so an
estate Danbyte provisioned and one built by hand read the same way - and the
**device type** from the inventory model when you have one by that name.

What the host does not say comes from the connection's defaults: a site, a
role, a device type.

### Adoption rules

The defaults put every adopted host at one site. An estate with a Zabbix per
region and a host per town needs more, so **adoption rules** decide placement
from what the host looks like - the same idea, and the same matcher, as the
[VM placement rules](../features/external-sync.md#placement-rules-when-the-names-dont-line-up). A rule matches
the host's **name**, one of its **host groups** or its **address** - a glob by
default (`kbh-*`, `*-core?`), `regex:` for a regular expression, a CIDR for an
address - and names the site, and optionally the role and device type, the
device is made with.

First match wins, lowest *order* first. A rule sets **only what it names**: one
that says `kbh-*` is København leaves the role to the default and the type to
the inventory model, as before. Each field is decided most-specific first - a
rule, then what the host itself says (a group naming a site, the inventory
model naming a type), then the defaults - and the queue says which rule placed
a host so a surprising site is explained rather than mysterious.

A broken regular expression is refused when the rule is saved, and a rule that
somehow holds one matches nothing rather than everything. A proposal missing any of them waits, with the reason on
the row, and cannot be applied until the defaults are set or the host group
names the site. An address that falls in no prefix of yours is left out and
said so, never given a prefix it invented.

The link an adoption makes is not one Danbyte *created*, so pruning never
touches the host. Adoption needs provisioning in **Review** or **Auto** - it
is the same queue - and in Review nothing is made without a person; in Auto,
new hosts become devices on the pass. An existing Zabbix is a way into
Danbyte, which is a strong reason for a Zabbix shop to try it at all.

An adopted device is not automatically watched *by* Zabbix in Danbyte: that
is still a Zabbix check on its address, from a policy or by hand, exactly as
for any other device.

## Not yet

**Interface** drift - "Zabbix says 48 interfaces, Danbyte has 24" - is planned
but not built, and is a bigger job than the inventory fields above: Zabbix has
no object for a host's network interfaces (its *interface* is the polling
endpoint), so the list has to be reconstructed from discovered items, which is
the heaviest read in the integration. It also only ever runs one way - a port
missing from Zabbix is not evidence the port is missing from the device, since
every stock template's discovery rule filters some out.
