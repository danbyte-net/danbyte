"""Who a PRTG policy hits: ``policies/<id>/matches/`` and ``match_count`` on
``policies/<id>/``.

The matching is the planning pass's own - :func:`prtg.provision.policy_matches`
over the objects :func:`prtg.provision._objects` walks, with the same
:class:`~prtg.provision.Context` - so the list is what the next plan would
see. For each object :func:`~prtg.provision.decide` says whether it is in
the plan and which policy decides its group when several match. Nothing is
written and PRTG is not asked.
"""
from __future__ import annotations

from rest_framework.decorators import action
from rest_framework.response import Response

from api.views import _get_active_tenant
from auth_api import rbac

from .models import PrtgDeviceLink, PrtgPolicy

_TRUE = ("1", "true", "yes")
_FALSE = ("0", "false", "no")


def _ref(row) -> dict | None:
    if row is None:
        return None
    return {"id": str(row.id), "name": getattr(row, "name", "") or str(row)}


def policy_matches_rows(policy: PrtgPolicy, user, tenant) -> list[dict]:
    """Every device and VM the policy matches that the user may view, in
    name order, with what the plan makes of it."""
    from .provision import (
        _is_vm,
        _objects,
        _prepare,
        decide,
        policy_matches,
        vm_site_id,
    )

    conn = policy.connection
    ctx, checked = _prepare(conn)
    # A disabled policy still shows who it would hit; the plan ignores it.
    if (policy.match_hardware or "").strip():
        ctx.want_hardware = True
    visible_devices = set(
        rbac.restrict_queryset(
            _device_qs(tenant), user, tenant, "device", "view"
        ).values_list("id", flat=True)
    )
    visible_vms = set(
        rbac.restrict_queryset(
            _vm_qs(tenant), user, tenant, "virtualmachine", "view"
        ).values_list("id", flat=True)
    )
    links = {
        (lk.device_id or lk.virtual_machine_id): lk
        for lk in PrtgDeviceLink.objects.filter(connection=conn, tenant=tenant)
    }
    rows = []
    for obj in _objects(conn):
        vm = _is_vm(obj)
        if obj.id not in (visible_vms if vm else visible_devices):
            continue
        if not policy_matches(policy, obj, ctx):
            continue
        link = links.get(obj.id)
        want = decide(conn, obj, ctx, linked=link is not None, checked=checked)
        lead = None
        if want.group and want.group.get("source") == "policy":
            lead = {"id": want.group.get("policy_id"), "name": want.group.get("policy")}
        site = obj.site if obj.site_id else (
            obj.cluster.site if vm and vm_site_id(obj) else None
        )
        rows.append({
            "kind": "virtual_machine" if vm else "device",
            "id": str(obj.id),
            "name": obj.name,
            "site": _ref(site),
            "role": _ref(obj.role if obj.role_id else None),
            "platform": _ref(obj.platform if obj.platform_id else None),
            "prtg_sync": getattr(obj, "prtg_sync", "inherit") or "inherit",
            "linked": link is not None,
            "link": (
                {"objid": link.objid, "name": link.name, "url": conn.device_url(link.objid)}
                if link else None
            ),
            "managed": want.managed,
            "via": want.via,
            "reason": want.reason,
            "group_policy": lead,
            "wins_group": bool(lead and lead["id"] == str(policy.id)),
            "policies": [{"id": str(p.id), "name": p.name} for p in want.policies],
        })
    rows.sort(key=lambda r: (r["name"].lower(), r["kind"]))
    return rows


def _device_qs(tenant):
    from api.models import Device

    return Device.objects.filter(tenant=tenant)


def _vm_qs(tenant):
    from api.models import VirtualMachine

    return VirtualMachine.objects.filter(tenant=tenant)


def _flag(value):
    value = (value or "").strip().lower()
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    return None


class PolicyMatchesMixin:
    """``matches/`` and ``match_count`` for :class:`PrtgPolicyViewSet`."""

    def retrieve(self, request, *args, **kwargs):
        policy = self.get_object()
        data = dict(self.get_serializer(policy).data)
        tenant = _get_active_tenant(request)
        data["match_count"] = len(policy_matches_rows(policy, request.user, tenant))
        return Response(data)

    @action(detail=True, methods=["get"])
    def matches(self, request, pk=None):
        """Every device and VM the policy matches, paged: ``?prtg_sync=``
        (``inherit``, ``always``, ``never``) and ``?linked=`` (``1``/``0``)
        narrow it. Each row: ``kind``, ``id``, ``name``, ``site``, ``role``,
        ``platform``, ``prtg_sync``, ``linked``, ``link``, ``managed``,
        ``via``, ``reason``, ``group_policy`` (the policy that decides the
        group), ``wins_group`` and ``policies`` (every enabled match)."""
        policy = self.get_object()
        tenant = _get_active_tenant(request)
        rows = policy_matches_rows(policy, request.user, tenant)
        sync = (request.query_params.get("prtg_sync") or "").strip()
        if sync:
            wanted = {s for s in sync.split(",") if s}
            rows = [r for r in rows if r["prtg_sync"] in wanted]
        linked = _flag(request.query_params.get("linked"))
        if linked is not None:
            rows = [r for r in rows if r["linked"] is linked]
        page = self.paginate_queryset(rows)
        if page is not None:
            return self.get_paginated_response(page)
        return Response(rows)
