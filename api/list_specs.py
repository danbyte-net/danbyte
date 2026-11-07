"""What the Devices, Interfaces, Cables and Virtual machines tables sort,
filter and show when they page on the server (#482, #487) - one
:class:`api.list_table.TableSpec` per list.

Facet and column ids are the SPA's (``frontend/src/components/columns``):
a facet's bucket key is exactly what the column's ``facet.get`` returns for
a row, so a badge clicked in a cell and a value ticked in the rail filter
alike. ``fields`` is the slim row: what the page's columns, its row actions
and its custom columns read - nothing a detail view or an API client needs is
taken from the default response, which stays the full serializer.
"""
from __future__ import annotations

from django.contrib.contenttypes.models import ContentType
from django.db.models import (
    Case,
    DateField,
    F,
    IntegerField,
    OuterRef,
    Prefetch,
    Subquery,
    Value,
    When,
)
from django.db.models.functions import Coalesce, Least, NullIf

from core.models import TaggedItem

from . import ip_usage, listed, software_target, support_coverage
from .list_table import TAGS_FACET, Facet, Sort, TableSpec, by, fk, nat, value
from .natural import natural

# ─── Shared pieces ───────────────────────────────────────────────────────────

def _tags_sort() -> Sort:
    """The client sorts a tags cell by its names: the first name (natural)
    stands for the row, untagged rows last."""

    def prepare(qs, request):
        ct = ContentType.objects.get_for_model(qs.model)
        first = (
            TaggedItem.objects.filter(content_type=ct, object_id=OuterRef("pk"))
            .order_by(natural("tag__name")).values("tag__name")[:1]
        )
        return qs.annotate(_sort_tags=Subquery(first))

    return Sort((natural("_sort_tags"),), prepare)


def _profiles_sort(fk_name: str) -> Sort:
    def prepare(qs, request):
        from profiles.models import DeviceProfileAssignment

        first = (
            DeviceProfileAssignment.objects.filter(**{fk_name: OuterRef("pk")})
            .order_by("position", "created_at").values("profile__name")[:1]
        )
        return qs.annotate(_sort_profiles=Subquery(first))

    return Sort((natural("_sort_profiles"),), prepare)


def _eol_cfg(request):
    from compliance.eol import config_for

    return config_for(request)


def _eol_buckets(prefix: str):
    """``eol`` facet buckets - empty while end-of-life data is off (the
    column does not exist then)."""

    def buckets(request):
        from compliance.eol import STATUSES, status_q

        cfg = _eol_cfg(request)
        if not cfg.enabled:
            return {}
        return {s: status_q(s, cfg, prefix) for s in STATUSES}

    return buckets


#: The EoL column's rank (eol-cell.tsx): worst first.
_EOL_RANK = {"eol": 0, "ending": 1, "supported": 2, "unknown": 3}


def _eol_sort(prefix: str) -> Sort:
    def prepare(qs, request):
        from compliance.eol import status_q

        cfg = _eol_cfg(request)
        whens = [When(status_q(s, cfg, prefix), then=Value(rank))
                 for s, rank in _EOL_RANK.items() if s != "unknown"]
        return qs.annotate(_sort_eol=Case(*whens, default=Value(3),
                                          output_field=IntegerField()))

    return Sort(("_sort_eol",), prepare)


#: The Coverage column's rank (coverage-cell.tsx): worst first.
_COVERAGE_RANK = {"expired": 0, "none": 1, "expiring": 2, "covered": 3}


def _coverage_buckets(request):
    days = support_coverage.warning_days_for(request)
    return {s: support_coverage.status_q(s, days) for s in support_coverage.STATUSES}


def _coverage_prepare(qs, request):
    return support_coverage.annotate_devices(qs)


def _coverage_sort() -> Sort:
    def prepare(qs, request):
        qs = support_coverage.annotate_devices(qs)
        days = support_coverage.warning_days_for(request)
        whens = [When(support_coverage.status_q(s, days), then=Value(rank))
                 for s, rank in _COVERAGE_RANK.items()]
        return qs.annotate(_sort_coverage=Case(*whens, default=Value(1),
                                               output_field=IntegerField()))

    return Sort(("_sort_coverage",), prepare)


def _platform_end(request, prefix="platform__"):
    """A platform's effective end (compliance.eol.effective_dates): its own
    end of support, else the synced mapping's end-of-life date while the
    feature is on."""
    own = F(f"{prefix}end_of_support")
    if not _eol_cfg(request).enabled:
        return own
    mapped = Case(
        When(**{f"{prefix}eol_mapping__synced_at__isnull": False},
             then=F(f"{prefix}eol_mapping__eol_date")),
        output_field=DateField(),
    )
    return Coalesce(own, mapped, output_field=DateField())


def _lifecycle_sort(device: bool) -> Sort:
    """The Next end of life column: the soonest dated end across the sources
    ``api.serializers._lifecycle_next`` reads. Postgres' LEAST skips NULLs."""

    def prepare(qs, request):
        software = "software_end_any" if _eol_cfg(request).enabled else "software_end_entered"
        terms = [_platform_end(request), F(software)]
        if device:
            qs = support_coverage.annotate_devices(qs)
            terms += [
                F("device_type__end_of_support"),
                NullIf("coverage_end_annotated", Value(support_coverage.OPEN_ENDED)),
            ]
        return qs.annotate(_sort_lifecycle=Least(*terms, output_field=DateField()))

    return Sort(("_sort_lifecycle",), prepare)


def _software_target_buckets(request):
    return {s: software_target.state_q(s) for s in software_target.STATES}


def _software_target_prepare(qs, request):
    return software_target.annotate(qs)


def _address_range(kind: str):
    """The IPs range: rows using between ``lo`` and ``hi`` addresses."""

    def between(qs, request, lo, hi):
        counts = ip_usage.address_counts(kind, qs)
        ids = qs.order_by().values_list("pk", flat=True)
        keep = [
            pk for pk in ids
            if (lo is None or counts.get(pk, 0) >= lo)
            and (hi is None or counts.get(pk, 0) <= hi)
        ]
        return qs.filter(pk__in=keep)

    return between


def _cooling_prepare(qs, request):
    from .cooling import annotate_devices

    if "cooling_effective" in qs.query.annotations:
        return qs
    return annotate_devices(qs)


# ─── Devices ─────────────────────────────────────────────────────────────────

def device_table_rows():
    """The device list's base for the slim row: the joins and prefetches its
    columns read - the config template, room, DIN rail and the per-row
    counts only the full row (or the detail page) carries are left out."""
    from .applications import software_end_annotations
    from .models import Device

    return (
        Device.objects.select_related(
            "device_type", "device_type__platform", "device_type__manufacturer",
            "site", "site__region", "primary_ip",
            "role", "rack", "status", "platform", "platform__eol_mapping",
        )
        .prefetch_related(
            # TAGS: the shared to_attr prefetch (core.tags).
            *_device_prefetches(),
        )
        .annotate(
            **support_coverage.device_annotations(),
            **software_end_annotations("device"),
        )
        .order_by(natural("name"))
    )


def _device_prefetches():
    from core.tags import TAGS
    from profiles.models import DeviceProfileAssignment

    return (TAGS, "secondary_ip", "oob_ip", "cabinet", _profiles_prefetch(DeviceProfileAssignment))


def _profiles_prefetch(model):
    """A device's or VM's profile assignments as a plain list (#483)."""
    return listed.prefetch("device_profile_assignments",
                           model.objects.select_related("profile"))


def _device_config_template(qs):
    from .models import ExportTemplate

    return qs.prefetch_related(*(
        Prefetch(f"{path}config_template",
                 queryset=ExportTemplate.objects.defer("template_code", "description"))
        for path in ("", "role__", "platform__")
    ))


def _device_count(name, model_name):
    def need(qs):
        from . import models as m
        from .viewsets import _count_of

        return qs.annotate(**{f"{name}_annotated": _count_of(getattr(m, model_name), "device")})

    return need


DEVICE_TABLE = TableSpec(
    facets={
        "status": fk("status", color="color", none_label="No status", text=True),
        "role": fk("role", color="color", none_label="No role"),
        "platform": fk("platform", none_label="No platform"),
        "eol": Facet(kind="buckets", buckets=_eol_buckets("platform__eol_mapping__")),
        "coverage": Facet(kind="buckets", prepare=_coverage_prepare, buckets=_coverage_buckets),
        "type": fk("device_type", none_label="No type"),
        "manufacturer": value("device_type__manufacturer__name"),
        "cooling": value("cooling_effective", prepare=_cooling_prepare),
        "site": fk("site", none_label="No site"),
        "software_version": value("software_version"),
        "software_target": Facet(kind="buckets", prepare=_software_target_prepare,
                                 buckets=_software_target_buckets),
        "ips": Facet(kind="range", between=_address_range("device")),
        "tags": TAGS_FACET,
    },
    sorts={
        "name": nat("name"),
        "status": nat("status__name"),
        "role": nat("role__name"),
        "platform": nat("platform__name"),
        "eol": _eol_sort("platform__eol_mapping__"),
        "coverage": _coverage_sort(),
        "lifecycle_next": _lifecycle_sort(device=True),
        "type": nat("device_type__name"),
        "manufacturer": nat("device_type__manufacturer__name"),
        "cooling": Sort(("cooling_effective",), _cooling_prepare),
        "site": nat("site__name"),
        "rack": nat("rack__name"),
        "cabinet": nat("cabinet__name"),
        "software_version": nat("software_version"),
        "software_target": Sort(("_software_target",), _software_target_prepare),
        "device_profiles": _profiles_sort("device"),
        "tags": _tags_sort(),
        "updated": by("updated_at"),
    },
    fields=(
        "id", "numid", "name", "permissions", "status", "role", "platform",
        "effective_platform", "coverage", "lifecycle_next", "device_type",
        "cooling_method", "effective_cooling_method", "site", "rack", "cabinet",
        "serial_number", "software_version", "ip_count", "primary_ip",
        "secondary_ip", "oob_ip", "description", "device_profiles", "tags",
        "custom_fields", "created_at", "updated_at",
    ),
    cheap={
        # On the slim base already, or a join of it.
        "asset_tag": None, "comments": None, "airflow": None, "effective_airflow": None,
        "warranty_end": None, "software_version_seen_at": None,
        "software_version_source": None, "position": None, "face": None,
        "rack_side": None, "u_height": None, "rack_width": None, "latitude": None,
        "longitude": None, "icon": None, "vc_position": None, "vc_priority": None,
        "width_mm": None, "height_mm": None, "depth_mm": None,
        "effective_width_mm": None, "effective_height_mm": None,
        "effective_depth_mm": None, "din_offset_mm": None,
        "location": lambda qs: qs.select_related("location"),
        "cluster": lambda qs: qs.select_related("cluster"),
        "room": lambda qs: qs.prefetch_related("room"),
        "din_rail": lambda qs: qs.prefetch_related("din_rail"),
        "config_template": _device_config_template,
        "interface_count": _device_count("interface_count", "Interface"),
        "install_count": _device_count("install_count", "InstalledSoftware"),
    },
)


# ─── Interfaces ──────────────────────────────────────────────────────────────

def interface_table_rows():
    """The interface list's base for the slim row: no far end, no addresses,
    no MAC objects, parents, bundles or children - the full row's eight
    reverse prefetches that the table never reads (#483, #487)."""
    from core.tags import TAGS

    from .models import VLAN, CableTermination, Interface, PortReservation, TunnelTermination

    return (
        Interface.objects.select_related("device", "vlan", "vlan__zone", "vrf", "status")
        .prefetch_related(
            TAGS,
            listed.prefetch(
                "terminations", CableTermination.objects.select_related("cable__status"),
            ),
            listed.prefetch(
                "reservations", PortReservation.objects.select_related("claimed_by"),
            ),
            listed.prefetch("tagged_vlans", VLAN.objects.select_related("zone")),
            listed.prefetch(
                "tunnel_terminations", TunnelTermination.objects.select_related("tunnel"),
            ),
        )
        .order_by(natural("device__name"), natural("name"))
    )


INTERFACE_TABLE = TableSpec(
    facets={
        "device": fk("device"),
        # Null is Active - how an interface's status reads everywhere, and
        # the key the list's links have always used.
        "status": fk("status", color="color", none_label="Active", none_key="none",
                     text=True),
        "tags": TAGS_FACET,
    },
    sorts={
        "device": Sort((natural("device__name"), natural("name"))),
        "name": Sort((natural("name"), natural("device__name"))),
        "status": nat("status__name"),
        "vlan": by("vlan__vlan_id"),
        "vrf": nat("vrf__name"),
        "type": nat("type"),
        "tags": _tags_sort(),
        "updated": by("updated_at"),
    },
    fields=(
        "id", "device", "name", "label", "type", "virtual", "mgmt_only",
        "combo_group", "snmp_name", "snmp_ignore", "tunnel_terminations",
        "enabled", "status", "speed", "mtu", "mode", "vlan", "tagged_vlans",
        "cable", "cable_count", "reservation", "mark_connected", "tags",
        "description", "custom_fields", "created_at", "updated_at",
    ),
    cheap={
        "is_uplink": None, "never_uplink": None, "evpn_mh_uplink": None,
        "duplex": None, "poe_mode": None, "poe_type": None, "wwn": None,
        "mac_address": None, "hide_label": None, "label_color": None,
        "lag_protocol": None, "lacp_mode": None, "lacp_rate": None,
        "lag_min_links": None, "lag_mode": None, "lag_hash_policy": None,
        "lag_miimon": None, "macsec_enabled": None, "macsec_cipher": None,
        "macsec_replay_window": None, "module_id": None, "vrf": None,
        "macsec_keychain": lambda qs: qs.select_related("macsec_keychain"),
    },
)


# ─── Cables ──────────────────────────────────────────────────────────────────

def _cable_type_labels():
    from .models import Cable

    return {k: str(v) for k, v in Cable._meta.get_field("type").flatchoices}


CABLE_TABLE = TableSpec(
    facets={
        "type": Facet(field="type", blank=True, labels=_cable_type_labels),
        "status": fk("status", color="color", none_label="No status", text=True),
        "tags": TAGS_FACET,
    },
    sorts={
        "status": nat("status__name"),
        "label": nat("label"),
        "type": nat("type"),
        "tags": _tags_sort(),
        "updated": by("updated_at"),
    },
    fields=(
        "id", "numid", "label", "type", "type_display", "status", "description",
        "fiber_count", "strands", "is_fiber", "a_terminations", "b_terminations",
        "tags", "custom_fields", "created_at", "updated_at",
    ),
    cheap={"length": None, "length_unit": None, "length_source": None, "color": None,
           "pve_vnet": None},
)


# ─── Virtual machines ────────────────────────────────────────────────────────

VM_TABLE = TableSpec(
    facets={
        "cluster": value("cluster__name"),
        "group": value("group__name"),
        "status": fk("status", color="color", none_label="No status", text=True),
        "power": value("power_state"),
        "synced_from": value("synced_from"),
        "site": fk("site", none_label="No site"),
        "role": fk("role", color="color", none_label="No role"),
        "platform": fk("platform", none_label="No platform"),
        "eol": Facet(kind="buckets", buckets=_eol_buckets("platform__eol_mapping__")),
        "software_version": value("software_version"),
        "software_target": Facet(kind="buckets", prepare=_software_target_prepare,
                                 buckets=_software_target_buckets),
        "tags": TAGS_FACET,
    },
    sorts={
        "name": nat("name"),
        "cluster": nat("cluster__name"),
        "group": nat("group__name"),
        "status": nat("status__name"),
        "power": by("power_state"),
        "synced_from": nat("synced_from"),
        "vcpus": by("vcpus"),
        "memory": by("memory_mb"),
        "disk": by("disk_gb"),
        "site": nat("site__name"),
        "role": nat("role__name"),
        "platform": nat("platform__name"),
        "eol": _eol_sort("platform__eol_mapping__"),
        "lifecycle_next": _lifecycle_sort(device=False),
        "software_version": nat("software_version"),
        "software_target": Sort(("_software_target",), _software_target_prepare),
        "device_profiles": _profiles_sort("virtual_machine"),
        "tags": _tags_sort(),
        "updated": by("updated_at"),
    },
    fields=(
        "id", "numid", "name", "cluster", "group", "status",
        "power_state", "power_state_at", "synced_from", "synced_from_id", "vcpus",
        "memory_mb", "disk_gb", "primary_ip", "site", "role", "platform",
        "lifecycle_next", "software_version", "device_profiles", "tags",
        "description", "custom_fields", "created_at", "updated_at",
    ),
    cheap={
        "device": None, "represents_device": None, "intended": None, "vmid": None,
        "cpu_type": None, "sockets": None, "image": None, "storage": None,
        "missing_since": None, "software_version_seen_at": None,
        "software_version_source": None, "hypervisor_options": None,
    },
)


__all__ = ["CABLE_TABLE", "DEVICE_TABLE", "INTERFACE_TABLE", "VM_TABLE",
           "device_table_rows", "interface_table_rows"]
