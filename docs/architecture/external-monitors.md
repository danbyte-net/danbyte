---
icon: lucide/plug
---

# External monitor internals

How Danbyte reads from monitoring systems it does not run, and what a new one
plugs into. [Zabbix](../monitoring/zabbix.md) is the system built on it today.

An external monitor is a server somebody already operates. What differs per
system is its client, its vocabulary and its object tree. What does not differ
lives in `monitoring/external/`, so a second system uses the same machinery
instead of a copy of it. Systems import `monitoring.external`. Nothing in it
imports a system's package.

## What lives in `monitoring/external/`

| Module | What it holds |
|---|---|
| `state_map.py` | `StateMap`, a system's states or severities mapped onto Danbyte's statuses: source values, defaults, the statuses an operator may pick, values whose status is fixed, `clean()` for a stored map and `worst()` for a set of live values. |
| `matching.py` | `Cascade` and `Level`: the order for matching a device to a remote object. The stored link comes first, then each level, most reliable first. Two candidates at a level are no match, with a sentence for the queue. `Match` is the result. |
| `models.py` | Abstract bases: `ExternalLinkBase` (`matched_by`, `created_here`, `last_seen_at`, `unwanted_since`, prune grace), `ExternalChangeBase` (`detail`, `ignored`, `propose()`, `drop_stale()`, `applicable()`), `ExternalAdoptionRuleBase` (`pattern`, `role`, `device_type`, `weight`, `enabled`). |
| `queue.py` | `ChangeQueueMixin`: the review queue's `apply`, `dismiss`, `restore` and `apply-all` actions, and its default `?connection=` / `?ignored=1` filtering. |
| `adoption.py` | Turning an unknown remote object into a device proposal. Covers the tenant-wide `device_index`, the rule → object → connection-defaults placement chain, the "missing" sentence, re-applying changed defaults to waiting proposals, and `make_device`, which re-reads every catalog id inside the tenant and records an address only inside an existing prefix. |
| `maintenance.py` | `desired_windows(tenant)`, the open windows that own a silence, with their devices. `desired_for_links(tenant, links)` narrows them to the devices a connection has linked. |
| `hooks.py` | Registries: `register_ack_writer(check_kind, fn, system=…)` and `register_window_listener(name, fn)`. Monitoring connects the one signal handler for each. |
| `beat.py` | `register_beat(name, label, enqueue_due, own_timer=…)`, `enqueue_due()` over a system's connections, and `skip_reason()`: the run-time check (row exists, tenant active, integration on) that every job starts with. |
| `policy.py` | `device_matches(rule, device)` for rules that pick devices. These are the global, region, site, platform, device type, device role and device scopes, plus the tag, name and hardware filters from `monitoring/policy_scopes.py`. |

## Tables stay per system

Each system keeps concrete tables of its own: a link per device, a review
queue, adoption rules. Those rows already hold live data with their own API
paths, RBAC object types and constraints. Only fields that are identical in
every system live on the abstract bases. The tenant and connection foreign
keys, the remote id, the `kind` choices, constraints and ordering stay on the
concrete model. An abstract base adds no table. Moving a field onto one
creates no migration as long as the field's definition does not change.
`makemigrations --check` confirms this.

## Acknowledgements and the `source`

`monitoring.alerts.set_acknowledged(alert, acknowledged, actor=…, note=…,
source=…)` is the only place an acknowledgement is written. The alert API
calls it for an operator, with no `source`. An integration that reads an
acknowledgement made on its own side calls it with `source="<system>"` and,
usually, no actor.

The `alert_acknowledged` signal carries `source`. The shared handler calls
every writer registered for the alert's check kind, except the writer whose
`system` is the `source`. An acknowledgement read from a system is never
written back to that system.

## Plugging a system in

In the system's `AppConfig.ready()`:

1. `register_monitoring_engine(...)` for the engine kind, plus the driver that
   answers its checks in bulk through `ingest_results`.
2. `register_ack_writer(KIND, fn, system="<name>")` if it writes
   acknowledgements. The `fn` should only queue a job after commit.
3. `register_window_listener("<name>", fn)` if it mirrors maintenance. The
   `fn(tenant_id)` queues a reconcile, which reads `desired_for_links`.
4. `register_beat("<name>", label, enqueue_due)` for its periodic passes.
   `enqueue_due` usually wraps `beat.enqueue_due` with `BeatTask`s. Every job
   starts with `skip_reason(conn, "<toggle key>")`.
5. `register_observation_source("<name>", label, loader)` if it reports
   inventory facts into the drift inbox.

Its models subclass the abstract bases. Its change viewset mixes in
`ChangeQueueMixin` before `TenantScopedViewSet` and implements
`apply_change`, `apply_pending` and `remote_errors`. Its matching declares a
`Cascade` with its levels. Its state vocabulary is a `StateMap`.

## The beat

`manage.py extmon_sync` runs every beat entry that has no timer of its own.
Zabbix registers with `own_timer=True` and is still driven by
`danbyte-zabbix-sync.timer` running `zabbix_sync`, so `extmon_sync` never runs
it twice. `extmon_sync` has no timer yet. One is added when the first system
that depends on it ships.

## Where Zabbix sits

| Zabbix module | Built on |
|---|---|
| `zabbix/severity.py` | `StateMap` (`STATE_MAP`). `clean_map`, `worst`, `SEVERITIES`, `DEFAULT_MAP` and `MAPPABLE` keep their names. |
| `zabbix/matching.py` | `Cascade` (`CASCADE`): address → serial → name. `Match`, `index_hosts` and `match_device` keep their names. |
| `zabbix/models.py` | `ZabbixHostLink`, `ZabbixChange` and `ZabbixAdoptionRule` subclass the abstract bases. Their tables are unchanged. |
| `zabbix/viewsets.py` | `ZabbixChangeViewSet` uses `ChangeQueueMixin`. |
| `zabbix/provision.py` | `ZabbixChange.propose` / `drop_stale` / `applicable`, and the link's prune grace. |
| `zabbix/adopt.py` | The shared placement chain, defaults refresh and `make_device`. `applicable` and `device_index` are re-exported. |
| `zabbix/maintenance.py` | `desired_for_links`, plus `skip_reason` in the job. |
| `zabbix/hooks.py` | Registered as the `zabbix` ack writer and window listener. |
| `zabbix/sync_tasks.py` | `enqueue_due` and `skip_reason`. Registered on the beat with its own timer. |
