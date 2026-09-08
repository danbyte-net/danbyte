"""The global search index (#89): what gets indexed, how each object is
flattened into a :class:`~api.models.SearchEntry`, and the hooks that keep
the table current.

One spec per navigable type. Titles and bodies are built generically from
the fields a model has (name, description, comments, custom-field values,
the short id, …) with a handful of per-type overrides; facets are the
lower-cased name and slug of the object's site, role, status, platform,
type, VRF, cluster, provider, manufacturer, group and tags, so a
``site:esbjerg`` token is a JSON containment test on the row.
"""
from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass

from django.apps import apps
from django.db import transaction

logger = logging.getLogger(__name__)

# Body text is capped so a wall of comments cannot swamp the trigram index.
_BODY_MAX = 4000


_LIGATURES = str.maketrans({"æ": "ae", "Æ": "AE", "ø": "o", "Ø": "O", "ß": "ss", "œ": "oe", "Œ": "OE"})


def fold(value) -> str:
    """Python twin of the SQL ``danbyte_fold``: lowercase, accents stripped
    the way ``unaccent`` does it, and the Danish "aa" collapsed to "a" so
    ``aarhus``, ``arhus`` and ``Århus`` are the same key."""
    text = unicodedata.normalize("NFKD", str(value or "")).translate(_LIGATURES)
    text = "".join(c for c in text if not unicodedata.combining(c)).lower().strip()
    return text.replace("aa", "a")


@dataclass(frozen=True)
class IndexSpec:
    model: str                      # "app_label.ModelName"
    url: str                        # "/devices/{id}"
    tenant: str = "tenant"          # attribute path to the tenant
    site: str | None = "site"       # attribute path to the site (None = no site)
    weight: int = 5                 # 0-10, added to the score as weight/10
    title: str | None = None        # attribute path, or None for the generic pick
    subtitle: str | None = None     # attribute path shown under the title
    body: tuple[str, ...] = ()      # extra attribute paths folded into the body
    facets: tuple[str, ...] = ()    # extra facet attribute paths (key = last segment)


# Ordered by the weight a hit should carry when everything else is equal:
# the things people navigate to most rank above catalog rows.
SPECS: dict[str, IndexSpec] = {
    "device": IndexSpec("api.Device", "/devices/{id}", weight=10, subtitle="device_type.model",
                        body=("device_type.model", "device_type.manufacturer.name",
                              "primary_ip.ip_address", "platform.name", "rack.name"),
                        facets=("role", "status", "platform", "device_type", "cluster", "rack")),
    "prefix": IndexSpec("api.Prefix", "/prefixes/{id}", weight=10, title="cidr",
                        subtitle="description", body=("vrf.name",), facets=("status", "role", "vrf")),
    "ipaddress": IndexSpec("api.IPAddress", "/ips/{id}", weight=9, title="ip_address",
                           subtitle="dns_name", body=("dns_name", "reservation_note",
                                                      "assigned_device.name", "mac_address"),
                           facets=("status", "role", "vrf")),
    "site": IndexSpec("api.Site", "/sites/{id}", weight=10, site=None,
                      subtitle="description", body=("location", "region.name"), facets=("status", "region")),
    "vlan": IndexSpec("api.VLAN", "/vlans/{id}", weight=9, subtitle="description",
                      facets=("status", "role", "group")),
    "virtualmachine": IndexSpec("api.VirtualMachine", "/virtual-machines/{id}", weight=9,
                                subtitle="cluster.name", body=("primary_ip.ip_address", "platform.name"),
                                facets=("role", "status", "platform", "cluster")),
    "rack": IndexSpec("api.Rack", "/racks/{id}", weight=8, subtitle="site.name", facets=("status", "role")),
    "location": IndexSpec("api.Location", "/locations/{id}", weight=7, subtitle="site.name"),
    "region": IndexSpec("api.Region", "/regions/{id}", weight=6, site=None),
    "tenant": IndexSpec("core.Tenant", "/tenants/{id}", tenant="", site=None, weight=6),
    "interface": IndexSpec("api.Interface", "/interfaces/{id}", weight=6, tenant="device.tenant",
                           site="device.site", subtitle="device.name",
                           body=("device.name", "mac_address", "dns_name"), facets=("status", "vlan")),
    "macaddress": IndexSpec("api.MACAddress", "/macs/{mac_address}", weight=6, site=None,
                            title="mac_address", subtitle="assigned_interface.device.name"),
    "iprange": IndexSpec("api.IPRange", "/ip-ranges/{id}", weight=8, subtitle="description",
                         facets=("status", "role")),
    "aggregate": IndexSpec("api.Aggregate", "/aggregates/{id}", weight=7, site=None, title="prefix",
                           subtitle="description", facets=("rir",)),
    "asn": IndexSpec("api.ASN", "/asns/{id}", weight=6, site=None, title="asn", subtitle="description",
                     facets=("rir",)),
    "vrf": IndexSpec("api.VRF", "/vrfs/{id}", weight=8, site=None, subtitle="rd", body=("rd",)),
    "routetarget": IndexSpec("api.RouteTarget", "/route-targets/{id}", weight=5, site=None),
    "vlangroup": IndexSpec("api.VLANGroup", "/vlan-groups/{id}", weight=5),
    "zone": IndexSpec("api.Zone", "/zones/{id}", weight=5, site=None),
    "fhrpgroup": IndexSpec("api.FHRPGroup", "/fhrp-groups/{id}", weight=5, site=None),
    "service": IndexSpec("api.Service", "/services/{id}", weight=6, site="device.site",
                         subtitle="device.name", body=("device.name",)),
    "servicetemplate": IndexSpec("api.ServiceTemplate", "/service-templates/{id}", weight=4, site=None),
    "iprole": IndexSpec("api.IPRole", "/ip-roles/{id}", weight=4, site=None),
    "rir": IndexSpec("api.RIR", "/rirs/{id}", weight=4, site=None),
    "circuit": IndexSpec("api.Circuit", "/circuits/{id}", weight=8, site=None, title="cid",
                         subtitle="provider.name", facets=("status", "provider", "type")),
    "provider": IndexSpec("api.Provider", "/providers/{id}", weight=6, site=None),
    "providernetwork": IndexSpec("api.ProviderNetwork", "/provider-networks/{id}", weight=5, site=None,
                                 subtitle="provider.name", facets=("provider",)),
    "circuittype": IndexSpec("api.CircuitType", "/circuit-types/{id}", weight=4, site=None),
    "powerpanel": IndexSpec("api.PowerPanel", "/power-panels/{id}", weight=6, subtitle="site.name"),
    "powerfeed": IndexSpec("api.PowerFeed", "/power-feeds/{id}", weight=6, site="power_panel.site",
                           subtitle="power_panel.name", facets=("status",)),
    "wirelesslan": IndexSpec("api.WirelessLAN", "/wireless-lans/{id}", weight=7, site=None,
                             title="ssid", facets=("status", "group")),
    "wirelesslangroup": IndexSpec("api.WirelessLANGroup", "/wireless-lan-groups/{id}", weight=4, site=None),
    "tunnel": IndexSpec("api.Tunnel", "/tunnels/{id}", weight=7, site=None, facets=("status", "group")),
    "tunnelgroup": IndexSpec("api.TunnelGroup", "/tunnel-groups/{id}", weight=4, site=None),
    "ipsecprofile": IndexSpec("api.IPSecProfile", "/ipsec-profiles/{id}", weight=4, site=None),
    "l2vpn": IndexSpec("api.L2VPN", "/l2vpns/{id}", weight=7, site=None, facets=("status",)),
    "devicetype": IndexSpec("api.DeviceType", "/device-types/{id}", weight=6, site=None,
                            subtitle="manufacturer.name", body=("model", "part_number"),
                            facets=("manufacturer",)),
    "moduletype": IndexSpec("api.ModuleType", "/module-types/{id}", weight=5, site=None,
                            subtitle="manufacturer.name", body=("part_number",), facets=("manufacturer",)),
    "manufacturer": IndexSpec("api.Manufacturer", "/manufacturers/{id}", weight=5, site=None),
    "devicerole": IndexSpec("api.DeviceRole", "/device-roles/{id}", weight=4, site=None),
    "platform": IndexSpec("api.Platform", "/platforms/{id}", weight=5, site=None,
                          subtitle="manufacturer.name"),
    "platformgroup": IndexSpec("api.PlatformGroup", "/platform-groups/{id}", weight=4, site=None),
    "rackrole": IndexSpec("api.RackRole", "/rack-roles/{id}", weight=4, site=None),
    "racktype": IndexSpec("api.RackType", "/rack-types/{id}", weight=4, site=None),
    "cable": IndexSpec("api.Cable", "/cables/{id}", weight=5, site=None, title="label",
                       facets=("status",)),
    "virtualchassis": IndexSpec("api.VirtualChassis", "/virtual-chassis/{id}", weight=8,
                                site="master.site", subtitle="master.name", body=("domain",)),
    "floorplan": IndexSpec("api.FloorPlan", "/floorplans/{id}", weight=6, subtitle="site.name"),
    "cluster": IndexSpec("api.Cluster", "/clusters/{id}", weight=7, subtitle="type.name",
                         facets=("type", "group")),
    "clustertype": IndexSpec("api.ClusterType", "/cluster-types/{id}", weight=4, site=None),
    "clustergroup": IndexSpec("api.ClusterGroup", "/cluster-groups/{id}", weight=4, site=None),
    "virtualswitch": IndexSpec("api.VirtualSwitch", "/virtual-switches/{id}", weight=5, site=None),
    "contact": IndexSpec("api.Contact", "/contacts/{id}", weight=6, site=None, subtitle="title",
                         body=("title", "email", "phone")),
    "contactgroup": IndexSpec("api.ContactGroup", "/contact-groups/{id}", weight=4, site=None),
    "contactrole": IndexSpec("api.ContactRole", "/contact-roles/{id}", weight=3, site=None),
    "certificaterequest": IndexSpec("monitoring.CertificateRequest", "/certificate-requests/{id}",
                                    weight=5, site=None, title="common_name"),
    "compliancerule": IndexSpec("compliance.ComplianceRule", "/compliance-rules/{id}", weight=4, site=None),
    "configcontext": IndexSpec("api.ConfigContext", "/config-contexts/{id}", weight=4, site=None),
    "exporttemplate": IndexSpec("api.ExportTemplate", "/export-templates/{id}", weight=3, site=None),
    "status": IndexSpec("api.Status", "/statuses/{id}", weight=3, site=None),
    "tag": IndexSpec("core.Tag", "/tags/{id}", weight=4, site=None),
    "dnszone": IndexSpec("integrations.DnsZone", "/dns-zones/{id}", weight=6, site=None),
    "dnsrecord": IndexSpec("integrations.DnsRecord", "/dns-records/{id}", weight=5, site=None,
                           tenant="zone.tenant", subtitle="zone.name", body=("zone.name", "value")),
    "windowsserverconnection": IndexSpec("integrations.WindowsServerConnection", "/windows-servers/{id}",
                                         weight=4, site=None, body=("host",)),
    "virtualizationsource": IndexSpec("integrations.VirtualizationSource", "/virtualization-sources/{id}",
                                      weight=4, site=None, body=("host",)),
    "automationtarget": IndexSpec("integrations.AutomationTarget", "/automation-targets/{id}",
                                  weight=3, site=None),
}

# Where the generic title comes from, first hit wins.
_TITLE_CANDIDATES = ("name", "ssid", "cid", "cidr", "prefix", "ip_address", "mac_address",
                     "asn", "common_name", "label")
# Generic body contributors.
_BODY_CANDIDATES = ("description", "comments", "slug", "model", "part_number", "serial_number",
                    "asset_tag", "dns_name", "rd", "domain", "host", "reservation_note", "email",
                    "phone", "title")
# Generic facet relations (key = attribute name; device_type is exposed as "type").
_FACET_RELATIONS = ("site", "role", "status", "platform", "device_type", "vrf", "cluster",
                    "provider", "manufacturer", "group", "type", "rir", "region", "rack", "vlan")
_FACET_KEYS = {"device_type": "type"}


def _path(obj, path: str):
    """Follow ``a.b.c`` through related objects; None when any hop is missing."""
    cur = obj
    for part in path.split("."):
        if cur is None:
            return None
        try:
            cur = getattr(cur, part)
        except Exception:  # noqa: BLE001 - a missing relation is "no value"
            return None
    return cur


def _has_field(obj, name: str) -> bool:
    try:
        obj._meta.get_field(name)
    except Exception:  # noqa: BLE001
        return False
    return True


def _facet_values(rel) -> list[str]:
    if rel is None:
        return []
    out = []
    for attr in ("name", "slug", "model", "cid"):
        v = getattr(rel, attr, None)
        if v:
            f = fold(v)
            if f and f not in out:
                out.append(f)
    return out


def _title(obj, spec: IndexSpec) -> str:
    if spec.title:
        v = _path(obj, spec.title)
        if v not in (None, ""):
            return str(v)
    model_name = obj._meta.model_name
    if model_name == "vlan":
        return f"{obj.vlan_id} · {obj.name}"
    if model_name == "iprange":
        return f"{obj.start_address}-{obj.end_address}"
    if model_name == "cable":
        return obj.label or f"Cable #{getattr(obj, 'numid', '') or ''}".rstrip("# ")
    for attr in _TITLE_CANDIDATES:
        if _has_field(obj, attr):
            v = getattr(obj, attr, None)
            if v not in (None, ""):
                return str(v)
    return str(obj)


def _custom_values(obj) -> str:
    values = getattr(obj, "custom_fields", None) or {}
    bits = []
    for v in values.values():
        if isinstance(v, dict):
            v = v.get("name") or v.get("label") or ""
        elif isinstance(v, list):
            v = " ".join(str(x) for x in v)
        if v not in (None, "", False):
            bits.append(str(v))
    return " ".join(bits)


def _body(obj, spec: IndexSpec) -> str:
    bits: list[str] = []
    for attr in _BODY_CANDIDATES:
        if _has_field(obj, attr):
            v = getattr(obj, attr, None)
            if v not in (None, ""):
                bits.append(str(v))
    for path in spec.body:
        v = _path(obj, path)
        if v not in (None, ""):
            bits.append(str(v))
    numid = getattr(obj, "numid", None)
    if numid is not None:
        bits.append(f"#{numid}")
    mac = getattr(obj, "mac_address", None)
    if mac:
        bits.append(re.sub(r"[^0-9a-f]", "", mac.lower()))
    if obj._meta.model_name == "vlan":
        bits.append(str(obj.vlan_id))
    bits.append(_custom_values(obj))
    text = " ".join(b for b in bits if b)
    return text[:_BODY_MAX]


def _facets(obj, spec: IndexSpec) -> dict:
    out: dict = {}
    for attr in (*_FACET_RELATIONS, *spec.facets):
        if not _has_field(obj, attr):
            continue
        try:
            rel = getattr(obj, attr, None)
        except Exception:  # noqa: BLE001
            continue
        if rel is None or isinstance(rel, (str, int)):
            continue
        vals = _facet_values(rel)
        if vals:
            out[_FACET_KEYS.get(attr, attr)] = vals
    if hasattr(obj, "tags") and _has_field(obj, "tags"):
        try:
            tags = [fold(t.name) for t in obj.tags.all()] + [fold(t.slug) for t in obj.tags.all()]
        except Exception:  # noqa: BLE001
            tags = []
        tags = [t for t in dict.fromkeys(tags) if t]
        if tags:
            out["tag"] = tags
    return out


# Relations shown on a result row, in this order. Value is the related
# object's display name; status carries its colour so it renders as a pill.
_CONTEXT_RELATIONS = (
    ("status", "status"), ("site", "site"), ("location", "location"),
    ("region", "region"), ("rack", "rack"), ("role", "role"), ("device", "device"),
    ("vm", "vm"), ("device_type", "type"), ("platform", "platform"),
    ("cluster", "cluster"), ("vrf", "vrf"), ("vlan", "vlan"), ("provider", "provider"),
    ("manufacturer", "manufacturer"), ("group", "group"), ("rir", "rir"),
    ("prefix", "prefix"), ("assigned_device", "device"), ("assigned_interface", "interface"),
    ("primary_ip", "ip"), ("master", "master"), ("zone", "zone"),
)


def _display(rel) -> str:
    for attr in ("name", "model", "cid", "ssid", "cidr", "ip_address", "prefix", "label"):
        v = getattr(rel, attr, None)
        if v:
            if attr == "cidr" or attr == "ip_address" or attr == "prefix":
                return str(v)
            return str(v)
    return str(rel)


def _context(obj, spec: IndexSpec) -> dict:
    out: dict = {}
    for attr, key in _CONTEXT_RELATIONS:
        if key in out or not _has_field(obj, attr):
            continue
        try:
            rel = getattr(obj, attr, None)
        except Exception:  # noqa: BLE001
            continue
        if rel is None or isinstance(rel, (str, int)):
            continue
        if key == "status":
            out["status"] = {
                "name": rel.name,
                "color": getattr(rel, "color", "") or "",
                "text_color": getattr(rel, "text_color", "") or "",
            }
            continue
        if key == "vlan" and getattr(rel, "vlan_id", None) is not None:
            out["vlan"] = f"{rel.vlan_id} · {rel.name}"
            continue
        if key == "rack":
            pos = getattr(obj, "position", None)
            out["rack"] = f"{rel.name} · U{pos}" if pos else rel.name
            continue
        out[key] = _display(rel)
    # Things worth reading off the row that aren't relations.
    for attr, key in (("dns_name", "dns"), ("serial_number", "serial"),
                      ("asset_tag", "asset"), ("part_number", "part")):
        if _has_field(obj, attr):
            v = getattr(obj, attr, None)
            if v:
                out[key] = str(v)
    if obj._meta.model_name == "interface" and getattr(obj, "device_id", None):
        site = getattr(obj.device, "site", None)
        if site is not None:
            out.setdefault("site", site.name)
    if obj._meta.model_name == "virtualmachine":
        vc = getattr(obj, "vcpus", None)
        mem = getattr(obj, "memory_mb", None)
        if vc or mem:
            out["size"] = " · ".join(
                b for b in (f"{vc} vCPU" if vc else "", f"{mem // 1024} GB" if mem and mem % 1024 == 0
                            else f"{mem} MB" if mem else "") if b
            )
    return out


def entry_values(obj, spec: IndexSpec | None = None) -> dict | None:
    """The SearchEntry field values for ``obj``, or None when it must not be
    indexed (no tenant to scope it to)."""
    slug = obj._meta.model_name
    spec = spec or SPECS.get(slug)
    if spec is None:
        return None
    if spec.tenant == "":
        tenant = obj  # the tenant row itself
    else:
        tenant = _path(obj, spec.tenant)
    if tenant is None and slug != "tag":
        return None
    site = _path(obj, spec.site) if spec.site else None
    subtitle = _path(obj, spec.subtitle) if spec.subtitle else None
    numid = getattr(obj, "numid", None)
    return {
        "object_type": slug,
        "object_id": obj.pk,
        "tenant_id": getattr(tenant, "pk", None),
        "site_id": getattr(site, "pk", None) if site is not None and slug != "site" else None,
        "numid": int(numid) if isinstance(numid, int) else None,
        "title": _title(obj, spec)[:255],
        "subtitle": (str(subtitle) if subtitle not in (None, "") else "")[:255],
        "body": _body(obj, spec),
        "facets": _facets(obj, spec),
        "context": _context(obj, spec),
        "url": spec.url.format(id=obj.pk, mac_address=getattr(obj, "mac_address", "")),
        "weight": spec.weight,
    }


def index_object(obj) -> None:
    """Upsert one object's row. Never raises - the index must not break a save."""
    from .models import SearchEntry

    try:
        values = entry_values(obj)
        if values is None:
            SearchEntry.objects.filter(object_type=obj._meta.model_name, object_id=obj.pk).delete()
            return
        SearchEntry.objects.update_or_create(
            object_type=values["object_type"], object_id=values["object_id"], defaults=values
        )
    except Exception:  # noqa: BLE001
        logger.exception("search index: failed to index %s %s", obj._meta.model_name, obj.pk)


def unindex(model, pk) -> None:
    from .models import SearchEntry

    try:
        SearchEntry.objects.filter(object_type=model._meta.model_name, object_id=pk).delete()
    except Exception:  # noqa: BLE001
        logger.exception("search index: failed to drop %s %s", model._meta.model_name, pk)


def indexed_models() -> list:
    out = []
    for spec in SPECS.values():
        try:
            out.append(apps.get_model(spec.model))
        except LookupError:
            continue
    return out


def rebuild(slugs=None, *, log=None) -> dict[str, int]:
    """Rebuild the index for every spec (or the given slugs) - one transaction
    per type so a half-built table is never visible."""
    from .models import SearchEntry

    counts: dict[str, int] = {}
    for slug, spec in SPECS.items():
        if slugs and slug not in slugs:
            continue
        try:
            model = apps.get_model(spec.model)
        except LookupError:
            continue
        rows: list[SearchEntry] = []
        qs = model.objects.all()
        for obj in qs.iterator(chunk_size=500):
            values = entry_values(obj, spec)
            if values is not None:
                rows.append(SearchEntry(**values))
        with transaction.atomic():
            SearchEntry.objects.filter(object_type=slug).delete()
            for i in range(0, len(rows), 1000):
                SearchEntry.objects.bulk_create(rows[i : i + 1000])
        counts[slug] = len(rows)
        if log:
            log(f"{slug}: {len(rows)}")
    return counts


# ─── signals ───────────────────────────────────────────────────────────────

def _on_save(sender, instance, **kwargs):
    if kwargs.get("raw"):
        return
    index_object(instance)


def _on_delete(sender, instance, **kwargs):
    unindex(sender, instance.pk)


def connect_signals() -> None:
    from django.db.models.signals import post_delete, post_save

    for model in indexed_models():
        key = model._meta.label_lower
        post_save.connect(_on_save, sender=model, dispatch_uid=f"search:save:{key}", weak=False)
        post_delete.connect(_on_delete, sender=model, dispatch_uid=f"search:delete:{key}", weak=False)
