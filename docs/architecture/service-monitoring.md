# Service monitoring

How a documented **Service** (a name + protocol + ports exposed by a device or
VM) ties into the monitoring engine, and how you configure it fleet-wide from a
**device type** so every device of that type is monitored the moment it's
created.

## The problem

Monitoring's target is always an **IPAddress** (see
[`monitoring/models.py`](../../monitoring/models.py): `CheckState`,
`CheckResult`, `CheckAssignment`). A service, by contrast, is a property of a
*host* — "this box answers HTTPS on 443". Before this feature, the only way to
monitor a service was the per-device **Monitor** button, which:

- gave no visible feedback on the Services tab (the checks landed on the IP /
  monitoring pages, so the row looked unchanged — "the button does nothing");
- left no link back from the Service to the checks it created, so "is this
  service monitored?" wasn't answerable and turning it *off* was unsafe;
- had to be clicked once per device — there was no way to say "every firewall of
  this type should have its HTTPS admin port watched".

## The model

Three small additions, no new monitoring-target abstraction:

| Field / model | Where | Purpose |
|---|---|---|
| `Service.monitored` (bool) | `api/models.py` | Source of truth: is this service watched? Drives check create/teardown. |
| `DeviceTypeService` | `api/models.py` | A service *template* on a device type (name · protocol · ports · `monitor`). Materialises onto every new device of the type, exactly like interface/port templates. |
| `CheckAssignment.service` (FK, nullable) | `monitoring/models.py` | Ownership link so a service's checks are queryable and can be torn down safely. Manual/legacy assignments have `service = NULL` and are never auto-removed. |

`monitored` is the *flag*; the actual checks are still ordinary per-IP
`CheckTemplate` (slug `tcp-443`) + `CheckAssignment` rows — the same primitives
the Monitor button always created. We reuse them; we just now own and track them.

### Reconciliation — `sync_service_checks`

[`monitoring/service_checks.py`](../../monitoring/service_checks.py) is the
single code path. Given a Service it:

1. Resolves the **target IP** — the service's own `ip_address`, else the parent
   device's `primary_ip`, else the VM's `primary_ip`.
2. If `monitored` **and** there's a target IP **and** there are ports → for each
   port, `get_or_create` the `tcp`/`udp` `CheckTemplate` and a `CheckAssignment`
   (stamped with `service=`) on that IP, then `materialise_ip()`.
3. Otherwise (flag off, no ports, or no IP yet) → delete the
   `CheckAssignment`s this service owns (`service=svc`) and re-materialise the
   affected IPs. Manual checks (`service IS NULL`) are untouched.

It's idempotent and safe to call on every save. A monitored service created
before its device has an IP simply parks at zero checks until an IP appears — the
flag stays on and the next save (e.g. setting the primary IP) activates it.

### Propagation from a device type

`materialize_device_components(device)`
([`api/models.py`](../../api/models.py)) — the same function that stamps
interfaces, ports and bays onto a new device — now also stamps `Service` rows
from the device type's `DeviceTypeService` templates, carrying `monitored` from
each template's `monitor` flag. Idempotent by service name (re-running skips
names the device already has). Deleting a template from the device type does
**not** touch existing devices — only future ones — matching the rest of the
component-template system.

`DeviceViewSet.perform_update` re-runs `sync_service_checks` for the device's
monitored services, so setting a device's primary IP switches on the services
that were waiting for one.

## The surfaces (where you touch it)

- **Device → Services tab.** Each service shows a **Monitored** badge and a
  toggle. Toggling calls `PATCH /api/services/{id}/ {monitored}` → reconciled
  server-side. `check_count` on the row tells you how many ports are actually
  scheduled (0 with the flag on = "no target IP yet").
- **Device type → Components → Services.** Define the services a device of this
  type exposes and tick **Monitor** to have every new device auto-watched. This
  is the fleet-wide control plane.
- The old `POST /api/services/{id}/monitor/` action still exists (sets
  `monitored=True` + reconciles) for backward compatibility.

## Why not a new "service" check target?

A first-class service target would mean a new nullable FK on `CheckState`,
`CheckResult`, `CheckAssignment`, `Alert`, `StateTransition`, plus resolver and
engine changes — a large, cross-cutting abstraction. Decomposing a service into
per-port IP checks reuses everything that already exists (the tcp/udp/http
checkers, the resolver, the engines) and keeps one mental model: **services live
on a host; monitoring is a flag on the service.**

## Limitations

- `CheckAssignment` is unique on `(template, ip_address)`, so two services on the
  same IP sharing an identical port template share one assignment row; ownership
  goes to whichever created it first. Rare in practice (distinct services expose
  distinct ports). Documented rather than modelled around.
- Deleting a Service cascades its owned checks (`on_delete=CASCADE`).
