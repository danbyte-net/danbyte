"""Tenant endpoints for mappings, matches and priority (#451).

Every endpoint answers 404 while vulnerability data is off and needs an
active tenant. Access follows the objects, not a type of its own:

* a mapping is read with ``view`` and written with ``change`` on its subject
  (the platform, device type or application), row and site scope included;
* a match is visible when its device or VM is (``device`` /
  ``virtualmachine`` view through the caller's restricted querysets) and,
  for an application match, its install is (``installedsoftware`` view) -
  so a site role sees only its own sites' matches;
* the policy is read by anyone who may view devices or VMs and written by a
  tenant admin.

Routes (``vulnerabilities/api_urls.py``):

``vulnerabilities/mappings/``              list, create; ``<id>/`` read,
                                           PATCH, DELETE
``vulnerabilities/matches/``               match rows, filtered
``vulnerabilities/``                       one row per matched record
``vulnerabilities/<vuln id>/``             the record + affected objects
``vulnerabilities/policy/``                GET, PATCH
``vulnerabilities/summary/``               counts
``vulnerabilities/coverage/``              per mapping: what could not match
``devices|virtual-machines|platforms|applications/<id>/vulnerabilities/``
"""
from __future__ import annotations

import uuid
from decimal import Decimal, InvalidOperation

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.db.models import Case, Count, F, IntegerField, Min, Q, Value, When
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api import rbac
from auth_api.permissions import can_manage_admin

from . import list_api, versions
from . import priority as prio
from .identifiers import CPE_PARTS, purl_key, split_cpe
from .models import (
    PRODUCT_KINDS,
    VERSION_SCHEMES,
    Cve,
    CveProduct,
    ProductMapping,
    VulnerabilityMatch,
    VulnerabilityPolicy,
    VulnerabilitySettings,
)

_SCHEMES = tuple(k for k, _ in VERSION_SCHEMES)
_KINDS = tuple(k for k, _ in PRODUCT_KINDS)
_SUBJECTS = {"platform": "platform", "device_type": "devicetype",
             "application": "application"}
_TRUE = ("1", "true", "yes")
_FALSE = ("0", "false", "no")
_RANK = Case(*[When(priority=k, then=Value(v)) for k, v in prio.RANK.items()],
             default=Value(9), output_field=IntegerField())
_CPE_TOKEN_OK = set("abcdefghijklmnopqrstuvwxyz0123456789._-~!%\\+")
_SCORE_DESC = F("cve__cvss_score").desc(nulls_last=True)
AFFECTED_MAX = 1000


# ─── gate, scope ─────────────────────────────────────────────────────────────


def _tenant(request):
    from api.views import _get_active_tenant

    if not VulnerabilitySettings.load().enabled:
        raise NotFound("Vulnerability data is off.")
    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")
    return tenant


def _restricted(model, request, tenant, slug: str, action: str = "view"):
    return rbac.restrict_queryset(model.objects.filter(tenant=tenant), request.user, tenant,
                                  slug, action)


def visible_matches(request, tenant):
    """The tenant's match rows the caller may see."""
    from api.models import Device, InstalledSoftware, VirtualMachine

    qs = VulnerabilityMatch.objects.filter(tenant=tenant)
    if request.user.is_superuser:
        return qs
    devices = _restricted(Device, request, tenant, "device")
    vms = _restricted(VirtualMachine, request, tenant, "virtualmachine")
    installs = _restricted(InstalledSoftware, request, tenant, "installedsoftware")
    return qs.filter(
        Q(device__in=devices.values("pk")) | Q(virtual_machine__in=vms.values("pk"))
    ).filter(Q(installed_software__isnull=True)
             | Q(installed_software__in=installs.values("pk")))


def visible_mappings(request, tenant, action: str = "view"):
    from api.models import Application, DeviceType, Platform

    qs = ProductMapping.objects.filter(tenant=tenant)
    if request.user.is_superuser:
        return qs
    return qs.filter(
        Q(platform__in=_restricted(Platform, request, tenant, "platform", action).values("pk"))
        | Q(device_type__in=_restricted(DeviceType, request, tenant, "devicetype", action)
            .values("pk"))
        | Q(application__in=_restricted(Application, request, tenant, "application", action)
            .values("pk")))


def _can_read_matches(request, tenant) -> bool:
    return any(rbac.has_action(request.user, tenant, s, "view")
               for s in ("device", "virtualmachine"))


# ─── parameters ──────────────────────────────────────────────────────────────


def _values(request, name: str) -> list[str]:
    out: list[str] = []
    for raw in request.query_params.getlist(name):
        out.extend(p.strip() for p in raw.split(",") if p.strip())
    return out[:1000]


def _uuids(request, name: str) -> list[uuid.UUID] | None:
    vals = _values(request, name)
    if not vals:
        return None
    try:
        return [uuid.UUID(v) for v in vals]
    except ValueError:
        raise ValidationError({name: "Not a valid id."}) from None


def _bool(request, name: str) -> bool | None:
    raw = (request.query_params.get(name) or "").strip().lower()
    if not raw:
        return None
    if raw in _TRUE:
        return True
    if raw in _FALSE:
        return False
    raise ValidationError({name: "true or false."})


def _decimal(request, name: str, lo: float, hi: float) -> Decimal | None:
    raw = (request.query_params.get(name) or "").strip()
    if not raw:
        return None
    try:
        d = Decimal(raw)
    except InvalidOperation:
        raise ValidationError({name: f"A number from {lo} to {hi}."}) from None
    if not d.is_finite() or not lo <= d <= hi:
        raise ValidationError({name: f"A number from {lo} to {hi}."})
    return d


def _paginate(request, qs, rows):
    from api.viewsets import StandardPagination

    pager = StandardPagination()
    page = pager.paginate_queryset(qs, request)
    return pager.get_paginated_response(rows(page))


# ─── serialisation ───────────────────────────────────────────────────────────


def _ref(obj, label="name") -> dict | None:
    if obj is None:
        return None
    return {"id": str(obj.pk), "name": getattr(obj, label)}


def cve_brief(c: Cve) -> dict:
    return {
        "vuln_id": c.vuln_id,
        "aliases": c.aliases,
        "summary": c.summary[:300],
        "published": c.published,
        "cvss_version": c.cvss_version,
        "cvss_score": c.cvss_score,
        "cvss_severity": c.cvss_severity,
        "attack_vector": c.attack_vector,
        "kev": c.kev_added is not None,
        "kev_added": c.kev_added,
        "kev_due": c.kev_due,
        "epss": c.epss,
        "epss_percentile": c.epss_percentile,
        "analysed": bool(c.configurations) or bool(c.osv),
    }


def mapping_dict(m: ProductMapping) -> dict:
    return {
        "id": str(m.pk),
        "numid": m.numid,
        "subject_type": m.subject_type,
        "platform": _ref(m.platform),
        "device_type": _ref(m.device_type),
        "application": _ref(m.application),
        "kind": m.kind,
        "part": m.part,
        "vendor": m.vendor,
        "product": m.product,
        "identifier": m.identifier,
        "version_scheme": m.version_scheme,
        "scheme": m.scheme,
        "enabled": m.enabled,
        "coverage": m.coverage,
        "matched_at": m.matched_at,
        "created_at": m.created_at,
        "updated_at": m.updated_at,
    }


def exception_brief(e) -> dict | None:
    if e is None:
        return None
    return {
        "id": str(e.pk),
        "numid": e.numid,
        "status": e.status,
        "scope": e.scope,
        "expires_on": e.expires_on,
        "owner_name": e.owner_name,
    }


def match_dict(r: VulnerabilityMatch) -> dict:
    inst = r.installed_software
    return {
        "id": str(r.pk),
        "cve": cve_brief(r.cve),
        "priority": r.priority,
        "confidence": r.confidence,
        "via": r.via,
        "version": r.version,
        "device": _ref(r.device),
        "virtual_machine": _ref(r.virtual_machine),
        "installed_software": None if inst is None else {
            "id": str(inst.pk), "version": inst.version,
            "application": _ref(inst.application)},
        "mapping": {"id": str(r.mapping_id), "identifier": r.mapping.identifier,
                    "platform": _ref(r.mapping.platform)},
        "exception": exception_brief(r.excepted),
        "first_seen_at": r.first_seen_at,
        "last_seen_at": r.last_seen_at,
        "resolved_at": r.resolved_at,
    }


def _match_rows(qs):
    return qs.select_related("cve", "device", "virtual_machine", "mapping__platform",
                             "installed_software__application", "excepted")


# ─── match filters ───────────────────────────────────────────────────────────


def excepted_mode(request, default: str = "false") -> str:
    """``excepted``: ``false`` (default) leaves out the matches an exception
    covers, ``true`` lists only them, ``all`` both."""
    raw = (request.query_params.get("excepted") or default).strip().lower()
    if raw in _TRUE:
        return "true"
    if raw in _FALSE:
        return "false"
    if raw == "all":
        return "all"
    raise ValidationError({"excepted": "true, false or all."})


def excepted_q(mode: str) -> Q | None:
    if mode == "false":
        return Q(excepted__isnull=True)
    if mode == "true":
        return Q(excepted__isnull=False)
    return None


def _filter_matches(request, qs, *, status_default="open", excepted=True,
                    excepted_default="false"):
    if excepted:
        q = excepted_q(excepted_mode(request, excepted_default))
        if q is not None:
            qs = qs.filter(q)
    status = (request.query_params.get("status") or status_default).strip().lower()
    if status == "open":
        qs = qs.filter(resolved_at__isnull=True)
    elif status == "resolved":
        qs = qs.filter(resolved_at__isnull=False)
    elif status != "all":
        raise ValidationError({"status": "open, resolved or all."})
    for name, field in (("device", "device_id"), ("virtual_machine", "virtual_machine_id"),
                        ("mapping", "mapping_id"), ("platform", "mapping__platform_id"),
                        ("application", "mapping__application_id")):
        ids = _uuids(request, name)
        if ids is not None:
            qs = qs.filter(**{f"{field}__in": ids})
    sites = _uuids(request, "site")
    if sites is not None:
        qs = qs.filter(Q(device__site_id__in=sites) | Q(virtual_machine__site_id__in=sites))
    for name, field, allowed in (
            ("priority", "priority", prio.LEVELS),
            ("confidence", "confidence", ("exact", "range", "partial")),
            ("via", "via", ("platform", "application")),
            ("severity", "cve__cvss_severity", ("critical", "high", "medium", "low", "none"))):
        vals = _values(request, name)
        if vals:
            bad = [v for v in vals if v not in allowed]
            if bad:
                raise ValidationError({name: f"One of: {', '.join(allowed)}."})
            qs = qs.filter(**{f"{field}__in": vals})
    kev = _bool(request, "kev")
    if kev is not None:
        qs = qs.filter(cve__kev_added__isnull=not kev)
    epss_min = _decimal(request, "epss_min", 0, 1)
    if epss_min is not None:
        qs = qs.filter(cve__epss__gte=epss_min)
    cves = _values(request, "cve")
    if cves:
        cq = Q(cve__vuln_id__in=cves)
        for v in cves[:50]:
            cq |= Q(cve__aliases__contains=[v])
        qs = qs.filter(cq)
    q = (request.query_params.get("q") or "").strip()
    if q:
        qs = qs.filter(Q(cve__vuln_id__icontains=q) | Q(cve__summary__icontains=q))
    return qs


# ─── mappings ────────────────────────────────────────────────────────────────


def _clean_cpe_token(value: str, name: str) -> str:
    v = value.strip().lower()
    if not v or v in ("*", "-") or len(v) > 255 or not set(v) <= _CPE_TOKEN_OK:
        raise ValidationError({"identifier": f"The CPE {name} is not valid."})
    return v


def parse_identifier(text: str) -> tuple[str, str, str, str]:
    """``(kind, part, vendor, product)`` of a CPE 2.3 name (full, a template,
    or just ``cpe:2.3:part:vendor:product``) or a package URL."""
    if not isinstance(text, str) or not text.strip():
        raise ValidationError({"identifier": "Give a CPE 2.3 name or a package URL."})
    text = text.strip()
    if text.lower().startswith("pkg:"):
        key = purl_key(text.replace("{", "").replace("}", ""))
        if key is None:
            raise ValidationError({"identifier": "Not a package URL (pkg:type/name)."})
        return "purl", "", key[0], key[1]
    if text.lower().startswith("cpe:2.3:"):
        parts = split_cpe(text)
        if parts is None:
            parts = (text + ":*" * 13).split(":")[:13]
        part = parts[2].lower()
        if part not in CPE_PARTS:
            raise ValidationError({"identifier": "The CPE part is o, a or h."})
        return ("cpe", part, _clean_cpe_token(parts[3], "vendor"),
                _clean_cpe_token(parts[4], "product"))
    raise ValidationError({"identifier": "A CPE starts cpe:2.3:, a package URL pkg:."})


def _subject_template(subject) -> str:
    """The SBOM identifier the subject already carries (0.19)."""
    for field in ("purl_template", "cpe_template"):
        value = getattr(subject, field, "") or ""
        if value:
            return value
    return ""


def _check_kind(subject_type: str, kind: str, part: str) -> None:
    if subject_type == "devicetype":
        if kind != "cpe" or part != "h":
            raise ValidationError({"identifier": "A device type maps to a hardware CPE "
                                                 "(cpe:2.3:h:…)."})
    elif kind == "cpe" and part == "h":
        raise ValidationError({"identifier": "A hardware CPE belongs on a device type."})


def _subject(request, tenant, data, action):
    from api.models import Application, DeviceType, Platform

    given = [f for f in _SUBJECTS if data.get(f)]
    if len(given) != 1:
        raise ValidationError({"subject": "Give exactly one of platform, device_type, "
                                          "application."})
    field = given[0]
    slug = _SUBJECTS[field]
    model = {"platform": Platform, "device_type": DeviceType,
             "application": Application}[field]
    if not rbac.has_action(request.user, tenant, slug, action):
        raise PermissionDenied(f"{slug}.{action} required.")
    try:
        obj = _restricted(model, request, tenant, slug, action).filter(pk=data[field]).first()
    except (ValueError, DjangoValidationError):
        obj = None
    if obj is None:
        raise ValidationError({field: "Not found."})
    return field, obj


def _scheme(data, default="auto") -> str:
    scheme = data.get("version_scheme", default) or "auto"
    if scheme not in _SCHEMES:
        raise ValidationError({"version_scheme": f"One of: {', '.join(_SCHEMES)}."})
    return scheme


def _enabled(data, default=True) -> bool:
    v = data.get("enabled", default)
    if not isinstance(v, bool):
        raise ValidationError({"enabled": "true or false."})
    return v


def _product_from(data, subject) -> tuple[str, str, str, str]:
    if data.get("identifier"):
        return parse_identifier(data["identifier"])
    if data.get("vendor") or data.get("product"):
        kind = data.get("kind") or "cpe"
        if kind not in _KINDS:
            raise ValidationError({"kind": "cpe or purl."})
        if kind == "purl":
            return parse_identifier(f"pkg:{data.get('vendor', '')}/{data.get('product', '')}")
        return parse_identifier(
            f"cpe:2.3:{data.get('part') or 'o'}:{data.get('vendor', '')}:"
            f"{data.get('product', '')}")
    template = _subject_template(subject)
    if not template:
        raise ValidationError({"identifier": "Give a CPE 2.3 name or a package URL; "
                                             f"{subject} has no package URL or CPE."})
    return parse_identifier(template)


def _mutation(request):
    if not isinstance(request.data, dict):
        raise ValidationError({"detail": "A JSON object."})
    return request.data


class ProductMappingViewSet(viewsets.ViewSet):
    """Mappings of the active tenant's platforms, device types and
    applications to CPE products and package URLs. ``POST`` takes one
    subject (``platform``/``device_type``/``application``) and an
    ``identifier`` (``cpe:2.3:o:cisco:ios_xe``, ``pkg:pypi/django``; a full
    CPE or a template is cut to its product); without one, the subject's
    own SBOM package URL or CPE is used. Filters: ``platform``,
    ``device_type``, ``application``, ``kind``, ``enabled``."""

    permission_classes = [IsAuthenticated]

    def _qs(self, request, tenant, action="view"):
        return visible_mappings(request, tenant, action).select_related(
            "platform", "device_type", "application")

    @extend_schema(summary="Product mappings", tags=["vulnerabilities"],
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    def list(self, request):
        tenant = _tenant(request)
        qs = self._qs(request, tenant)
        for name in ("platform", "device_type", "application"):
            ids = _uuids(request, name)
            if ids is not None:
                qs = qs.filter(**{f"{name}_id__in": ids})
        kind = request.query_params.get("kind")
        if kind:
            qs = qs.filter(kind=kind)
        enabled = _bool(request, "enabled")
        if enabled is not None:
            qs = qs.filter(enabled=enabled)
        return _paginate(request, qs.order_by("vendor", "product", "id"),
                         lambda page: [mapping_dict(m) for m in page])

    def _get(self, request, tenant, pk, action="view"):
        try:
            obj = self._qs(request, tenant, action).filter(pk=pk).first()
        except (ValueError, DjangoValidationError):
            obj = None
        if obj is None:
            raise NotFound("Not found.")
        return obj

    @extend_schema(summary="One product mapping", tags=["vulnerabilities"],
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    def retrieve(self, request, pk=None):
        tenant = _tenant(request)
        return Response(mapping_dict(self._get(request, tenant, pk)))

    def _save(self, m: ProductMapping) -> None:
        try:
            with transaction.atomic():
                m.save()
        except IntegrityError:
            raise ValidationError({"identifier": "This product is already mapped here."}) \
                from None

    @extend_schema(summary="Map a subject to a product", tags=["vulnerabilities"],
                   request=OpenApiTypes.OBJECT,
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    def create(self, request):
        tenant = _tenant(request)
        data = _mutation(request)
        field, subject = _subject(request, tenant, data, "change")
        kind, part, vendor, product = _product_from(data, subject)
        _check_kind(_SUBJECTS[field], kind, part)
        m = ProductMapping(tenant=tenant, kind=kind, part=part, vendor=vendor[:128],
                           product=product[:255], version_scheme=_scheme(data),
                           enabled=_enabled(data), **{field: subject})
        self._save(m)
        return Response(mapping_dict(m), status=201)

    @extend_schema(summary="Change a product mapping", tags=["vulnerabilities"],
                   request=OpenApiTypes.OBJECT,
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    def partial_update(self, request, pk=None):
        tenant = _tenant(request)
        data = _mutation(request)
        m = self._get(request, tenant, pk, "change")
        if any(f in data for f in _SUBJECTS):
            raise ValidationError({"subject": "A mapping's subject does not change; "
                                              "delete it and map again."})
        if data.get("identifier") or data.get("vendor") or data.get("product"):
            kind, part, vendor, product = _product_from(data, m.subject)
            _check_kind(m.subject_type, kind, part)
            m.kind, m.part, m.vendor, m.product = kind, part, vendor[:128], product[:255]
        m.version_scheme = _scheme(data, m.version_scheme)
        m.enabled = _enabled(data, m.enabled)
        self._save(m)
        return Response(mapping_dict(m))

    @extend_schema(summary="Remove a product mapping", tags=["vulnerabilities"],
                   responses={204: None})
    def destroy(self, request, pk=None):
        tenant = _tenant(request)
        self._get(request, tenant, pk, "change").delete()
        return Response(status=204)


# ─── matches and records ─────────────────────────────────────────────────────


class VulnerabilityMatchViewSet(viewsets.ViewSet):
    """Match rows of the active tenant the caller may see. Open by default
    (``status=open|resolved|all``). Filters: ``device``, ``virtual_machine``,
    ``platform``, ``application``, ``mapping``, ``site``, ``cve``,
    ``priority``, ``confidence``, ``via``, ``severity``, ``kev``,
    ``epss_min``, ``q``, ``excepted`` (``false`` by default: matches an
    exception covers are left out; ``true``, ``all``). Worst priority first."""

    permission_classes = [IsAuthenticated]

    def _base(self, request, tenant, *, every=False):
        """The filtered matches before the rail. The ``f_excepted`` facet
        (or, with ``every``, the caller) decides on excepted matches; an
        explicit ``excepted`` parameter still works as on every list."""
        explicit = "excepted" in request.query_params
        qs = _filter_matches(request, visible_matches(request, tenant),
                             excepted=explicit and not every)
        return list_api.search(request, qs)

    @extend_schema(summary="Vulnerability matches", tags=["vulnerabilities"],
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    def list(self, request):
        tenant = _tenant(request)
        list_api.table_params(request)
        qs = list_api.apply_facets(request, self._base(request, tenant), list_api.MATCH_FACETS)
        qs = list_api.ordered_matches(_match_rows(qs).annotate(rank=_RANK), request)
        return _paginate(request, qs, lambda page: [match_dict(r) for r in page])

    @extend_schema(summary="Facet counts of the match list", tags=["vulnerabilities"],
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    @action(detail=False, methods=["get"], url_path="facets")
    def facets(self, request):
        """Matches per facet value, each counted over what the other
        filters leave (``vulnerabilities.list_api``)."""
        tenant = _tenant(request)
        counts = list_api.facet_counts(request, self._base(request, tenant),
                                       list_api.MATCH_FACETS, "id", tenant)
        return Response({"facets": counts, "sortable": list(list_api.MATCH_ORDERS)})


def _relevant(request, tenant, cve: Cve) -> bool:
    """A record is shown to a tenant that matched it or maps one of its
    products - the store's content is everyone's mapped products, and one
    tenant must not learn another's from it."""
    if VulnerabilityMatch.objects.filter(tenant=tenant, cve=cve).exists():
        return True
    keys = list(CveProduct.objects.filter(cve=cve).values_list(
        "kind", "part", "vendor", "product"))
    q = Q()
    for kind, part, vendor, product in keys:
        q |= Q(kind=kind, part=part, vendor=vendor, product=product)
    return bool(keys) and ProductMapping.objects.filter(q, tenant=tenant).exists()


def cve_detail(c: Cve, policy) -> dict:
    out = cve_brief(c)
    out.update({
        "summary": c.summary,
        "last_modified": c.last_modified,
        "vuln_status": c.vuln_status,
        "rejected": c.rejected,
        "cvss_vector": c.cvss_vector,
        "cvss_verified": c.cvss_verified,
        "cwes": c.cwes,
        "references": c.references,
        "fixed_in": c.fixed_in,
        "osv_fixed_in": [f for adv in (c.osv or {}).values()
                         for f in adv.get("fixed_in") or []][:200],
        "kev_action": c.kev_action,
        "kev_ransomware": c.kev_ransomware,
        "epss_date": c.epss_date,
        "source": c.source,
        "fetched_at": c.fetched_at,
        "priority": prio.of_cve(c, policy),
    })
    return out


class VulnerabilityViewSet(viewsets.ViewSet):
    """Records matched in the active tenant, one row per record, with the
    devices and VMs affected (the ones the caller may see), the worst
    priority and when it was first seen. Filters as the match list
    (``severity``, ``kev``, ``priority``, ``epss_min``, ``platform``,
    ``application``, ``site``, ``q``, …). ``<vuln id>/`` takes a CVE id, an
    OSV id or an alias."""

    permission_classes = [IsAuthenticated]
    lookup_field = "vuln_id"
    lookup_value_regex = r"[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9._:-]+"

    def _base(self, request, tenant, *, every=False):
        """The filtered matches before the rail. The ``f_excepted`` facet
        (or, with ``every``, the caller) decides on excepted matches; an
        explicit ``excepted`` parameter still works as on every list."""
        explicit = "excepted" in request.query_params
        qs = _filter_matches(request, visible_matches(request, tenant),
                             excepted=explicit and not every)
        return list_api.search(request, qs)

    @extend_schema(summary="Vulnerabilities matched in the tenant", tags=["vulnerabilities"],
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    def list(self, request):
        tenant = _tenant(request)
        list_api.table_params(request)
        # Every match the facets leave, excepted or not: the row counts the
        # live ones and says how many an exception covers.
        qs = list_api.apply_facets(request, self._base(request, tenant, every=True),
                                   list_api.RECORD_FACETS, exclude_excepted=False)
        live = list_api.live_q(request)
        groups = list_api.ordered_records(qs.values("cve_id", "cve__vuln_id").annotate(
            devices=Count("device_id", distinct=True, filter=live),
            virtual_machines=Count("virtual_machine_id", distinct=True, filter=live),
            installs=Count("installed_software_id", distinct=True, filter=live),
            matches=Count("id", filter=live),
            excepted_n=Count("id", filter=Q(excepted__isnull=False)),
            worst=Min(_RANK, filter=live),
            first_seen_at=Min("first_seen_at", filter=live),
            score=Min("cve__cvss_score"),
        ).filter(matches__gt=0), request)

        def rows(page):
            cves = {c.pk: c for c in Cve.objects.filter(pk__in=[g["cve_id"] for g in page])}
            return [{
                "id": cves[g["cve_id"]].vuln_id,
                **cve_brief(cves[g["cve_id"]]),
                "priority": prio.LEVELS[g["worst"]] if g["worst"] < len(prio.LEVELS) else "",
                "devices": g["devices"],
                "virtual_machines": g["virtual_machines"],
                "installs": g["installs"],
                "matches": g["matches"],
                "excepted": g["excepted_n"],
                "first_seen_at": g["first_seen_at"],
            } for g in page if g["cve_id"] in cves]

        return _paginate(request, groups, rows)

    @extend_schema(summary="Facet counts of the record list", tags=["vulnerabilities"],
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    @action(detail=False, methods=["get"], url_path="facets")
    def facets(self, request):
        """Records per facet value, each counted over what the other
        filters leave (``vulnerabilities.list_api``)."""
        tenant = _tenant(request)
        counts = list_api.facet_counts(request, self._base(request, tenant),
                                       list_api.RECORD_FACETS, "cve_id", tenant)
        return Response({"facets": counts, "sortable": list(list_api.RECORD_ORDERS)})

    @extend_schema(summary="One vulnerability with what it affects",
                   tags=["vulnerabilities"],
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    def retrieve(self, request, vuln_id=None):
        tenant = _tenant(request)
        c = Cve.objects.filter(vuln_id=vuln_id).first() \
            or Cve.objects.filter(aliases__contains=[vuln_id]).first()
        if c is None or not _relevant(request, tenant, c):
            raise NotFound("Not found.")
        policy = VulnerabilityPolicy.objects.filter(tenant=tenant).first()
        mode = excepted_mode(request, "all")
        affected = visible_matches(request, tenant).filter(cve=c, resolved_at__isnull=True)
        excepted_count = affected.filter(excepted__isnull=False).count()
        if excepted_q(mode) is not None:
            affected = affected.filter(excepted_q(mode))
        affected = _match_rows(affected).order_by("device__name", "virtual_machine__name")
        total = affected.count()
        out = cve_detail(c, policy)
        out["affected_count"] = total
        out["excepted_count"] = excepted_count
        out["affected"] = [match_dict(r) for r in affected[:AFFECTED_MAX]]
        return Response(out)


# ─── per object ──────────────────────────────────────────────────────────────

_OBJECTS = {
    "device": ("api.Device", "device", "device_id"),
    "virtual_machine": ("api.VirtualMachine", "virtualmachine", "virtual_machine_id"),
    "platform": ("api.Platform", "platform", "mapping__platform_id"),
    "application": ("api.Application", "application", "mapping__application_id"),
}


def object_vulnerabilities(request, kind: str, pk):
    from django.apps import apps

    tenant = _tenant(request)
    label, slug, field = _OBJECTS[kind]
    model = apps.get_model(label)
    obj = _restricted(model, request, tenant, slug).filter(pk=pk).first()
    if obj is None:
        raise NotFound("Not found.")
    qs = _filter_matches(request, visible_matches(request, tenant).filter(**{field: obj.pk}))
    qs = _match_rows(qs).annotate(rank=_RANK).order_by(
        "rank", _SCORE_DESC, "cve__vuln_id", "id")
    return _paginate(request, qs, lambda page: [match_dict(r) for r in page])


def _object_view(kind: str):
    @extend_schema(summary=f"Vulnerabilities of one {kind.replace('_', ' ')}",
                   tags=["vulnerabilities"],
                   responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
    @api_view(["GET"])
    @permission_classes([IsAuthenticated])
    def view(request, pk):
        return object_vulnerabilities(request, kind, pk)

    view.__name__ = f"{kind}_vulnerabilities"
    return view


device_vulnerabilities = _object_view("device")
virtual_machine_vulnerabilities = _object_view("virtual_machine")
platform_vulnerabilities = _object_view("platform")
application_vulnerabilities = _object_view("application")


# ─── policy, summary, coverage ───────────────────────────────────────────────

_POLICY_DECIMALS = {
    "fix_first_epss": (0, 1, "0.00001"),
    "fix_first_cvss": (0, 10, "0.1"),
    "high_cvss": (0, 10, "0.1"),
    "high_epss": (0, 1, "0.00001"),
    "high_epss_cvss": (0, 10, "0.1"),
    "medium_cvss": (0, 10, "0.1"),
}
_NOTIFY = ("fix_first", "critical", "kev")


def policy_dict(p: VulnerabilityPolicy, *, can_change: bool) -> dict:
    return {
        "kev_is_fix_first": p.kev_is_fix_first,
        **{f: getattr(p, f) for f in _POLICY_DECIMALS},
        "notify_on": p.notify_on,
        "notify_enabled": p.notify_enabled,
        "updated_at": p.updated_at,
        "can_change": can_change,
    }


@extend_schema(summary="The tenant's vulnerability priority policy", tags=["vulnerabilities"],
               request=OpenApiTypes.OBJECT,
               responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticated])
def vulnerability_policy(request):
    """Thresholds (decision 12). Read by anyone who may view devices or VMs;
    changed by a tenant admin. A change re-prioritises the open matches."""
    tenant = _tenant(request)
    admin = can_manage_admin(request.user, tenant)
    if not admin and not _can_read_matches(request, tenant):
        raise PermissionDenied("device.view or virtualmachine.view required.")
    policy = VulnerabilityPolicy.for_tenant(tenant)
    if request.method == "GET":
        return Response(policy_dict(policy, can_change=admin))
    if not admin:
        raise PermissionDenied("Tenant admin required.")
    data = _mutation(request)
    errors = {}
    for f, (lo, hi, places) in _POLICY_DECIMALS.items():
        if f not in data:
            continue
        try:
            d = Decimal(str(data[f]))
        except (InvalidOperation, ValueError):
            d = None
        if isinstance(data[f], bool) or d is None or not d.is_finite() or not lo <= d <= hi:
            errors[f] = f"A number from {lo} to {hi}."
            continue
        setattr(policy, f, d.quantize(Decimal(places)))
    for f in ("kev_is_fix_first", "notify_enabled"):
        if f in data:
            if isinstance(data[f], bool):
                setattr(policy, f, data[f])
            else:
                errors[f] = "true or false."
    if "notify_on" in data:
        v = data["notify_on"]
        if not isinstance(v, list) or any(x not in _NOTIFY for x in v):
            errors["notify_on"] = f"A list of: {', '.join(_NOTIFY)}."
        else:
            policy.notify_on = sorted(set(v), key=_NOTIFY.index)
    if errors:
        return Response(errors, status=400)
    policy.save()
    return Response(policy_dict(policy, can_change=True))


@extend_schema(summary="Vulnerability counts for the tenant", tags=["vulnerabilities"],
               responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def vulnerability_summary(request):
    """Open matches the caller may see that no exception covers: records
    per priority, KEV and critical records, records new this week, and the
    devices and VMs affected; plus how many matches (``excepted``) and
    records (``excepted_records``) exceptions cover."""
    tenant = _tenant(request)
    every = visible_matches(request, tenant).filter(resolved_at__isnull=True)
    qs = every.filter(excepted__isnull=True)
    by_priority = dict(qs.values_list("priority").annotate(n=Count("cve_id", distinct=True)))
    week = list_api.first_seen_q("7d")
    totals = qs.aggregate(
        records=Count("cve_id", distinct=True),
        devices=Count("device_id", distinct=True),
        virtual_machines=Count("virtual_machine_id", distinct=True),
        matches=Count("id"),
        kev=Count("cve_id", distinct=True, filter=Q(cve__kev_added__isnull=False)),
        critical=Count("cve_id", distinct=True, filter=Q(cve__cvss_severity="critical")),
        # Records with a match that appeared in the last 7 days - the list's
        # ``first_seen=7d`` facet counts the same.
        new_this_week=Count("cve_id", distinct=True, filter=week),
    )
    ex = every.filter(excepted__isnull=False).aggregate(
        n=Count("id"), records=Count("cve_id", distinct=True))
    return Response({**totals, "excepted": ex["n"], "excepted_records": ex["records"],
                     "by_priority": {k: by_priority.get(k, 0) for k in prio.LEVELS}})


def _host_versions(request, tenant, m: ProductMapping) -> tuple[list[str], int]:
    """``(versions, hosts)`` of the objects a mapping tests, as the caller
    sees them: hosts on a platform, installs of an application."""
    from api.models import Device, InstalledSoftware, VirtualMachine

    if m.platform_id:
        devs = _restricted(Device, request, tenant, "device").filter(
            Q(platform_id=m.platform_id)
            | Q(platform__isnull=True, device_type__platform_id=m.platform_id))
        vms = _restricted(VirtualMachine, request, tenant, "virtualmachine").filter(
            platform_id=m.platform_id)
        vals = list(devs.values_list("software_version", flat=True)) + list(
            vms.values_list("software_version", flat=True))
        return vals, len(vals)
    if m.application_id:
        vals = list(_restricted(InstalledSoftware, request, tenant, "installedsoftware")
                    .filter(application_id=m.application_id)
                    .values_list("version", flat=True))
        return vals, len(vals)
    n = _restricted(Device, request, tenant, "device").filter(
        device_type_id=m.device_type_id).count()
    return [], n


@extend_schema(summary="What each mapping could and could not match",
               tags=["vulnerabilities"],
               responses=OpenApiResponse(response=OpenApiTypes.OBJECT))
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def vulnerability_coverage(request):
    """Per mapping the caller may view (filters ``platform``,
    ``device_type``, ``application``): the objects it tests, how many
    matched, how many have no version or one its scheme cannot read; and
    from the last recompute, the records it could not decide (bounds that do
    not parse, ranges in an ecosystem without an ordering)."""
    tenant = _tenant(request)
    qs = visible_mappings(request, tenant).select_related(
        "platform", "device_type", "application")
    for name in ("platform", "device_type", "application"):
        ids = _uuids(request, name)
        if ids is not None:
            qs = qs.filter(**{f"{name}_id__in": ids})
    qs = list(qs.order_by("vendor", "product", "id")[:500])
    matched = dict(
        visible_matches(request, tenant).filter(resolved_at__isnull=True, mapping__in=qs)
        .values_list("mapping_id").annotate(
            n=Count("device_id", distinct=True) + Count("virtual_machine_id", distinct=True)))
    out = []
    for m in qs:
        vals, total = _host_versions(request, tenant, m)
        blank = sum(1 for v in vals if not (v or "").strip())
        scheme = m.scheme
        unread = sum(1 for v in vals if (v or "").strip()
                     and versions.parse(v.strip(), scheme) is None)
        out.append({
            "mapping": mapping_dict(m),
            "objects": total,
            "matched": matched.get(m.pk, 0),
            "blank_version": blank,
            "version_not_understood": unread,
            "records": m.coverage or {},
        })
    return Response({"results": out})
