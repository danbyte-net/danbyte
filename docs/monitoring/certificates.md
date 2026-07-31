# Certificate inventory

An expired TLS certificate is one of the most common self-inflicted outages, and
the hardest to see coming from a spreadsheet. Danbyte's certificate inventory
answers it by **observing what your endpoints actually serve**: it connects,
completes the handshake, reads the certificate chain the server presents, and
records it.

!!! danger "Danbyte never stores a private key"
    A certificate inventory holds **public data only**. Subject, issuer, SANs,
    serial, fingerprint, validity window, key size, signature algorithm — every
    one of those is broadcast to every client that opens a connection, so
    recording them adds no secret to your deployment.

    A private key is the one secret in this domain, and Danbyte **never stores,
    requests, or accepts one**. Not behind a flag, not for convenience, not for
    renewal. When you [upload](#authoring-certificates) a certificate, only the
    **public** PEM is stored — and the upload path rejects a PEM carrying any
    `PRIVATE KEY` block with a clear `400` *before* it parses anything, while the
    model itself still refuses to save anything key-shaped in any field, whatever
    wrote it. If someone offers you a workflow that needs Danbyte to hold the
    key, that is a different product.

## What Danbyte records

Everything below comes out of the certificate the endpoint presented:

| Field | What it is |
|---|---|
| **SHA-256 fingerprint** | Hash of the certificate's DER bytes. This is the *identity* — see [Identity and renewal](#identity-and-renewal). |
| **Subject** / **Subject CN** | Who the certificate is for, full RFC 4514 name plus the common name. |
| **Issuer** / **Issuer CN** | Who signed it. |
| **Serial** | The certificate serial number, in hex. |
| **SANs (DNS)** and **SANs (IP)** | The subject alternative names — the names the certificate is actually valid for. |
| **Not before** / **Not after** | The validity window. *Not after* is the expiry date everything else hangs off. |
| **Public key algorithm** and **size** | RSA / ECDSA / Ed25519 / Ed448 / DSA, and the key size in bits. Spots a downgrade to a weak key. |
| **Signature algorithm** | For example `sha256WithRSAEncryption`. Spots a SHA-1 signature that shouldn't still be around. |
| **Self-signed** | Whether the certificate signed itself. |
| **Last seen** | The most recent time this certificate was observed **anywhere** — "is it still in service?". The row's creation time is the first sighting. |

Nothing else is stored. There is no field for a key, a passphrase, or a
credential, because a certificate check needs none.

Everything above is **intrinsic** — a property of the certificate's exact bytes,
which is why it can be written once and never rewritten. Facts that depend on
*where* the certificate was seen live on the [binding](#bindings-what-breaks-when-this-expires)
instead.

## Reading a certificate you don't trust

An expired or self-signed certificate is exactly what an inventory most needs to
record — so the read must not give up when verification fails. But "just turn
verification off" would be worse: an unverified reading would then be
indistinguishable from a verified one.

So Danbyte does two clearly separated passes:

1. A **normal, fully verifying** handshake against the system trust store. If it
   succeeds, the reading is marked **verified**.
2. Only if verification fails, a **second, explicitly unverified** handshake
   whose only job is to read the chain. That reading is marked **unverified**
   and carries the verifier's own reason (for example *self-signed certificate*
   or *certificate has expired*).

The permissive connection is a single-use, local one. No global setting is
weakened, and "unverified" is always recorded as a fact rather than assumed.

!!! note "Trust is reported, not enforced"
    Danbyte tells you a certificate is self-signed, untrusted, or expired. It
    does not become a trust store, and it never decides what your systems should
    accept.

### Internal PKI on private addresses

Certificates from an internal CA live on RFC1918 addresses, which the outbound
guard rightly refuses for user-supplied targets. As with
[BMC (Redfish) endpoints](../features/monitoring.md), reaching them requires an
**explicit, scoped allowance on an operator-configured endpoint** — never a
weakened default, and never something a user-defined check can turn on for
itself. Loopback, link-local (cloud metadata), multicast and the unspecified
address stay refused in every case.

If your internal root CA isn't in the server's system trust store, its
certificates read as **unverified** with the reason recorded. That is an honest
observation, not an error.

## The `tls_cert` check

The collector is also a monitoring check kind, so it schedules, retries, and
records history like every other check.

| Field | Value |
|---|---|
| Kind | TLS certificate |
| Port | `443` by default |
| Server name | Optional SNI / hostname to request. Defaults to the target address. |

It reports:

| Status | When |
|---|---|
| **up** | The chain verified and the certificate is inside its validity window. |
| **degraded** | The endpoint answered, but the certificate is untrusted, self-signed, expired, or not yet valid — reachable, impaired. |
| **down** | No usable TLS at all: connection refused, timed out, or the handshake failed outright. |
| **unknown** | A configuration or policy problem, such as a refused target address. Misconfiguration never masquerades as an outage. |

A certificate changes rarely, so a **daily** interval is usually right; there's
nothing to gain from polling it every five minutes.

!!! warning "A failed read is *unknown*, never *valid*"
    If the chain can't be read, the reading is `unknown` and carries no
    certificate at all — and **nothing is written to the inventory**. An
    unreachable endpoint can't create a certificate record, can't refresh one,
    and can never make an old record look freshly healthy.

The check needs **no credentials**. Any credential fields on the check template
are ignored by this kind.

## Identity and renewal

A certificate's identity is its **SHA-256 fingerprint**, which is a hash of its
exact bytes.

- **The same certificate served by ten endpoints is one record, not ten.**
  Wildcard and multi-SAN certificates are usually shared across many services;
  the inventory shows one row for the certificate itself.
- **Uniqueness is per tenant.** Two tenants that both observe the same public
  certificate each own their own record. Certificate data never crosses a
  tenant boundary.
- **A renewal creates a new record.** A renewed certificate has a new validity
  window (and normally a new serial and key), so different bytes, so a different
  fingerprint. Danbyte adds the new record; **the old one is never overwritten
  or deleted**. That is what lets you answer "what were we serving last March?"
  after the fact.

Re-observing a certificate that's already on file only refreshes when it was
last seen. The certificate's own facts are properties of those exact bytes, so
they are never rewritten.

## Bindings — what breaks when this expires

A certificate on its own is a floating fact. You can see it expires on Tuesday;
you cannot see *what stops working on Tuesday*. A **binding** is the row that
closes that gap: it records that a specific endpoint served a specific
certificate.

**An endpoint is an IP address, a port, and the server name (SNI) requested.**
That is exactly what the check dialled, so every observation produces one. It is
deliberately not a [Service](../architecture/service-monitoring.md) record — anchoring on
Services would have silently skipped every endpoint nobody happened to author a
Service for, and an inventory with invisible gaps is worse than no inventory.

So a wildcard certificate on twelve hosts is **one certificate row and twelve
bindings** — which is the whole reason the fingerprint, not the hostname, is the
certificate's identity.

Each binding records:

| Field | What it is |
|---|---|
| **Endpoint** | The IP, port and requested server name. One `IP:port` can legitimately serve a different certificate per name, so the name is part of the endpoint's identity. |
| **Chain depth** | Position in the chain *this endpoint* presented — `0` is the end-entity (leaf), `1` its issuer, and so on. Every certificate the server sent is recorded, not just the leaf, so a **missing intermediate is visible**. |
| **Chain verified** | Whether the chain *this endpoint* presented validated against the trust store. Recorded, never enforced. |
| **First seen** / **Last seen** | When this endpoint was first and most recently observed serving this certificate. |

!!! note "Chain facts belong to the endpoint, not the certificate"
    A server that stops sending its intermediate changes what you observe
    without changing a single byte of any certificate. The same intermediate is
    depth `1` where the chain is complete and absent where it isn't, and a
    certificate can verify from one host and fail from another. Recorded on the
    certificate, those would have been whichever endpoint happened to be read
    last — so they live on the binding, where they are true.

### Bindings are history, and history is never deleted

When an endpoint stops serving a certificate, its binding is **not removed**.
The `last_seen` timestamp simply goes stale. That is the record of what an
endpoint *used* to serve, and deleting it would throw away the answer to "what
were we running when that outage happened?" — which is half the reason to keep
an inventory at all.

A binding is **stale** once it hasn't been observed for
`cert_binding_stale_days` (default **7**).

## Expiry alerting

Expiry alerts use the ordinary [alerting engine](../features/monitoring.md) —
the same `Alert` rows routed to the same [notification
channels](../features/monitoring.md) (email, Slack, Teams, Discord, PagerDuty,
webhook). A certificate alert names the **certificate** rather than reading
`tls_cert is down`: the message and webhook/PagerDuty payload carry the subject
CN, a short fingerprint, the expiry date and days remaining, so an on-call
message is actionable on its own. They inherit acknowledgement, silences and
maintenance
windows, renotify, escalation, grouping, and every notification channel you have
configured. There is no separate certificate-notification path to set up.

| State | Severity | When |
|---|---|---|
| **Expiring (warning)** | warning | Within `cert_expiry_warning_days` (default **30**). |
| **Expiring (critical)** | critical | Within `cert_expiry_critical_days` (default **7**). |
| **Expired** | critical | Past `not_after`. Its own state, not merely "very urgent" — anything validating this certificate is *already* failing, so it is recorded with the `down` check status while an approaching expiry is `degraded`. |

Thresholds live in **Monitoring settings**, per tenant. A tenant with no
settings row still alerts, on the defaults above.

Only **leaf** certificates raise alerts. An expiring intermediate or root in a
presented chain is the CA's renewal to do and would double every alert.

### The alert is about the endpoint, not the certificate

This is the part that matters, and the part that is easy to get wrong.

A renewal produces a **new certificate row** — new bytes, new fingerprint, new
record. If an expiry alert were attached to the certificate, then renewing would
leave the old alert firing forever on a record nobody serves, with nothing that
could ever resolve it. One renewal cycle later the alert list is noise and gets
muted.

So the alert is keyed on the **endpoint**, which is exactly what a renewal does
*not* change. Evaluating asks "what is this endpoint serving **now**?" — after a
renewal that is the new certificate, which is healthy, which **resolves the same
alert row** that was firing for the old one. One endpoint, one alert, across any
number of renewals.

### Declared certificates alert too, even if never observed

The endpoint path above only sees certificates a scan actually observed on the
wire. A certificate you **uploaded** and **assigned** to a device, VM or IP is
*intent* — Danbyte knows it exists and is expiring — so it warns on expiry as
well, without ever having to be scanned. This is the difference between "email me
before my cert expires" working for everything you told Danbyte about versus only
for what it happened to catch on the wire.

- The source-of-truth pass keys the alert on the **assignment** (namespaced apart
  from the endpoint keys, so the two can never collide) and hangs it on the
  assigned object's IP — a device or VM contributes its **primary IP** (or any
  assigned IP if it has no primary); an IP assignment is its own IP. An uploaded
  certificate with no way to resolve an IP stays list- and dashboard-only rather
  than raising an alert with nowhere to point.
- Only certificates that are **not currently observed** take this path. Once a
  declared certificate is also seen being served, the endpoint path owns it — so
  a cert never double-alerts.
- It resolves the same way: renew (the assignment now points at a healthy cert),
  unassign, or observe it, and the alert clears. It runs both reactively (on
  assign/unassign) and in the same nightly sweep as the endpoint path.

### What does *not* alert

- **Stale bindings.** A certificate nobody serves any more raises nothing, and
  an alert that was firing for it resolves. An endpoint that has gone
  unreachable already raises its *own* check alert, which is the honest place
  for "we cannot reach this"; a certificate inventory that also pages about
  decommissioned endpoints becomes noise and gets ignored.
- **Anything, if `cert_expiry_alerts_enabled` is off** — and switching it off
  resolves the alerts it was maintaining, rather than leaving strays nothing can
  clear.

!!! warning "Set the warning window below your renewal lead time"
    If your certificates are valid for 14 days and the warning window is 30, a
    freshly renewed certificate is *immediately* inside the window and the alert
    never clears. Short-lived (ACME-style) certificates want a correspondingly
    short warning window.

### When alerts are evaluated

Two paths, both needed:

- **On every observation.** A `tls_cert` check that lands re-evaluates the
  endpoint it just read, so a renewal resolves its alert in the same pass rather
  than waiting for the night.
- **Daily, on a timer** (`danbyte-certificate-expiry` →
  `manage.py certificate_expiry`). A certificate crosses the 30-day line whether
  or not anything scanned it that day, so time passing has to be enough on its
  own. The same sweep covers declared (uploaded, assigned) certificates, so an
  uploaded cert that nothing serves still warns on time. It appears in
  **Jobs → Scheduled tasks** like every other timer.

### The monitoring overview at a glance

The **Monitoring → Overview** page carries a **Certificate & key health** card:
one row of tiles — expired, expiring within the critical window, expiring within
the warning window, healthy, self-signed, SSH host-key drift, and the tenant's
firing-alert total. The labels track the tenant's own thresholds. Each tile opens
the matching list, and the whole card hides on a deployment with no certificates
and no key drift. The counts come from a single tenant-scoped read,
`GET /api/monitoring/certificates/health/`, so the client never re-buckets the
inventory itself.

## The secret store (for issuance keys)

The certificate **inventory** never holds a private key, and never will. But
requesting a certificate (a CSR) and automated issuance (ACME) do need one, so
those features are gated behind an opt-in **secret store** an administrator
enables under **Settings → Administration → Secret store**:

- **Disabled** (default) — no keys are stored anywhere, and the key-bearing
  features stay off (fail closed).
- **Local** — keys live in an encrypted table, at rest under
  `MONITORING_SECRET_KEY`, exactly like every other stored credential. Works out
  of the box and airgap-friendly.
- **Vault / OpenBao** — keys live in an external HashiCorp Vault / OpenBao and
  Danbyte holds only a reference.

It is a **deployment-tier** choice on purpose — where the organisation's private
keys live is not a per-tenant decision. Nothing reads a stored secret over the
API or writes it to the change log. CSR and ACME build on this in later releases.

## Certificate authorities and chains

An issuer is more than a string. When a certificate is recorded — uploaded or
observed — Danbyte reads its **basicConstraints** (is it a CA?) and the RFC 5280
**key identifiers** (Subject Key Identifier and Authority Key Identifier). A
leaf's AKI equals its issuer's SKI, and that is how Danbyte links each
certificate to the **CA certificate that signed it** (`issuer_certificate`),
falling back to matching the issuer DN against a CA's subject DN when a cert
omits the identifiers. The links are tenant-scoped and resolve regardless of the
order certs arrive — upload a leaf first and it adopts its CA the moment the CA
is added.

This gives you a real chain, not a flat list:

- `GET /api/monitoring/certificates/{id}/chain/` walks
  leaf → intermediate → root, each hop carrying its own expiry so an expiring
  **intermediate** is as visible as an expiring leaf.
- `GET /api/monitoring/certificates/authorities/` lists the tenant's CA
  certificates with how many certs each has issued.
- The list filters `?is_ca=1|0` (CAs only / leaves only) and
  `?issued_by=<ca id>` (everything one CA signed).

Chain membership stays public-data-only, exactly like the rest of the inventory
— a CA certificate is still just an observed/uploaded row, never a key.

### Importing a bundle

**Upload certificate** stores a single leaf. **Import bundle** (beside it on the
Certificates list) takes a whole **PEM bundle** — leaf + intermediates + root, or
any batch of concatenated certificates — and stores **each block as its own
row**, so the chain links up immediately. It dedups every block by fingerprint
(re-importing is safe), reports how many were added versus already on file, and
skips any unreadable block rather than failing the whole import.
`POST /api/monitoring/certificates/import-bundle/` with `{"pem": "…"}` is the
API. A private-key block anywhere in the input refuses the whole bundle — the
inventory never stores a key.

## Viewing certificates

The inventory has its own UI under **Governance → Certificates** in the
sidebar.

### The list

`/certificates` is the whole inventory for the active tenant, one row per
certificate. It shows the **subject** (links to the detail page), the
**issuer**, the **expiry** (see below), the **origin** (Observed / Uploaded /
Both), the **key** (algorithm plus size, e.g. `RSA 2048`), the number of
**endpoints** serving it (`binding_count` — the blast radius), how many objects
it is **assigned** to (`assignment_count`), whether it is **self-signed**, and
when it was **last seen**.

An **Upload certificate** button in the header opens the [upload
dialog](#authoring-certificates) (shown only to users with the `add` grant on
certificates).

The search box matches subject, issuer, name, or a fingerprint prefix
(server-side, the same `search=` the API takes). The filter rail on the left
refines by:

- **Expiry** — expired, critical (≤7 days), warning (≤30 days), or healthy.
- **Origin** — observed, uploaded, or both.
- **Assigned** — assigned to an object, or unassigned.
- **Trust** — self-signed vs CA-issued.
- **Key algorithm** — RSA, ECDSA, Ed25519, …

The list arrives ordered soonest-to-expire first, so the top of the page is
always what needs attention. The **Expiry** column sorts by urgency (remaining
days ascending, expired first) rather than alphabetically.

### The expiry column and its colours

Expiry is the headline, so it reads at a glance. Each row shows a coloured tag
with the remaining life, and the colour is derived from the server's
`is_expired` / `days_until_expiry` — never a date compared in the browser, so a
row that hasn't been re-observed can't paint itself healthy. The tiers reuse the
application's existing severity vocabulary (the same tones alerts use); they are
**not** a new palette:

| Tier | When | Treatment |
|---|---|---|
| **Expired** | past `not_after` | the `destructive` / down tone (red) |
| **Critical** | within `cert_expiry_critical_days` (7) | the `warning` tone (amber) |
| **Warning** | within `cert_expiry_warning_days` (30) | the `info` caution tone |
| **Healthy** | further out | quiet muted text, no tag |

The thresholds match the [expiry-alerting](#expiry-alerting) defaults, so the
colour a row shows agrees with when an alert would actually fire.

### The detail page

`/certificates/{id}` opens the certificate with five tabs. The hero carries the
**origin** badge (Observed / Uploaded / Both) beside the expiry tag, and — for
users with the grant — an **Edit** button (the only writable fields, `name` and
`notes`) and **Delete**.

- **Overview** — the certificate's facts in grouped cards: *Identity* (subject,
  issuer, serial, SHA-256 fingerprint, SANs), *Validity* (not-before, not-after,
  the expiry tag, last seen), *Key* (algorithm, size, signature algorithm,
  self-signed), and the *Record* card (origin, name, notes, timestamps). For an
  **uploaded** certificate the stored public **PEM** is shown below the cards in
  a scrolling block with **copy** and **download** actions.
- **Bindings** — the endpoints that served this certificate: endpoint, IP, port,
  SNI, chain depth (`leaf` at depth 0), chain verified, and first / last seen.
  This is the tab that answers *what breaks when this expires*. A binding whose
  chain did **not** verify is shown as an *Unverified* tag rather than hidden —
  a self-signed or incomplete chain from that endpoint is a fact worth seeing.
- **Assignments** — the objects declared to present this certificate (the
  source-of-truth intent), each linking to its detail page, with an **Assign
  to…** control (pick an object type — device / VM / IP — then the object) and a
  per-row **Unassign**. Empty until you assign it somewhere.
- **Journal** and **History** — the shared operator notes and change log, last.

### Dashboard widget

The dashboard carries an **Expiring certificates** widget listing everything
expired or expiring within 30 days, most urgent first, each row linking to its
detail page. With nothing expiring it shows a clean "No certificates expiring in
the next 30 days" message rather than an empty box. Add or remove it from the
dashboard's **Add widget** menu like any other tile.

## Source of truth: authoring and assignment

Observation answers *what is being served*. To answer *what should be served*,
Danbyte lets you **declare** the certificates you expect — the same
observe → intent → drift model interfaces and hardware use. A served certificate
that isn't the declared one is [drift](#assignment-drift-cert_mismatch), not a
silent overwrite.

### Authoring certificates

Upload a certificate by posting its **public PEM**. Danbyte parses it exactly as
the collector parses an observed one — the same fingerprint, subject, issuer,
SANs, validity window and key facts come straight from the bytes — so an
uploaded certificate and the same certificate observed on the wire are **one
row**, identified by their shared fingerprint. An uploaded row carries two extra
truths:

- a **public PEM** (`pem`), stored only for uploaded certs;
- editable **`name`** and **`notes`**. These are the *only* editable fields. The
  intrinsic facts (subject, issuer, serial, fingerprint, validity, key) are
  read-only forever — they are properties of the exact bytes, so a `PATCH` can
  never rewrite them.

Every row records how it came to exist in its **`origin`**:

| `origin` | Meaning |
|---|---|
| `observed` | Seen being served; the collector wrote it. |
| `uploaded` | Declared by an operator; not (yet) seen on the wire. |
| `both` | Uploaded **and** observed — the certificate you declared is the one being served. This convergence is free: it is the same row, by fingerprint identity. |

!!! danger "The upload path refuses a private key, loudly"
    A PEM containing any `PRIVATE KEY` block is rejected with a `400` and the
    message *"Remove the private key; only the public certificate is stored"* —
    checked before parsing, so you never get an opaque `500`. If the blob holds
    several certificates, the **first** block is taken as the leaf (the
    end-entity certificate you are declaring) and re-serialised on its own; no
    chain member or stray key is ever stored. An unparseable PEM is also a `400`.

In the UI, **Upload certificate** (on the certificate list, or **Upload** inside
an object's [Certificates section](#the-certificates-section-on-an-object)) opens
a dialog: paste the PEM or **load a `.pem`/`.crt` file** into the box, with an
optional name and notes. A `201` reports *"Certificate added"*; a `200` — the
fingerprint already existed (e.g. it was already observed) and is now also marked
uploaded — reports *"Matched an already-seen certificate"*. Both the private-key
and parse `400`s surface as an error toast carrying the field message.

### Assigning a certificate to an object

A **certificate assignment** declares that some object should present a
certificate. It is a generic reference — an `object_type` label plus an
`object_id` — so a certificate can be declared on a device, an IP address, a
virtual machine, or a service without a column per kind (the same shape contact
assignments use). One certificate can be assigned to many objects (a wildcard on
every host it covers); one object can carry several certificates (a device
running several services).

The target must belong to the **active tenant** — a certificate can never be
attached to another tenant's object, validated on both create and update.

### The Certificates section on an object

The payoff of the source-of-truth model is the view *on the object*. Device and
virtual-machine detail pages carry a **Certificates** tab; the IP detail page
carries a compact **Certificates** card inside its Monitoring tab (a full tab
would be heavy for a single address). All three are the same panel, resolved
from the object's `(object_type, object_id)`:

- the certificates **assigned** to the object (subject, origin, expiry, notes)
  with a per-row **Unassign**;
- an **Assign a certificate…** control to attach an existing certificate, and an
  **Upload** button to author a new one and assign it in one step;
- a **drift** banner — amber, with the compare-arrows marker used for SNMP drift
  — for each endpoint serving a certificate that is *not* assigned here
  (`cert_mismatch`), with an **Accept served** action.

With nothing assigned the panel shows a clean *"No certificates assigned"* empty
state and still offers the assign/upload controls; the assign and accept actions
are shown only to users with the `add` grant on certificate assignments, and
unassign only with `delete`.

## Assignment drift (`cert_mismatch`)

Once an object has an assigned certificate, its endpoints are checked against it
on the **same endpoint alert path as expiry** — reactively after every
observation, and on the nightly sweep. There is no second mechanism:
`cert_mismatch` opens and resolves ordinary alerts, so acknowledgement, silences,
renotify and every notification channel apply to it exactly as they do to expiry.

For each endpoint (an `IP + port + SNI`, the newest leaf binding — *what it
serves now*), Danbyte resolves whether the endpoint's object has an assigned
certificate:

- **direct** — an assignment to the endpoint's IP (`object_type=api.ipaddress`);
- **inherited** — an assignment to the Device or VM the IP is assigned to
  (`api.device` / `api.virtualmachine`); a device-level declaration applies to
  every endpoint of that device.

Then:

- the served fingerprint matches one of the assigned certificates → healthy, no
  drift;
- it matches **none** of them → `cert_mismatch` fires (a `warning` — the endpoint
  serves TLS fine, it just isn't serving the certificate you declared);
- the object has **no** assignment → nothing to drift against, so nothing fires.

A renewal is a new fingerprint, so it reads as a mismatch until you point the
assignment at the new certificate — which is the honest signal that intent and
reality have diverged.

!!! note "Detection never writes intent"
    Drift is read-only. **Accepting** a mismatch is the only path that writes an
    assignment: `POST /api/monitoring/certificate-assignments/accept-served/`
    with `{"binding": "<id>"}` creates (or replaces) an IP-level assignment
    pointing at what is actually served, mirroring how SNMP/interface drift is
    accepted, and re-evaluates the endpoint so the alert clears at once. In the
    UI this is the **Accept served** button on the object's Certificates
    section; the button is wired to the drifting endpoint's binding, so one click
    repoints intent at reality and clears the `cert_mismatch` alert.

Expiry drift is unchanged — see [expiry alerting](#expiry-alerting).

## Permissions

Certificates, their bindings, and their assignments are separate RBAC object
types (**Monitoring → Certificates**, **Monitoring → Certificate bindings**,
**Monitoring → Certificate assignments**), so each can be granted or withheld
like any other object. The certificate data itself is public, but *which
endpoints your organisation runs* — and *which certificates you declare on them*
— is not.

Observed facts stay **read-only** whatever the grant: uploading authors a row and
edits only `name` / `notes`, and no request body can reach a fact field. Creating
a certificate requires an `add` grant; editing metadata a `change` grant;
deleting a `delete` grant. Deleting an **observed** certificate is harmless — it
is simply re-created on the next poll, since the fingerprint is its identity — so
delete is allowed for either origin; an uploaded-only row is gone.

## API

`GET /api/monitoring/certificates/` — the active tenant's certificates.

| Query parameter | Effect |
|---|---|
| `expiring_in_days=N` | Only certificates expiring within N days (already-expired included). |
| `expired=1` / `expired=0` | Only expired / only currently-valid certificates. |
| `self_signed=1` / `self_signed=0` | Filter on the self-signed flag. |
| `origin=observed\|uploaded\|both` | Filter on how the row came to exist. |
| `assigned=1` / `assigned=0` | Only certificates that are declared somewhere / declared nowhere. |
| `search=` | Matches subject, issuer, name, or a fingerprint prefix. |

`GET /api/monitoring/certificates/{id}/` returns one record.

`POST /api/monitoring/certificates/` is **upload only** — it accepts
`{"pem": "<public PEM>", "name": "...", "notes": "..."}` (also as a form/file
field), never fact fields. It parses the PEM, computes the fingerprint, and
either creates a new `uploaded` row or converges onto the existing row for that
fingerprint (marking it `uploaded` and attaching the PEM). It returns `201` for a
new row, `200` when it converged onto one already on file. A private-key block is
a `400`; an unparseable PEM is a `400`.

`PATCH /api/monitoring/certificates/{id}/` edits **only** `name` and `notes`;
every other field is read-only and silently ignored. `DELETE` removes the
tenant's row.

Each record also exposes derived, always-current values: `is_expired`,
`days_until_expiry` (negative once expired), and `origin`. These are computed at
read time, never stored, so a record that hasn't been re-observed can never
report itself healthy. `binding_count` is the size of the blast radius — how
many endpoints are on record as having served it — and `assignment_count` is how
many objects declare it.

`GET /api/monitoring/certificate-bindings/` — the active tenant's bindings, also
read-only.

| Query parameter | Effect |
|---|---|
| `certificate=<id>` | Every endpoint that has served this certificate — *what breaks when it expires*. |
| `target_ip=<id>` | Everything one address has ever presented. |
| `endpoint_key=` | One exact endpoint (IP + port + SNI), across renewals. |
| `leaf=1` / `leaf=0` | End-entity certificates only / chain members only. |
| `stale=1` / `stale=0` | What an endpoint *used* to serve / what it is still observed serving. |

`GET /api/monitoring/certificate-assignments/` — the active tenant's assignments
(intent). Writable: `POST` to declare, `PATCH` to adjust, `DELETE` to remove.

| Query parameter | Effect |
|---|---|
| `certificate=<id>` | The objects a certificate is declared on. |
| `object_type=` & `object_id=` | The certificates declared on one object. |

`POST /api/monitoring/certificate-assignments/accept-served/` with
`{"binding": "<id>"}` accepts a `cert_mismatch`: it declares the served
certificate on the endpoint's IP (replacing any conflicting IP-level assignment)
and re-evaluates, so the alert clears immediately.

## Changes are journalled

Certificate records **and their assignments** are audited, so creation and any
change appear in the change log alongside the rest of your inventory.

Bindings are **not** audited. Their `last_seen` moves on every observation, so
journalling them would write one change-log entry per endpoint per scan and bury
everything worth reading — the same reason check results and check state aren't
journalled either. The bindings themselves are the history.
