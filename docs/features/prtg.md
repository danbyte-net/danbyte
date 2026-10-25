---
icon: lucide/activity
---

# PRTG monitoring

Danbyte can connect to an existing PRTG Network Monitor core server. Today
that means a connection and a test of it: Danbyte reaches PRTG, reads its
version, counts the probes and sensors the API key can see, and checks whether
PRTG's API v2 answers. Nothing is read on a schedule yet, and nothing is
written to PRTG.

!!! note "Danbyte does not become a PRTG frontend"
    No graphs, no history browser, no channel limits. What PRTG monitors
    stays configured in PRTG.

## Turning it on

1. **Settings → Integrations → PRTG monitoring**. Off by default, per tenant,
   like every other integration. On, it adds **PRTG** under *Integrations* in
   the sidebar; off, the page is hidden and the API answers 404. Opened by
   link, the page says PRTG is off.
2. In PRTG, create an **API key** for the user Danbyte should act as (*Setup →
   Account Settings → API Keys*). Read access is enough for everything Danbyte
   does today.
3. On the **PRTG** page, add the connection: a name, the URL of the PRTG web
   interface, the API key, how often Danbyte will read PRTG, TLS verification,
   and whether the connection is enabled. Press **Test connection**.

The API key is write-only. The form shows whether one is stored, never the key;
leaving the field blank keeps the stored key. Changing the URL to another host
drops the stored key, so it is never sent to a server it was not typed for.
The key is encrypted at rest and left out of the change log.

!!! warning "An internal PRTG has to be allow-listed"
    A tenant-configured URL is never a way to reach internal services, so every
    request goes through the outbound guard and redirects are never followed.
    Most PRTG servers are on RFC1918: a deployment admin adds the address under
    **Settings → Security → Outbound connections** (or `DANBYTE_SSRF_ALLOWLIST`).

PRTG installs with a self-signed certificate. Keep **Verify TLS certificate**
on and give PRTG a certificate your deployment trusts, rather than switching
verification off.

## What the test reports

| Field | Meaning |
|---|---|
| Version | The PRTG version from `getstatus.json`. Below **24.1** the connection is marked unsupported. |
| Probes, sensors | How many the API key can see, from `table.json`. A key scoped to nothing shows zero. |
| API v2 | Whether PRTG's API v2 answers on the same host (port 1616 for HTTPS, 1615 for HTTP). A refused key still counts as answering. |
| Last error | PRTG's own sentence when it refused the call, or why it could not be reached. |

A failed test answers 502 with the reason; the reason is also kept on the
connection until the next test passes.

## How Danbyte talks to PRTG

The classic HTTP API, with the API key in an `Authorization: Bearer` header,
which PRTG prefers over query parameters. Tables are read in pages of 5,000
rows with a short pause between pages, since the same web server serves the
PRTG interface. Status codes 0-14 are read from `status_raw`; *Not Licensed*
(11, the state of sensors beyond a licence's limit) and every paused state read
as **unknown**, never down.

The freeware edition (100 sensors) has the same API as the commercial ones.

## API

All under `/api/prtg/`, scoped to the active tenant, 404 while the integration
is off, and gated on the *PRTG connections* permission (group *Monitoring*).

| Endpoint | Purpose |
|---|---|
| `connections/` | List, create, update, delete. `api_key` is write-only; `api_key_set` says whether one is stored. `status_interval_seconds` is 60-3600. `api_v2_url` is blank to derive it, and must name the same host as `url`. |
| `connections/<id>/test/` | `POST`. Returns `ok`, `detail`, `version`, `probes`, `sensors`, `v2_available` and `v2_detail`; 502 when it fails. Records the version, API v2 answer and error on the connection. |

## Coming

Reading sensor states into Danbyte's checks and alerts, the sensors of a
linked device on its page, acknowledgements and maintenance windows in both
directions, adopting PRTG devices, and keeping PRTG in step with Danbyte's
inventory. The connection's provisioning scope already defaults to
*every device the policies match* for that last part.

---

PRTG is a trademark of Paessler GmbH. Danbyte is not affiliated with or
endorsed by Paessler.
