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
    renewal. There is deliberately no PEM, blob, notes, or custom-field column
    on a certificate that *could* hold key material — and the model refuses to
    save anything that looks like a key, whatever wrote it. If someone offers
    you a workflow that needs Danbyte to hold the key, that is a different
    product.

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
the same `Alert` rows, so they inherit acknowledgement, silences and maintenance
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
  own. The sweep appears in **Jobs → Scheduled tasks** like every other timer.

## Viewing certificates

The inventory has its own UI under **Governance → Certificates** in the
sidebar.

### The list

`/certificates` is the whole inventory for the active tenant, one row per
certificate. It shows the **subject** (links to the detail page), the
**issuer**, the **expiry** (see below), the **key** (algorithm plus size, e.g.
`RSA 2048`), the number of **endpoints** serving it (`binding_count` — the blast
radius), whether it is **self-signed**, and when it was **last seen**.

The search box matches subject, issuer, or a fingerprint prefix (server-side,
the same `search=` the API takes). The filter rail on the left refines by:

- **Expiry** — expired, critical (≤7 days), warning (≤30 days), or healthy.
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

`/certificates/{id}` opens the certificate with four tabs:

- **Overview** — the certificate's facts in grouped cards: *Identity* (subject,
  issuer, serial, SHA-256 fingerprint, SANs), *Validity* (not-before, not-after,
  the expiry tag, last seen), *Key* (algorithm, size, signature algorithm,
  self-signed), and the *Record* timestamps.
- **Bindings** — the endpoints that served this certificate: endpoint, IP, port,
  SNI, chain depth (`leaf` at depth 0), chain verified, and first / last seen.
  This is the tab that answers *what breaks when this expires*. A binding whose
  chain did **not** verify is shown as an *Unverified* tag rather than hidden —
  a self-signed or incomplete chain from that endpoint is a fact worth seeing.
- **Journal** and **History** — the shared operator notes and change log, last.

### Dashboard widget

The dashboard carries an **Expiring certificates** widget listing everything
expired or expiring within 30 days, most urgent first, each row linking to its
detail page. With nothing expiring it shows a clean "No certificates expiring in
the next 30 days" message rather than an empty box. Add or remove it from the
dashboard's **Add widget** menu like any other tile.

## Permissions

Certificates and their bindings are separate RBAC object types
(**Monitoring → Certificates** and **Monitoring → Certificate bindings**), so
each can be granted or withheld like any other object. The certificate data
itself is public, but *which endpoints your organisation runs* is not — which is
exactly what a binding records.

The inventory is **read-only** everywhere — API and admin alike. A certificate
record is an observation, so there is no legitimate way to author one by hand,
and no request body can reach these fields at all.

## API

`GET /api/monitoring/certificates/` — the active tenant's certificates.

| Query parameter | Effect |
|---|---|
| `expiring_in_days=N` | Only certificates expiring within N days (already-expired included). |
| `expired=1` / `expired=0` | Only expired / only currently-valid certificates. |
| `self_signed=1` / `self_signed=0` | Filter on the self-signed flag. |
| `search=` | Matches subject, issuer, or a fingerprint prefix. |

`GET /api/monitoring/certificates/{id}/` returns one record. `POST`, `PATCH`,
`PUT` and `DELETE` are not available.

Each record also exposes two derived, always-current values: `is_expired` and
`days_until_expiry` (negative once the certificate has expired). These are
computed at read time, never stored, so a record that hasn't been re-observed
can never report itself healthy. `binding_count` is the size of the blast
radius — how many endpoints are on record as having served it.

`GET /api/monitoring/certificate-bindings/` — the active tenant's bindings, also
read-only.

| Query parameter | Effect |
|---|---|
| `certificate=<id>` | Every endpoint that has served this certificate — *what breaks when it expires*. |
| `target_ip=<id>` | Everything one address has ever presented. |
| `endpoint_key=` | One exact endpoint (IP + port + SNI), across renewals. |
| `leaf=1` / `leaf=0` | End-entity certificates only / chain members only. |
| `stale=1` / `stale=0` | What an endpoint *used* to serve / what it is still observed serving. |

## Changes are journalled

Certificate records are audited, so creation and any change appear in the
change log alongside the rest of your inventory.

Bindings are **not** audited. Their `last_seen` moves on every observation, so
journalling them would write one change-log entry per endpoint per scan and bury
everything worth reading — the same reason check results and check state aren't
journalled either. The bindings themselves are the history.
