"""MAC address registry for the IPAM MAC page.

``GET /api/macs/`` → the MAC addresses known in the active tenant, a page at
a time (#527: the stored summary of api.mac_summary), aggregated from four
places: device interface hardware addresses, virtual-machine
interface addresses, IP↔MAC pairings, and first-class
:class:`~api.models.MACAddress` objects. Each MAC is one row carrying the
interfaces that bear it, the IPs paired with it, and any MAC objects (with
their description / tags) recorded for it.

Full CRUD on the MAC *objects* themselves lives at ``/api/mac-addresses/``
(see :class:`~api.viewsets.MACAddressViewSet`); this module only aggregates.

Each source is a row type of its own, cut to the caller's view scope for it
(``interface``, ``vminterface``, ``ipaddress``, ``macaddress``) in the active
tenant: a viewer limited to Site A never learns a Site B address or port
through a shared MAC. An IP's device and interface show only when the caller
may view that row as well; SNMP sightings only on devices and VMs they may
view.
"""
from __future__ import annotations

import functools
import operator
import re

from django.db.models import Case, CharField, F, OuterRef, Q, Subquery, Value, When
from django.db.models.functions import Coalesce, Collate, Concat, NullIf
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import serializers, viewsets
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api import rbac
from core.models import Tag
from core.tags import TAGS, tags_of

from . import list_summaries, mac_summary
from .list_table import Facet, Sort, TableListMixin, TableSpec
from .mac_summary import source_rows
from .models import (
    Device,
    Interface,
    IPAddress,
    MACAddress,
    MacSummary,
    VirtualMachine,
    VMInterface,
)
from .natural import natural
from .oui import vendor_for
from .pagination import StandardResultsSetPagination
from .serializers import TagSerializer
from .views import _get_active_tenant


def _norm(mac: str) -> str:
    return mac.strip().lower()


def _hexkey(mac: str) -> str:
    """Separator-insensitive comparison key: aa:bb == AA-BB == aabb."""
    return re.sub(r"[^0-9a-f]", "", (mac or "").lower())


def _visible(qs, user, tenant, slug):
    """``qs`` cut to the rows the caller may view (tenant filter is the
    caller's)."""
    return rbac.restrict_queryset(qs, user, tenant, slug, "view")


def _visible_ids(model, tenant_path, ids, user, tenant, slug) -> set:
    """The ids among ``ids`` of rows in ``tenant`` the caller may view - one
    query for a whole page, none when ``ids`` is empty."""
    if not ids:
        return set()
    qs = model.objects.filter(pk__in=ids, **{tenant_path: tenant})
    return set(_visible(qs, user, tenant, slug).values_list("pk", flat=True))


def _snmp_sightings(tenant, mac: str, user) -> list[dict]:
    """Where polling has *observed* this MAC. A MAC clicked on a monitoring
    card often exists only here (a neighbour's address learned on a port), so
    the detail page must be able to say "seen on sw1 port eth2" instead of
    pretending the address doesn't exist. Only devices and VMs the caller may
    view are listed.

    Since #284 these are indexed reads of the sighting tables: every port the
    MAC was learned on and every ARP entry naming it, present and gone (the
    history, within the tenant's retention). A ``fdb`` row carries its VLAN,
    first and last seen, whether it is still there and the port's role
    (access or uplink) next to the original ``device``/``source``/``port``
    keys. A device polled before 0.17 still answers from its JSON tables
    until its next poll - only those rows are loaded."""
    from django.db.models import F, Q

    # Local: api must not import monitoring at module level.
    from monitoring.mac_location import UplinkContext, seen_rows
    from monitoring.mac_tables import canon_mac
    from monitoring.models import ArpSighting, DeviceSnmp, MacSighting

    key = _hexkey(mac)
    canon = canon_mac(key)
    seen: list[dict] = []
    devices = _visible(Device.objects.filter(tenant=tenant), user, tenant, "device")
    vms = _visible(
        VirtualMachine.objects.filter(tenant=tenant), user, tenant, "virtualmachine"
    )
    if canon:
        rows = seen_rows(
            MacSighting.objects.filter(tenant=tenant, mac=canon, device__in=devices)
            .order_by(F("gone_at").desc(nulls_first=True), "-last_seen")
        )
        ctx = UplinkContext(tenant).load(
            {r.polled_device_id for r in rows}, {r.interface_id for r in rows}
        )
        for r in rows:
            uplink = ctx.classify(r.polled_device_id, r.port_key, r.interface_id)
            seen.append({
                "device": {"id": str(r.device_id), "name": r.device_name},
                "source": "fdb",
                "port": r.port_name,
                "interface": (
                    {"id": str(r.interface_id), "name": r.interface_name}
                    if r.interface_id else None
                ),
                "vlan": r.vlan,
                "first_seen": r.first_seen,
                "last_seen": r.last_seen,
                "gone_at": r.gone_at,
                "present": r.gone_at is None,
                "role": "uplink" if uplink.is_uplink else "access",
            })
        for a in (
            ArpSighting.objects.filter(tenant=tenant, mac=canon)
            .filter(Q(device__in=devices) | Q(vm__in=vms))
            .order_by(F("gone_at").desc(nulls_first=True), "-last_seen")
            .values(
                "device_id", "device__name", "vm_id", "vm__name", "ip",
                "interface_id", "interface__name", "first_seen", "last_seen", "gone_at",
            )
        ):
            owner = (
                {"device": {"id": str(a["device_id"]), "name": a["device__name"]}}
                if a["device_id"]
                else {"vm": {"id": str(a["vm_id"]), "name": a["vm__name"]}}
            )
            seen.append({
                **owner, "source": "arp", "ip": a["ip"],
                "interface": (
                    {"id": str(a["interface_id"]), "name": a["interface__name"]}
                    if a["interface_id"] else None
                ),
                "vlan": None,
                "first_seen": a["first_seen"],
                "last_seen": a["last_seen"],
                "gone_at": a["gone_at"],
                "present": a["gone_at"] is None,
                "role": None,
            })

    states = (
        DeviceSnmp.objects.filter(tenant=tenant, fdb_meta={})
        .filter(Q(device__in=devices) | Q(vm__in=vms))
        .select_related("device", "vm")
    )
    for state in states:
        # A state row belongs to a device OR a VM (#13) - reading
        # state.device.name on a VM row was a straight 500 (#139).
        if state.device_id:
            owner = {
                "device": {"id": str(state.device_id), "name": state.device.name}
            }
        elif state.vm_id:
            owner = {"vm": {"id": str(state.vm_id), "name": state.vm.name}}
        else:
            continue
        legacy = {
            "interface": None, "vlan": None, "first_seen": None,
            "last_seen": state.polled_at, "gone_at": None, "present": True, "role": None,
        }
        ifname = {
            str(o.get("if_index")): o.get("name")
            for o in (state.interfaces or [])
            if o.get("if_index")
        }
        for a in state.arp or []:
            if _hexkey(a.get("mac", "")) == key:
                seen.append({**owner, "source": "arp", "ip": a.get("ip"), **legacy})
        for f in state.fdb or []:
            if _hexkey(f.get("mac", "")) == key:
                seen.append({
                    **owner, "source": "fdb",
                    "port": ifname.get(str(f.get("if_index") or "")),
                    **legacy,
                })
    return seen


def _match_mac(qs, field: str, key: str, canon: str | None):
    """``qs`` rows whose ``field`` holds this MAC: in any notation when the
    query is a whole MAC, else the old case-insensitive match."""
    if canon:
        from monitoring.mac_tables import filter_hex

        return filter_hex(qs, field, [canon])
    return qs.filter(**{f"{field}__iexact": key})


def _iface_ref(iface) -> dict:
    return {
        "id": str(iface.id),
        "name": iface.name,
        "device": {"id": str(iface.device_id), "name": iface.device.name},
    }


def _vm_iface_ref(vi) -> dict:
    return {
        "id": str(vi.id),
        "name": vi.name,
        "vm": {"id": str(vi.vm_id), "name": vi.vm.name},
    }


# The columns a list row reads: the full interface and device rows cost far
# more to load than the id and name it shows (#393).
_MAC_ROW = (
    "id", "numid", "mac_address", "description", "vendor_override",
    "assigned_interface", "assigned_interface__name",
    "assigned_interface__device", "assigned_interface__device__name",
)


def _tags_json(m: MACAddress, seen: dict | None) -> list:
    """The row's tags as the API shows them, from the :data:`~core.tags.TAGS`
    prefetch. ``seen`` serializes each distinct tag once for a whole list."""
    if seen is None:
        return TagSerializer(tags_of(m), many=True).data
    out = []
    for t in tags_of(m):
        data = seen.get(t.pk)
        if data is None:
            data = seen[t.pk] = TagSerializer(t).data
        out.append(data)
    return out


def _mac_object(
    m: MACAddress, *, with_custom_fields: bool = False, seen_tags: dict | None = None
) -> dict:
    """Serialize a MAC object for the aggregation views (list / detail)."""
    obj = {
        "id": str(m.id),
        "numid": m.numid,
        "mac_address": m.mac_address,
        "description": m.description,
        "vendor_override": m.vendor_override,
        "assigned_interface": (
            _iface_ref(m.assigned_interface) if m.assigned_interface_id else None
        ),
        "tags": _tags_json(m, seen_tags),
    }
    if with_custom_fields:
        obj["custom_fields"] = m.custom_fields or {}
    return obj


# ─── the list (#527) ─────────────────────────────────────────────────────────

#: The sources of a row: (row type, model, tenant path, row list key).
_SOURCE_SLUGS = (
    ("interface", Interface, "device__tenant", "interfaces"),
    ("vminterface", VMInterface, "vm__tenant", "vm_interfaces"),
    ("ipaddress", IPAddress, "tenant", "ips"),
    ("macaddress", MACAddress, "tenant", "objects"),
)


class MacScope:
    """What the caller may see of a tenant's MACs, once per request: every
    row of every source (and every device, for the learned Location) - then
    the stored counts and vendor are theirs - or the visible rows of each
    source, which the list's filters and facets then read live."""

    def __init__(self, request, tenant):
        user = request.user
        self.tenant = tenant
        self.user = user
        self.grants = {
            slug: rbac.row_filter(user, tenant, slug, "view")
            for slug in ("interface", "vminterface", "ipaddress", "macaddress", "device")
        }
        self.all = all(v is True for v in self.grants.values())

    @classmethod
    def of(cls, request, tenant) -> MacScope:
        got = getattr(request, "_mac_scope", None)
        if got is None or got.tenant.pk != tenant.pk:
            got = cls(request, tenant)
            try:
                request._mac_scope = got
            except AttributeError:
                pass
        return got

    def rows(self, slug: str):
        """The visible rows carrying a MAC of one source, keyed ``_k``; None
        when the caller sees none of them."""
        if self.grants[slug] is None:
            return None
        _, model, path, _ = next(s for s in _SOURCE_SLUGS if s[0] == slug)
        # Through the row restriction even for an open grant (a no-op then),
        # so no path reads a source unrestricted.
        return _visible(source_rows(model, f"{path}_id", self.tenant.pk),
                        self.user, self.tenant, slug)

    def keys(self, slug: str, q: Q | None = None):
        """A subquery of the visible keys of one source (rows matching
        ``q``), or None."""
        rows = self.rows(slug)
        if rows is None:
            return None
        if q is not None:
            rows = rows.filter(q)
        return rows.order_by().values("_k")

    def devices(self):
        """A subquery of the devices the caller may view; None for all."""
        if self.grants["device"] is True:
            return None
        if self.grants["device"] is None:
            return Device.objects.none().values("pk")
        return _visible(Device.objects.filter(tenant=self.tenant), self.user, self.tenant,
                        "device").values("pk")


def _any_key(scope: MacScope, slugs, q_of=None) -> Q:
    """Rows whose key one of ``slugs``' visible rows carries."""
    out = Q(pk__in=[])
    for slug in slugs:
        keys = scope.keys(slug, q_of(slug) if q_of else None)
        if keys is not None:
            out |= Q(key__in=keys)
    return out


def _has(scope: MacScope, field: str, slugs) -> Q:
    if scope.all:
        return functools.reduce(operator.or_, (Q(**{f"{f}__gt": 0}) for f in field))
    return _any_key(scope, slugs)


def _vendor_expr(scope: MacScope):
    oui = NullIf(F("oui_vendor"), Value(""))
    if scope.all:
        return Coalesce(NullIf(F("vendor_override"), Value("")), oui)
    objects = scope.rows("macaddress")
    if objects is None:
        return oui
    first = (objects.filter(_k=OuterRef("key")).exclude(vendor_override="")
             .order_by("numid", "pk").values("vendor_override")[:1])
    return Coalesce(Subquery(first, output_field=CharField()), oui)


def _learned_q(scope: MacScope) -> Q:
    q = Q(learned_device__isnull=False)
    devices = scope.devices()
    if devices is not None:
        q &= Q(learned_device__in=devices)
    return q


def _masked(scope: MacScope, path):
    """``path`` of the learned Location, NULL where the caller may not see
    the switch it was learned on."""
    expr = F(path) if isinstance(path, str) else path
    return Case(When(_learned_q(scope), then=expr), default=None, output_field=CharField())


def _annotate(qs, request):
    """What the rail, the sorts and the search read from a row."""
    if "_vendor" in qs.query.annotations:
        return qs
    scope = MacScope.of(request, _get_active_tenant(request))
    learned = _learned_q(scope)
    return qs.annotate(
        _vendor=_vendor_expr(scope),
        _loc_site=Case(
            When(learned & Q(learned_device__site__isnull=False),
                 then=F("learned_device__site__name")),
            When(learned, then=Value(NOSITE)),
            default=None, output_field=CharField(),
        ),
        # The Location sort reads a learned place without a site as an
        # empty name, as the table sorted it in the browser.
        _loc_site_name=Case(
            When(learned, then=Coalesce(F("learned_device__site__name"), Value(""))),
            default=None, output_field=CharField(),
        ),
        _loc_location=_masked(scope, "learned_device__location__name"),
        _loc_device=_masked(scope, "learned_device__name"),
        _loc_port=_masked(scope, Coalesce(F("learned_interface__name"), F("learned_port"))),
    )


NOSITE = "__nosite__"


def _yes_no(field: tuple, slugs):
    def buckets(request):
        scope = MacScope.of(request, _get_active_tenant(request))
        yes = _has(scope, field, slugs)
        return {"yes": yes, "no": ~yes}

    return buckets


def _tag_filter(qs, request, wanted):
    scope = MacScope.of(request, _get_active_tenant(request))
    keys = scope.keys("macaddress", Q(tags__slug__in=wanted))
    return qs.filter(key__in=keys) if keys is not None else qs.none()


def _tag_count(qs, request, selected):
    from .list_table import _by_count, _cap, _text_color, group_count

    scope = MacScope.of(request, _get_active_tenant(request))
    objects = scope.rows("macaddress")
    if objects is None:
        return []
    pairs = (objects.filter(_k__in=qs.order_by().values("key"), tags__isnull=False)
             .annotate(_tag=F("tags__id")).order_by().values("_tag", "_k").distinct())
    counts = dict(group_count(pairs, "_tag"))
    merged: dict = {}
    for t in (Tag.objects.filter(pk__in=list(counts)).order_by("name", "id")
              .values("id", "slug", "name", "color")):
        got = merged.setdefault(t["slug"], {
            "value": t["slug"], "label": t["name"], "count": 0,
            "color": t["color"] or None, "text_color": _text_color(t["color"]), "id": t["id"],
        })
        got["count"] += counts[t["id"]]
    return _cap(_by_count(merged.values()), selected)


def _location_sort(qs, request):
    return _annotate(qs, request)


MAC_SPEC = TableSpec(
    facets={
        "vendor": Facet(field="_vendor", prepare=_annotate, none_label="Unknown", blank=True),
        "location": Facet(field="_loc_site", prepare=_annotate, none_label="Not learned",
                          labels={NOSITE: "No site"}),
        "interfaces": Facet(kind="buckets", buckets=_yes_no(
            ("interfaces", "vm_interfaces"), ("interface", "vminterface")),
            labels={"yes": "Has interface", "no": "No interface"}),
        "ips": Facet(kind="buckets", buckets=_yes_no(("ips",), ("ipaddress",)),
                     labels={"yes": "Has IP", "no": "No IP"}),
        "description": Facet(kind="buckets", buckets=_yes_no(("mac_objects",), ("macaddress",)),
                             labels={"yes": "Has object", "no": "No object"}),
        "tags": Facet(kind="custom", filter_fn=_tag_filter, count_fn=_tag_count),
    },
    sorts={
        "mac": Sort((Collate("key", "C"),)),
        "location": Sort((natural("_loc_site_name"), natural("_loc_location"),
                          natural("_loc_device"), natural("_loc_port")),
                         prepare=_location_sort),
    },
    # The advanced filter: the row's scalar fields, as the caller sees them.
    expr_fields={
        "mac": ("text", "key"),
        "vendor.name": ("text", "_vendor"),
        "location.site.name": ("text", "_loc_site_name"),
        "location.location.name": ("text", "_loc_location"),
        "location.device.name": ("text", "_loc_device"),
        "location.port_name": ("text", "_loc_port"),
        "location.interface.name": ("text", "_loc_port"),
    },
    expr_prepare=_annotate,
)


def _search_q(scope: MacScope, needle: str) -> Q:
    """The search box: the MAC, its vendor, where it was learned, and the
    names, addresses and descriptions of the rows the caller may see."""
    loc = Concat(
        Coalesce("_loc_site", Value("")), Value(" "), Coalesce("_loc_location", Value("")),
        Value(" "), Coalesce("_loc_device", Value("")), Value(" "),
        Coalesce("_loc_port", Value("")), output_field=CharField(),
    )
    text = {
        "interface": Q(name__icontains=needle) | Q(device__name__icontains=needle),
        "vminterface": Q(name__icontains=needle) | Q(vm__name__icontains=needle),
        "ipaddress": Q(ip_address__icontains=needle),
        "macaddress": Q(description__icontains=needle),
    }
    return (Q(key__contains=needle.lower()) | Q(_vendor__icontains=needle)
            | Q(_loc_text__icontains=needle)
            | _any_key(scope, text, lambda slug: text[slug])), loc


class _NoFields(serializers.Serializer):
    """The list's rows are built by hand (:func:`_page_entries`); the
    advanced filter reads :data:`MAC_SPEC`'s fields only."""

    class Meta:
        fields = ()


class MacListViewSet(TableListMixin, viewsets.GenericViewSet):
    """``GET /api/macs/`` - one row per MAC value the tenant records (on a
    device or VM interface, an IP pairing or a MAC object), paged, searched,
    sorted and counted in SQL from the stored summary (api.mac_summary).
    The list contract of api.list_table: ``page``/``page_size``,
    ``ordering`` (``mac``, ``location``), ``search``, ``f_<facet>``
    (``vendor``, ``location``, ``interfaces``, ``ips``, ``description``,
    ``tags``) and ``facets/``. Each row: ``{id, mac, vendor, interfaces[],
    vm_interfaces[], ips[], objects[], location}``, cut to the caller's
    view scope; ``summary: {building, updating}`` says whether the stored
    rows are complete yet."""

    rbac_object_type = "macaddress"
    #: Read-only: whatever the action, the list reads.
    rbac_action_map = {"retrieve": "view", "partial_update": "view", "destroy": "view"}
    permission_classes = [IsAuthenticated]
    pagination_class = StandardResultsSetPagination
    queryset = MacSummary.objects.all()
    filter_backends: list = []
    table_spec = MAC_SPEC

    def _tenant(self):
        tenant = _get_active_tenant(self.request)
        if tenant is not None and not rbac.has_action(
                self.request.user, tenant, "macaddress", "view"):
            raise PermissionDenied("macaddress.view required.")
        return tenant

    def get_queryset(self):
        tenant = self._tenant()
        if tenant is None:
            return MacSummary.objects.none()
        scope = MacScope.of(self.request, tenant)
        qs = MacSummary.objects.filter(tenant=tenant)
        # The MAC objects the caller may view, read for every caller: a row
        # is theirs only through a source row they may view.
        scope.rows("macaddress")
        if not scope.all:
            qs = qs.filter(_any_key(scope, [s[0] for s in _SOURCE_SLUGS]))
        needle = (self.request.query_params.get("search") or "").strip()
        if needle:
            q, loc = _search_q(scope, needle[:200])
            qs = _annotate(qs, self.request).annotate(_loc_text=loc).filter(q)
        return qs.order_by(Collate("key", "C"))

    def list(self, request, *args, **kwargs):
        tenant = self._tenant()
        if tenant is None:
            return Response({"count": 0, "next": None, "previous": None, "results": []})
        summary = list_summaries.ensure(mac_summary.KIND, tenant)
        page = self.paginate_queryset(self.filter_queryset(self.get_queryset()))
        rows = _page_entries(tenant, request, page or [])
        response = self.get_paginated_response(rows)
        response.data["summary"] = summary
        return response

    def table_facets(self, request):
        tenant = self._tenant()
        if tenant is not None:
            list_summaries.ensure(mac_summary.KIND, tenant)
        return super().table_facets(request)

    def get_serializer_class(self):
        return _NoFields

    def table_sortable(self) -> list[str]:
        return list(self.table_spec.sorts)

    def table_ids(self, request):
        """Every MAC the filters match, in the list's order - what *Select
        all* ticks (the rows' ids are their MACs)."""
        from django.conf import settings

        cap = int(getattr(settings, "API_MAX_SELECT", 50_000))
        qs = self.filter_queryset(self.get_queryset())
        ids = list(qs.values_list("key", flat=True)[: cap + 1])
        return Response({"count": len(ids[:cap]), "truncated": len(ids) > cap,
                         "results": ids[:cap]})


def _page_entries(tenant, request, summaries) -> list[dict]:
    """The rows of one page, in its order: each source's visible rows that
    carry the page's MACs, read for those keys alone."""
    from monitoring.mac_location import location_cells
    from monitoring.mac_tables import canon_mac

    user = request.user
    scope = MacScope.of(request, tenant)
    keys = [s.key for s in summaries]
    if not keys:
        return []
    entries = {
        s.key: {"id": s.key, "mac": None, "vendor": None, "interfaces": [],
                "vm_interfaces": [], "ips": [], "objects": [], "location": None}
        for s in summaries
    }
    display: dict = {}

    def seen(key, raw, rank):
        if key in entries and (key not in display or display[key][0] > rank):
            display[key] = (rank, raw)

    rows = scope.rows("interface")
    if rows is not None:
        for i in (rows.filter(_k__in=keys).select_related("device")
                  .order_by(natural("device__name"), natural("name"), "pk")):
            entries[i._k]["interfaces"].append(_iface_ref(i))
            seen(i._k, i.mac_address, 0)
    rows = scope.rows("vminterface")
    if rows is not None:
        for vi in (rows.filter(_k__in=keys).select_related("vm")
                   .order_by(natural("vm__name"), natural("name"), "pk")):
            entries[vi._k]["vm_interfaces"].append(_vm_iface_ref(vi))
            seen(vi._k, vi.mac_address, 1)
    rows = scope.rows("ipaddress")
    if rows is not None:
        ips = list(rows.filter(_k__in=keys).select_related("assigned_device")
                   .order_by("ip_address", "pk"))
        # An IP's device is its own row: named only when the caller may view it.
        devices = _visible_ids(
            Device, "tenant", {ip.assigned_device_id for ip in ips} - {None},
            user, tenant, "device",
        )
        for ip in ips:
            entries[ip._k]["ips"].append({
                "id": str(ip.id),
                "ip_address": ip.ip_address,
                "device": (
                    {"id": str(ip.assigned_device_id), "name": ip.assigned_device.name}
                    if ip.assigned_device_id in devices else None
                ),
            })
            seen(ip._k, ip.mac_address, 2)
    rows = scope.rows("macaddress")
    if rows is not None:
        seen_tags: dict = {}
        for m in (rows.filter(_k__in=keys).select_related("assigned_interface__device")
                  .only(*_MAC_ROW).prefetch_related(TAGS).order_by("numid", "pk")):
            entries[m._k]["objects"].append(_mac_object(m, seen_tags=seen_tags))
            seen(m._k, m.mac_address, 3)

    # Where each MAC was learned, among the switches the caller may view
    # (#344) - for the page's MACs alone.
    canon = {k: canon_mac(k) for k in keys}
    located = location_cells(tenant, {c for c in canon.values() if c}, user)
    out = []
    for s in summaries:
        entry = entries[s.key]
        entry["mac"] = display.get(s.key, (0, s.key))[1]
        override = next((o["vendor_override"] for o in entry["objects"]
                         if o["vendor_override"]), "")
        if override:
            entry["vendor"] = {"name": override, "source": "override"}
        elif s.oui_vendor:
            entry["vendor"] = {"name": s.oui_vendor, "source": s.oui_source}
        entry["location"] = located.get(canon[s.key]) if canon[s.key] else None
        out.append(entry)
    return out


@extend_schema(
    summary="Detail for one MAC address: interfaces bearing it, IPs paired with "
    "it, first-class MAC objects recorded for it, and where the network has "
    "seen it",
    tags=["mac-addresses"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="{mac, vendor, objects[], interfaces[], vm_interfaces[], ips[], "
        "seen[], location, ips_observed[], names[], name, name_source} for the "
        "given MAC address in any notation, or 404 when nothing carries it.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def mac_detail_view(request, mac):
    """One MAC address: every interface that bears it, every IP paired with it,
    and every first-class MAC object recorded for it (with the description /
    tags / custom fields you can edit)."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "Not found."}, status=404)
    user = request.user
    if not rbac.has_action(user, tenant, "macaddress", "view"):
        return Response({"detail": "macaddress.view required."}, status=403)

    from monitoring.mac_location import enrich, locate, location_payload, vlan_objects
    from monitoring.mac_tables import canon_mac

    key = _norm(mac)
    # Any notation of a whole MAC - colons, dashes, Cisco dots, bare hex -
    # names the same address (#284).
    canon = canon_mac(key)
    ifaces = _visible(
        _match_mac(Interface.objects.filter(device__tenant=tenant), "mac_address", key, canon)
        .select_related("device")
        .order_by(natural("device__name"), natural("name")),
        user, tenant, "interface",
    )
    vm_ifaces = _visible(
        _match_mac(VMInterface.objects.filter(vm__tenant=tenant), "mac_address", key, canon)
        .select_related("vm")
        .order_by(natural("vm__name"), natural("name")),
        user, tenant, "vminterface",
    )
    ips = _visible(
        _match_mac(IPAddress.objects.filter(tenant=tenant), "mac_address", key, canon)
        .select_related("assigned_device", "assigned_interface", "status")
        .order_by("ip_address"),
        user, tenant, "ipaddress",
    )
    objects = _visible(
        _match_mac(MACAddress.objects.filter(tenant=tenant), "mac_address", key, canon)
        .select_related("assigned_interface__device")
        .prefetch_related(TAGS)
        .order_by(
            natural("assigned_interface__device__name"), natural("assigned_interface__name")
        ),
        user, tenant, "macaddress",
    )
    seen = _snmp_sightings(tenant, key, user)
    # Where it is, what it answers to and what it's called - each source cut
    # to the caller's scope for its own type (#284).
    location = None
    observed = {"ips": [], "names": [], "name": None, "name_source": None}
    if canon:
        loc = locate(tenant, [canon], user).get(canon)
        if loc is not None:
            vlans = vlan_objects(tenant, user, {(loc.at.site_id, loc.at.vlan)})
            location = location_payload(loc, vlans)
        observed = enrich(tenant, [canon], user).get(canon) or observed
    if (
        not ifaces.exists()
        and not vm_ifaces.exists()
        and not ips.exists()
        and not objects.exists()
        and not seen
        and not observed["ips"]
    ):
        return Response({"detail": "Not found."}, status=404)

    if ifaces.exists():
        display = ifaces.first().mac_address
    elif vm_ifaces.exists():
        display = vm_ifaces.first().mac_address
    elif ips.exists():
        display = ips.first().mac_address
    elif objects.exists():
        display = objects.first().mac_address
    else:
        display = canon or key

    override = next((m.vendor_override for m in objects if m.vendor_override), "")
    vendor = (
        {"name": override, "source": "override"} if override else vendor_for(key, tenant)
    )
    # An IP's device and interface are rows of their own: named only when the
    # caller may view them.
    ips = list(ips)
    devices = _visible_ids(
        Device, "tenant", {ip.assigned_device_id for ip in ips} - {None},
        user, tenant, "device",
    )
    ports = _visible_ids(
        Interface, "device__tenant", {ip.assigned_interface_id for ip in ips} - {None},
        user, tenant, "interface",
    )
    return Response(
        {
            "mac": display,
            "vendor": vendor,
            "seen": seen,
            "location": location,
            "ips_observed": observed["ips"],
            "names": observed["names"],
            "name": observed["name"],
            "name_source": observed["name_source"],
            "objects": [_mac_object(m, with_custom_fields=True) for m in objects],
            "interfaces": [
                {**_iface_ref(i), "enabled": i.enabled} for i in ifaces
            ],
            "vm_interfaces": [
                {**_vm_iface_ref(vi), "enabled": vi.enabled} for vi in vm_ifaces
            ],
            "ips": [
                {
                    "id": str(ip.id),
                    "ip_address": ip.ip_address,
                    "status": (
                        {
                            "name": ip.status.name,
                            "color": ip.status.color,
                            "text_color": ip.status.text_color,
                        }
                        if ip.status_id
                        else None
                    ),
                    "device": (
                        {"id": str(ip.assigned_device_id), "name": ip.assigned_device.name}
                        if ip.assigned_device_id in devices
                        else None
                    ),
                    "interface": (
                        {"id": str(ip.assigned_interface_id), "name": ip.assigned_interface.name}
                        if ip.assigned_interface_id in ports
                        else None
                    ),
                }
                for ip in ips
            ],
        }
    )
