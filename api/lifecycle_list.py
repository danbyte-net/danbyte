"""``GET /api/lifecycle/`` - the Lifecycle page (#436), a page at a time (#535).

The rows are :class:`~api.models.LifecycleEntry` (a database view naming
which rows exist); every name, date and mapping is joined at read and the
effective dates, days left, window and status are worked out in SQL by the
rules ``api.lifecycle_api`` documents (``compliance.eol.effective_dates``,
``date_status``, ``api.support_coverage``), against today and the
settings. So the list pages, sorts, filters and counts its facets in the
database with the contract of ``api.list_table``, instead of building every
row of the tenant in Python on every visit.

* ``ordering``: ``object``, ``kind``, ``source``, ``item``, ``application``,
  ``status``, ``lifetime`` / ``end`` / ``days_left`` (soonest first),
  ``window``, ``site``, ``tenant``, ``role``, ``manufacturer``. The default
  is the old order: window, days left, name, source.
* ``f_<facet>``: ``kind``, ``source``, ``application``, ``status``,
  ``window`` (``past``, ``90``, ``180``, ``365``, ``later``, ``none``),
  ``site``, ``role``, ``manufacturer``, ``tags``; ``search`` matches the
  object's and the item's name.
* ``source=`` (comma-separated), ``site=`` (a UUID) and ``undated=1`` as
  before: without ``undated`` the rows with no end date are left out (and
  still counted by ``summary/``).

``GET /api/lifecycle/summary/`` answers the window chips: ``{counts,
windows, eol_enabled}`` over every row the caller may see (``source`` and
``site`` apply, the rail does not).

Every source is cut to what the caller may view, as before: devices and VMs
through their row restriction (site scope included), installs through
theirs and only on a device or VM the caller may view; a source whose type
the caller cannot view is left out. A contract's number and start show only
on a contract the caller may view.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

from django.contrib.contenttypes.models import ContentType
from django.db.models import (
    BooleanField,
    Case,
    CharField,
    Count,
    DateField,
    F,
    Func,
    IntegerField,
    OuterRef,
    Q,
    Subquery,
    Value,
    When,
)
from django.db.models.functions import Cast, Coalesce, Greatest
from django.utils import timezone
from rest_framework import serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api import rbac
from compliance.eol import config_for
from core.models import Tag, TaggedItem

from . import support_coverage as cov
from .list_table import Facet, Sort, TableListMixin, TableSpec, group_count
from .models import (
    Device,
    InstalledSoftware,
    LifecycleEntry,
    SupportContract,
    VirtualMachine,
)
from .natural import natural
from .pagination import StandardResultsSetPagination
from .views import _get_active_tenant

SOURCES = ("hardware", "os", "coverage", "software")
WINDOWS = ("past", "d90", "d180", "y1", "later", "none")
#: A window's facet value - also its URL param (``/lifecycle?window=90``).
WINDOW_PARAMS = {"past": "past", "d90": "90", "d180": "180", "y1": "365",
                 "later": "later", "none": "none"}
SOURCE_LABELS = {"hardware": "Hardware", "os": "OS", "coverage": "Coverage",
                 "software": "Software"}
KIND_LABELS = {"device": "Device", "virtualmachine": "VM"}
STATUS_LABELS = {
    "supported": "Supported", "ending": "Support ending", "eol": "End of life",
    "unknown": "Unknown", "covered": "Covered", "expiring": "Expiring",
    "expired": "Expired", "none": "Not covered",
}
_FAR = 10 ** 9


def _is(source: str, kind: str | None = None) -> Q:
    q = Q(source=source)
    return q & Q(kind=kind) if kind else q


class _Ctx:
    """What one request's rows are worked out against."""

    def __init__(self, request):
        tenant = _get_active_tenant(request)
        self.tenant = tenant
        self.today = timezone.localdate()
        self.eol = config_for(request)
        self.coverage_days = cov.warning_days_for(request, tenant)

    @classmethod
    def of(cls, request) -> _Ctx:
        got = getattr(request, "_lifecycle_ctx", None)
        if got is None:
            got = cls(request)
            try:
                request._lifecycle_ctx = got
            except AttributeError:
                pass
        return got


def _days(expr, today):
    return Func(expr, Value(today, output_field=DateField()), function="", arg_joiner=" - ",
                template="(%(expressions)s)", output_field=IntegerField())


def annotate(qs, request):
    """Everything a row shows, sorts and filters by, in SQL."""
    if "lc_window" in qs.query.annotations:
        return qs
    c = _Ctx.of(request)
    today = c.today
    date = DateField()
    qs = qs.annotate(_e_start=F("entered_start"), _e_end=F("entered_end"))
    if c.eol.enabled:
        qs = qs.annotate(
            _m_synced=F("mapping__synced_at"),
            _m_release=F("mapping__release_date"),
            _m_eol=F("mapping__eol_date"),
            _m_reached=F("mapping__eol_reached"),
            _m_source=F("mapping__source"),
        )
        m_ok = Q(_m_synced__isnull=False)
        m_end = m_ok & (Q(_m_eol__isnull=False) | Q(_m_reached__isnull=False))
        m_start = m_ok & Q(_m_release__isnull=False)
    else:
        qs = qs.annotate(_m_release=Cast(Value(None), date),
                         _m_eol=Cast(Value(None), date),
                         _m_reached=Cast(Value(None), BooleanField()),
                         _m_source=Cast(Value(None), CharField()))
        m_end = m_start = Q(pk__in=[])
    qs = qs.annotate(
        _cov_contract_end=F("cov_contract_end"),
        _cov_contract=F("cov_contract_id"),
        _cov_warranty=F("warranty_end"),
    ).annotate(
        _cov_raw=Greatest(F("_cov_contract_end"), F("_cov_warranty"), output_field=date),
    )
    end = Case(
        When(_is("coverage") & Q(_cov_raw=cov.OPEN_ENDED), then=Value(None, output_field=date)),
        When(_is("coverage"), then=F("_cov_raw")),
        When(_e_end__isnull=False, then=F("_e_end")),
        When(m_end, then=F("_m_eol")),
        default=None, output_field=date,
    )
    # Cast: a CASE whose branches are all NULL is text to PostgreSQL.
    reached = Cast(Case(
        When(_is("coverage") | Q(_e_end__isnull=False), then=Value(None)),
        When(m_end & Q(_m_eol__isnull=True), then=F("_m_reached")),
        default=None, output_field=BooleanField(),
    ), output_field=BooleanField())
    start = Case(
        When(_is("coverage"), then=Value(None, output_field=date)),
        When(_e_start__isnull=False, then=F("_e_start")),
        When(m_start, then=F("_m_release")),
        default=None, output_field=date,
    )
    date_source = Case(
        When(_is("coverage") | _is("hardware"), then=Value(None)),
        When(_e_end__isnull=False, then=Value("entered")),
        When(m_end, then=F("_m_source")),
        When(_e_start__isnull=False, then=Value("entered")),
        When(m_start, then=F("_m_source")),
        default=None, output_field=CharField(),
    )
    qs = qs.annotate(lc_end=end, lc_reached=reached, lc_start=start,
                     lc_date_source=date_source)
    qs = qs.annotate(lc_days=_days(F("lc_end"), today))
    past = (_is("coverage") & Q(lc_end__lt=today)) | (~_is("coverage") & Q(lc_end__lte=today))
    window = Case(
        When(Q(lc_end__isnull=True) & _is("coverage") & Q(_cov_raw=cov.OPEN_ENDED),
             then=Value("later")),
        When(Q(lc_end__isnull=True) & _is("coverage"), then=Value("none")),
        When(Q(lc_end__isnull=True) & Q(lc_reached=True), then=Value("past")),
        When(Q(lc_end__isnull=True) & Q(lc_reached=False), then=Value("later")),
        When(lc_end__isnull=True, then=Value("none")),
        When(past, then=Value("past")),
        When(lc_days__lte=90, then=Value("d90")),
        When(lc_days__lte=180, then=Value("d180")),
        When(lc_days__lte=365, then=Value("y1")),
        default=Value("later"), output_field=CharField(),
    )
    eol_edge = today + timedelta(days=c.eol.warning_days)
    cov_edge = today + timedelta(days=c.coverage_days)
    status = Case(
        When(_is("coverage") & Q(_cov_raw__isnull=True), then=Value("none")),
        When(_is("coverage") & Q(_cov_raw__lt=today), then=Value("expired")),
        When(_is("coverage") & Q(_cov_raw__lte=cov_edge), then=Value("expiring")),
        When(_is("coverage"), then=Value("covered")),
        When(lc_end__lte=today, then=Value("eol")),
        When(lc_end__lte=eol_edge, then=Value("ending")),
        When(lc_end__isnull=False, then=Value("supported")),
        When(lc_reached=True, then=Value("eol")),
        When(lc_reached=False, then=Value("supported")),
        default=Value("unknown"), output_field=CharField(),
    )
    qs = qs.annotate(lc_window=window, lc_status=status)
    rank = Case(*[When(lc_window=w, then=Value(i)) for i, w in enumerate(WINDOWS)],
                output_field=IntegerField())
    days_sort = Case(
        When(lc_days__isnull=False, then=F("lc_days")),
        When(lc_window="past", then=Value(-_FAR)),
        When(lc_window="later", then=Value(_FAR)),
        default=Value(_FAR + 1), output_field=IntegerField(),
    )
    governed = Case(
        When(Q(_cov_contract_end__isnull=False) & (
            Q(_cov_warranty__isnull=True) | Q(_cov_contract_end__gte=F("_cov_warranty"))),
            then=Value("contract")),
        When(_cov_warranty__isnull=False, then=Value("warranty")),
        default=None, output_field=CharField(),
    )
    visible = _visible_contracts(request, c.tenant)
    contract_number = Subquery(
        visible.filter(pk=OuterRef("_cov_contract")).values("contract_number")[:1])
    qs = qs.annotate(
        lc_window_rank=rank, lc_days_sort=days_sort, lc_governed=governed,
        lc_window_param=Case(*[When(lc_window=w, then=Value(p))
                               for w, p in WINDOW_PARAMS.items()], output_field=CharField()),
        lc_source_rank=Case(*[When(source=s, then=Value(i)) for i, s in enumerate(SOURCES)],
                            output_field=IntegerField()),
        lc_name=F("name"),
        lc_site=F("site_id"),
        lc_site_name=F("site__name"),
        lc_role=F("role_id"),
        lc_role_name=F("role__name"),
        lc_role_color=F("role__color"),
        lc_mfr=F("manufacturer_id"),
        lc_mfr_name=F("manufacturer__name"),
        lc_app=F("application_id"),
        lc_app_name=F("application__name"),
    )
    qs = qs.annotate(lc_contract_number=Case(
        When(lc_governed="contract", then=contract_number), default=None,
        output_field=CharField()))
    item = Case(
        When(_is("coverage") & Q(lc_governed="contract"),
             then=Coalesce(F("lc_contract_number"), Value("Contract"))),
        When(_is("coverage") & Q(lc_governed="warranty"), then=Value("Warranty")),
        When(_is("coverage"), then=Value(None)),
        default=F("item_name"), output_field=CharField(),
    )
    return qs.annotate(lc_item=item, lc_status_label=Case(
        *[When(lc_status=k, then=Value(v)) for k, v in STATUS_LABELS.items()],
        output_field=CharField()),
        lc_source_label=Case(*[When(source=k, then=Value(v)) for k, v in SOURCE_LABELS.items()],
                             output_field=CharField()),
        lc_kind_label=Case(*[When(kind=k, then=Value(v)) for k, v in KIND_LABELS.items()],
                           output_field=CharField()))


def _visible_contracts(request, tenant):
    if tenant is None or not rbac.has_action(request.user, tenant, "supportcontract", "view"):
        return SupportContract.objects.none()
    return rbac.restrict_queryset(SupportContract.objects.filter(tenant=tenant), request.user,
                                  tenant, "supportcontract", "view")


def _tag_ids(model, slugs):
    return TaggedItem.objects.filter(
        content_type=ContentType.objects.get_for_model(model), tag__slug__in=slugs
    ).values("object_id")


def _tag_filter(qs, request, wanted):
    return qs.filter(Q(device_id__in=_tag_ids(Device, wanted))
                     | Q(virtual_machine_id__in=_tag_ids(VirtualMachine, wanted)))


def _tag_count(qs, request, selected):
    from .list_table import _by_count, _cap, _text_color

    merged: dict = {}
    for model, path in ((Device, "device_id"), (VirtualMachine, "virtual_machine_id")):
        rows = qs.order_by().filter(**{f"{path}__isnull": False})
        items = TaggedItem.objects.filter(
            content_type=ContentType.objects.get_for_model(model),
            object_id__in=rows.values(path))
        # A row per (row, tag): the rows of one object share its tags.
        per_object = dict(rows.values(path).annotate(n=Count("pk")).values_list(path, "n"))
        for oid, tid, slug, name, color in items.values_list(
                "object_id", "tag_id", "tag__slug", "tag__name", "tag__color"):
            got = merged.setdefault(slug, {"value": slug, "label": name, "count": 0,
                                           "color": color or None,
                                           "text_color": _text_color(color), "id": tid})
            got["count"] += per_object.get(oid, 0)
    return _cap(_by_count(merged.values()), selected)


def _prep(qs, request):
    return annotate(qs, request)


def _s(*keys) -> Sort:
    return Sort(keys, prepare=_prep)


SPEC = TableSpec(
    facets={
        "kind": Facet(field="kind", labels=KIND_LABELS),
        "source": Facet(field="source", labels=SOURCE_LABELS),
        "application": Facet(field="lc_app", label="lc_app_name", prepare=_prep, uuid=True),
        "status": Facet(field="lc_status", prepare=_prep, labels=STATUS_LABELS),
        "window": Facet(field="lc_window_param", prepare=_prep, labels={
            "past": "Past", "90": "≤ 90 d", "180": "≤ 180 d", "365": "≤ 1 y",
            "later": "Later", "none": "No date"}),
        "site": Facet(field="lc_site", label="lc_site_name", prepare=_prep, uuid=True,
                      none_label="No site"),
        "role": Facet(field="lc_role", label="lc_role_name", color="lc_role_color",
                      prepare=_prep, uuid=True, none_label="No role"),
        "manufacturer": Facet(field="lc_mfr", label="lc_mfr_name", prepare=_prep, uuid=True,
                              none_label="No manufacturer"),
        "tags": Facet(kind="custom", filter_fn=_tag_filter, count_fn=_tag_count),
    },
    sorts={
        "object": _s(natural("lc_name")),
        "kind": _s("lc_kind_label"),
        "source": _s("lc_source_label"),
        "item": _s(natural("lc_item")),
        "application": _s(natural("lc_app_name")),
        "status": _s("lc_status_label"),
        "lifetime": _s("lc_days_sort"),
        "end": _s("lc_days_sort"),
        "days_left": _s("lc_days_sort"),
        "window": _s("lc_window_rank"),
        "site": _s(natural("lc_site_name")),
        "tenant": _s("tenant__name"),
        "role": _s(natural("lc_role_name")),
        "manufacturer": _s(natural("lc_mfr_name")),
    },
    expr_fields={
        "object.name": ("text", "lc_name"),
        "object.kind": ("text", "kind"),
        "source": ("text", "source"),
        "item.name": ("text", "lc_item"),
        "status": ("text", "lc_status"),
        "window": ("text", "lc_window"),
        "end": ("date", "lc_end"),
        "start": ("date", "lc_start"),
        "days_left": ("number", "lc_days"),
        "site.name": ("text", "lc_site_name"),
        "role.name": ("text", "lc_role_name"),
        "manufacturer.name": ("text", "lc_mfr_name"),
    },
    expr_prepare=_prep,
)


def _parse_sources(raw: str | None) -> list[str]:
    wanted = [s.strip() for s in (raw or "").split(",") if s.strip()]
    bad = [s for s in wanted if s not in SOURCES]
    if bad:
        raise ValidationError({"source": f"One of {', '.join(SOURCES)}."})
    return wanted or list(SOURCES)


def _parse_site(raw: str | None):
    if not raw:
        return None
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise ValidationError({"site": "A valid UUID."}) from None


def scoped(request, tenant):
    """The tenant's rows the caller may see, by the source's own grants."""
    user = request.user
    qs = LifecycleEntry.objects.filter(tenant=tenant)
    params = request.query_params
    sources = _parse_sources(params.get("source"))
    site = _parse_site(params.get("site"))

    def visible(model, slug):
        if not rbac.has_action(user, tenant, slug, "view"):
            return None
        return rbac.restrict_queryset(model.objects.filter(tenant=tenant), user, tenant, slug,
                                      "view").values("pk")

    devices = visible(Device, "device")
    vms = visible(VirtualMachine, "virtualmachine")
    allowed = Q(pk__in=[])
    device_sources = [s for s in sources if s in ("hardware", "os", "coverage")]
    if devices is not None and device_sources:
        allowed |= Q(kind="device", source__in=device_sources, device_id__in=devices)
    if vms is not None and "os" in sources:
        allowed |= Q(kind="virtualmachine", source="os", virtual_machine_id__in=vms)
    installs = visible(InstalledSoftware, "installedsoftware")
    if installs is not None and "software" in sources:
        parents = Q(pk__in=[])
        if devices is not None:
            parents |= Q(device_id__in=devices)
        if vms is not None:
            parents |= Q(virtual_machine_id__in=vms)
        allowed |= Q(source="software", install_id__in=installs) & parents
    qs = qs.filter(allowed)
    if site:
        qs = qs.filter(site_id=site)
    return qs


class _NoFields(serializers.Serializer):
    class Meta:
        fields = ()


class LifecycleViewSet(TableListMixin, viewsets.GenericViewSet):
    permission_classes = [IsAuthenticated]
    pagination_class = StandardResultsSetPagination
    queryset = LifecycleEntry.objects.all()
    filter_backends: list = []
    table_spec = SPEC

    def get_serializer_class(self):
        return _NoFields

    def table_sortable(self) -> list[str]:
        return list(self.table_spec.sorts)

    def _tenant(self):
        from rest_framework.exceptions import PermissionDenied

        tenant = _get_active_tenant(self.request)
        if tenant is None:
            raise PermissionDenied("No active tenant.")
        return tenant

    def get_queryset(self):
        request = self.request
        qs = annotate(scoped(request, self._tenant()), request)
        if request.query_params.get("undated") not in ("1", "true"):
            qs = qs.exclude(lc_window="none")
        needle = (request.query_params.get("search") or "").strip()
        if needle:
            qs = qs.filter(Q(lc_name__icontains=needle[:200]) | Q(lc_item__icontains=needle[:200]))
        return qs.order_by("lc_window_rank", "lc_days_sort", natural("lc_name"),
                           "lc_source_rank", "pk")

    def list(self, request, *args, **kwargs):
        qs = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(qs)
        return self.get_paginated_response(_rows(request, self._tenant(), page or []))

    @action(detail=False, methods=["get"], url_path="summary")
    def summary(self, request):
        """The window chips: every row the caller may see, by window."""
        tenant = self._tenant()
        c = _Ctx.of(request)
        counts = dict.fromkeys(WINDOWS, 0)
        rows = annotate(scoped(request, tenant), request).order_by().values("lc_window")
        for window, n in group_count(rows, "lc_window"):
            counts[window] = n
        return Response({
            "counts": counts,
            "windows": {"eol_warning_days": c.eol.warning_days,
                        "coverage_warning_days": c.coverage_days},
            "eol_enabled": c.eol.enabled,
        })


_WARRANTY = {"type": "warranty", "id": None, "name": "Warranty"}
_HIDDEN_CONTRACT = {"type": "supportcontract", "id": None, "name": "Contract"}


def _rows(request, tenant, page) -> list[dict]:
    """The page's rows in the shape the page has always read."""
    tags: dict = {}
    # One query for the page's tags, devices and VMs alike.
    tagged = Q(pk__in=[])
    for model, ids in (
        (Device, {e.device_id for e in page if e.device_id}),
        (VirtualMachine, {e.virtual_machine_id for e in page if e.virtual_machine_id}),
    ):
        if ids:
            tagged |= Q(content_type=ContentType.objects.get_for_model(model), object_id__in=ids)
    for oid, tid, name, slug, color in TaggedItem.objects.filter(tagged).order_by(
            "tag__name").values_list("object_id", "tag_id", "tag__name", "tag__slug",
                                     "tag__color"):
        tags.setdefault(oid, []).append({"id": tid, "name": name, "slug": slug,
                                         "color": color,
                                         "text_color": Tag(color=color).text_color})
    contract_ids = {e._cov_contract for e in page if e.lc_governed == "contract"
                    and e._cov_contract}
    contracts = {c["id"]: c for c in _visible_contracts(request, tenant).filter(
        pk__in=contract_ids).values("id", "contract_number", "start_date")} if contract_ids else {}
    tenant_ref = {"id": str(tenant.pk), "name": tenant.name}
    out = []
    for e in page:
        oid = e.device_id or e.virtual_machine_id
        start = e.lc_start
        if e.source == "hardware":
            item = {"id": str(e.item_id), "type": "devicetype", "name": e.lc_item}
        elif e.source == "os":
            item = {"type": "platform", "id": str(e.item_id), "name": e.lc_item,
                    "date_source": e.lc_date_source}
        elif e.source == "software":
            item = {"type": "application", "id": str(e.item_id), "name": e.lc_item,
                    "application": e.lc_app_name, "version": e.version,
                    "install": str(e.install_id), "date_source": e.lc_date_source}
        elif e.lc_governed == "warranty":
            item = _WARRANTY
        elif e.lc_governed == "contract":
            c = contracts.get(e._cov_contract)
            item = ({"id": str(c["id"]), "type": "supportcontract",
                     "name": c["contract_number"]} if c else _HIDDEN_CONTRACT)
            start = c["start_date"] if c else None
        else:
            item = None
        out.append({
            "object": {"id": str(oid), "name": e.lc_name, "kind": e.kind},
            "site": {"id": str(e.lc_site), "name": e.lc_site_name} if e.lc_site else None,
            "role": ({"id": str(e.lc_role), "name": e.lc_role_name, "color": e.lc_role_color}
                     if e.lc_role else None),
            "tenant": tenant_ref,
            "manufacturer": ({"id": str(e.lc_mfr), "name": e.lc_mfr_name}
                             if e.lc_mfr else None),
            "tags": tags.get(oid, []),
            "source": e.source,
            "item": item,
            "status": e.lc_status,
            "start": start.isoformat() if start else None,
            "end": e.lc_end.isoformat() if e.lc_end else None,
            "days_left": e.lc_days,
            "window": e.lc_window,
            "id": e.pk,
        })
    return out
