"""Filtering and shaping for the status-history and statuses lists.

One set of target filters - site, region, device type, VLAN, tag, port and
the rest - shared by the transitions list and the checks list, so the two
rails offer the same dimensions and mean the same thing by them. Both rows
hang off ``target_ip``, which is where every dimension is reached from.

Facet counts are computed with every filter *except* the dimension's own
applied, so a multi-select within one facet keeps its other options
non-zero, and the numbers answer "how many if I also tick this" rather than
"how many in the whole table".
"""
from __future__ import annotations

from datetime import timedelta

from django.db.models import Count, F, Q, UUIDField
from django.db.models.functions import Coalesce, TruncDay, TruncHour
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .engines import STAMPED_SOURCE_EXPR
from .models import CheckStatus

#: The dimensions a rail can count, and how each is grouped.
FACET_FIELDS = {
    "kind": "kind",
    "source": "source",
    "site": "_site",
    "device_type": "target_ip__assigned_device__device_type_id",
    "role": "target_ip__assigned_device__role_id",
    "platform": "target_ip__assigned_device__platform_id",
    "template": "template_id",
    "engine": "engine_id",
}

#: The site an address is *at* - its own, else its prefix's, else its
#: device's - so the site facet counts what the site filter matches.
SITE_EXPR = Coalesce(
    F("target_ip__site_id"),
    F("target_ip__prefix__site_id"),
    F("target_ip__assigned_device__site_id"),
    output_field=UUIDField(),
)

#: Labels for facet ids, read once per request rather than once per bucket.
_LABEL_MODELS = {
    "site": ("api", "Site", "name"),
    "device_type": ("api", "DeviceType", "model"),
    "role": ("api", "DeviceRole", "name"),
    "platform": ("api", "Platform", "name"),
    "template": ("monitoring", "CheckTemplate", "name"),
    "engine": ("monitoring", "MonitoringEngine", "name"),
}

PAGE_SIZE_DEFAULT = 50
PAGE_SIZE_MAX = 200
DAYS_DEFAULT = 7
DAYS_MAX = 365


def _csv(params, key) -> list[str]:
    raw = params.get(key) or ""
    return [v.strip() for v in raw.split(",") if v.strip()]


def _many(params, key) -> list[str]:
    """A repeatable param (``?tag=a&tag=b``) or a CSV, whichever was sent."""
    values = []
    getlist = getattr(params, "getlist", None)
    for raw in (getlist(key) if getlist else [params.get(key) or ""]):
        values.extend(v.strip() for v in (raw or "").split(",") if v.strip())
    return values


def apply_target_filters(qs, params):
    """Narrow an IP-keyed queryset by what its target is.

    Every dimension is optional; each adds one AND. Lists are OR within the
    dimension, so ``site=a,b`` means either site. Tags are the exception -
    every tag named must be present, on the address or its device - because
    "tagged core *and* production" is what somebody narrowing by two tags
    means.
    """
    kinds = _csv(params, "kind")
    if kinds:
        qs = qs.filter(kind__in=kinds)
    templates = _csv(params, "template")
    if templates:
        qs = qs.filter(template_id__in=templates)
    ip = (params.get("ip") or "").strip()
    if ip:
        qs = qs.filter(target_ip_id=ip)
    sites = _csv(params, "site")
    if sites:
        # An address may carry its own site, inherit its prefix's, or sit on
        # a device that has one. Any of the three is "at that site".
        qs = qs.filter(
            Q(target_ip__site_id__in=sites)
            | Q(target_ip__prefix__site_id__in=sites)
            | Q(target_ip__assigned_device__site_id__in=sites)
        )
    regions = _csv(params, "region")
    if regions:
        from api.viewsets import _region_and_descendant_ids

        ids: list = []
        for r in regions:
            ids.extend(_region_and_descendant_ids(r))
        qs = qs.filter(
            Q(target_ip__site__region_id__in=ids)
            | Q(target_ip__prefix__site__region_id__in=ids)
            | Q(target_ip__assigned_device__site__region_id__in=ids)
        )
    devices = _csv(params, "device")
    if devices:
        qs = qs.filter(target_ip__assigned_device_id__in=devices)
    for key, path in (
        ("device_type", "target_ip__assigned_device__device_type_id__in"),
        ("role", "target_ip__assigned_device__role_id__in"),
        ("platform", "target_ip__assigned_device__platform_id__in"),
        ("prefix", "target_ip__prefix_id__in"),
        ("vrf", "target_ip__vrf_id__in"),
    ):
        values = _csv(params, key)
        if values:
            qs = qs.filter(**{path: values})
    vlans = _csv(params, "vlan")
    if vlans:
        qs = qs.filter(
            Q(target_ip__prefix__vlan_id__in=vlans)
            | Q(target_ip__assigned_interface__vlan_id__in=vlans)
        )
    port = (params.get("port") or "").strip()
    if port.isdigit():
        # Stored as a JSON number or a string depending on who wrote the
        # template; match either.
        qs = qs.filter(
            Q(template__params__port=int(port)) | Q(template__params__port=port)
        )
    tags = _many(params, "tag")
    for slug in tags:
        qs = qs.filter(
            Q(target_ip__tags__slug=slug)
            | Q(target_ip__assigned_device__tags__slug=slug)
        )
    if tags:
        qs = qs.distinct()
    search = (params.get("search") or params.get("q") or "").strip()
    if search:
        qs = qs.filter(
            Q(target_ip__ip_address__icontains=search)
            | Q(target_ip__dns_name__icontains=search)
            | Q(template__name__icontains=search)
            | Q(target_ip__assigned_device__name__icontains=search)
        )
    return qs


def window(params, now=None) -> tuple:
    """``(since, until)`` from ``since``/``until`` ISO stamps, else ``hours``,
    else ``days``.

    An explicit stamp wins over a span; ``hours`` (1 up to a year) wins over
    ``days`` so a panel can ask for the last hour or twelve. Naive stamps are
    refused rather than guessed at: a history query a few hours out because
    of a timezone is the kind of wrong that looks right.
    """
    now = now or timezone.now()
    until = parse_datetime(params.get("until") or "") if params.get("until") else None
    since = parse_datetime(params.get("since") or "") if params.get("since") else None
    if until is not None and timezone.is_naive(until):
        until = None
    if since is not None and timezone.is_naive(since):
        since = None
    until = until or now
    if since is None and params.get("hours"):
        try:
            hours = max(1, min(int(params.get("hours")), DAYS_MAX * 24))
            since = until - timedelta(hours=hours)
        except ValueError:
            since = None
    if since is None:
        try:
            days = int(params.get("days") or DAYS_DEFAULT)
        except ValueError:
            days = DAYS_DEFAULT
        days = max(1, min(days, DAYS_MAX))
        since = until - timedelta(days=days)
    if since >= until:
        since = until - timedelta(days=DAYS_DEFAULT)
    return since, until


def apply_transition_filters(qs, params, now=None, tz=None):
    """The target filters plus what a transition itself carries.

    ``dow`` (0 = Monday) and ``hour`` narrow to one cell of the viewer's
    week - the heatmap's cells are links into the table - and need the
    viewer's timezone to mean the right hour.
    """
    qs = qs.annotate(source=STAMPED_SOURCE_EXPR)
    qs = apply_target_filters(qs, params)
    dow, hour = (params.get("dow") or "").strip(), (params.get("hour") or "").strip()
    if tz is not None and (dow.isdigit() or hour.isdigit()):
        from django.db.models.functions import ExtractHour, ExtractWeekDay

        if dow.isdigit():
            # Django's weekday is 1 = Sunday … 7 = Saturday; ours is 0 = Monday.
            qs = qs.annotate(_dow=ExtractWeekDay("at", tzinfo=tz)).filter(
                _dow=(int(dow) + 1) % 7 + 1
            )
        if hour.isdigit():
            qs = qs.annotate(_hour=ExtractHour("at", tzinfo=tz)).filter(_hour=int(hour))
    to_status = _csv(params, "to_status") or _csv(params, "to")
    if to_status:
        qs = qs.filter(to_status__in=to_status)
    from_status = _csv(params, "from_status") or _csv(params, "from")
    if from_status:
        qs = qs.filter(from_status__in=from_status)
    sources = _csv(params, "source")
    if sources:
        qs = qs.filter(source__in=sources)
    engines = _csv(params, "engine")
    if engines:
        qs = qs.filter(engine_id__in=engines)
    if (params.get("flapping") or "").strip() == "1":
        # The changes behind what is flagged right now.
        qs = qs.filter(flapping_now())
    since, until = window(params, now)
    qs = qs.filter(at__gte=since, at__lte=until)
    return qs, since, until


def flapping_now():
    """The check behind a transition is flagged as flapping right now - an
    ``Exists`` on the state, so it annotates and filters alike."""
    from django.db.models import Exists, OuterRef

    from .models import CheckState

    return Exists(
        CheckState.objects.filter(
            target_ip_id=OuterRef("target_ip_id"), template_id=OuterRef("template_id"),
            flapping_since__isnull=False,
        )
    )


#: Which params each facet is *its own* filter for - dropped when counting it.
_OWN_PARAMS = {
    "to_status": ("to_status", "to"),
    "from_status": ("from_status", "from"),
    "kind": ("kind",),
    "source": ("source",),
    "site": ("site",),
    "device_type": ("device_type",),
    "role": ("role",),
    "platform": ("platform",),
    "template": ("template",),
    "engine": ("engine",),
    "flapping": ("flapping",),
    # The heatmap is drawn without its own cell selected, or one click
    # would leave one lit square.
    "cell": ("dow", "hour"),
}


def _without(params, keys) -> dict:
    out = {k: v for k, v in params.items() if k not in keys}
    # A QueryDict's items() yields the last value; keep repeatables whole.
    if hasattr(params, "getlist"):
        for k in list(out):
            vals = params.getlist(k)
            if len(vals) > 1:
                out[k] = ",".join(vals)
    return out


def facet_counts(base, params, dims, apply, *, status_field=None) -> dict:
    """``{dim: [{value, label, count}]}`` for the rail.

    ``apply(qs, params)`` is the filter function for this list, called once
    per dimension with that dimension's own params removed. ``base`` is the
    already tenant- and RBAC-scoped queryset.
    """
    from django.apps import apps

    out: dict = {}
    for dim in dims:
        own = _OWN_PARAMS.get(dim, (dim,))
        qs = apply(base, _without(params, own))
        if isinstance(qs, tuple):
            qs = qs[0]
        if dim in ("to_status", "from_status"):
            field = dim
        elif dim == "status" and status_field:
            field = status_field
        else:
            field = FACET_FIELDS.get(dim, dim)
        if field == "_site":
            qs = qs.annotate(_site=SITE_EXPR)
        rows = (
            qs.exclude(**{f"{field}__isnull": True})
            .values(field)
            .annotate(n=Count("id"))
            .order_by("-n")
        )
        buckets = [(str(r[field]), r["n"]) for r in rows if r[field] not in (None, "")]
        labels: dict = {}
        if dim in _LABEL_MODELS and buckets:
            app, model, attr = _LABEL_MODELS[dim]
            Model = apps.get_model(app, model)
            labels = {
                str(pk): name
                for pk, name in Model.objects.filter(
                    pk__in=[b[0] for b in buckets]
                ).values_list("pk", attr)
            }
        out[dim] = [
            {"value": value, "label": labels.get(value, value), "count": n}
            for value, n in buckets
        ]
    return out


def transition_series(qs, since, until) -> tuple[list[dict], str]:
    """Counts per bucket per ``to_status`` - hour up to three days, day after."""
    hourly = (until - since) <= timedelta(hours=72)
    trunc = TruncHour("at") if hourly else TruncDay("at")
    rows = (
        qs.annotate(b=trunc).values("b", "to_status").annotate(n=Count("id")).order_by("b")
    )
    empty = {s: 0 for s in CheckStatus.values}
    buckets: dict = {}
    for r in rows:
        key = r["b"].isoformat()
        b = buckets.setdefault(key, {"t": key, **empty})
        b[r["to_status"]] = b.get(r["to_status"], 0) + r["n"]
    return sorted(buckets.values(), key=lambda x: x["t"]), ("hour" if hourly else "day")


def paginate(qs, params) -> tuple[list, int, int, int]:
    """``(rows, total, page, page_size)`` - the same 1-based paging the checks
    list has always used, in one place."""
    try:
        page = max(1, int(params.get("page", 1)))
        page_size = max(1, min(int(params.get("page_size", PAGE_SIZE_DEFAULT)), PAGE_SIZE_MAX))
    except ValueError:
        page, page_size = 1, PAGE_SIZE_DEFAULT
    total = qs.count()
    start = (page - 1) * page_size
    return list(qs[start:start + page_size]), total, page, page_size


__all__ = [
    "FACET_FIELDS",
    "apply_target_filters",
    "apply_transition_filters",
    "facet_counts",
    "paginate",
    "transition_series",
    "window",
]
