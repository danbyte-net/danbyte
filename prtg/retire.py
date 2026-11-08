"""What happens in PRTG when a Danbyte device or VM retires or is deleted.

Two paths, both off unless somebody asks:

* **Retirement rules** (:class:`~prtg.models.PrtgRetireRule`). The planning
  pass tries a connection's rules on every linked object before it plans
  registration. The first rule whose statuses and tags match decides:
  ``pause`` proposes ``pause_device``, ``delete`` proposes ``remove_device``
  (a device Danbyte created; any device when the rule's ``delete_any`` is
  on), ``nothing`` leaves the PRTG device as it is. An object a rule paused
  that no longer matches a pause rule gets ``resume_device``. ``Exclude from
  PRTG`` only stops registration; the rules still apply to an excluded
  object.

* **Deleting with cleanup.** The device and VM delete endpoints take
  ``?prtg=keep|remove|pause`` (default ``keep``). Before the Danbyte object
  goes, every PRTG device linked to it is deleted (``remove``, for a device
  Danbyte created - or any with ``prtg_force``) or paused (``pause``, and
  ``remove`` on a device Danbyte did not create without ``prtg_force``).
  PRTG is asked inline; when it cannot be reached, or a bulk delete has many
  links, the rest goes to an RQ job. The delete proceeds either way. Every
  outcome is a journal note on the tenant, since the object is gone.
"""
from __future__ import annotations

import logging

from django.utils import timezone

from .models import PrtgChange, PrtgConnection, PrtgDeviceLink, PrtgRetireRule

log = logging.getLogger("prtg.retire")

KEEP, REMOVE, PAUSE = "keep", "remove", "pause"
MODES = (KEEP, REMOVE, PAUSE)
#: More links than this in one delete go to the RQ job straight away.
INLINE_LINKS = 5
#: The PRTG pause message a retirement or a delete leaves.
RULE_MESSAGE = "Retired: rule {name}"
DELETE_MESSAGE = "Deleted in Danbyte"


# ── rules ───────────────────────────────────────────────────────────────────


def load_rules(conn) -> list[PrtgRetireRule]:
    return list(
        PrtgRetireRule.objects.filter(connection=conn, tenant=conn.tenant)
        .order_by("position", "name")
    )


def rule_matches(rule: PrtgRetireRule, obj, tags: set) -> bool:
    """Its statuses (any of them) and its tags (any of them); an empty list
    asks nothing. A rule with neither never matches."""
    statuses = set(rule.statuses or [])
    wanted_tags = set(rule.tags or [])
    if not statuses and not wanted_tags:
        return False
    if rule.tenant_id != obj.tenant_id:
        return False
    if statuses:
        status = obj.status if obj.status_id else None
        if status is None or status.slug not in statuses:
            return False
    return not wanted_tags or bool(wanted_tags & tags)


def first_rule(rules, obj, tags: set) -> PrtgRetireRule | None:
    return next((r for r in rules if rule_matches(r, obj, tags)), None)


def why(rule: PrtgRetireRule, obj, tags: set) -> str:
    """What the row says: the rule and what in the object matched it."""
    parts = []
    if rule.statuses and obj.status_id:
        parts.append(f"status {obj.status.name}")
    hit = sorted(set(rule.tags or []) & tags)
    if hit:
        parts.append("tag " + ", ".join(hit))
    return f"Matches rule {rule.name}" + (f" ({'; '.join(parts)})" if parts else "") + "."


def plan_rules(conn, obj, *, link, present, rules, tags, counts, fresh, propose, parent,
               no_writes) -> bool:
    """The rules for one object of the planning pass. Returns True when a
    rule claimed the object - registration is not planned for it then."""
    rule = first_rule(rules, obj, tags)
    paused_by_rule = link is not None and link.rule_paused_at is not None
    if rule is None or rule.action == PrtgRetireRule.NOTHING:
        if paused_by_rule and present:
            counts["resume"] = counts.get("resume", 0) + 1
            reason = (f"Matches rule {rule.name}, which leaves PRTG alone."
                      if rule else "No retirement rule matches any more.")
            propose(conn, fresh, {
                "objid": link.objid, "name": link.name,
                "rule": {"name": link.rule_paused_name},
                "reason": reason, "applicable": True,
            }, **parent, kind=PrtgChange.RESUME_DEVICE, key="")
        return False
    if link is None or not present:
        # Nothing in PRTG to retire - and nothing to register either.
        return True
    base = {"objid": link.objid, "name": link.name, "group": link.group_path,
            "rule": {"id": str(rule.id), "name": rule.name, "action": rule.action},
            "reason": why(rule, obj, tags)}
    if rule.action == PrtgRetireRule.PAUSE:
        if paused_by_rule or (link.paused and link.maintenance_paused_at is None):
            # Already ours; or somebody else's pause, which stays theirs.
            return True
        counts["pause"] = counts.get("pause", 0) + 1
        propose(conn, fresh, {**base, "applicable": True},
                **parent, kind=PrtgChange.PAUSE_DEVICE, key="")
        return True
    allowed = link.created_here or rule.delete_any
    detail = {**base, "auto": bool(rule.allow_auto and allowed),
              "delete_any": bool(rule.delete_any), "applicable": allowed}
    if not allowed:
        detail["reason"] += (
            f" Danbyte did not create PRTG device {link.name or link.objid}; turn on "
            f"Delete devices Danbyte did not create on the rule to remove it."
        )
    counts["remove_device"] = counts.get("remove_device", 0) + 1
    if not allowed:
        counts["not_applicable"] = counts.get("not_applicable", 0) + 1
    propose(conn, fresh, detail, **parent, kind=PrtgChange.REMOVE_DEVICE, key="")
    return True


# ── deleting with cleanup ───────────────────────────────────────────────────


def can_write(user, tenant) -> bool:
    """Whether the user may change PRTG devices through Danbyte: the
    integration is on and they hold change on PRTG device links - the grant
    pause and resume need."""
    from auth_api import rbac
    from integrations.toggles import integration_enabled

    return bool(
        tenant is not None and integration_enabled(tenant, "prtg")
        and rbac.has_action(user, tenant, "prtgdevicelink", "change")
    )


def links_for(objs) -> list[PrtgDeviceLink]:
    """The links of these devices and VMs on connections that can be asked:
    enabled, with an API key, in the object's own tenant."""
    dev_ids = [o.pk for o in objs if o._meta.model_name == "device"]
    vm_ids = [o.pk for o in objs if o._meta.model_name == "virtualmachine"]
    tenants = {o.tenant_id for o in objs}
    from django.db.models import Q

    q = Q(pk__in=[])
    if dev_ids:
        q |= Q(device_id__in=dev_ids)
    if vm_ids:
        q |= Q(virtual_machine_id__in=vm_ids)
    out = []
    for link in PrtgDeviceLink.objects.filter(q, tenant_id__in=tenants).select_related(
        "connection", "device", "virtual_machine"
    ).order_by("connection__name", "name"):
        conn = link.connection
        if conn.tenant_id != link.tenant_id or not (conn.enabled and conn.api_key_set):
            continue
        out.append(link)
    return out


def summary(objs) -> dict:
    """For a delete dialog: how many PRTG devices the objects have, how many
    Danbyte created, and the connection's default."""
    links = links_for(objs)
    return {
        "linked": len(links),
        "created": sum(1 for lk in links if lk.created_here),
        "other": sum(1 for lk in links if not lk.created_here),
        "default_remove": any(lk.connection.delete_default_remove for lk in links),
    }


def plan_delete(objs, mode: str, *, force: bool = False) -> list[dict]:
    """What to do in PRTG for these objects, as plain data an RQ job can
    carry once the objects are gone."""
    if mode not in (REMOVE, PAUSE):
        return []
    items = []
    for link in links_for(objs):
        action = PAUSE
        if mode == REMOVE and (link.created_here or force):
            action = REMOVE
        parent = link.parent
        items.append({
            "connection": str(link.connection_id), "tenant": str(link.tenant_id),
            "objid": link.objid, "name": link.name or link.objid,
            "object": f"{'VM ' if link.virtual_machine_id else ''}{parent.name}",
            "created_here": link.created_here, "action": action,
        })
    return items


def _client_pair(conn):
    from .client import PrtgClient
    from .client_v2 import PrtgV2Client

    return PrtgClient.for_connection(conn), PrtgV2Client.for_connection(conn)


def _do(item: dict, conn) -> str:
    from .acks import MARKER
    from .writer import delete_remote

    classic, v2 = _client_pair(conn)
    if item["action"] == REMOVE:
        gone = not delete_remote(conn, item["objid"], classic=classic, v2=v2)
        return (f"PRTG device {item['name']} was already gone." if gone
                else f"Deleted PRTG device {item['name']}.")
    classic.pause(int(item["objid"]), f"{MARKER} {DELETE_MESSAGE}: {item['object']}"[:255])
    return f"Paused PRTG device {item['name']}."


def _journal(tenant_id, text: str, user=None, *, ok: bool) -> None:
    from audit.models import JournalEntry, JournalKind

    from .writer import _actor

    author, name = _actor(user)
    JournalEntry.objects.create(
        tenant_id=tenant_id, created_by=author, author_name=name,
        object_type="core.tenant", object_id=str(tenant_id),
        kind=JournalKind.INFO if ok else JournalKind.WARNING, comments=text[:2000],
    )


def execute(items: list[dict], *, user=None, allow_queue: bool = True) -> list[dict]:
    """Do ``items`` in PRTG, one at a time. A PRTG that cannot be reached
    hands the rest to :func:`run_delete_cleanup`. Answers one result per
    item: ``{connection, objid, name, object, action, ok, detail, queued}``."""
    from .client import PrtgError, PrtgUnreachable
    from .client_v2 import PrtgNotFound

    conns = {
        str(c.id): c for c in PrtgConnection.objects.filter(
            pk__in={i["connection"] for i in items}
        ).select_related("tenant")
    }
    out, rest = [], []
    for item in items:
        if rest:
            rest.append(item)
            continue
        conn = conns.get(item["connection"])
        base = {k: item[k] for k in ("connection", "objid", "name", "object", "action")}
        if conn is None or str(conn.tenant_id) != item["tenant"]:
            out.append({**base, "ok": False, "queued": False,
                        "detail": "The PRTG connection is gone."})
            continue
        try:
            detail = _do(item, conn)
        except PrtgUnreachable as exc:
            if allow_queue:
                rest.append(item)
                continue
            detail, ok = str(exc)[:300], False
        except (PrtgError, PrtgNotFound, ValueError) as exc:
            detail, ok = str(exc)[:300], False
        else:
            ok = True
        text = (f"{detail} ({item['object']} deleted in Danbyte.)" if ok else
                f"PRTG cleanup for deleted {item['object']} failed on {conn.name}: {detail}")
        _journal(conn.tenant_id, text, user, ok=ok)
        out.append({**base, "ok": ok, "queued": False, "detail": detail})
    if rest:
        out.extend(queue(rest, user=user))
    return out


def queue(items: list[dict], *, user=None) -> list[dict]:
    """Hand ``items`` to the RQ job, after commit. Answers them as queued."""
    from django.db import transaction

    user_id = str(user.pk) if user is not None and getattr(user, "pk", None) else None

    def _go():
        try:
            import django_rq

            django_rq.get_queue("low").enqueue(
                run_delete_cleanup, items, user_id, job_timeout=900
            )
        except Exception:  # noqa: BLE001 - say so on the tenant instead
            log.exception("prtg delete cleanup could not be queued")
            for item in items:
                _journal(item["tenant"], f"PRTG cleanup for deleted {item['object']} "
                         f"could not be queued; PRTG device {item['name']} is untouched.",
                         ok=False)

    transaction.on_commit(_go)
    return [{k: i[k] for k in ("connection", "objid", "name", "object", "action")}
            | {"ok": True, "queued": True, "detail": "Queued."} for i in items]


def run_delete_cleanup(items: list[dict], user_id: str | None = None) -> dict:
    """The RQ side of a delete's PRTG cleanup. The objects are gone; each
    item names its connection and tenant, and both are checked again."""
    from django.contrib.auth import get_user_model

    from monitoring.external.beat import skip_reason

    user = get_user_model().objects.filter(pk=user_id).first() if user_id else None
    ok_items = []
    for item in items:
        conn = PrtgConnection.objects.filter(
            pk=item["connection"], tenant_id=item["tenant"]
        ).first()
        reason = skip_reason(conn, "prtg") if conn else "connection gone"
        if reason or not (conn.enabled and conn.api_key_set):
            _journal(item["tenant"], f"PRTG cleanup for deleted {item['object']} skipped: "
                     f"{reason or 'the connection is off'}.", user, ok=False)
            continue
        ok_items.append(item)
    out = execute(ok_items, user=user, allow_queue=False)
    return {"done": sum(1 for r in out if r["ok"]), "failed": sum(1 for r in out if not r["ok"])}


def cleanup_before_delete(objs, mode: str, *, force: bool, user) -> list[dict]:
    """The delete endpoints' hook: plan and run (or queue) the PRTG side
    for ``objs`` before they are deleted."""
    items = plan_delete(objs, mode, force=force)
    if not items:
        return []
    if len(items) > INLINE_LINKS:
        return queue(items, user=user)
    return execute(items, user=user)


def mark_rule_paused(link: PrtgDeviceLink, name: str, now=None) -> None:
    link.rule_paused_at = now or timezone.now()
    link.rule_paused_name = name[:120]
    # The rule owns the pause now: the maintenance mirror lets go of it.
    link.maintenance_paused_at = None
    link.maintenance_paused_until = None
    link.maintenance_events = []
    link.save(update_fields=["rule_paused_at", "rule_paused_name", "maintenance_paused_at",
                             "maintenance_paused_until", "maintenance_events"])
