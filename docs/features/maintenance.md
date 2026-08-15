---
icon: lucide/wrench
---

# Maintenance & outages

Danbyte tracks **provider maintenance windows** and **outages** as first-class
events (Organization → Work → Maintenance): what is happening, when, whose
ticket it is, and which of *your* objects it touches. Events show on the
[planning calendar](planning.md), can silence monitoring alerts for the
impacted devices while the window is open, and can be fed automatically from
provider notification emails through the ingestion API.

## Events

An event is either **maintenance** (planned work — a fiber splice, a carrier
line-card swap) or an **outage** (unplanned — reported, being worked). Both
kinds share the same record:

| Field | Meaning |
|---|---|
| **Kind** | Maintenance (amber wrench) or Outage (red zap). |
| **Status** | A row from your [Statuses catalog](catalogs-and-settings.md#statuses) — see below. |
| **Provider** | The carrier it came from; empty for internal work. |
| **Provider reference** | The provider's own ticket id (`MAINT-77031`). It is the dedup key for ingestion: re-delivering a revised notification updates the event instead of duplicating it. |
| **Starts / Ends** | The window. Maintenance always has an end; an outage may be open-ended. |
| **ETR** | Outages only: the estimated time to restore, while the real end is unknown. |
| **Raw email** | The original notification, kept verbatim next to what was parsed out of it. |

## Statuses come from the catalog

Event statuses are **user-editable rows** in the shared Statuses catalog
(Settings → Statuses), available to the *Maintenance & outage events* type.
A fresh install (and every upgrade) seeds the two conventional workflows:

- **Maintenance**: Tentative → Confirmed → In Progress → Completed
  (or Cancelled / Rescheduled)
- **Outage**: Reported → Investigating → Identified → Monitoring → Resolved

Rename them, recolour them, or add your own — the *behaviour* of a status is
carried by two flags on the row, so it survives renames:

| Flag | Effect |
|---|---|
| **Suppresses alerts** | While an event carries this status, monitoring alerts for its impacted devices are silenced. Seeded on Confirmed, In Progress, and all active outage statuses — a *Tentative* window is a rumour and suppresses nothing. |
| **Closes the event** | The event counts as finished: it leaves the open list and the calendar's open count, and its silence is retired. Seeded on Completed, Cancelled, Rescheduled, and Resolved. |

## Impacts

Each event lists the objects it touches — circuits, devices, sites, prefixes —
with a level (*No impact*, *Reduced redundancy*, *Degraded*, *Outage*). You can
only mark impact on objects you can view, and the impact is site-stamped so
enhanced site separation keeps working after the fact.

## Alert suppression

Danbyte already has the "expected downtime" primitive —
[Silences](monitoring.md). A maintenance event does not grow a rival mechanism;
it **owns a silence**:

- When an event enters a status that *suppresses alerts* **and** has at least
  one impacted device, Danbyte creates a silence matching exactly those
  devices, mirroring the event's window.
- Alerts for those devices are still tracked during the window — just not
  delivered.
- An open-ended outage keeps a rolling one-day silence that each update pushes
  forward; an ETR bounds it when known.
- Closing the event (or removing all device impacts) retires the silence.
  No device impacts ever means no silence — a blanket mute is never implied.

## On the objects it touches

A device or circuit named in an open event shows a **Planned maintenance &
outages** panel at the top of its Overview — the reverse of the event's impact
list, so "is there a window on this box?" is answered where the operator
already is. The panel disappears when nothing is planned.

## On the calendar

Events overlapping the window appear on the planning calendar for **every**
board — provider maintenance matters to everyone's schedule, so the board
filter deliberately does not hide them. The header counts open events
separately from tasks, milestones and planned changes.

## iCal feed

`GET /api/planning/calendar.ics?token=<api token>[&days=60][&board=<id>]`
serves the same window as the calendar page — tasks, milestones, planned
changes and events — as an iCalendar feed Outlook/Google/Apple can subscribe
to. Calendar clients cannot send an `Authorization` header, so the feed takes
a normal Danbyte **API token** as `?token=`, validated exactly like the header
form (hash lookup, expiry, active user, `task:view` RBAC). Use a dedicated
token for a subscription: it rides in a URL, and revoking it kills just the
feed.

## Ingesting provider notifications

Parsing carrier emails stays outside Danbyte — any parser that can normalise a
notification can POST it in:

```
POST /api/monitoring/maintenance-events/ingest/
Authorization: Token <api token with maintenanceevent add+change>

{
  "provider": "carrierone",            // slug or id — must already exist
  "external_ref": "MAINT-77031",       // required: the upsert key
  "kind": "maintenance",
  "status": "confirmed",               // catalog slug or name
  "name": "Fiber splice, span DK-31",
  "starts_at": "2026-08-20T22:00:00Z",
  "ends_at":   "2026-08-21T02:00:00Z",
  "raw_email": "…the original notification…",
  "impacts": [                          // optional; replaces the event's set
    {"object_type": "circuit", "object_id": "…", "level": "degraded"}
  ]
}
```

- `(provider, external_ref)` is the identity: the first delivery answers
  `201`, a re-delivery updates the same event and answers `200`.
- Ingestion **never invents catalog rows**: an unknown provider or status is a
  `400` — add it under Providers / Settings → Statuses first.
- Impact rows pass the token's own view RBAC per object, and the silence is
  resynced after every ingest.

## API

| Endpoint | Purpose |
|---|---|
| `GET/POST /api/monitoring/maintenance-events/` | List and create. Filters: `kind`, `status` (id or slug), `provider`, `open=1`, `active_at=<iso>`, `object_type=&object_id=` (events touching that object) |
| `PATCH/DELETE …/{id}/` | Update (resyncs the silence) / delete (retires it) |
| `POST …/ingest/` | Upsert from an external parser (above) |
| `GET/POST /api/monitoring/event-impacts/` | Impacts; `?event=` or `?object_type=&object_id=` for the reverse "what maintenance touches this circuit?" |
| `GET /api/planning/calendar.ics` | The iCal feed |

Everything is tenant-scoped, default-closed, and audited; events use the
`maintenanceevent` RBAC type and impacts `eventimpact`.
