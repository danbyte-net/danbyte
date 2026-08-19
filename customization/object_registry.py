"""Registries that make custom fields model-aware - both are extensible at
runtime so a future plugin can join with one call from its AppConfig.ready().

1. **Customizable models** - what a custom field can attach to
   (``applies_to``). Auto-derived: every installed model that mixes in
   :class:`core.models.CustomFieldsMixin` qualifies, labelled by its
   ``verbose_name_plural``. Plugins that keep their JSONB elsewhere can
   still opt in via :func:`register_customizable_model`.

2. **Reference models** - what an *object-reference* custom field can point
   at (the "dropbox of users / groups / devices"). Each entry names the
   model, its list endpoint, and how to label an instance. Plugins add
   theirs via :func:`register_reference_model`.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from django.apps import apps

# ─── Customizable models (applies_to) ────────────────────────────────────────

# Plugin-registered extras: slug → label.
_EXTRA_CUSTOMIZABLE: dict[str, str] = {}


def register_customizable_model(slug: str, label: str) -> None:
    """Let a plugin's model appear in the custom-field ``applies_to`` list."""
    _EXTRA_CUSTOMIZABLE[slug] = label
    customizable_models.cache_clear()


@lru_cache(maxsize=1)
def customizable_models() -> list[tuple[str, str]]:
    """(slug, label) for every model carrying CustomFieldsMixin, plus
    registered extras. Lazy - the app registry isn't ready at import time."""
    from core.models import CustomFieldsMixin

    out: dict[str, str] = {}
    for model in apps.get_models():
        if issubclass(model, CustomFieldsMixin) and not model._meta.abstract:
            out[model._meta.model_name] = str(
                model._meta.verbose_name_plural
            ).capitalize()
    out.update(_EXTRA_CUSTOMIZABLE)
    return sorted(out.items(), key=lambda kv: kv[1].lower())


def customizable_model_values() -> set[str]:
    return {slug for slug, _ in customizable_models()}


# ─── Reference models (object-type custom fields) ───────────────────────────

@dataclass(frozen=True)
class ReferenceModel:
    slug: str
    label: str
    app_model: str          # "api.Device" - resolved lazily via apps registry
    endpoint: str           # SPA list endpoint
    # The attribute holding the display label. None → the model's own __str__,
    # for models whose bare field is ambiguous (an interface name is unique only
    # per device, so "Gi2/1" needs its device to mean anything).
    label_field: str | None = "name"
    picker: bool = True     # endpoint supports ?picker=1
    # ORM lookup from this model to its Tenant. A *lookup path* is allowed, not
    # just a local field: models with indirect tenancy (Interface and friends
    # have no tenant FK) say "device__tenant". None → global (users, groups) and
    # skips tenant filtering entirely, so never use it to paper over a bad path.
    tenant_field: str | None = "tenant"
    route: str | None = None  # SPA detail route template ("/devices/$id")
    # Joins resolve_labels should follow - needed when the label comes from
    # __str__ and reaches through a relation, or a 200-id batch is an N+1.
    select_related: tuple[str, ...] = ()

    @property
    def model(self):
        return apps.get_model(self.app_model)


_REFERENCE: dict[str, ReferenceModel] = {}


def register_reference_model(entry: ReferenceModel) -> None:
    """Make a model referenceable by object custom fields. Plugins call this
    from AppConfig.ready() with their own entry."""
    _REFERENCE[entry.slug] = entry


def reference_models() -> dict[str, ReferenceModel]:
    return dict(_REFERENCE)


def reference_model(slug: str) -> ReferenceModel | None:
    return _REFERENCE.get(slug)


for _e in [
    ReferenceModel("user", "Users", "auth.User", "/api/users/",
                   label_field="username", picker=False, tenant_field=None,
                   route=None),
    ReferenceModel("group", "Groups", "auth.Group", "/api/groups/",
                   picker=False, tenant_field=None, route=None),
    ReferenceModel("device", "Devices", "api.Device", "/api/devices/",
                   route="/devices/$id"),
    ReferenceModel("devicetype", "Device types", "api.DeviceType",
                   "/api/device-types/", route="/device-types/$id"),
    ReferenceModel("devicerole", "Device roles", "api.DeviceRole",
                   "/api/device-roles/", route="/device-roles/$id"),
    ReferenceModel("platform", "Platforms", "api.Platform",
                   "/api/platforms/", route="/platforms/$id"),
    ReferenceModel("manufacturer", "Manufacturers", "api.Manufacturer",
                   "/api/manufacturers/", route="/manufacturers/$id"),
    ReferenceModel("moduletype", "Module types", "api.ModuleType",
                   "/api/module-types/", route="/module-types/$id"),
    ReferenceModel("rack", "Racks", "api.Rack", "/api/racks/",
                   route="/racks/$id"),
    ReferenceModel("site", "Sites", "api.Site", "/api/sites/",
                   route="/sites/$id"),
    ReferenceModel("location", "Locations", "api.Location",
                   "/api/locations/", route="/locations/$id"),
    ReferenceModel("region", "Regions", "api.Region", "/api/regions/",
                   route="/regions/$id"),
    ReferenceModel("tenant", "Tenants", "core.Tenant", "/api/tenants/",
                   tenant_field=None, route="/tenants/$id"),
    ReferenceModel("vlan", "VLANs", "api.VLAN", "/api/vlans/",
                   route="/vlans/$id"),
    ReferenceModel("vrf", "VRFs", "api.VRF", "/api/vrfs/",
                   route="/vrfs/$id"),
    ReferenceModel("prefix", "Prefixes", "api.Prefix", "/api/prefixes/",
                   label_field="cidr", picker=False, route="/prefixes/$id"),
    ReferenceModel("ipaddress", "IP addresses", "api.IPAddress", "/api/ips/",
                   label_field="ip_address", picker=False, route="/ips/$id"),
    # Interfaces carry no tenant FK - scope through the device, exactly as
    # InterfaceViewSet does. The label is the device-qualified __str__ because
    # "Gi2/1" alone doesn't identify anything (unique_together device+name).
    ReferenceModel("interface", "Interfaces", "api.Interface",
                   "/api/interfaces/", label_field=None,
                   tenant_field="device__tenant", select_related=("device",),
                   route="/interfaces/$id"),
    ReferenceModel("cluster", "Clusters", "api.Cluster", "/api/clusters/",
                   route="/clusters/$id"),
    ReferenceModel("virtualmachine", "Virtual machines", "api.VirtualMachine",
                   "/api/virtual-machines/", route="/virtual-machines/$id"),
    ReferenceModel("contact", "Contacts", "api.Contact", "/api/contacts/",
                   route="/contacts/$id"),
    ReferenceModel("provider", "Providers", "api.Provider", "/api/providers/",
                   route="/providers/$id"),
    ReferenceModel("circuit", "Circuits", "api.Circuit", "/api/circuits/",
                   label_field="cid", route="/circuits/$id"),
]:
    register_reference_model(_e)


def resolve_labels(slug: str, ids: list[str], tenant=None) -> list[dict]:
    """Bulk id → {id, label, route} for display of object-field values.
    Unknown ids are silently dropped (the caller shows the raw id)."""
    ref = reference_model(slug)
    if ref is None or not ids:
        return []
    qs = ref.model.objects.filter(pk__in=ids)
    if ref.select_related:
        qs = qs.select_related(*ref.select_related)
    if ref.tenant_field and tenant is not None:
        qs = qs.filter(**{ref.tenant_field: tenant})
    out = []
    for obj in qs:
        label = getattr(obj, ref.label_field, None) if ref.label_field else None
        label = label or str(obj)
        out.append({
            "id": str(obj.pk),
            "label": str(label),
            "route": ref.route.replace("$id", str(obj.pk)) if ref.route else None,
        })
    return out
