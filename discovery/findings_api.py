"""Observed services and the review queue (#451 B3). Every endpoint answers
404 while Discovery is off for the active tenant. Service-scan rows need
``ipaddress`` view and are limited to addresses the caller may view; the
package inventory's proposals (``platform``, ``application``, ``link``;
``discovery.inventory_findings``) need ``installedsoftware`` view and are
limited to hosts the caller may view. The queue needs one of the two;
observed services need ``ipaddress`` view.

``discovery/services/``          GET: observed services
``discovery/findings/``          GET: proposals to review
``discovery/findings/accept/``   POST: create what the findings propose
                                 (*add* or *change* on it)
``discovery/findings/ignore/``   POST: hide findings until the evidence
                                 changes, or show them again
"""
from __future__ import annotations

import uuid

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api import rbac

from . import findings, gate, inventory_findings
from .api import _paginate, _ref, _visible_hosts_q, _visible_profiles
from .models import (
    FindingDecision,
    HostOsFact,
    InventoryFindingDecision,
    InventoryHostResult,
    InventoryRun,
)

MAX_IDS = 500
ALL_KINDS = (*findings.KINDS, *inventory_findings.KINDS)


def _need_ip_view(request, tenant):
    if not request.user.is_superuser and not rbac.has_action(
            request.user, tenant, "ipaddress", "view"):
        raise PermissionDenied("ipaddress.view required.")


def _may(request, tenant) -> tuple[bool, bool]:
    """``(service-scan rows, inventory rows)`` the caller may read; neither
    is a 403."""
    user = request.user
    if user.is_superuser:
        return True, True
    services = rbac.has_action(user, tenant, "ipaddress", "view")
    inventory = rbac.has_action(user, tenant, "installedsoftware", "view")
    if not (services or inventory):
        raise PermissionDenied("ipaddress.view or installedsoftware.view required.")
    return services, inventory


def _inventory_hosts_q(request, tenant):
    """Hosts the caller may view, narrowed like the observations: ``run``
    (the hosts it read), ``profile`` (hosts it read last), ``device``,
    ``virtual_machine``."""
    q = _visible_hosts_q(request, tenant)
    run_id = _uuid_param(request, "run")
    if run_id is not None:
        run = InventoryRun.objects.filter(
            tenant=tenant, pk=run_id,
            profile__in=_visible_profiles(request, tenant).values("pk")).first()
        if run is None:
            raise NotFound("Not found.")
        hosts = InventoryHostResult.objects.filter(run=run)
        q &= (Q(device__in=hosts.filter(device__isnull=False).values("device_id"))
              | Q(virtual_machine__in=hosts.filter(virtual_machine__isnull=False)
                  .values("virtual_machine_id")))
    profile_id = _uuid_param(request, "profile")
    if profile_id is not None:
        if not _visible_profiles(request, tenant).filter(pk=profile_id).exists():
            raise NotFound("Not found.")
        facts = HostOsFact.objects.filter(tenant=tenant, run__profile_id=profile_id)
        q &= (Q(device__in=facts.filter(device__isnull=False).values("device_id"))
              | Q(virtual_machine__in=facts.filter(virtual_machine__isnull=False)
                  .values("virtual_machine_id")))
    for field in ("device", "virtual_machine"):
        value = _uuid_param(request, field)
        if value is not None:
            q &= Q(**{f"{field}_id": value})
    return q


def _uuid_param(request, name):
    raw = (request.query_params.get(name) or "").strip()
    if not raw:
        return None
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise ValidationError({name: "Not a valid id."}) from None


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def observations(request, tenant):
    """Observations the caller may see - current ones unless
    ``?current=false`` - narrowed by ``run``, ``profile``, ``ip_address``,
    ``device``, ``virtual_machine``, ``confidence`` and ``search``."""
    p = request.query_params
    current = (p.get("current") or "").strip().lower() not in ("false", "0")
    qs = findings.visible_observations(request, tenant, current=current)
    run_id = _uuid_param(request, "run")
    if run_id is not None:
        run = InventoryRun.objects.filter(
            tenant=tenant, pk=run_id,
            profile__in=_visible_profiles(request, tenant).values("pk")).first()
        if run is None:
            raise NotFound("Not found.")
        qs = qs.filter(ip_address__in=InventoryHostResult.objects.filter(
            run=run, ip_address__isnull=False).values("ip_address_id"))
    profile_id = _uuid_param(request, "profile")
    if profile_id is not None:
        if not _visible_profiles(request, tenant).filter(pk=profile_id).exists():
            raise NotFound("Not found.")
        qs = qs.filter(run__profile_id=profile_id)
    for field in ("ip_address", "device", "virtual_machine"):
        value = _uuid_param(request, field)
        if value is not None:
            qs = qs.filter(**{f"{field}_id": value})
    conf = (p.get("confidence") or "").strip()
    if conf:
        qs = qs.filter(confidence__in=[c for c in conf.split(",") if c])
    q = (p.get("search") or "").strip()
    if q:
        qs = qs.filter(Q(address__icontains=q) | Q(product__icontains=q)
                       | Q(service_name__icontains=q) | Q(banner__icontains=q))
    return qs


def observed_dict(o) -> dict:
    return {
        "id": str(o.pk), "address": o.address, "port": o.port, "protocol": o.protocol,
        "ip_address": str(o.ip_address_id), "device": _ref(o.device),
        "virtual_machine": _ref(o.virtual_machine), "service_name": o.service_name,
        "banner": o.banner, "product": o.product, "vendor": o.vendor, "version": o.version,
        "cpe": o.cpe, "os_guess": o.os_guess, "source": o.source, "rule": o.rule,
        "confidence": o.confidence, "http": o.http or {}, "tls": o.tls or {},
        "certificate": str(o.certificate_id) if o.certificate_id else None,
        "first_seen": o.first_seen, "last_seen": o.last_seen, "gone_at": o.gone_at,
        "run": str(o.run_id) if o.run_id else None,
    }


@extend_schema(summary="Observed services", tags=["discovery"],
               responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def discovery_services(request):
    """Open ports service scans found on addresses the caller may view.
    Filters: ``run``, ``profile``, ``ip_address``, ``device``,
    ``virtual_machine``, ``confidence``, ``search``, ``current`` (default
    true: ports open at the last scan)."""
    tenant = gate.require(request)
    _need_ip_view(request, tenant)
    qs = observations(request, tenant).order_by("address", "port", "pk")
    return _paginate(request, qs, lambda page: [observed_dict(o) for o in page])


def _rows(request, tenant, *, include_ignored=False):
    """The service-scan proposals (``discovery.findings``)."""
    from vulnerabilities.models import VulnerabilitySettings

    return findings.build(
        tenant, observations(request, tenant),
        vulnerabilities_on=VulnerabilitySettings.objects.filter(pk=1, enabled=True).exists(),
        include_ignored=include_ignored)


def _inventory_rows(request, tenant, *, include_ignored=False):
    """The package inventory's proposals (``discovery.inventory_findings``)."""
    return inventory_findings.build(request, tenant, _inventory_hosts_q(request, tenant),
                                    include_ignored=include_ignored)


def _all_rows(request, tenant, *, include_ignored=False):
    services, inventory = _may(request, tenant)
    rows = _rows(request, tenant, include_ignored=include_ignored) if services else []
    if inventory:
        rows += _inventory_rows(request, tenant, include_ignored=include_ignored)
    return rows


def _public(row: dict) -> dict:
    return {k: v for k, v in row.items() if k != "evidence_key"}


@extend_schema(summary="Discovery findings to review", tags=["discovery"],
               responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def discovery_findings(request):
    """Proposals from current observations: ``service``, ``software`` and
    ``cpe`` (``discovery.findings``, with ``ipaddress`` view), and from the
    package inventory: ``platform``, ``application`` and ``link``
    (``discovery.inventory_findings``, with ``installedsoftware`` view).
    Filters as observed services, plus ``kind`` and ``ignored`` (``true``:
    ignored ones too). ``totals`` counts the open ones by kind."""
    tenant = gate.require(request)
    p = request.query_params
    kinds = [k for k in (p.get("kind") or "").split(",") if k]
    if any(k not in ALL_KINDS for k in kinds):
        raise ValidationError({"kind": f"One of: {', '.join(ALL_KINDS)}."})
    show_ignored = (p.get("ignored") or "").strip().lower() in ("true", "1")
    rows = _all_rows(request, tenant, include_ignored=show_ignored)
    totals = {k: sum(1 for r in rows if r["kind"] == k and not r["ignored"])
              for k in ALL_KINDS}
    if kinds:
        rows = [r for r in rows if r["kind"] in kinds]
    resp = _paginate(request, [_public(r) for r in rows], list)
    resp.data["totals"] = totals
    return resp


def _ids(request) -> list[str]:
    data = request.data if isinstance(request.data, dict) else {}
    ids = data.get("ids")
    if not isinstance(ids, list) or not ids or len(ids) > MAX_IDS \
            or not all(isinstance(i, str) and len(i) < 200 for i in ids):
        raise ValidationError({"ids": f"A list of 1 to {MAX_IDS} finding ids."})
    return ids


def _inventory_host(tenant, row):
    from api.models import Device, VirtualMachine

    model = Device if row["host"]["kind"] == "device" else VirtualMachine
    return model.objects.filter(tenant=tenant, pk=row["host"]["id"]).first()


def _accept_inventory(request, tenant, fid, row) -> dict:
    kind = row["kind"]
    if kind == "platform":
        host = _inventory_host(tenant, row)
        if host is None:
            raise inventory_findings.Refused("Not found.")
        return inventory_findings.accept_platform(request, tenant, row, host)
    if kind == "application":
        return inventory_findings.accept_application(request, tenant, row)
    return inventory_findings.accept_link(request, tenant, row)


@extend_schema(summary="Accept discovery findings", tags=["discovery"],
               request=OpenApiTypes.OBJECT,
               responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def discovery_findings_accept(request):
    """``{ids: [...]}`` of findings: ``service:`` and ``software:`` create the
    Service, or the install (and its application when the tenant has none of
    that name); ``platform:`` puts the host on the platform (creating and
    mapping it as proposed); ``application:`` creates the application with
    its package names; ``link:`` sets an application's package names. Each a
    normal change-logged object. Needs *add* on what is created and *change*
    on what is changed, site scope included; a row the caller may not
    create is refused and nothing of it stays. ``cpe:`` findings are
    accepted through ``POST /api/vulnerabilities/mappings/bulk-create/``.
    Answers ``created`` (``[{finding, kind, id, name}]``) and ``refused``
    (``[{id, reason}]``)."""
    tenant = gate.require(request)
    services, inventory = _may(request, tenant)
    ids = _ids(request)
    user = request.user
    visible, current = {}, set()
    if services:
        oids = [i.split(":", 1)[1] for i in ids if ":" in i and _is_uuid(i.split(":", 1)[1])]
        visible = {str(o.pk): o for o in findings.visible_observations(
            request, tenant).filter(pk__in=oids)}
        current = {r["id"] for r in _rows(request, tenant, include_ignored=True)}
    inv = {}
    if inventory and any(i.partition(":")[0] in inventory_findings.KINDS for i in ids):
        inv = {r["id"]: r for r in _inventory_rows(request, tenant, include_ignored=True)}
    created, refused = [], []
    for fid in ids:
        kind, _sep, oid = fid.partition(":")
        if kind == "cpe":
            refused.append({"id": fid, "reason": "Map products through the vulnerability "
                                                 "mappings bulk create."})
            continue
        if kind in inventory_findings.KINDS:
            row = inv.get(fid)
            if row is None:
                refused.append({"id": fid, "reason": "Not found."})
                continue
            try:
                with transaction.atomic():
                    made = _accept_inventory(request, tenant, fid, row)
            except inventory_findings.Refused as exc:
                refused.append({"id": fid, "reason": str(exc)})
                continue
            created.append({"finding": fid, **made})
            continue
        o = visible.get(oid)
        if kind not in ("service", "software") or o is None or fid not in current:
            refused.append({"id": fid, "reason": "Not found."})
            continue
        slug = "service" if kind == "service" else "installedsoftware"
        if not user.is_superuser and not rbac.has_action(user, tenant, slug, "add"):
            refused.append({"id": fid, "reason": f"{slug}.add required."})
            continue
        try:
            with transaction.atomic():
                made = (findings.accept_service if kind == "service"
                        else findings.accept_software)(request, tenant, o)
        except findings.Refused as exc:
            refused.append({"id": fid, "reason": str(exc)})
            continue
        created.append({"finding": fid, **made})
    return Response({"created": created, "refused": refused})


#: What ignoring an inventory finding needs: what accepting it needs.
INVENTORY_NEEDS = {"application": ("application", "add"), "link": ("application", "change")}


@extend_schema(summary="Ignore discovery findings", tags=["discovery"],
               request=OpenApiTypes.OBJECT,
               responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def discovery_findings_ignore(request):
    """``{ids: [...], ignore: true|false}``: hide findings until their
    evidence changes, or show them again. Needs what accepting would need:
    *add* on services or installed software, *change* on applications for
    ``cpe:`` and ``link:``, *add* on applications for ``application:``,
    *change* on the host for ``platform:``."""
    tenant = gate.require(request)
    services, inventory = _may(request, tenant)
    ids = _ids(request)
    ignore = request.data.get("ignore", True)
    if not isinstance(ignore, bool):
        raise ValidationError({"ignore": "true or false."})
    user = request.user
    rows = {r["id"]: r for r in _rows(request, tenant, include_ignored=True)} if services else {}
    if inventory and any(i.partition(":")[0] in inventory_findings.KINDS for i in ids):
        rows.update({r["id"]: r for r in _inventory_rows(request, tenant,
                                                         include_ignored=True)})
    wanted = {e["observed_id"] for fid in ids if fid in rows for e in rows[fid]["evidence"]}
    obs = {str(o.pk): o for o in findings.visible_observations(request, tenant).filter(
        pk__in=list(wanted))} if wanted else {}
    needs = {"service": ("service", "add"), "software": ("installedsoftware", "add"),
             "cpe": ("application", "change"), **INVENTORY_NEEDS}
    done, refused = [], []
    now = timezone.now()
    for fid in ids:
        row = rows.get(fid)
        if row is None:
            refused.append({"id": fid, "reason": "Not found."})
            continue
        if row["kind"] == "platform":
            slug = "device" if row["host"]["kind"] == "device" else "virtualmachine"
            host = _inventory_host(tenant, row)
            if host is None or not (user.is_superuser or rbac.can_act_on(
                    user, tenant, slug, "change", host)):
                refused.append({"id": fid, "reason": f"{slug}.change required."})
                continue
        else:
            slug, verb = needs[row["kind"]]
            if not user.is_superuser and not rbac.has_action(user, tenant, slug, verb):
                refused.append({"id": fid, "reason": f"{slug}.{verb} required."})
                continue
        if row["kind"] in inventory_findings.KINDS:
            if ignore:
                InventoryFindingDecision.objects.update_or_create(
                    tenant=tenant, key=fid,
                    defaults={"kind": row["kind"], "evidence": row["evidence_key"],
                              "decided_by": user,
                              "decided_by_name": user.get_username()[:150],
                              "decided_at": now})
            else:
                InventoryFindingDecision.objects.filter(tenant=tenant, key=fid).delete()
            done.append(fid)
            continue
        for ev in row["evidence"]:
            o = obs.get(ev["observed_id"])
            if o is None:
                continue
            if ignore:
                FindingDecision.objects.update_or_create(
                    tenant=tenant, observed=o, kind=row["kind"],
                    defaults={"evidence": o.evidence_key(), "decided_by": user,
                              "decided_by_name": user.get_username()[:150],
                              "decided_at": now})
            else:
                FindingDecision.objects.filter(tenant=tenant, observed=o,
                                               kind=row["kind"]).delete()
        done.append(fid)
    return Response({"done": done, "refused": refused})
