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
| **Chain depth** | Position in the presented chain — `0` is the end-entity (leaf) certificate, `1` its issuer, and so on. Every certificate the server sent is recorded, not just the leaf, so a missing intermediate is visible. |
| **Self-signed** | Whether the certificate signed itself. |
| **Chain verified** | Whether the chain validated against the trust store when it was last read. Recorded, never enforced. |
| **Last seen** | The most recent time the certificate was observed. The row's creation time is the first. |

Nothing else is stored. There is no field for a key, a passphrase, or a
credential, because a certificate check needs none.

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
last seen and where it sat in the chain. The certificate's own facts are
properties of those exact bytes, so they are never rewritten.

## Permissions

Certificates are an RBAC object type (**Monitoring → Certificates**), so viewing
the inventory can be granted or withheld like any other object. The data itself
is public, but *which endpoints your organisation runs* is not.

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
`days_until_expiry` (negative once the certificate has expired).

## Changes are journalled

Certificate records are audited, so creation and any change appear in the
change log alongside the rest of your inventory.
