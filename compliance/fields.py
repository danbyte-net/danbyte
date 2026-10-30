"""The fields a compliance rule can name, per object type.

A rule's scope and conditions (``core.expressions``) name logical keys, never
model attributes: each type lists what it offers here, with the ORM path and
the kind that decides the operators and the value control. Anything not
listed - JSON blobs, layout fields, credentials - cannot be reached.

One key means one field: wherever two types share a key, the kind and the
referenced catalog agree (``tests_expressions`` pins this). A device role and
an IP role are different catalogs, so they are ``role`` and ``ip_role``.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from core.expressions import FieldDef

from .models import OBJECT_TYPES


@dataclass(frozen=True)
class RefModel:
    model: str
    #: List endpoint the builder's value picker reads (its own RBAC applies).
    api: str
    #: How a value draws: "status" (StatusBadge), "color" (ColorBadge with the
    #: row's colour), "" (a neutral pill).
    badge: str
    noun: str
    #: Deployment-global rows (tenant NULL) count as the tenant's (tags).
    shared_null_tenant: bool = False


REF_MODELS: dict[str, RefModel] = {
    "status": RefModel("api.Status", "/api/statuses/?picker=1", "status", "status"),
    "devicerole": RefModel("api.DeviceRole", "/api/device-roles/", "color", "device role"),
    "platform": RefModel("api.Platform", "/api/platforms/", "", "platform"),
    "site": RefModel("api.Site", "/api/sites/?picker=1", "color", "site"),
    "region": RefModel("api.Region", "/api/regions/", "color", "region"),
    "location": RefModel("api.Location", "/api/locations/", "color", "location"),
    "rack": RefModel("api.Rack", "/api/racks/", "", "rack"),
    "cluster": RefModel("api.Cluster", "/api/clusters/", "", "cluster"),
    "devicetype": RefModel("api.DeviceType", "/api/device-types/", "", "device type"),
    "manufacturer": RefModel("api.Manufacturer", "/api/manufacturers/", "", "manufacturer"),
    "deviceprofile": RefModel("profiles.DeviceProfile", "/api/device-profiles/", "color",
                              "device profile"),
    "tag": RefModel("core.Tag", "/api/tags/?picker=1", "color", "tag", shared_null_tenant=True),
    "vrf": RefModel("api.VRF", "/api/vrfs/?picker=1", "color", "VRF"),
    "vlangroup": RefModel("api.VLANGroup", "/api/vlan-groups/", "", "VLAN group"),
    "zone": RefModel("api.Zone", "/api/zones/?picker=1", "color", "zone"),
    "iprole": RefModel("api.IPRole", "/api/ip-roles/?picker=1", "color", "IP role"),
    "virtualmachinegroup": RefModel("api.VirtualMachineGroup", "/api/vm-groups/", "",
                                    "VM group"),
    "device": RefModel("api.Device", "/api/devices/?picker=1", "", "device"),
}

_PROFILE_STATES = (
    ("ok", "In step"), ("missing", "Missing items"), ("edited", "Edited items"),
    ("pending", "Pending"),
)

#: Custom-field type → expression kind. Object references are matched on
#: presence only: their value is an id of some other catalog.
_CF_KINDS = {
    "text": "string", "textarea": "string", "url": "string", "integer": "number",
    "decimal": "number", "boolean": "bool", "date": "date", "select": "choice",
    "multiselect": "choice", "object": "ref",
}
_CF_KEY = re.compile(r"^[A-Za-z0-9_-]+$")
_PRESENCE = ("empty", "not_empty")


def model_for(object_type: str):
    from .engine import _models

    return _models()[object_type]


def ref_model(ref: str):
    from django.apps import apps

    return apps.get_model(REF_MODELS[ref].model)


def _s(key, label, path=None, **kw):
    return FieldDef(key=key, label=label, kind="string", path=path or key, **kw)


def _ref(key, label, ref, path=None):
    return FieldDef(key=key, label=label, kind="ref", path=path or key, ref=ref)


def _tags(model) -> FieldDef:
    def holders(values):
        from django.contrib.contenttypes.models import ContentType

        from core.models import TaggedItem

        qs = TaggedItem.objects.filter(content_type=ContentType.objects.get_for_model(model))
        if values is not None:
            qs = qs.filter(tag_id__in=values)
        return qs.values("object_id")

    return FieldDef(key="tags", label="Tags", kind="tags", ref="tag", holders=holders)


def _profiles(fk: str) -> list[FieldDef]:
    def assignments():
        from profiles.models import DeviceProfileAssignment

        return DeviceProfileAssignment.objects.filter(**{f"{fk}__isnull": False})

    def by_profile(values):
        qs = assignments()
        if values is not None:
            qs = qs.filter(profile_id__in=values)
        return qs.values(fk)

    def by_state(values):
        qs = assignments()
        if values is not None:
            qs = qs.filter(state__in=values)
        return qs.values(fk)

    return [
        FieldDef(key="profile", label="Device profile", kind="ref", ref="deviceprofile",
                 holders=by_profile),
        FieldDef(key="profile_state", label="Profile state", kind="choice",
                 choices=_PROFILE_STATES, holders=by_state),
    ]


def _number(key, label):
    return FieldDef(key=key, label=label, kind="number", path=key, text=False)


def _presence(key, label, path=None):
    return FieldDef(key=key, label=label, kind="ref", path=path or key, ops=_PRESENCE)


def _static_fields(object_type: str) -> list[FieldDef]:
    """The type's own fields, custom fields aside."""
    model = model_for(object_type)
    status = _ref("status", "Status", "status")
    site = _ref("site", "Site", "site")
    region = _ref("region", "Region", "region", "site__region")
    tags = _tags(model)
    if object_type == "device":
        return [
            _s("name", "Name"), _s("description", "Description"),
            _s("software_version", "Software version"),
            _s("serial_number", "Serial number"), _s("asset_tag", "Asset tag"),
            status, _ref("role", "Device role", "devicerole"),
            _ref("platform", "Platform", "platform"), site, region,
            _ref("location", "Location", "location"), _ref("rack", "Rack", "rack"),
            _ref("cluster", "Cluster", "cluster"),
            _ref("device_type", "Device type", "devicetype"),
            _ref("manufacturer", "Manufacturer", "manufacturer", "device_type__manufacturer"),
            _presence("primary_ip", "Primary IP"),
            FieldDef(key="warranty_end", label="Warranty end", kind="date",
                     path="warranty_end", text=False),
            tags, *_profiles("device"),
        ]
    if object_type == "virtualmachine":
        return [
            _s("name", "Name"), _s("description", "Description"),
            _s("software_version", "Software version"),
            status, _ref("role", "Device role", "devicerole"),
            _ref("platform", "Platform", "platform"), site, region,
            _ref("cluster", "Cluster", "cluster"),
            _ref("vm_group", "VM group", "virtualmachinegroup", "group"),
            _ref("host", "Host device", "device", "device"),
            _number("vcpus", "vCPUs"), _number("memory_mb", "Memory (MB)"),
            _number("disk_gb", "Disk (GB)"),
            _presence("primary_ip", "Primary IP"),
            tags, *_profiles("virtual_machine"),
        ]
    if object_type == "prefix":
        return [
            _s("prefix", "Prefix", "cidr"), _s("description", "Description"), status,
            site, region, _ref("location", "Location", "location"),
            _ref("vrf", "VRF", "vrf"), _presence("vlan", "VLAN"), tags,
        ]
    if object_type == "ipaddress":
        return [
            _s("address", "Address", "ip_address", text=False),
            _s("dns_name", "DNS name"), _s("description", "Description"),
            _s("mac_address", "MAC address"), status,
            _ref("ip_role", "IP role", "iprole", "role"), site, region,
            _ref("vrf", "VRF", "vrf"),
            _presence("assigned_device", "Assigned device"),
            FieldDef(key="discovered", label="Discovered", kind="bool", path="discovered",
                     text=False),
            FieldDef(key="monitoring_excluded", label="Monitoring excluded", kind="bool",
                     path="monitoring_excluded", text=False),
            tags,
        ]
    if object_type == "vlan":
        return [
            _s("name", "Name"),
            FieldDef(key="vid", label="VLAN ID", kind="number", path="vlan_id", text=False),
            _s("description", "Description"), status, site, region,
            _ref("vlan_group", "VLAN group", "vlangroup", "group"),
            _ref("zone", "Zone", "zone"), _ref("vrf", "VRF", "vrf"), tags,
        ]
    if object_type == "vrf":
        return [_s("name", "Name"), _s("rd", "Route distinguisher"),
                _s("description", "Description"), tags]
    if object_type == "site":
        return [
            _s("name", "Name"), _s("description", "Description"),
            _ref("region", "Region", "region"), _s("time_zone", "Time zone"), tags,
        ]
    return []


def _cf_fields(tenant, object_type: str, cf_rows=None) -> list[FieldDef]:
    from customization.models import CustomField

    rows = cf_rows if cf_rows is not None else list(
        CustomField.objects.filter(tenant=tenant).only(
            "key", "label", "type", "applies_to", "choices"
        )
    )
    out = []
    for cf in rows:
        if object_type not in (cf.applies_to or []):
            continue
        if not _CF_KEY.match(cf.key or "") or "__" in cf.key:
            continue
        kind = _CF_KINDS.get(cf.type, "string")
        choices = tuple((str(c), str(c)) for c in (cf.choices or [])) if kind == "choice" else ()
        out.append(FieldDef(
            key=f"cf.{cf.key}", label=cf.label or cf.key, kind=kind,
            path=f"custom_fields__{cf.key}", json=True,
            json_list=cf.type == "multiselect", choices=choices,
            ops=_PRESENCE if cf.type == "object" else None,
            text=kind == "string",
        ))
    return out


class Registry:
    """The fields of each object type in one tenant, read once per use."""

    def __init__(self, tenant):
        self.tenant = tenant
        self._by_type: dict[str, dict[str, FieldDef]] = {}
        self._cf_rows = None

    def _cfs(self):
        if self._cf_rows is None:
            from customization.models import CustomField

            self._cf_rows = list(
                CustomField.objects.filter(tenant=self.tenant).only(
                    "key", "label", "type", "applies_to", "choices"
                )
            ) if self.tenant is not None else []
        return self._cf_rows

    def of(self, object_type: str) -> dict[str, FieldDef]:
        if object_type not in self._by_type:
            fields = _static_fields(object_type) + _cf_fields(
                self.tenant, object_type, self._cfs()
            )
            self._by_type[object_type] = {f.key: f for f in fields}
        return self._by_type[object_type]

    def field_on(self, object_type: str):
        own = self.of(object_type)
        return own.get

    def union(self, types: list[str]) -> dict[str, tuple[FieldDef, list[str]]]:
        """``key → (field, the chosen types that have it)``, in a stable order,
        plus the ``type`` pseudo-field."""
        out: dict[str, tuple[FieldDef, list[str]]] = {
            "type": (type_field(types), list(types)),
        }
        for t in types:
            for key, f in self.of(t).items():
                if key in out:
                    first, have = out[key]
                    if first.shape() == f.shape():
                        have.append(t)
                    continue
                out[key] = (f, [t])
        return out

    def field_for(self, types: list[str]):
        """The lookup ``core.expressions.validate`` takes for these types."""
        u = self.union(types)

        def get(key):
            hit = u.get(key)
            return hit[0] if hit else None

        return get


def type_field(types: list[str]) -> FieldDef:
    return FieldDef(
        key="type", label="Object type", kind="type",
        choices=tuple((t, OBJECT_TYPES[t]) for t in types if t in OBJECT_TYPES),
    )


def payload(registry: Registry, types: list[str]) -> list[dict]:
    """The fields endpoint's rows: names and shapes only, never data."""
    out = []
    for key, (f, have) in registry.union(types).items():
        row = {
            "key": key,
            "label": f.label,
            "kind": f.kind,
            "types": have,
            "ops": list(f.allowed_ops),
            "ref": None,
            "choices": [{"value": v, "label": label} for v, label in f.choices],
        }
        if f.ref:
            r = REF_MODELS[f.ref]
            row["ref"] = {"model": f.ref, "api": r.api, "badge": r.badge, "noun": r.noun}
        out.append(row)
    return out
