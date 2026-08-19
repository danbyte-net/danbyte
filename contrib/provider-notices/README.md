# Provider notices → Danbyte

The reference parser for provider maintenance/outage notifications
(issue #20). Parsing stays outside Danbyte - this script reads a mailbox (or
one `.eml`), normalises per provider, and POSTs to
`/api/monitoring/maintenance-events/ingest/`.

Quick start:

```bash
export DANBYTE_URL=https://danbyte.example.com
export DANBYTE_TOKEN=<api token with maintenanceevent add+change>

# Develop against a saved mail:
./ingest_mail.py --file examples/carrierone.eml   # → created
./ingest_mail.py --file examples/carrierone.eml   # → updated (upsert)

# Production: poll a mailbox from cron or a systemd timer.
export IMAP_PASSWORD=…
./ingest_mail.py --imap imap.example.com --user notices@example.com
```

Write a parser per provider: one function taking the parsed
`email.message.Message` and returning the ingest payload (or `None` when the
mail isn't yours), registered in `PARSERS`. `external_ref` is the upsert key;
`raw_email` keeps the original for audit; `circuit_impact()` shows how to map
a carrier circuit id to a Danbyte object. Full endpoint semantics are in the
docs under *Maintenance & outages → Ingesting provider notifications*.
