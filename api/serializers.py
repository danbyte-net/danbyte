"""DRF serializers — thin JSON projections of the domain models for the v2
React frontend. Kept narrow on purpose: each serializer ships what the
matching list / detail page actually renders, no kitchen-sink output.
"""
from __future__ import annotations

from django.db import transaction
from rest_framework import serializers

from core.models import Tag, Tenant, TenantGroup
from customization.models import (
    CustomField, CustomFieldGroup, customizable_model_values,
)
from .models import (
    Aggregate, ASN, AuxPort, AuxPortTemplate,
    Cable, CableRoute, CableTermination, Circuit, CircuitTermination,
    CircuitType, Cluster, ClusterGroup, ClusterType,
    ConsolePort, ConsolePortTemplate, ConsoleServerPort,
    ConsoleServerPortTemplate,
    Contact, ContactAssignment, ContactGroup, ContactRole,
    Device, DeviceRole, DeviceType, FHRPGroup, FHRPGroupAssignment,
    ImageAttachment,
    FiberSettings,
    FloorPlan, FloorPlanTile, FloorPlanTray, FloorTileType, FrontPort,
    FrontPortTemplate, InterfaceTemplate,
    IPAddress, IPRange, IPRole, Status, Interface, MACAddress, Manufacturer,
    DeviceBay, DeviceBayTemplate, InventoryItem, InventoryItemTemplate,
    TopologyView,
    Module, ModuleBay, ModuleBayTemplate, ModuleInterfaceTemplate, ModuleType,
    NumIdMixin, Platform, PlatformGroup, weight_kg,
    ConfigContext, ExportTemplate, Location, PowerFeed, PowerOutlet,
    PowerOutletTemplate, PowerPanel, PowerPort, PowerPortTemplate,
    Prefix, Provider, ProviderNetwork, Rack, RackRole, RearPort,
    RearPortTemplate, Region, RIR, RouteTarget, Service, ServiceTemplate,
    SiteMarker,
    DeviceTypeService, Site,
    VirtualMachine, VMInterface, VLAN, VLANGroup, VRF, Zone,
    WirelessLAN, WirelessLANGroup,
    Tunnel, TunnelGroup, TunnelTermination, IPSecProfile,
    L2VPN, L2VPNTermination, VirtualChassis,
)


class NumIdModelSerializer(serializers.ModelSerializer):
    """``ModelSerializer`` that auto-exposes a read-only ``numid`` for any model
    that carries it (``NumIdMixin``), so every object surfaces its per-tenant
    human-readable number without each serializer re-listing the field (#82).

    The field is injected into ``get_field_names``; because the model column is
    ``editable=False``, DRF builds it read-only. Models without numid are
    untouched, so swapping this in for ``serializers.ModelSerializer`` is a no-op
    for them.
    """

    def get_field_names(self, declared_fields, info):
        names = super().get_field_names(declared_fields, info)
        model = getattr(getattr(self, "Meta", None), "model", None)
        if (
            model is not None
            and isinstance(model, type)
            and issubclass(model, NumIdMixin)
            and "numid" not in names
        ):
            names = ["numid", *names]
        return names


# Models that carry no ``tenant`` column but ARE tenant-scoped through a parent
# relation — the lookup path used to scope them. Without this, the scoped field
# would pass such models through UNFILTERED, letting a client reference another
# tenant's Interface/VMInterface by id (cross-tenant FK smuggling, issue #59+).
# Tenant-scoped models whose tenant column is NULLABLE and where NULL means
# "legacy / global to the deployment" (pre-scoping tags). NULL rows remain
# referenceable by every tenant; they're just not writable by tenant users.
_NULLABLE_TENANT_MODELS = {"Tag"}

_PARENT_TENANT_PATH = {
    "Interface": "device__tenant",
    "VMInterface": "vm__tenant",
    "FrontPort": "device__tenant",
    "RearPort": "device__tenant",
    "ConsolePort": "device__tenant",
    "ConsoleServerPort": "device__tenant",
    "PowerPort": "device__tenant",
    "PowerOutlet": "device__tenant",
}


class TenantScopedPrimaryKeyRelatedField(serializers.PrimaryKeyRelatedField):
    """A ``PrimaryKeyRelatedField`` whose lookup queryset is scoped to the
    request's active tenant, so tenant A can't reference tenant B's objects by
    posting a foreign ``*_id``. Models with a ``tenant`` field scope on it;
    models that are tenant-scoped through a parent (Interface→device,
    VMInterface→vm, …) scope via ``_PARENT_TENANT_PATH``; genuinely global
    models pass through. With no request context (shell/tests) it passes through
    so internal callers aren't blocked.

    Under **enhanced site separation** the lookup is additionally narrowed for
    site-scoped users (their write grants all carry sites): Site targets to
    their own sites, site-bearing targets to those sites **or NULL-site
    (shared) rows**. Foreign-site FKs then fail at 400 validation instead of
    only at the post-save 403 guard — which stays authoritative either way.
    """

    def get_queryset(self):
        qs = super().get_queryset()
        request = self.context.get("request") if self.context else None
        if request is None or qs is None:
            return qs
        model = qs.model
        if any(f.name == "tenant" for f in model._meta.fields):
            path = "tenant"
        else:
            path = _PARENT_TENANT_PATH.get(model.__name__)
            if path is None:
                return qs  # genuinely global
        from api.views import _get_active_tenant

        tenant = _get_active_tenant(request)
        if tenant is None:
            return qs.none()
        if model.__name__ in _NULLABLE_TENANT_MODELS:
            # Legacy/deployment-global rows (tenant NULL) stay referenceable.
            from django.db.models import Q

            scoped = qs.filter(Q(**{path: tenant}) | Q(**{f"{path}__isnull": True}))
        else:
            scoped = qs.filter(**{path: tenant})
        return _site_fence(scoped, request, tenant)


def _site_fence(qs, request, tenant):
    """Narrow an FK lookup queryset for site-scoped users when enhanced site
    separation is ON. No-op otherwise. ``editable_sites`` is memoised on the
    request — this field is instantiated many times per serializer."""
    from core.effective_settings import separation_enabled

    user = getattr(request, "user", None)
    if user is None or not getattr(user, "is_authenticated", False) or user.is_superuser:
        return qs
    if not separation_enabled(tenant):
        return qs
    if not hasattr(request, "_rbac_editable_sites"):
        from auth_api import rbac

        request._rbac_editable_sites = rbac.editable_sites(user, tenant)
    editable = request._rbac_editable_sites
    if editable is None:
        return qs  # edits any site → no fence
    from django.db.models import Q

    from api.models import Site
    from auth_api.site_paths import CATALOG_SITE_PATHS, SITE_PATHS

    model = qs.model
    if model is Site:
        return qs.filter(pk__in=editable)
    # Placement types AND local/global catalogs (a site-1 device must not be
    # built on site-2's local device type). NULL = shared/global → offerable.
    slug = model._meta.model_name
    site_path = SITE_PATHS.get(slug) or CATALOG_SITE_PATHS.get(slug)
    if site_path and site_path != "id":
        return qs.filter(
            Q(**{f"{site_path}__in": editable})
            | Q(**{f"{site_path}__isnull": True})
        )
    return qs


class OwningSiteSerializerMixin(serializers.Serializer):
    """Local/global catalog fields (enhanced site separation).

    Read: ``owning_site`` = ``{id, name} | null`` — null renders as "Global".
    Write: ``owning_site_id`` — tenant-scoped, and under separation a
    site-scoped user may only pick their own sites (the shared field fence).
    Include both names in ``Meta.fields``.
    """

    owning_site = serializers.SerializerMethodField()
    owning_site_id = TenantScopedPrimaryKeyRelatedField(
        queryset=Site.objects.all(),
        source="owning_site",
        write_only=True,
        required=False,
        allow_null=True,
    )

    def get_owning_site(self, obj) -> dict | None:
        s = getattr(obj, "owning_site", None)
        return {"id": str(s.id), "name": s.name} if s else None


class ObjectPermsSerializerMixin(serializers.Serializer):
    """Adds a read-only ``permissions`` field — ``{"change": bool, "delete":
    bool}`` for the *current user on this specific object*, in the active tenant.

    Unlike the frontend's type-level ``canDo`` map, this is **constraint-aware**:
    a grant restricted to certain rows (e.g. only ``status=active`` prefixes)
    reports ``change: false`` for an object outside that set, so the UI can hide
    an Edit button that would only 403. The API still enforces independently;
    this is presentation, not the boundary.

    The per-action constraint decision is resolved once per request and cached,
    so serializing a list stays cheap: superuser / ungranted / unconstrained
    rows never hit the DB; only a genuinely constrained grant runs one indexed
    ``pk`` lookup per row.

    Set ``rbac_object_type`` on the serializer to override the slug; it defaults
    to the model's ``model_name``.
    """

    rbac_object_type: str | None = None

    permissions = serializers.SerializerMethodField()

    def _rbac_slug(self) -> str:
        return self.rbac_object_type or self.Meta.model._meta.model_name

    def get_permissions(self, obj) -> dict[str, bool]:
        from auth_api import rbac

        request = self.context.get("request")
        if request is None:
            return {"change": False, "delete": False}
        user = getattr(request, "user", None)
        if not getattr(user, "is_authenticated", False):
            return {"change": False, "delete": False}
        if getattr(user, "is_superuser", False):
            return {"change": True, "delete": True}

        from api.views import _get_active_tenant

        slug = self._rbac_slug()
        tenant = _get_active_tenant(request)
        # Per-request memo of the row-filter (constraints + site scope) so a
        # 50-row list resolves the grant once per action, not once per row.
        cache = getattr(request, "_rbac_rowfilter_cache", None)
        if cache is None:
            cache = request._rbac_rowfilter_cache = {}

        out: dict[str, bool] = {}
        for action in ("change", "delete"):
            key = (slug, action)
            if key not in cache:
                cache[key] = rbac.row_filter(user, tenant, slug, action)
            filt = cache[key]
            if filt is None:
                out[action] = False  # not granted
            elif filt is True:
                out[action] = True  # granted, no constraints/site → all rows
            else:
                # Site- and constraint-aware: one indexed pk lookup per row.
                out[action] = (
                    type(obj)._default_manager.filter(pk=obj.pk)
                    .filter(filt)
                    .exists()
                )
        return out


class TaggableSerializerMixin:
    """Persist ``tags`` for serializers backed by django-taggit's
    ``TaggableManager``. Without this, DRF's default ``create()`` /
    ``update()`` silently drops the value because ``tags`` isn't a real
    M2M field on the model — it's a custom manager descriptor.

    Used together with::

        tag_ids = PrimaryKeyRelatedField(source="tags", many=True,
                                         queryset=Tag.objects.all(), ...)

    Semantics:
    - POST / PUT with ``tag_ids`` → tags replaced with that list (empty list clears).
    - PATCH without ``tag_ids`` → tags untouched.
    """

    def create(self, validated_data):
        tags = validated_data.pop("tags", None)
        instance = super().create(validated_data)
        if tags is not None:
            # TaggableManager.set() expects Tag instances or strings, NOT
            # pks — PrimaryKeyRelatedField already resolved them to objects.
            instance.tags.set(tags)
        return instance

    def update(self, instance, validated_data):
        had_tags = "tags" in validated_data
        tags = validated_data.pop("tags", None)
        old_tags = (
            set(instance.tags.values_list("name", flat=True)) if had_tags else set()
        )
        instance = super().update(instance, validated_data)
        if had_tags:
            instance.tags.set(tags or [])
            new_tags = set(instance.tags.values_list("name", flat=True))
            if new_tags != old_tags:
                from audit.bulk import log_tag_change

                log_tag_change(
                    instance,
                    added=new_tags - old_tags,
                    removed=old_tags - new_tags,
                )
        return instance


class CustomFieldsSerializerMixin:
    """Field-level validation of ``custom_fields`` against the active tenant's
    custom-field definitions. Subclasses set ``cf_model`` to the model slug
    (e.g. ``"prefix"``) and include ``custom_fields`` in ``Meta.fields``.

    The validator only runs when ``custom_fields`` is in the payload, so a
    PATCH that doesn't touch it leaves stored values alone.
    """

    cf_model: str | None = None

    def validate_custom_fields(self, value):
        from api.views import _get_active_tenant
        from customization.cf_validation import clean_custom_fields

        request = self.context.get("request")
        tenant = _get_active_tenant(request) if request is not None else None
        if tenant is None or not self.cf_model:
            return value
        cleaned, errors = clean_custom_fields(tenant, self.cf_model, value)
        if errors:
            raise serializers.ValidationError(errors)
        return cleaned


class TenantGroupMiniSerializer(serializers.ModelSerializer):
    class Meta:
        model = TenantGroup
        fields = ["id", "name", "slug"]


class TenantGroupSerializer(serializers.ModelSerializer):
    """Org-scoped, self-nesting tenant grouping (NetBox tenantgroup parity)."""

    slug = serializers.SlugField(required=False, allow_blank=True)
    parent = TenantGroupMiniSerializer(read_only=True)
    parent_id = serializers.PrimaryKeyRelatedField(
        source="parent", queryset=TenantGroup.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tenant_count = serializers.SerializerMethodField()
    child_count = serializers.SerializerMethodField()

    def get_tenant_count(self, obj) -> int:
        return obj.tenants.count()

    def get_child_count(self, obj) -> int:
        return obj.children.count()

    def validate_parent_id(self, value):
        if value and self.instance:
            node = value
            while node is not None:
                if node.pk == self.instance.pk:
                    raise serializers.ValidationError(
                        "This would create a cycle."
                    )
                node = node.parent
        return value

    class Meta:
        model = TenantGroup
        fields = ["id", "name", "slug", "parent", "parent_id", "description",
                  "tenant_count", "child_count", "created_at", "updated_at"]
        read_only_fields = ["id", "tenant_count", "child_count",
                            "created_at", "updated_at"]


class TenantSerializer(NumIdModelSerializer):
    """Full read+write tenant. Stat counts come back so the list page can
    show rollups without an extra round trip."""

    group = TenantGroupMiniSerializer(read_only=True)
    group_id = serializers.PrimaryKeyRelatedField(
        source="group", queryset=TenantGroup.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    site_count = serializers.SerializerMethodField()
    prefix_count = serializers.SerializerMethodField()
    vlan_count = serializers.SerializerMethodField()
    ip_count = serializers.SerializerMethodField()

    def get_site_count(self, obj) -> int:
        return obj.sites.count()

    def get_prefix_count(self, obj) -> int:
        return obj.prefixes.count()

    def get_vlan_count(self, obj) -> int:
        return obj.vlans.count()

    def get_ip_count(self, obj) -> int:
        return obj.ip_addresses.count()

    class Meta:
        model = Tenant
        fields = [
            "id", "name", "slug", "color", "description", "is_active",
            "group", "group_id",
            "site_count", "prefix_count", "vlan_count", "ip_count",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]


class TenantPickerSerializer(NumIdModelSerializer):
    """Light tenant shape — used by the topbar switcher and combo pickers."""

    class Meta:
        model = Tenant
        fields = ["id", "name", "slug", "color", "is_active"]


class TagSerializer(NumIdModelSerializer):
    # Kept minimal on purpose: this is embedded read-only in every taggable
    # object's serializer (Prefix, IP, VRF, …). Do NOT add a usage count here
    # — it would fire one COUNT per tag per row on every list page.
    class Meta:
        model = Tag
        fields = ["id", "name", "slug", "color", "text_color"]


class TagManageSerializer(OwningSiteSerializerMixin, ObjectPermsSerializerMixin, NumIdModelSerializer):
    """Read+write Tag for the Tags management page. Adds ``usage_count``.

    The list viewset annotates ``usage_count_annotated`` (one GROUP BY) so the
    method field is cheap there; on a single create/update response it falls
    back to a single COUNT.
    """

    usage_count = serializers.SerializerMethodField()

    def get_usage_count(self, obj) -> int:
        v = getattr(obj, "usage_count_annotated", None)
        return v if v is not None else obj.tagged_items.count()

    class Meta:
        model = Tag
        fields = [
            "owning_site", "owning_site_id", "permissions", "id", "name", "slug", "color", "text_color", "usage_count"]
        read_only_fields = ["id", "slug", "text_color", "usage_count"]


class SiteMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = Site
        fields = ["id", "name"]


class VLANMiniSerializer(NumIdModelSerializer):
    # zone rides along so tables embedding a VLAN (prefixes, interfaces) can
    # render its zone chip without a second fetch. Callers embedding this in
    # list endpoints should select_related("vlan__zone").
    zone = serializers.SerializerMethodField()

    class Meta:
        model = VLAN
        fields = ["id", "vlan_id", "name", "zone"]

    def get_zone(self, obj):
        z = obj.zone
        if not z:
            return None
        return {
            "id": str(z.id), "name": z.name,
            "color": z.color, "text_color": z.text_color,
        }


class VLANSerializer(CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    """Read+write VLAN. Mirror PrefixSerializer's flat write payload."""

    cf_model = "vlan"
    site = SiteMiniSerializer(read_only=True)
    group = serializers.SerializerMethodField()
    tags = TagSerializer(many=True, read_only=True)
    prefix_count = serializers.SerializerMethodField()

    site_id = TenantScopedPrimaryKeyRelatedField(
        source="site", queryset=Site.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    group_id = TenantScopedPrimaryKeyRelatedField(
        source="group", queryset=VLANGroup.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    zone = serializers.SerializerMethodField()
    zone_id = TenantScopedPrimaryKeyRelatedField(
        source="zone", queryset=Zone.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_prefix_count(self, obj) -> int:
        return obj.prefixes.count()

    def get_group(self, obj):
        g = obj.group
        return {"id": str(g.id), "name": g.name} if g else None

    def get_zone(self, obj):
        z = obj.zone
        if not z:
            return None
        return {
            "id": str(z.id), "name": z.name,
            "color": z.color, "text_color": z.text_color,
        }

    def validate(self, attrs):
        group = attrs.get("group", getattr(self.instance, "group", None))
        vid = attrs.get("vlan_id", getattr(self.instance, "vlan_id", None))
        if group is not None and vid is not None:
            if not (group.min_vid <= vid <= group.max_vid):
                raise serializers.ValidationError(
                    {"vlan_id": f"VID must be within the group's range "
                                f"({group.min_vid}–{group.max_vid})."}
                )
        return attrs

    class Meta:
        model = VLAN
        fields = [
            "id", "vlan_id", "name",
            "site", "site_id",
            "group", "group_id",
            "zone", "zone_id",
            "description",
            "tags", "tag_ids",
            "prefix_count",
            "custom_fields",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]


class VRFMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = VRF
        fields = ["id", "name", "rd", "color"]


class SiteSerializer(CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    """Read+write Site. Tags + VRF M2M + relation counts."""

    cf_model = "site"
    tags = TagSerializer(many=True, read_only=True)
    vrfs = VRFMiniSerializer(many=True, read_only=True)
    region = serializers.SerializerMethodField()
    prefix_count = serializers.SerializerMethodField()
    vlan_count = serializers.SerializerMethodField()

    region_id = TenantScopedPrimaryKeyRelatedField(
        source="region", queryset=Region.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )
    vrf_ids = TenantScopedPrimaryKeyRelatedField(
        source="vrfs", queryset=VRF.objects.all(),
        write_only=True, required=False, many=True,
    )
    default_prefix = serializers.SerializerMethodField()
    default_prefix_id = TenantScopedPrimaryKeyRelatedField(
        source="default_prefix", queryset=Prefix.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    def get_region(self, obj):
        return (
            {"id": str(obj.region_id), "name": obj.region.name}
            if obj.region_id else None
        )

    def get_default_prefix(self, obj):
        return (
            {"id": str(obj.default_prefix_id), "cidr": obj.default_prefix.cidr}
            if obj.default_prefix_id else None
        )

    def validate_default_prefix_id(self, value):
        # A site's default must be a prefix that actually applies there: its own,
        # or a shared/container one with no site. Anything else would hand staff
        # a default from someone else's site.
        if value is not None and value.site_id:
            site_id = self.instance.id if self.instance else None
            if str(value.site_id) != str(site_id):
                raise serializers.ValidationError(
                    "Pick a prefix at this site, or a shared one with no site."
                )
        return value

    def get_prefix_count(self, obj) -> int:
        return obj.prefixes.count()

    def get_vlan_count(self, obj) -> int:
        return obj.vlan_set.count()

    class Meta:
        model = Site
        fields = [
            "id", "name", "region", "region_id", "location", "description",
            "latitude", "longitude",
            "gateway_policy",
            "default_prefix", "default_prefix_id",
            "vrfs", "vrf_ids",
            "tags", "tag_ids",
            "prefix_count", "vlan_count",
            "custom_fields",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]


class RouteTargetMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = RouteTarget
        fields = ["id", "name"]


class RouteTargetSerializer(OwningSiteSerializerMixin, ObjectPermsSerializerMixin, CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    """Read+write Route Target with vrf-usage counts for the list view."""

    cf_model = "routetarget"
    import_vrf_count = serializers.SerializerMethodField()
    export_vrf_count = serializers.SerializerMethodField()
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_import_vrf_count(self, obj) -> int:
        return obj.importing_vrfs.count()

    def get_export_vrf_count(self, obj) -> int:
        return obj.exporting_vrfs.count()

    class Meta:
        model = RouteTarget
        fields = [
            "owning_site", "owning_site_id", "permissions",
            "id", "name", "description",
            "import_vrf_count", "export_vrf_count",
            "tags", "tag_ids",
            "custom_fields",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]


class VRFSerializer(OwningSiteSerializerMixin, ObjectPermsSerializerMixin, CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    """Read+write VRF. Same flat-write pattern as PrefixSerializer."""

    cf_model = "vrf"
    import_targets = RouteTargetMiniSerializer(many=True, read_only=True)
    export_targets = RouteTargetMiniSerializer(many=True, read_only=True)
    prefix_count = serializers.SerializerMethodField()
    ip_count = serializers.SerializerMethodField()
    tags = TagSerializer(many=True, read_only=True)

    import_target_ids = TenantScopedPrimaryKeyRelatedField(
        source="import_targets", queryset=RouteTarget.objects.all(),
        write_only=True, required=False, many=True,
    )
    export_target_ids = TenantScopedPrimaryKeyRelatedField(
        source="export_targets", queryset=RouteTarget.objects.all(),
        write_only=True, required=False, many=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_prefix_count(self, obj) -> int:
        return obj.prefixes.count()

    def get_ip_count(self, obj) -> int:
        return obj.ip_addresses.count()

    class Meta:
        model = VRF
        fields = [
            "owning_site", "owning_site_id", "permissions",
            "id", "name", "rd", "color", "description", "enforce_unique",
            "import_targets", "import_target_ids",
            "export_targets", "export_target_ids",
            "tags", "tag_ids",
            "prefix_count", "ip_count",
            "custom_fields",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]


class StatusMiniSerializer(NumIdModelSerializer):
    text_color = serializers.CharField(read_only=True)

    class Meta:
        model = Status
        fields = ["id", "name", "color", "text_color"]


class StatusSerializerMixin(serializers.Serializer):
    """Shared status fields for any model with a ``Status`` FK: a nested
    read-only ``status`` ({id,name,color,text_color}) + a write-only
    ``status_id``. Mix in before ``ModelSerializer``; add ``status_id`` to
    ``Meta.fields`` (``status`` is already there)."""

    status = StatusMiniSerializer(read_only=True)
    status_id = TenantScopedPrimaryKeyRelatedField(
        source="status",
        queryset=Status.objects.all(),
        write_only=True,
        required=False,
        allow_null=True,
    )


class PrefixSerializer(StatusSerializerMixin, ObjectPermsSerializerMixin, CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    """Read+write shape for the /prefixes list page in v2.

    Nested mini-serializers on read so the React table can render names
    and colors without a second round-trip. Write side uses
    ``*_id`` fields (UUIDs) — keeps the form payload flat and avoids the
    nested-write headaches DRF is famous for.
    """

    cf_model = "prefix"

    # ── read-only nested projections ────────────────────────────────────
    site = SiteMiniSerializer(read_only=True)
    vlan = VLANMiniSerializer(read_only=True)
    vrf = VRFMiniSerializer(read_only=True)
    tags = TagSerializer(many=True, read_only=True)
    family = serializers.IntegerField(read_only=True)
    utilisation_pct = serializers.IntegerField(read_only=True, allow_null=True)
    is_enumerable = serializers.BooleanField(read_only=True)
    ip_count = serializers.SerializerMethodField()
    child_count = serializers.SerializerMethodField()
    has_descendants = serializers.SerializerMethodField()
    monitoring_engine = serializers.SerializerMethodField()

    def get_ip_count(self, obj) -> int:
        return obj.ip_addresses.count()

    def get_child_count(self, obj) -> int:
        return self._descendant_count(obj)

    def get_has_descendants(self, obj) -> bool:
        return self._descendant_count(obj) > 0

    def get_monitoring_engine(self, obj) -> dict | None:
        try:
            from monitoring.engines import engine_for_prefix
        except Exception:
            return None
        engine = engine_for_prefix(obj)
        return {
            "id": str(engine.id),
            "name": engine.name,
            "is_local": engine.is_local,
        }

    def _descendant_count(self, obj) -> int:
        # Cached per-instance so child_count + has_descendants share the work.
        cached = getattr(obj, "_descendant_count_cache", None)
        if cached is not None:
            return cached
        net = obj.network
        if net is None:
            obj._descendant_count_cache = 0
            return 0
        n = 0
        for sib in (
            Prefix.objects.filter(tenant_id=obj.tenant_id, vrf_id=obj.vrf_id)
            .exclude(pk=obj.pk)
            .only("cidr")
        ):
            sn = sib.network
            if sn is None:
                continue
            try:
                if sn.subnet_of(net):
                    n += 1
            except (TypeError, ValueError):
                continue
        obj._descendant_count_cache = n
        return n

    # ── write-only id pointers ──────────────────────────────────────────
    # The frontend posts ``{vrf_id, site_id, vlan_id, tag_ids: [...]}``.
    # source="vrf" wires each one back onto the FK, so DRF's default
    # create/update keeps working.
    vrf_id = TenantScopedPrimaryKeyRelatedField(
        source="vrf", queryset=VRF.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    site_id = TenantScopedPrimaryKeyRelatedField(
        source="site", queryset=Site.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    vlan_id = TenantScopedPrimaryKeyRelatedField(
        source="vlan", queryset=VLAN.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    location = serializers.SerializerMethodField()
    location_id = TenantScopedPrimaryKeyRelatedField(
        source="location", queryset=Location.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_location(self, obj) -> dict | None:
        if not obj.location_id:
            return None
        return {"id": str(obj.location_id), "name": obj.location.name}

    def validate(self, attrs):
        """Pre-save IPAM checks so a bad CIDR is a clean 400, never a DB 500.

        1. Exact duplicate `(tenant, vrf, cidr)` — the DB unique constraint
           would otherwise raise an uncaught IntegrityError.
        2. When the VRF has `enforce_unique` on, a *partial* overlap — two
           prefixes where neither contains the other (a real collision, not the
           normal /16 ⊃ /24 nesting). Gated on the flag so existing hierarchies
           aren't retroactively rejected.
        """
        import ipaddress

        request = self.context.get("request")
        if request is None:
            return attrs
        from api.views import _get_active_tenant

        tenant = _get_active_tenant(request)
        if tenant is None:
            return attrs

        # cidr/vrf may be absent on a PATCH — fall back to the instance.
        cidr = attrs.get("cidr", getattr(self.instance, "cidr", None))
        vrf = attrs.get("vrf", getattr(self.instance, "vrf", None))
        if not cidr:
            return attrs
        try:
            net = ipaddress.ip_network(cidr, strict=False)
        except (ValueError, TypeError):
            raise serializers.ValidationError({"cidr": f"'{cidr}' is not a valid network."})

        siblings = Prefix.objects.filter(tenant=tenant, vrf=vrf)
        if self.instance is not None:
            siblings = siblings.exclude(pk=self.instance.pk)

        vrf_label = vrf.name if vrf else "the Global VRF"
        enforce = vrf.enforce_unique if vrf else False
        for other in siblings.only("cidr"):
            on = other.network
            if on is None:
                continue
            if on == net:
                raise serializers.ValidationError(
                    {"cidr": f"{cidr} already exists in {vrf_label}."}
                )
            if enforce and net.version == on.version and net.overlaps(on):
                # A real collision only if neither contains the other.
                if not (net.subnet_of(on) or on.subnet_of(net)):
                    raise serializers.ValidationError(
                        {"cidr": f"{cidr} overlaps {other.cidr} in {vrf_label} "
                                 "(this VRF rejects overlapping prefixes)."}
                    )
        return attrs

    class Meta:
        model = Prefix
        fields = [
            "id", "numid", "cidr", "status", "status_id",
            "family", "utilisation_pct", "is_enumerable",
            "ip_count", "child_count", "has_descendants",
            "site", "vlan", "vrf", "location",
            "vrf_id", "site_id", "vlan_id", "location_id", "tag_ids",
            "gateway", "description", "auto_discover", "auto_assign_site",
            "monitoring_engine",
            "tags",
            "custom_fields",
            "permissions",
            "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "created_at", "updated_at"]


# ─── Picker payloads ────────────────────────────────────────────────────
#
# Light list endpoints for combobox pickers on the React forms. They reuse
# the *MiniSerializer fields but live as separate names so the URL routes
# stay intention-revealing (``/api/vrfs/`` returns "the VRF picker shape").

class VRFPickerSerializer(VRFMiniSerializer):
    pass


class SitePickerSerializer(SiteMiniSerializer):
    pass


class VLANPickerSerializer(VLANMiniSerializer):
    pass


class TagPickerSerializer(TagSerializer):
    pass


class RouteTargetPickerSerializer(RouteTargetMiniSerializer):
    pass


# ─── IP Address (table row + write payload) ────────────────────────────

class IPRoleMiniSerializer(NumIdModelSerializer):
    text_color = serializers.CharField(read_only=True)

    class Meta:
        model = IPRole
        fields = ["id", "name", "color", "text_color", "icon", "is_gateway", "is_virtual"]


class DeviceMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = Device
        fields = ["id", "name"]


class PrefixMiniSerializer(NumIdModelSerializer):
    """Light prefix shape attached to nested objects (IPs, etc).

    Includes the related VRF / Site / VLAN / gateway so consumer pages
    can render network context for an IP without a second round trip.
    """

    vrf = VRFMiniSerializer(read_only=True)
    site = SiteMiniSerializer(read_only=True)
    vlan = VLANMiniSerializer(read_only=True)

    class Meta:
        model = Prefix
        fields = ["id", "cidr", "vrf", "site", "vlan", "gateway"]


class IPAddressSerializer(ObjectPermsSerializerMixin, CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    cf_model = "ipaddress"
    status = StatusMiniSerializer(read_only=True)
    role = IPRoleMiniSerializer(read_only=True)
    assigned_device = DeviceMiniSerializer(read_only=True)
    assigned_interface = serializers.SerializerMethodField()
    switch = DeviceMiniSerializer(read_only=True)
    switch_interface = serializers.SerializerMethodField()
    prefix = PrefixMiniSerializer(read_only=True)
    tags = TagSerializer(many=True, read_only=True)
    is_primary_for_device = serializers.SerializerMethodField()
    is_secondary_for_device = serializers.SerializerMethodField()
    is_oob_for_device = serializers.SerializerMethodField()

    # Write-side ids — same pattern as PrefixSerializer.
    status_id = TenantScopedPrimaryKeyRelatedField(
        source="status", queryset=Status.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    role_id = TenantScopedPrimaryKeyRelatedField(
        source="role", queryset=IPRole.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    assigned_device_id = TenantScopedPrimaryKeyRelatedField(
        source="assigned_device", queryset=Device.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    assigned_interface_id = TenantScopedPrimaryKeyRelatedField(
        source="assigned_interface", queryset=Interface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    switch_id = TenantScopedPrimaryKeyRelatedField(
        source="switch", queryset=Device.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    switch_interface_id = TenantScopedPrimaryKeyRelatedField(
        source="switch_interface", queryset=Interface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    assigned_vm = serializers.SerializerMethodField()
    assigned_vm_interface = serializers.SerializerMethodField()
    assigned_vm_id = TenantScopedPrimaryKeyRelatedField(
        source="assigned_vm", queryset=VirtualMachine.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    assigned_vm_interface_id = TenantScopedPrimaryKeyRelatedField(
        source="assigned_vm_interface", queryset=VMInterface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    prefix_id = TenantScopedPrimaryKeyRelatedField(
        source="prefix", queryset=Prefix.objects.all(),
        write_only=True, required=False,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def validate(self, attrs):
        attrs = super().validate(attrs)
        import ipaddress as _ipa

        ip_str = attrs.get("ip_address", getattr(self.instance, "ip_address", None))
        prefix = attrs.get("prefix", getattr(self.instance, "prefix", None))
        if ip_str and prefix is not None:
            try:
                addr = _ipa.ip_address(ip_str)
            except ValueError:
                raise serializers.ValidationError(
                    {"ip_address": f"{ip_str} is not a valid IP address."}
                )
            net = prefix.network  # ipaddress network, or None for a bad CIDR
            if net is None:
                raise serializers.ValidationError(
                    {"prefix": f"Prefix {prefix.cidr} is not a valid network."}
                )
            if addr.version != net.version or addr not in net:
                raise serializers.ValidationError(
                    {"ip_address": f"{ip_str} is not inside the prefix {prefix.cidr}."}
                )
        return attrs

    def get_is_primary_for_device(self, obj) -> bool:
        dev = obj.assigned_device
        return bool(dev and dev.primary_ip_id == obj.id)

    def get_is_secondary_for_device(self, obj) -> bool:
        dev = obj.assigned_device
        return bool(dev and dev.secondary_ip_id == obj.id)

    def get_is_oob_for_device(self, obj) -> bool:
        dev = obj.assigned_device
        return bool(dev and dev.oob_ip_id == obj.id)

    def get_assigned_interface(self, obj):
        i = obj.assigned_interface
        if i is None:
            return None
        return {
            "id": str(i.id),
            "name": i.name,
            "device": {"id": str(i.device_id), "name": i.device.name},
        }

    def get_switch_interface(self, obj):
        i = obj.switch_interface
        if i is None:
            return None
        dev = i.device
        vc = getattr(dev, "virtual_chassis", None)
        return {
            "id": str(i.id),
            "name": i.name,
            "device": {"id": str(i.device_id), "name": dev.name},
            "virtual_chassis": (
                {"id": str(vc.id), "name": vc.name} if vc else None
            ),
        }

    def get_assigned_vm(self, obj):
        vm = obj.assigned_vm
        if vm is None:
            return None
        return {"id": str(vm.id), "name": vm.name,
                "status": vm.status.name if vm.status_id else None}

    def get_assigned_vm_interface(self, obj):
        i = obj.assigned_vm_interface
        if i is None:
            return None
        return {
            "id": str(i.id),
            "name": i.name,
            "vm": {"id": str(i.vm_id), "name": i.vm.name},
        }

    # Read-only: site is auto-filled from the prefix (when the prefix opts in)
    # or set on the model directly; it isn't edited from the IP form.
    site = SiteMiniSerializer(read_only=True)

    class Meta:
        model = IPAddress
        fields = [
            "id", "numid", "ip_address",
            "prefix", "prefix_id",
            "site",
            "status", "status_id",
            "role", "role_id",
            "assigned_device", "assigned_device_id",
            "assigned_interface", "assigned_interface_id",
            "switch", "switch_id",
            "switch_interface", "switch_interface_id",
            "assigned_vm", "assigned_vm_id",
            "assigned_vm_interface", "assigned_vm_interface_id",
            "mac_address",
            "dns_name",
            "last_seen",
            "discovered",
            "flap_exclude",
            "is_primary_for_device",
            "is_secondary_for_device",
            "is_oob_for_device",
            "description", "reservation_note",
            "custom_fields",
            "tags", "tag_ids",
            "permissions",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "numid", "last_seen", "discovered", "created_at", "updated_at"]


# ─── IP picker serializers ─────────────────────────────────────────────

class StatusSerializer(OwningSiteSerializerMixin, ObjectPermsSerializerMixin, NumIdModelSerializer):
    """Full read+write Status for the catalog management page."""

    text_color = serializers.CharField(read_only=True)
    slug = serializers.SlugField(required=False, allow_blank=True)
    usage_count = serializers.SerializerMethodField()

    # Reverse relation names for every model whose status FKs Status.
    _USAGE_RELS = [
        "ips", "devices", "prefixes", "ip_ranges", "racks", "clusters",
        "virtual_machines", "cables", "circuits", "power_feeds",
        "wireless_lans", "tunnels", "locations",
    ]

    def get_usage_count(self, obj) -> int:
        v = getattr(obj, "usage_count_annotated", None)
        if v is not None:
            return v
        return sum(getattr(obj, rn).count() for rn in self._USAGE_RELS)

    class Meta:
        model = Status
        fields = [
            "owning_site", "owning_site_id", "permissions", "id", "name", "slug", "color", "text_color", "description",
                  "weight", "available_to", "default_for",
                  "is_available", "requires_note",
                  "usage_count", "created_at", "updated_at"]
        read_only_fields = ["id", "text_color", "usage_count", "created_at", "updated_at"]


class IPRoleSerializer(OwningSiteSerializerMixin, ObjectPermsSerializerMixin, NumIdModelSerializer):
    """Full read+write IPRole for the catalog management page."""

    text_color = serializers.CharField(read_only=True)
    slug = serializers.SlugField(required=False, allow_blank=True)
    usage_count = serializers.SerializerMethodField()

    def get_usage_count(self, obj) -> int:
        v = getattr(obj, "usage_count_annotated", None)
        return v if v is not None else obj.ips.count()

    class Meta:
        model = IPRole
        fields = [
            "owning_site", "owning_site_id", "permissions", "id", "name", "slug", "color", "text_color", "description",
                  "weight", "is_gateway", "is_virtual", "icon",
                  "usage_count", "created_at", "updated_at"]
        read_only_fields = ["id", "text_color", "usage_count", "created_at", "updated_at"]


class StatusPickerSerializer(NumIdModelSerializer):
    text_color = serializers.CharField(read_only=True)

    class Meta:
        model = Status
        fields = ["id", "name", "slug", "color", "text_color",
                  "available_to", "default_for", "is_available",
                  "requires_note", "weight"]


class IPRolePickerSerializer(NumIdModelSerializer):
    text_color = serializers.CharField(read_only=True)

    class Meta:
        model = IPRole
        fields = ["id", "name", "slug", "color", "text_color", "icon",
                  "is_gateway", "is_virtual", "weight"]


class ZoneSerializer(
    OwningSiteSerializerMixin,
    ObjectPermsSerializerMixin,
    CustomFieldsSerializerMixin,
    TaggableSerializerMixin,
    NumIdModelSerializer,
):
    """Read+write security Zone (zone-based firewalling catalog)."""

    cf_model = "zone"
    text_color = serializers.CharField(read_only=True)
    slug = serializers.SlugField(required=False, allow_blank=True)
    usage_count = serializers.SerializerMethodField()
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", many=True, queryset=Tag.objects.all(),
        write_only=True, required=False,
    )

    def get_usage_count(self, obj) -> int:
        v = getattr(obj, "usage_count_annotated", None)
        return v if v is not None else obj.vlans.count()

    class Meta:
        model = Zone
        fields = [
            "id", "name", "slug", "color", "text_color", "description",
            "weight", "usage_count", "owning_site", "owning_site_id",
            "permissions", "tags", "tag_ids", "custom_fields",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "text_color", "usage_count", "created_at", "updated_at",
        ]


class ZonePickerSerializer(NumIdModelSerializer):
    text_color = serializers.CharField(read_only=True)

    class Meta:
        model = Zone
        fields = ["id", "name", "slug", "color", "text_color", "weight"]


class DevicePickerSerializer(NumIdModelSerializer):
    class Meta:
        model = Device
        fields = ["id", "name"]


class DeviceVcPickerSerializer(DevicePickerSerializer):
    """Picker shape (?picker=1&with_vc=1) that also carries the device's current
    virtual chassis, so a picker can "ghost" switches already in a stack."""

    virtual_chassis = serializers.SerializerMethodField()

    class Meta(DevicePickerSerializer.Meta):
        fields = DevicePickerSerializer.Meta.fields + ["virtual_chassis"]

    def get_virtual_chassis(self, obj):
        vc = obj.virtual_chassis
        return {"id": str(vc.id), "name": vc.name} if vc else None


class InterfacePickerSerializer(NumIdModelSerializer):
    device_id = TenantScopedPrimaryKeyRelatedField(source="device", read_only=True)

    class Meta:
        model = Interface
        fields = ["id", "name", "device_id"]


# ─── DCIM (manufacturers / device types / devices) ──────────────────────────

class ManufacturerMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = Manufacturer
        fields = ["id", "name"]


class ManufacturerSerializer(TaggableSerializerMixin, OwningSiteSerializerMixin, ObjectPermsSerializerMixin, NumIdModelSerializer):
    slug = serializers.SlugField(required=False, allow_blank=True)
    device_type_count = serializers.SerializerMethodField()
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_device_type_count(self, obj) -> int:
        v = getattr(obj, "device_type_count_annotated", None)
        return v if v is not None else obj.device_types.count()

    class Meta:
        model = Manufacturer
        fields = [
            "owning_site", "owning_site_id", "permissions", "id", "name", "slug", "url", "description",
                  "tags", "tag_ids",
                  "device_type_count", "created_at", "updated_at"]
        read_only_fields = ["id", "device_type_count", "created_at", "updated_at"]


def _img_url(serializer, f):
    """Same-origin URL (/media/…) for an uploaded image field, or None.

    Deliberately relative: absolute URLs bake in whatever Host the proxy sent
    (localhost:8000 behind Vite), which breaks from any other origin. The
    browser resolves /media/… against the page origin, and the Vite proxy /
    nginx route it to Django."""
    if not f:
        return None
    try:
        return f.url
    except ValueError:
        return None


# User-entered vendor lifecycle window + the derived state — shared by
# DeviceType (hardware) and Platform (OS). `lifecycle_state` is a model
# property, so ReadOnlyField picks it up on any LifecycleMixin serializer.
LIFECYCLE_FIELDS = [
    "release_date", "end_of_sale", "end_of_security_updates",
    "end_of_support", "lifecycle_url", "lifecycle_state",
]


class DeviceTypeMiniSerializer(NumIdModelSerializer):
    front_image = serializers.SerializerMethodField()
    rear_image = serializers.SerializerMethodField()
    lifecycle_state = serializers.ReadOnlyField()

    def get_front_image(self, obj):
        return _img_url(self, obj.front_image)

    def get_rear_image(self, obj):
        return _img_url(self, obj.rear_image)

    class Meta:
        model = DeviceType
        fields = ["id", "name", "u_height", "rack_width", "is_full_depth",
                  "front_image", "rear_image",
                  "release_date", "end_of_support", "lifecycle_state"]


class DeviceTypeSerializer(OwningSiteSerializerMixin, ObjectPermsSerializerMixin, CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    cf_model = "devicetype"
    manufacturer = ManufacturerMiniSerializer(read_only=True)
    manufacturer_id = TenantScopedPrimaryKeyRelatedField(
        source="manufacturer", queryset=Manufacturer.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    platform = serializers.SerializerMethodField()
    platform_id = TenantScopedPrimaryKeyRelatedField(
        source="platform", queryset=Platform.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )
    device_count = serializers.SerializerMethodField()
    front_image = serializers.SerializerMethodField()
    rear_image = serializers.SerializerMethodField()

    def get_platform(self, obj):
        p = obj.platform
        return {"id": str(p.id), "name": p.name} if p else None

    def get_device_count(self, obj) -> int:
        v = getattr(obj, "device_count_annotated", None)
        return v if v is not None else obj.device_set.count()

    def get_front_image(self, obj):
        return _img_url(self, obj.front_image)

    def get_rear_image(self, obj):
        return _img_url(self, obj.rear_image)

    # Faceplate layout doc — v1 envelope, port slots reference component-
    # template names. Shape-checked here (mirrors Service.validate_ports);
    # names are NOT cross-checked against templates (they may be renamed
    # later — the renderer degrades those slots to ghosts).
    _FACEPLATE_SLOT_KINDS = {
        "interface", "console-port", "console-server-port", "power-port",
        "power-outlet", "front-port", "rear-port", "aux-port",
    }

    def validate_faceplate(self, value):
        if value is None:
            return None
        if not isinstance(value, dict) or value.get("v") != 1:
            raise serializers.ValidationError(
                'Faceplate must be a {"v": 1, "front": [...], "rear": [...]} '
                "document.")
        if not isinstance(value.get("full", False), bool):
            raise serializers.ValidationError("full must be a boolean.")
        groups = []
        for s in ("front", "rear"):
            side = value.get(s)
            if not isinstance(side, list):
                raise serializers.ValidationError(f"{s} must be a list of groups.")
            groups.extend(side)
        if len(groups) > 64:
            raise serializers.ValidationError("Too many groups (max 64).")
        seen: set[tuple[str, str]] = set()
        total = 0
        for g in groups:
            if not isinstance(g, dict) or not isinstance(g.get("id"), str):
                raise serializers.ValidationError("Each group needs a string id.")
            if g.get("rows") not in (1, 2, 3, 4):
                raise serializers.ValidationError("Group rows must be 1–4.")
            bank = g.get("bank")
            if not isinstance(bank, int) or not (0 <= bank <= 48):
                raise serializers.ValidationError("Group bank must be 0–48.")
            u = g.get("u", 1)
            if not isinstance(u, int) or not (1 <= u <= 48):
                raise serializers.ValidationError("Group u must be 1–48.")
            slots = g.get("slots")
            if not isinstance(slots, list):
                raise serializers.ValidationError("Each group needs a slots list.")
            total += len(slots)
            for s in slots:
                if not isinstance(s, dict):
                    raise serializers.ValidationError("Each slot must be an object.")
                t = s.get("t")
                if t == "port":
                    kind = s.get("kind", "interface")
                    name = s.get("name")
                    if kind not in self._FACEPLATE_SLOT_KINDS:
                        raise serializers.ValidationError(
                            f"Unknown slot kind {kind!r}.")
                    if not isinstance(name, str) or not name or len(name) > 64:
                        raise serializers.ValidationError(
                            "Port slots need a name (≤64 chars).")
                    key = (kind, name.lower())
                    if key in seen:
                        raise serializers.ValidationError(
                            f"Duplicate port slot: {name}.")
                    seen.add(key)
                elif t == "blank":
                    pass  # optional family is advisory; renderer defaults it
                elif t == "label":
                    text = s.get("text")
                    if not isinstance(text, str) or len(text) > 64:
                        raise serializers.ValidationError(
                            "Label slots need text (≤64 chars).")
                else:
                    raise serializers.ValidationError(
                        "Slot t must be port, blank, or label.")
        if total > 1024:
            raise serializers.ValidationError("Too many slots (max 1024).")
        return value

    lifecycle_state = serializers.ReadOnlyField()

    class Meta:
        model = DeviceType
        fields = [
            "owning_site", "owning_site_id", "permissions", "id", "name", "manufacturer", "manufacturer_id", "model",
                  "part_number", "platform", "platform_id",
                  "u_height", "rack_width", "description",
                  "front_image", "rear_image", "faceplate",
                  "is_full_depth", "airflow", "weight", "weight_unit",
                  "subdevice_role", "exclude_from_utilization",
                  "custom_fields",
                  *LIFECYCLE_FIELDS,
                  "tags", "tag_ids", "device_count", "created_at", "updated_at"]
        read_only_fields = ["id", "device_count", "front_image", "rear_image",
                            "lifecycle_state", "created_at", "updated_at"]


class ImageAttachmentSerializer(serializers.ModelSerializer):
    """An uploaded image pinned to an object. ``image`` is a same-origin
    /media/ URL on read; the file itself is set through the parent's ``images``
    upload action, not this serializer (write is limited to caption +
    ordering)."""

    image = serializers.SerializerMethodField()

    def get_image(self, obj):
        return _img_url(self, obj.image)

    class Meta:
        model = ImageAttachment
        fields = ["id", "image", "name", "sort_order",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "image", "created_at", "updated_at"]


class DeviceSerializer(StatusSerializerMixin, ObjectPermsSerializerMixin, CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    cf_model = "device"
    device_type = DeviceTypeMiniSerializer(read_only=True)
    site = SiteMiniSerializer(read_only=True)
    primary_ip = serializers.SerializerMethodField()
    secondary_ip = serializers.SerializerMethodField()
    oob_ip = serializers.SerializerMethodField()
    interface_count = serializers.SerializerMethodField()
    ip_count = serializers.SerializerMethodField()
    hardware_count = serializers.SerializerMethodField()
    console_count = serializers.SerializerMethodField()
    power_count = serializers.SerializerMethodField()
    service_count = serializers.SerializerMethodField()
    tags = TagSerializer(many=True, read_only=True)
    rack = serializers.SerializerMethodField()
    u_height = serializers.SerializerMethodField()
    rack_width = serializers.SerializerMethodField()
    role = serializers.SerializerMethodField()
    platform = serializers.SerializerMethodField()
    effective_platform = serializers.SerializerMethodField()
    location = serializers.SerializerMethodField()
    cluster = serializers.SerializerMethodField()

    device_type_id = TenantScopedPrimaryKeyRelatedField(
        source="device_type", queryset=DeviceType.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    role_id = TenantScopedPrimaryKeyRelatedField(
        source="role", queryset=DeviceRole.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    platform_id = TenantScopedPrimaryKeyRelatedField(
        source="platform", queryset=Platform.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    site_id = TenantScopedPrimaryKeyRelatedField(
        source="site", queryset=Site.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    rack_id = TenantScopedPrimaryKeyRelatedField(
        source="rack", queryset=Rack.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )
    primary_ip_id = TenantScopedPrimaryKeyRelatedField(
        source="primary_ip", queryset=IPAddress.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    secondary_ip_id = TenantScopedPrimaryKeyRelatedField(
        source="secondary_ip", queryset=IPAddress.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    oob_ip_id = TenantScopedPrimaryKeyRelatedField(
        source="oob_ip", queryset=IPAddress.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    location_id = TenantScopedPrimaryKeyRelatedField(
        source="location", queryset=Location.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    cluster_id = TenantScopedPrimaryKeyRelatedField(
        source="cluster", queryset=Cluster.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    virtual_chassis = serializers.SerializerMethodField()
    vc_renamed_interfaces = serializers.SerializerMethodField()
    virtual_chassis_id = TenantScopedPrimaryKeyRelatedField(
        source="virtual_chassis", queryset=VirtualChassis.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    config_template = serializers.SerializerMethodField()
    config_template_id = TenantScopedPrimaryKeyRelatedField(
        source="config_template", queryset=ExportTemplate.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    @staticmethod
    def _ip_mini(ip):
        if not ip:
            return None
        return {
            "id": str(ip.id),
            "ip_address": ip.ip_address,
            "dns_name": ip.dns_name,
        }

    def get_primary_ip(self, obj):
        return self._ip_mini(obj.primary_ip)

    def get_secondary_ip(self, obj):
        return self._ip_mini(obj.secondary_ip)

    def get_oob_ip(self, obj):
        return self._ip_mini(obj.oob_ip)

    def get_rack(self, obj):
        r = obj.rack
        if r is None:
            return None
        return {
            "id": str(r.id), "name": r.name, "u_height": r.u_height,
            "starting_unit": r.starting_unit, "desc_units": r.desc_units,
        }

    def get_u_height(self, obj) -> int:
        return (obj.device_type.u_height if obj.device_type else 1) or 1

    def get_rack_width(self, obj) -> str:
        return (obj.device_type.rack_width if obj.device_type else "") or "full"

    def get_role(self, obj):
        r = obj.role
        return {"id": str(r.id), "name": r.name, "slug": r.slug,
                "color": r.color} if r else None

    def get_platform(self, obj):
        p = obj.platform
        if not p:
            return None
        # Carries the OS lifecycle window so device pages can render the
        # "OS support" bar without a second fetch.
        return {"id": str(p.id), "name": p.name, "slug": p.slug,
                "release_date": p.release_date,
                "end_of_support": p.end_of_support,
                "lifecycle_state": p.lifecycle_state}

    def get_effective_platform(self, obj):
        # The device's own platform wins; otherwise fall back to its type's
        # default. Read-only and derived — the stored field is untouched.
        p = obj.platform or (obj.device_type.platform if obj.device_type else None)
        return {"id": str(p.id), "name": p.name} if p else None

    def get_location(self, obj):
        loc = obj.location
        return {"id": str(loc.id), "name": loc.name} if loc else None

    def get_cluster(self, obj):
        c = obj.cluster
        return {"id": str(c.id), "name": c.name} if c else None

    def get_unique_together_validators(self):
        # DRF 3.16 maps the conditional (virtual_chassis, vc_position) DB
        # constraint to a UniqueTogetherValidator, which would make both
        # fields required on every device write. The clash is checked in
        # validate() instead (with a friendlier message), so drop it.
        return [
            v for v in super().get_unique_together_validators()
            if "vc_position" not in getattr(v, "fields", ())
        ]

    def get_vc_renamed_interfaces(self, obj):
        # Set by DeviceViewSet.perform_update when a stack-membership change
        # renamed {position}-templated interfaces; null on ordinary reads.
        return getattr(obj, "_vc_renamed_interfaces", None)

    def get_virtual_chassis(self, obj):
        vc = obj.virtual_chassis
        if vc is None:
            return None
        return {
            "id": str(vc.id), "name": vc.name,
            "is_master": vc.master_id == obj.pk,
            "member_count": vc.members.count(),
        }

    def get_config_template(self, obj):
        from .models import resolve_config_template

        own = obj.config_template
        resolved = resolve_config_template(obj)
        return {
            "own": {"id": str(own.id), "name": own.name} if own else None,
            "resolved": (
                {"id": str(resolved.id), "name": resolved.name}
                if resolved else None
            ),
        }

    def validate(self, attrs):
        attrs = super().validate(attrs)

        vc = attrs.get(
            "virtual_chassis", getattr(self.instance, "virtual_chassis", None)
        )
        pos = attrs.get(
            "vc_position", getattr(self.instance, "vc_position", None)
        )
        if vc is not None and pos is not None:
            clash = vc.members.filter(vc_position=pos).exclude(
                pk=getattr(self.instance, "pk", None)
            ).first()
            if clash is not None:
                raise serializers.ValidationError(
                    {"vc_position": f"Position {pos} is taken by {clash.name}."}
                )

        # An IP designated as primary/secondary/oob must already be assigned to
        # this device. ``None`` clears the designation and is always allowed.
        ip_fields = {
            "primary_ip": "primary_ip_id",
            "secondary_ip": "secondary_ip_id",
            "oob_ip": "oob_ip_id",
        }
        for attr, field in ip_fields.items():
            if attr not in attrs:
                continue
            ip = attrs[attr]
            if ip is None:
                continue
            # On create there's no device yet, so no IP can be assigned to it.
            if self.instance is None or ip.assigned_device_id != self.instance.pk:
                raise serializers.ValidationError(
                    {field: "Pick an IP assigned to this device."}
                )

        rack = attrs.get("rack", getattr(self.instance, "rack", None))
        position = attrs.get("position", getattr(self.instance, "position", None))
        face = attrs.get("face", getattr(self.instance, "face", ""))
        dt = attrs.get("device_type", getattr(self.instance, "device_type", None))
        width = (dt.rack_width if dt else "") or "full"
        side = attrs.get("rack_side", getattr(self.instance, "rack_side", ""))
        if width != "half":
            # Full-width devices never carry a side — keep stale values out.
            side = ""
            attrs["rack_side"] = ""
        if rack is None or position is None:
            return attrs
        if width == "half" and not side:
            raise serializers.ValidationError(
                {"rack_side": "This device type is half-width — pick which "
                              "half of the U it sits in (left or right)."}
            )
        height = (dt.u_height if dt else 1) or 1
        top = rack.starting_unit + rack.u_height - 1
        if position < rack.starting_unit or position + height - 1 > top:
            raise serializers.ValidationError(
                {"position": f"Device doesn't fit at U{position} in a "
                             f"{rack.u_height}U rack."}
            )
        my_units = set(range(position, position + height))
        others = rack.devices.select_related("device_type").exclude(
            pk=getattr(self.instance, "pk", None)
        )
        for d in others:
            if d.position is None:
                continue
            # Same face conflicts (or a full-depth device with no face set).
            if face and d.face and d.face != face:
                continue
            # Two half-width devices coexist in the same U on opposite sides.
            d_width = (d.device_type.rack_width if d.device_type else "") or "full"
            if (width == "half" and d_width == "half"
                    and side and d.rack_side and d.rack_side != side):
                continue
            dh = (d.device_type.u_height if d.device_type else 1) or 1
            if my_units & set(range(d.position, d.position + dh)):
                raise serializers.ValidationError(
                    {"position": f"Overlaps {d.name} at U{d.position}."}
                )
        return attrs

    def get_interface_count(self, obj) -> int:
        return obj.interfaces.count()

    def get_ip_count(self, obj) -> int:
        return obj.ip_addresses.count()

    def _detail_only(self) -> bool:
        # These per-tab counts are only for the device detail page; skip the
        # extra queries on the list (it doesn't render them) to avoid an N+1.
        view = self.context.get("view")
        return view is None or getattr(view, "action", None) != "list"

    def get_hardware_count(self, obj) -> int:
        # Everything on the Hardware tab: bays, modules, inventory, front/rear.
        if not self._detail_only():
            return 0
        return (
            obj.device_bays.count() + obj.module_bays.count()
            + obj.modules.count() + obj.inventory_items.count()
            + obj.front_ports.count() + obj.rear_ports.count()
        )

    def get_console_count(self, obj) -> int:
        if not self._detail_only():
            return 0
        return obj.console_ports.count() + obj.console_server_ports.count()

    def get_power_count(self, obj) -> int:
        if not self._detail_only():
            return 0
        return obj.power_ports.count() + obj.power_outlets.count()

    def get_service_count(self, obj) -> int:
        if not self._detail_only():
            return 0
        return obj.services.count()

    class Meta:
        model = Device
        fields = ["id", "numid", "name", "device_type", "device_type_id", "site", "site_id",
                  "role", "role_id", "platform", "platform_id",
                  "effective_platform",
                  "rack", "rack_id", "position", "face", "rack_side",
                  "u_height", "rack_width",
                  "location", "location_id", "cluster", "cluster_id",
                  "virtual_chassis", "virtual_chassis_id",
                  "vc_position", "vc_priority", "vc_renamed_interfaces",
                  "config_template", "config_template_id",
                  "status", "status_id",  "serial_number", "asset_tag",
                  "description", "comments", "airflow",
                  "latitude", "longitude",
                  "fov_direction", "fov_deg", "fov_distance_m", "fov_ptz",
                  "primary_ip", "primary_ip_id",
                  "secondary_ip", "secondary_ip_id",
                  "oob_ip", "oob_ip_id",
                  "tags", "tag_ids", "custom_fields",
                  "interface_count", "ip_count",
                  "hardware_count", "console_count", "power_count",
                  "service_count", "permissions",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "u_height", "rack_width",
                            "created_at", "updated_at"]


# ─── Cabling: terminations, ports, cables ──────────────────────────────────
# A CableTermination points at exactly one of the kinds in
# CableTermination.POINT_FIELDS (interfaces, patch-panel ports, console
# ports, device power ports/outlets, or a site power feed). These helpers
# give a uniform read shape + the "what cable is this port on" lookup (a port
# is cabled at most once, so it's a single cable).

def _point_kind(t) -> str:
    for field in CableTermination.POINT_FIELDS:
        if getattr(t, f"{field}_id") is not None:
            return field
    return ""


def _point_of(t):
    return t.point


def _termination_repr(t) -> dict:
    p = _point_of(t)
    # A power feed hangs off a panel, not a device — surface the panel under
    # the same "device" key so the cable UI renders one consistent shape.
    if isinstance(p, PowerFeed):
        parent = {"id": str(p.power_panel_id), "name": p.power_panel.name}
    else:
        parent = {"id": str(p.device_id), "name": p.device.name}
    return {
        "kind": _point_kind(t),
        "id": str(p.id),
        "name": p.name,
        "device": parent,
    }


class CableMiniSerializer(NumIdModelSerializer):
    status = StatusMiniSerializer(read_only=True)

    class Meta:
        model = Cable
        fields = ["id", "type", "color", "status"]


def _point_cable(point):
    t = point.terminations.all().first()  # ≤1 due to the per-port unique rule
    return CableMiniSerializer(t.cable).data if t is not None else None


class InterfaceSerializer(TaggableSerializerMixin, NumIdModelSerializer):
    device = DeviceMiniSerializer(read_only=True)
    vlan = VLANMiniSerializer(read_only=True)
    tagged_vlans = VLANMiniSerializer(many=True, read_only=True)
    vrf = VRFMiniSerializer(read_only=True)
    mode_display = serializers.CharField(source="get_mode_display", read_only=True)
    mac_addresses = serializers.SerializerMethodField()
    tags = TagSerializer(many=True, read_only=True)
    cable = serializers.SerializerMethodField()

    def get_mac_addresses(self, obj):
        primary = (obj.mac_address or "").lower()
        return [
            {"id": str(m.id), "mac_address": m.mac_address,
             "is_primary": m.mac_address == primary}
            for m in obj.mac_addresses.all()
        ]
    cable_count = serializers.SerializerMethodField()
    parent = serializers.SerializerMethodField()
    child_count = serializers.SerializerMethodField()
    lag = serializers.SerializerMethodField()
    bridge = serializers.SerializerMethodField()
    lag_member_count = serializers.SerializerMethodField()
    # Lenient (CharField, not the model's ChoiceField) so legacy/custom values
    # round-trip; the UI offers the standard dropdown via dcim_choices.
    type = serializers.CharField(required=False, allow_blank=True)
    type_display = serializers.SerializerMethodField()

    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), write_only=True,
    )
    vlan_id = TenantScopedPrimaryKeyRelatedField(
        source="vlan", queryset=VLAN.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tagged_vlan_ids = TenantScopedPrimaryKeyRelatedField(
        source="tagged_vlans", queryset=VLAN.objects.all(),
        write_only=True, required=False, many=True,
    )
    vrf_id = TenantScopedPrimaryKeyRelatedField(
        source="vrf", queryset=VRF.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    parent_id = TenantScopedPrimaryKeyRelatedField(
        source="parent", queryset=Interface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    lag_id = TenantScopedPrimaryKeyRelatedField(
        source="lag", queryset=Interface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    bridge_id = TenantScopedPrimaryKeyRelatedField(
        source="bridge", queryset=Interface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    ip_addresses = serializers.SerializerMethodField()
    tunnel_terminations = serializers.SerializerMethodField()

    @staticmethod
    def _mini(rel):
        return {"id": str(rel.id), "name": rel.name} if rel else None

    def get_cable(self, obj):
        return _point_cable(obj)

    def get_cable_count(self, obj) -> int:
        return obj.terminations.count()

    def get_parent(self, obj):
        return self._mini(obj.parent)

    def get_lag(self, obj):
        return self._mini(obj.lag)

    def get_bridge(self, obj):
        return self._mini(obj.bridge)

    def get_child_count(self, obj) -> int:
        # Prefetched via `children` on the viewset querysets — no N+1.
        return len(obj.children.all())

    def get_lag_member_count(self, obj) -> int:
        return len(obj.lag_members.all())

    def get_type_display(self, obj) -> str:
        return obj.get_type_display()

    def get_ip_addresses(self, obj):
        # Prefetched via `ip_addresses` on the viewset querysets — no N+1.
        return [
            {"id": str(ip.id), "ip_address": ip.ip_address}
            for ip in obj.ip_addresses.all()
        ]

    def get_tunnel_terminations(self, obj):
        # Tunnel ends this interface terminates — the frontend's "in a tunnel"
        # indicator. Prefetched via `tunnel_terminations__tunnel` on the
        # viewset querysets — no N+1. Defensive tenant filter: a termination's
        # tunnel must live in the interface's own tenant (cross-tenant links
        # are rejected on write, but never trust stored relations).
        return [
            {"id": str(t.id), "role": t.role,
             "role_display": t.get_role_display(),
             "tunnel": {"id": str(t.tunnel_id), "name": t.tunnel.name}}
            for t in obj.tunnel_terminations.all()
            if t.tunnel.tenant_id == obj.device.tenant_id
        ]

    def validate(self, attrs):
        attrs = super().validate(attrs)
        device = attrs.get("device", getattr(self.instance, "device", None))
        self_pk = getattr(self.instance, "pk", None)

        # All three self-relations must point at an interface on the same device
        # and never at the interface itself.
        for field in ("parent", "lag", "bridge"):
            rel = attrs.get(field, getattr(self.instance, field, None))
            if rel is None:
                continue
            if device is not None and rel.device_id != device.id:
                raise serializers.ValidationError(
                    {f"{field}_id": f"{field.capitalize()} must be an interface "
                                    "on the same device."}
                )
            if self_pk is not None and rel.pk == self_pk:
                raise serializers.ValidationError(
                    {f"{field}_id": f"An interface can't be its own {field}."}
                )

        # `parent` additionally must not form a cycle (sub-interface chains).
        parent = attrs.get("parent", getattr(self.instance, "parent", None))
        if parent is not None and self_pk is not None:
            node, seen = parent, set()
            while node is not None and node.pk not in seen:
                if node.pk == self_pk:
                    raise serializers.ValidationError(
                        {"parent_id": "An interface can't be its own ancestor."}
                    )
                seen.add(node.pk)
                node = node.parent
        return attrs

    class Meta:
        model = Interface
        fields = ["id", "device", "device_id", "name", "type", "type_display",
                  "speed", "mtu",
                  "enabled", "mgmt_only", "duplex", "poe_mode", "poe_type",
                  "wwn", "mac_address", "mac_addresses",
                  "mode", "mode_display", "vlan", "vlan_id",
                  "tagged_vlans", "tagged_vlan_ids", "vrf", "vrf_id",
                  "tags", "tag_ids",
                  "cable", "cable_count", "ip_addresses", "tunnel_terminations",
                  "virtual", "parent", "parent_id", "child_count",
                  "lag", "lag_id", "lag_member_count", "bridge", "bridge_id",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "tunnel_terminations", "created_at", "updated_at"]


class InterfaceMiniSerializer(NumIdModelSerializer):
    """Interface with its device — for cable endpoints + pickers that need
    to render ``device:interface``."""

    device = DeviceMiniSerializer(read_only=True)

    class Meta:
        model = Interface
        fields = ["id", "name", "device"]


class MACAddressSerializer(
    CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer
):
    """Read+write MAC address object. Assigned to an interface (optional) and
    carrying its own description / tags / custom fields."""

    cf_model = "macaddress"
    assigned_interface = InterfaceMiniSerializer(read_only=True)
    tags = TagSerializer(many=True, read_only=True)

    assigned_interface_id = TenantScopedPrimaryKeyRelatedField(
        source="assigned_interface", queryset=Interface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    class Meta:
        model = MACAddress
        fields = ["id", "numid", "mac_address", "assigned_interface",
                  "assigned_interface_id", "description",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "created_at", "updated_at"]


class MACAddressMiniSerializer(serializers.ModelSerializer):
    """The MAC objects an interface bears, with which one is its primary."""

    is_primary = serializers.SerializerMethodField()

    def get_is_primary(self, obj) -> bool:
        iface = obj.assigned_interface
        return bool(iface and obj.mac_address == (iface.mac_address or "").lower())

    class Meta:
        model = MACAddress
        fields = ["id", "mac_address", "is_primary"]


class RearPortMiniSerializer(NumIdModelSerializer):
    device = DeviceMiniSerializer(read_only=True)

    class Meta:
        model = RearPort
        fields = ["id", "name", "device", "positions"]


class RearPortSerializer(TaggableSerializerMixin, NumIdModelSerializer):
    device = DeviceMiniSerializer(read_only=True)
    tags = TagSerializer(many=True, read_only=True)
    cable = serializers.SerializerMethodField()
    front_port_count = serializers.SerializerMethodField()

    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), write_only=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_cable(self, obj):
        return _point_cable(obj)

    def get_front_port_count(self, obj) -> int:
        return obj.front_ports.count()

    def validate(self, attrs):
        splitter = attrs.get(
            "is_splitter",
            self.instance.is_splitter if self.instance else False,
        )
        positions = attrs.get(
            "positions", self.instance.positions if self.instance else 1
        )
        if splitter and (positions or 1) != 1:
            raise serializers.ValidationError(
                {"positions": "A splitter has exactly 1 input position — "
                 "its front ports are the outputs."}
            )
        # Clearing the flag would strand overlapping front ports that the
        # normal one-front-port-per-position rule forbids.
        if (
            self.instance
            and self.instance.is_splitter
            and not splitter
            and self.instance.front_ports.count() > 1
        ):
            raise serializers.ValidationError(
                {"is_splitter": "Remove the extra front ports first — a "
                 "non-splitter rear port allows one front port per position."}
            )
        return attrs

    class Meta:
        model = RearPort
        fields = ["id", "device", "device_id", "name", "positions",
                  "is_splitter", "type",
                  "tags", "tag_ids", "cable", "front_port_count",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class FrontPortSerializer(TaggableSerializerMixin, NumIdModelSerializer):
    device = DeviceMiniSerializer(read_only=True)
    rear_port = RearPortMiniSerializer(read_only=True)
    tags = TagSerializer(many=True, read_only=True)
    cable = serializers.SerializerMethodField()

    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), write_only=True,
    )
    rear_port_id = TenantScopedPrimaryKeyRelatedField(
        source="rear_port", queryset=RearPort.objects.all(), write_only=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_cable(self, obj):
        return _point_cable(obj)

    def validate(self, attrs):
        # Run the model's range/overlap check (DRF doesn't call clean()).
        from django.core.exceptions import ValidationError as DjangoError

        def val(field, default=None):
            if field in attrs:
                return attrs[field]
            return getattr(self.instance, field, default) if self.instance else default

        inst = FrontPort(
            rear_port=val("rear_port"),
            rear_port_position=val("rear_port_position", 1),
            positions=val("positions", 1),
        )
        if self.instance is not None:
            inst.pk = self.instance.pk
        try:
            inst.clean()
        except DjangoError as e:
            raise serializers.ValidationError(e.message_dict)
        return attrs

    class Meta:
        model = FrontPort
        fields = ["id", "device", "device_id", "name", "rear_port",
                  "rear_port_id", "rear_port_position", "positions", "type",
                  "tags", "tag_ids", "cable", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class _DevicePortSerializer(TaggableSerializerMixin, NumIdModelSerializer):
    """Shared shape for console/power components — device mini + cable lookup
    + lenient `type` (free-form values round-trip; the UI offers the standard
    dropdown via /api/dcim/choices/)."""

    device = DeviceMiniSerializer(read_only=True)
    tags = TagSerializer(many=True, read_only=True)
    cable = serializers.SerializerMethodField()
    type = serializers.CharField(required=False, allow_blank=True)
    type_display = serializers.SerializerMethodField()

    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), write_only=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_cable(self, obj):
        return _point_cable(obj)

    def get_type_display(self, obj) -> str:
        return obj.get_type_display() if obj.type else ""


class ConsolePortSerializer(_DevicePortSerializer):
    class Meta:
        model = ConsolePort
        fields = ["id", "device", "device_id", "name", "type", "type_display",
                  "speed", "description", "tags", "tag_ids", "cable",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class AuxPortSerializer(_DevicePortSerializer):
    class Meta:
        model = AuxPort
        fields = ["id", "device", "device_id", "name", "type", "type_display",
                  "description", "tags", "tag_ids", "cable",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class ConsoleServerPortSerializer(_DevicePortSerializer):
    class Meta:
        model = ConsoleServerPort
        fields = ["id", "device", "device_id", "name", "type", "type_display",
                  "speed", "description", "tags", "tag_ids", "cable",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class PowerPortSerializer(_DevicePortSerializer):
    outlet_count = serializers.SerializerMethodField()

    def get_outlet_count(self, obj) -> int:
        return obj.outlets.count()

    class Meta:
        model = PowerPort
        fields = ["id", "device", "device_id", "name", "type", "type_display",
                  "maximum_draw", "allocated_draw", "description",
                  "outlet_count", "tags", "tag_ids", "cable",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class PowerPortMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = PowerPort
        fields = ["id", "name"]


class PowerOutletSerializer(_DevicePortSerializer):
    power_port = PowerPortMiniSerializer(read_only=True)
    power_port_id = TenantScopedPrimaryKeyRelatedField(
        source="power_port", queryset=PowerPort.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    class Meta:
        model = PowerOutlet
        fields = ["id", "device", "device_id", "name", "type", "type_display",
                  "power_port", "power_port_id", "feed_leg", "description",
                  "tags", "tag_ids", "cable", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


# ─── Device-type component templates ────────────────────────────────────────
# Same lenient-`type` treatment as the concrete components. All are scoped by
# ?device_type= and materialise onto new devices of the type.

class _ComponentTemplateSerializer(serializers.ModelSerializer):
    type = serializers.CharField(required=False, allow_blank=True)
    device_type_id = TenantScopedPrimaryKeyRelatedField(
        source="device_type", queryset=DeviceType.objects.all(), write_only=True,
    )

    class Meta:
        fields = ["id", "device_type_id", "name", "type", "description",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class InterfaceTemplateSerializer(_ComponentTemplateSerializer):
    class Meta(_ComponentTemplateSerializer.Meta):
        model = InterfaceTemplate
        fields = _ComponentTemplateSerializer.Meta.fields + ["enabled", "mgmt_only", "poe_mode", "poe_type",]


class ConsolePortTemplateSerializer(_ComponentTemplateSerializer):
    class Meta(_ComponentTemplateSerializer.Meta):
        model = ConsolePortTemplate


class AuxPortTemplateSerializer(_ComponentTemplateSerializer):
    class Meta(_ComponentTemplateSerializer.Meta):
        model = AuxPortTemplate


class DeviceBayTemplateSerializer(_ComponentTemplateSerializer):
    class Meta(_ComponentTemplateSerializer.Meta):
        model = DeviceBayTemplate


class InventoryItemTemplateSerializer(_ComponentTemplateSerializer):
    manufacturer = ManufacturerMiniSerializer(read_only=True)
    manufacturer_id = TenantScopedPrimaryKeyRelatedField(
        source="manufacturer", queryset=Manufacturer.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    part_id = serializers.CharField(required=False, allow_blank=True)

    class Meta(_ComponentTemplateSerializer.Meta):
        model = InventoryItemTemplate
        fields = _ComponentTemplateSerializer.Meta.fields + [
            "manufacturer", "manufacturer_id", "part_id",
        ]


class ModuleBayTemplateSerializer(_ComponentTemplateSerializer):
    position = serializers.CharField(required=False, allow_blank=True)

    class Meta(_ComponentTemplateSerializer.Meta):
        model = ModuleBayTemplate
        fields = _ComponentTemplateSerializer.Meta.fields + ["position"]


# ─── Modules (pluggable line cards) ──────────────────────────────────────────

class TopologyViewSerializer(NumIdModelSerializer):
    state = serializers.JSONField(required=False)

    def validate_state(self, v):
        if not isinstance(v, dict):
            raise serializers.ValidationError("state must be an object")
        pos = v.get("positions", {})
        if not isinstance(pos, dict) or len(pos) > 5000:
            raise serializers.ValidationError("positions must be an object (≤5000 nodes)")
        return v

    class Meta:
        model = TopologyView
        fields = ["id", "numid", "name", "state", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "created_at", "updated_at"]


class ModuleTypeMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = ModuleType
        fields = ["id", "name", "part_number"]


class ModuleTypeSerializer(CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    cf_model = "moduletype"

    def validate_faceplate(self, value):
        # Same document rules as device types — one validator, two owners.
        return DeviceTypeSerializer.validate_faceplate(
            DeviceTypeSerializer(), value
        )
    manufacturer = ManufacturerMiniSerializer(read_only=True)
    manufacturer_id = TenantScopedPrimaryKeyRelatedField(
        source="manufacturer", queryset=Manufacturer.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )
    interface_template_count = serializers.SerializerMethodField()
    module_count = serializers.SerializerMethodField()

    def get_interface_template_count(self, obj) -> int:
        return obj.interface_templates.count()

    def get_module_count(self, obj) -> int:
        return obj.modules.count()

    class Meta:
        model = ModuleType
        fields = ["id", "name", "manufacturer", "manufacturer_id",
                  "part_number", "description", "faceplate", "custom_fields",
                  "tags", "tag_ids", "interface_template_count",
                  "module_count", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class ModuleInterfaceTemplateSerializer(serializers.ModelSerializer):
    type = serializers.CharField(required=False, allow_blank=True)
    module_type_id = serializers.PrimaryKeyRelatedField(
        source="module_type", queryset=ModuleType.objects.all(),
        write_only=True,
    )

    class Meta:
        model = ModuleInterfaceTemplate
        fields = ["id", "module_type_id", "name", "type", "enabled",
                  "mgmt_only", "description", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class InventoryItemSerializer(TaggableSerializerMixin, NumIdModelSerializer):
    device = DeviceMiniSerializer(read_only=True)
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), write_only=True,
    )
    manufacturer = ManufacturerMiniSerializer(read_only=True)
    manufacturer_id = TenantScopedPrimaryKeyRelatedField(
        source="manufacturer", queryset=Manufacturer.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    parent = serializers.SerializerMethodField()
    parent_id = serializers.PrimaryKeyRelatedField(
        source="parent", queryset=InventoryItem.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_parent(self, obj):
        return (
            {"id": str(obj.parent_id), "name": obj.parent.name}
            if obj.parent_id
            else None
        )

    def validate(self, attrs):
        parent = attrs.get("parent")
        device = attrs.get("device") or (
            self.instance.device if self.instance else None
        )
        if parent is not None and device is not None:
            if parent.device_id != device.id:
                raise serializers.ValidationError(
                    {"parent_id": "Pick a part on the same device."}
                )
            if self.instance and parent.id == self.instance.id:
                raise serializers.ValidationError(
                    {"parent_id": "A part can't contain itself."}
                )
        return attrs

    class Meta:
        model = InventoryItem
        fields = ["id", "device", "device_id", "parent", "parent_id", "name",
                  "manufacturer", "manufacturer_id", "part_id",
                  "serial_number", "asset_tag", "description",
                  "tags", "tag_ids", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class DeviceBaySerializer(TaggableSerializerMixin, NumIdModelSerializer):
    device = DeviceMiniSerializer(read_only=True)
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), write_only=True,
    )
    installed_device = DeviceMiniSerializer(read_only=True)
    installed_device_id = TenantScopedPrimaryKeyRelatedField(
        source="installed_device", queryset=Device.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def validate(self, attrs):
        child = attrs.get("installed_device")
        parent = attrs.get("device") or (
            self.instance.device if self.instance else None
        )
        if child is not None and parent is not None:
            if child.id == parent.id:
                raise serializers.ValidationError(
                    {"installed_device_id": "A device can't install into itself."}
                )
            role = child.device_type.subdevice_role if child.device_type else ""
            if role == "parent":
                raise serializers.ValidationError(
                    {"installed_device_id":
                     f"“{child.name}” is a parent chassis — only child-class "
                     "devices install into bays."}
                )
        return attrs

    class Meta:
        model = DeviceBay
        fields = ["id", "device", "device_id", "name", "installed_device",
                  "installed_device_id", "description", "tags", "tag_ids",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class ModuleBaySerializer(TaggableSerializerMixin, NumIdModelSerializer):
    device = DeviceMiniSerializer(read_only=True)
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), write_only=True,
    )
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )
    # The installed module (if any) — enough for the bays table.
    module = serializers.SerializerMethodField()

    def get_module(self, obj):
        m = getattr(obj, "module", None)
        if m is None:
            return None
        return {
            "id": str(m.id),
            "module_type": {
                "id": str(m.module_type_id),
                "name": m.module_type.name,
            },
            "serial_number": m.serial_number,
        }

    class Meta:
        model = ModuleBay
        fields = ["id", "device", "device_id", "name", "position",
                  "description", "module", "tags", "tag_ids",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class ModuleSerializer(TaggableSerializerMixin, NumIdModelSerializer):
    device = DeviceMiniSerializer(read_only=True)
    module_type = ModuleTypeMiniSerializer(read_only=True)
    module_bay = serializers.SerializerMethodField()
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), write_only=True,
    )
    module_bay_id = serializers.PrimaryKeyRelatedField(
        source="module_bay", queryset=ModuleBay.objects.all(), write_only=True,
    )
    module_type_id = TenantScopedPrimaryKeyRelatedField(
        source="module_type", queryset=ModuleType.objects.all(),
        write_only=True,
    )
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_module_bay(self, obj):
        return {"id": str(obj.module_bay_id), "name": obj.module_bay.name,
                "position": obj.module_bay.position}

    module_type_faceplate = serializers.SerializerMethodField()

    def get_module_type_faceplate(self, obj):
        return obj.module_type.faceplate

    def validate(self, attrs):
        bay = attrs.get("module_bay") or (
            self.instance.module_bay if self.instance else None
        )
        device = attrs.get("device") or (
            self.instance.device if self.instance else None
        )
        if bay is not None and device is not None and bay.device_id != device.id:
            raise serializers.ValidationError(
                {"module_bay_id": "Pick a bay on the same device."}
            )
        if bay is not None and self.instance is None and hasattr(bay, "module"):
            raise serializers.ValidationError(
                {"module_bay_id": f"Bay “{bay.name}” already has a module — "
                                  "remove it first."}
            )
        return attrs

    class Meta:
        model = Module
        fields = ["id", "device", "device_id", "module_bay", "module_bay_id",
                  "module_type", "module_type_id", "module_type_faceplate",
                  "serial_number",
                  "asset_tag", "description", "tags", "tag_ids",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class ConsoleServerPortTemplateSerializer(_ComponentTemplateSerializer):
    class Meta(_ComponentTemplateSerializer.Meta):
        model = ConsoleServerPortTemplate


class PowerPortTemplateSerializer(_ComponentTemplateSerializer):
    class Meta(_ComponentTemplateSerializer.Meta):
        model = PowerPortTemplate
        fields = _ComponentTemplateSerializer.Meta.fields + [
            "maximum_draw", "allocated_draw",
        ]


class PowerOutletTemplateSerializer(_ComponentTemplateSerializer):
    power_port_template = serializers.SerializerMethodField()
    power_port_template_id = serializers.PrimaryKeyRelatedField(
        source="power_port_template", queryset=PowerPortTemplate.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    def get_power_port_template(self, obj):
        t = obj.power_port_template
        return {"id": str(t.id), "name": t.name} if t else None

    def validate(self, attrs):
        ppt = attrs.get("power_port_template")
        dt = attrs.get("device_type") or (
            self.instance.device_type if self.instance else None
        )
        if ppt is not None and dt is not None and ppt.device_type_id != dt.id:
            raise serializers.ValidationError(
                {"power_port_template_id": "Pick an inlet template on the same device type."}
            )
        return attrs

    class Meta(_ComponentTemplateSerializer.Meta):
        model = PowerOutletTemplate
        fields = _ComponentTemplateSerializer.Meta.fields + [
            "power_port_template", "power_port_template_id", "feed_leg",
        ]


class RearPortTemplateSerializer(_ComponentTemplateSerializer):
    def validate(self, attrs):
        splitter = attrs.get(
            "is_splitter",
            self.instance.is_splitter if self.instance else False,
        )
        positions = attrs.get(
            "positions", self.instance.positions if self.instance else 1
        )
        if splitter and (positions or 1) != 1:
            raise serializers.ValidationError(
                {"positions": "A splitter has exactly 1 input position — "
                 "its front ports are the outputs."}
            )
        return attrs

    class Meta(_ComponentTemplateSerializer.Meta):
        model = RearPortTemplate
        fields = _ComponentTemplateSerializer.Meta.fields + [
            "positions", "is_splitter",
        ]


class FrontPortTemplateSerializer(_ComponentTemplateSerializer):
    rear_port_template = serializers.SerializerMethodField()
    rear_port_template_id = serializers.PrimaryKeyRelatedField(
        source="rear_port_template", queryset=RearPortTemplate.objects.all(),
        write_only=True,
    )

    def get_rear_port_template(self, obj):
        t = obj.rear_port_template
        return {"id": str(t.id), "name": t.name}

    def validate(self, attrs):
        rpt = attrs.get("rear_port_template") or (
            self.instance.rear_port_template if self.instance else None
        )
        dt = attrs.get("device_type") or (
            self.instance.device_type if self.instance else None
        )
        if rpt is not None and dt is not None and rpt.device_type_id != dt.id:
            raise serializers.ValidationError(
                {"rear_port_template_id": "Pick a rear-port template on the same device type."}
            )
        return attrs

    class Meta(_ComponentTemplateSerializer.Meta):
        model = FrontPortTemplate
        fields = _ComponentTemplateSerializer.Meta.fields + [
            "rear_port_template", "rear_port_template_id", "rear_port_position",
            "positions",
        ]


class CableSerializer(CustomFieldsSerializerMixin, StatusSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    """Read+write cable with A/B termination sets (1:1, breakout 1:N, M:N).

    Read: ``a_terminations`` / ``b_terminations`` (lists of
    ``{kind,id,name,device}``). Write: ``a`` / ``b`` lists of ``{kind, id}``
    where kind ∈ interface|front_port|rear_port.
    """

    cf_model = "cable"
    a_terminations = serializers.SerializerMethodField()
    b_terminations = serializers.SerializerMethodField()
    tags = TagSerializer(many=True, read_only=True)
    # Lenient so legacy free-form values round-trip; UI offers the dropdown.
    type = serializers.CharField(required=False, allow_blank=True)
    type_display = serializers.CharField(source="get_type_display", read_only=True)

    a = serializers.ListField(child=serializers.DictField(), write_only=True, required=False)
    b = serializers.ListField(child=serializers.DictField(), write_only=True, required=False)
    is_fiber = serializers.SerializerMethodField()

    def get_is_fiber(self, obj) -> bool:
        from .fiber_colors import is_fiber_type

        return is_fiber_type(obj.type)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    _POINT_MODELS = {
        "interface": Interface,
        "front_port": FrontPort,
        "rear_port": RearPort,
        "console_port": ConsolePort,
        "console_server_port": ConsoleServerPort,
        "power_port": PowerPort,
        "power_outlet": PowerOutlet,
        "power_feed": PowerFeed,
        "aux_port": AuxPort,
    }

    def get_a_terminations(self, obj):
        return [_termination_repr(t) for t in obj.terminations.all() if t.end == "A"]

    def get_b_terminations(self, obj):
        return [_termination_repr(t) for t in obj.terminations.all() if t.end == "B"]

    def _resolve(self, items, field):
        out = []
        for it in items or []:
            kind = it.get("kind")
            pid = it.get("id")
            model = self._POINT_MODELS.get(kind)
            if model is None or not pid:
                raise serializers.ValidationError({field: "Each termination needs a kind + id."})
            obj = model.objects.filter(pk=pid).first()
            if obj is None:
                raise serializers.ValidationError({field: f"Unknown {kind} {pid}."})
            out.append((kind, obj))
        return out

    def validate(self, attrs):
        from api.views import _get_active_tenant
        request = self.context.get("request")
        tenant = _get_active_tenant(request) if request is not None else None

        a = self._resolve(attrs.get("a"), "a") if "a" in attrs else None
        b = self._resolve(attrs.get("b"), "b") if "b" in attrs else None

        if self.instance is None and (not a or not b):
            raise serializers.ValidationError({"a": "Both ends need at least one port."})

        def existing(end):
            if self.instance is None:
                return []
            return [(_point_kind(t), _point_of(t)) for t in self.instance.terminations.filter(end=end)]

        eff_a = a if a is not None else existing("A")
        eff_b = b if b is not None else existing("B")
        if {(k, o.pk) for k, o in eff_a} & {(k, o.pk) for k, o in eff_b}:
            raise serializers.ValidationError({"b": "A port can't be on both ends of the same cable."})

        for side, pts in (("a", a or []), ("b", b or [])):
            for kind, obj in pts:
                # Power feeds carry their own tenant FK; every other point
                # kind inherits tenant via its device.
                obj_tenant_id = (
                    obj.tenant_id if kind == "power_feed" else obj.device.tenant_id
                )
                if tenant is not None and obj_tenant_id != tenant.id:
                    raise serializers.ValidationError({side: "Pick a port in the current tenant."})
                clash = CableTermination.objects.filter(**{kind: obj})
                if self.instance is not None:
                    clash = clash.exclude(cable=self.instance)
                if clash.exists():
                    raise serializers.ValidationError({side: f"{obj} is already cabled."})

        # ── Fibre strands ──────────────────────────────────────────────────
        eff_type = attrs.get("type", getattr(self.instance, "type", ""))
        count = attrs.get(
            "fiber_count", getattr(self.instance, "fiber_count", None)
        )
        if count is not None and count > 2048:
            raise serializers.ValidationError(
                {"fiber_count": "That's an implausible strand count."}
            )
        if "strands" in attrs:
            strands = attrs["strands"] or {}
            if not isinstance(strands, dict):
                raise serializers.ValidationError(
                    {"strands": "Expected an object keyed by strand position."}
                )
            for key in strands:
                try:
                    pos = int(key)
                except (TypeError, ValueError):
                    raise serializers.ValidationError(
                        {"strands": f"Strand key {key!r} isn't a position."}
                    )
                if pos < 1 or (count is not None and pos > count):
                    raise serializers.ValidationError(
                        {"strands": f"Strand {pos} is outside 1..{count}."}
                    )
        # Non-fibre cables carry no strands.
        from .fiber_colors import is_fiber_type

        if count is not None and not is_fiber_type(eff_type):
            raise serializers.ValidationError(
                {"fiber_count": "Only fibre cable types have strands."}
            )

        attrs["_a"] = a
        attrs["_b"] = b
        return attrs

    def _sync(self, cable, end, points):
        CableTermination.objects.bulk_create(
            [CableTermination(cable=cable, end=end, **{kind: obj}) for kind, obj in points]
        )

    @transaction.atomic
    def create(self, validated_data):
        a = validated_data.pop("_a")
        b = validated_data.pop("_b")
        validated_data.pop("a", None)
        validated_data.pop("b", None)
        tags = validated_data.pop("tags", None)
        cable = Cable.objects.create(**validated_data)
        self._sync(cable, "A", a)
        self._sync(cable, "B", b)
        if tags is not None:
            cable.tags.set(tags)
        return cable

    @transaction.atomic
    def update(self, instance, validated_data):
        a = validated_data.pop("_a", None)
        b = validated_data.pop("_b", None)
        validated_data.pop("a", None)
        validated_data.pop("b", None)
        tags = validated_data.pop("tags", None)
        for k, v in validated_data.items():
            setattr(instance, k, v)
        instance.save()
        if a is not None:
            instance.terminations.filter(end="A").delete()
            self._sync(instance, "A", a)
        if b is not None:
            instance.terminations.filter(end="B").delete()
            self._sync(instance, "B", b)
        if tags is not None:
            instance.tags.set(tags)
        return instance

    class Meta:
        model = Cable
        fields = ["id", "numid", "label", "type", "type_display", "status", "status_id",
                  "length", "length_unit", "color", "description",
                  "fiber_count", "strands", "is_fiber",
                  "a_terminations", "b_terminations", "a", "b",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "is_fiber", "created_at", "updated_at"]


# ─── Custom field definitions ──────────────────────────────────────────────

class CustomFieldGroupSerializer(
    OwningSiteSerializerMixin, ObjectPermsSerializerMixin, serializers.ModelSerializer
):
    slug = serializers.SlugField(required=False, allow_blank=True)
    field_count = serializers.SerializerMethodField()

    def get_field_count(self, obj) -> int:
        v = getattr(obj, "field_count_annotated", None)
        return v if v is not None else obj.fields.count()

    class Meta:
        model = CustomFieldGroup
        fields = ["id", "name", "slug", "description", "weight", "collapsed",
                  "field_count", "owning_site", "owning_site_id", "permissions",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "field_count", "created_at", "updated_at"]


class FiberSettingsSerializer(serializers.ModelSerializer):
    """The tenant's fibre-strand colour palette (Fibre settings page)."""

    colors = serializers.ListField(child=serializers.DictField(), required=False)

    def validate_colors(self, value):
        import re

        if value is None:
            return value
        if not (1 <= len(value) <= 24):
            raise serializers.ValidationError("Palette needs 1–24 colours.")
        cleaned = []
        for c in value:
            name = str(c.get("name", "")).strip()
            hex_ = str(c.get("hex", "")).strip()
            if not name:
                raise serializers.ValidationError("Every colour needs a name.")
            if not re.match(r"^#[0-9A-Fa-f]{6}$", hex_):
                raise serializers.ValidationError(
                    f"“{hex_}” isn't a 6-digit hex colour."
                )
            cleaned.append({"name": name, "hex": hex_.upper()})
        return cleaned

    class Meta:
        model = FiberSettings
        fields = ["id", "colors", "strand_modelling", "updated_at"]
        read_only_fields = ["id", "updated_at"]


class CustomFieldSerializer(
    OwningSiteSerializerMixin, ObjectPermsSerializerMixin, NumIdModelSerializer
):
    """Read+write for tenant-scoped custom-field definitions.

    Tenant + (tenant, key) uniqueness are enforced in the viewset, since the
    tenant isn't a writable field here.
    """

    # Write the group by id (tenant-scoped); read its name/weight/collapsed so
    # the form + detail page can render sections from the field list alone.
    group = TenantScopedPrimaryKeyRelatedField(
        queryset=CustomFieldGroup.objects.all(),
        required=False, allow_null=True,
    )
    group_name = serializers.CharField(
        source="group.name", read_only=True, default=None
    )
    group_weight = serializers.IntegerField(
        source="group.weight", read_only=True, default=None
    )
    group_collapsed = serializers.BooleanField(
        source="group.collapsed", read_only=True, default=None
    )

    class Meta:
        model = CustomField
        fields = [
            "id", "key", "label", "type", "applies_to", "choices",
            "related_model", "scope_rules",
            "required", "default", "description", "weight",
            "group", "group_name", "group_weight", "group_collapsed",
            "owning_site", "owning_site_id", "permissions",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]

    def validate(self, attrs):
        ftype = attrs.get("type", getattr(self.instance, "type", "text"))
        choices = attrs.get("choices", getattr(self.instance, "choices", None) or [])
        if ftype in ("select", "multiselect") and not choices:
            raise serializers.ValidationError(
                {"choices": "Provide at least one choice for a selection field."}
            )
        applies = attrs.get("applies_to", getattr(self.instance, "applies_to", None) or [])
        bad = [m for m in applies if m not in customizable_model_values()]
        if bad:
            raise serializers.ValidationError(
                {"applies_to": f"Unknown model(s): {', '.join(bad)}"}
            )
        if ftype == "object":
            from customization.object_registry import reference_model

            related = attrs.get(
                "related_model",
                getattr(self.instance, "related_model", "") or "",
            )
            if not related:
                raise serializers.ValidationError(
                    {"related_model": "Object fields must name a target model."}
                )
            if reference_model(related) is None:
                raise serializers.ValidationError(
                    {"related_model": f"Unknown model: {related}"}
                )
        rules = attrs.get("scope_rules", getattr(self.instance, "scope_rules", {}) or {})
        try:
            from customization.scopes import validate_scope_rules

            attrs["scope_rules"] = validate_scope_rules(rules)
        except ValueError as exc:
            raise serializers.ValidationError({"scope_rules": str(exc)})
        return attrs


# ─── Virtualization ──────────────────────────────────────────────────────────
class ClusterTypeMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = ClusterType
        fields = ["id", "name", "slug"]


class ClusterTypeSerializer(NumIdModelSerializer):
    slug = serializers.SlugField(required=False, allow_blank=True)
    cluster_count = serializers.SerializerMethodField()

    def get_cluster_count(self, obj) -> int:
        v = getattr(obj, "cluster_count_annotated", None)
        return v if v is not None else obj.clusters.count()

    class Meta:
        model = ClusterType
        fields = ["id", "name", "slug", "description", "cluster_count",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "cluster_count", "created_at", "updated_at"]


class ClusterGroupMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = ClusterGroup
        fields = ["id", "name", "slug"]


class ClusterGroupSerializer(NumIdModelSerializer):
    slug = serializers.SlugField(required=False, allow_blank=True)
    cluster_count = serializers.SerializerMethodField()

    def get_cluster_count(self, obj) -> int:
        v = getattr(obj, "cluster_count_annotated", None)
        return v if v is not None else obj.clusters.count()

    class Meta:
        model = ClusterGroup
        fields = ["id", "name", "slug", "description", "cluster_count",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "cluster_count", "created_at", "updated_at"]


class ClusterMiniSerializer(NumIdModelSerializer):
    status = StatusMiniSerializer(read_only=True)

    class Meta:
        model = Cluster
        fields = ["id", "name", "status"]


class ClusterSerializer(StatusSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    type = ClusterTypeMiniSerializer(read_only=True)
    type_id = TenantScopedPrimaryKeyRelatedField(
        source="type", queryset=ClusterType.objects.all(), write_only=True
    )
    group = ClusterGroupMiniSerializer(read_only=True)
    group_id = TenantScopedPrimaryKeyRelatedField(
        source="group", queryset=ClusterGroup.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    site = SiteMiniSerializer(read_only=True)
    site_id = TenantScopedPrimaryKeyRelatedField(
        source="site", queryset=Site.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )
    vm_count = serializers.SerializerMethodField()

    def get_vm_count(self, obj) -> int:
        return getattr(obj, "vm_count_annotated", 0) or 0

    class Meta:
        model = Cluster
        fields = ["id", "name", "type", "type_id", "group", "group_id",
                  "site", "site_id", "status", "status_id",  "description",
                  "vm_count", "tags", "tag_ids", "custom_fields",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "vm_count", "created_at", "updated_at"]


class IPMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = IPAddress
        fields = ["id", "ip_address", "dns_name"]


class VirtualMachineMiniSerializer(NumIdModelSerializer):
    status = StatusMiniSerializer(read_only=True)

    class Meta:
        model = VirtualMachine
        fields = ["id", "name", "status"]


class VirtualMachineSerializer(StatusSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    cluster = ClusterMiniSerializer(read_only=True)
    cluster_id = TenantScopedPrimaryKeyRelatedField(
        source="cluster", queryset=Cluster.objects.all(), write_only=True
    )
    role = serializers.SerializerMethodField()
    platform = serializers.SerializerMethodField()
    role_id = TenantScopedPrimaryKeyRelatedField(
        source="role", queryset=DeviceRole.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    platform_id = TenantScopedPrimaryKeyRelatedField(
        source="platform", queryset=Platform.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    device = DeviceMiniSerializer(read_only=True)
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    site = SiteMiniSerializer(read_only=True)
    site_id = TenantScopedPrimaryKeyRelatedField(
        source="site", queryset=Site.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    primary_ip = IPMiniSerializer(read_only=True)
    primary_ip_id = TenantScopedPrimaryKeyRelatedField(
        source="primary_ip", queryset=IPAddress.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_role(self, obj):
        r = obj.role
        return {"id": str(r.id), "name": r.name, "slug": r.slug,
                "color": r.color} if r else None

    def get_platform(self, obj):
        p = obj.platform
        return {"id": str(p.id), "name": p.name, "slug": p.slug} if p else None

    class Meta:
        model = VirtualMachine
        fields = ["id", "name", "cluster", "cluster_id",
                  "role", "role_id", "platform", "platform_id",
                  "device", "device_id",
                  "site", "site_id", "status", "status_id", 
                  "vcpus", "memory_mb", "disk_gb",
                  "primary_ip", "primary_ip_id", "description",
                  "tags", "tag_ids", "custom_fields",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class VMInterfaceSerializer(TaggableSerializerMixin, NumIdModelSerializer):
    vm = VirtualMachineMiniSerializer(read_only=True)
    vm_id = TenantScopedPrimaryKeyRelatedField(
        source="vm", queryset=VirtualMachine.objects.all(), write_only=True
    )
    vlan = VLANMiniSerializer(read_only=True)
    vlan_id = TenantScopedPrimaryKeyRelatedField(
        source="vlan", queryset=VLAN.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    mode_display = serializers.CharField(source="get_mode_display", read_only=True)
    tagged_vlans = VLANMiniSerializer(many=True, read_only=True)
    tagged_vlan_ids = TenantScopedPrimaryKeyRelatedField(
        source="tagged_vlans", queryset=VLAN.objects.all(),
        write_only=True, required=False, many=True,
    )
    vrf = VRFMiniSerializer(read_only=True)
    vrf_id = TenantScopedPrimaryKeyRelatedField(
        source="vrf", queryset=VRF.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )
    ip_addresses = serializers.SerializerMethodField()

    def get_ip_addresses(self, obj):
        return [
            {"id": str(ip.id), "ip_address": ip.ip_address}
            for ip in obj.ip_addresses.all()
        ]

    class Meta:
        model = VMInterface
        fields = ["id", "vm", "vm_id", "name", "enabled", "mac_address",
                  "mtu", "description", "ip_addresses",
                  "vlan", "vlan_id", "mode", "mode_display",
                  "tagged_vlans", "tagged_vlan_ids", "vrf", "vrf_id",
                  "tags", "tag_ids", "custom_fields",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "ip_addresses", "mode_display",
                            "created_at", "updated_at"]


# ─── Racks ───────────────────────────────────────────────────────────────────
class RackRoleMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = RackRole
        fields = ["id", "name", "slug", "color"]


class RackRoleSerializer(NumIdModelSerializer):
    slug = serializers.SlugField(required=False, allow_blank=True)
    rack_count = serializers.SerializerMethodField()

    def get_rack_count(self, obj) -> int:
        v = getattr(obj, "rack_count_annotated", None)
        return v if v is not None else obj.racks.count()

    class Meta:
        model = RackRole
        fields = ["id", "name", "slug", "color", "description", "rack_count",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "rack_count", "created_at", "updated_at"]


class RackMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = Rack
        fields = ["id", "name", "u_height", "starting_unit", "desc_units"]


class RackSerializer(StatusSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    site = SiteMiniSerializer(read_only=True)
    site_id = TenantScopedPrimaryKeyRelatedField(
        source="site", queryset=Site.objects.all(), write_only=True
    )
    role = RackRoleMiniSerializer(read_only=True)
    role_id = TenantScopedPrimaryKeyRelatedField(
        source="role", queryset=RackRole.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    location = serializers.SerializerMethodField()
    location_id = TenantScopedPrimaryKeyRelatedField(
        source="location", queryset=Location.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )
    device_count = serializers.SerializerMethodField()
    used_units = serializers.SerializerMethodField()

    def get_location(self, obj):
        l = obj.location
        return {"id": str(l.id), "name": l.name} if l else None

    def validate(self, attrs):
        # A rack's location must live in the rack's site.
        location = attrs.get("location", getattr(self.instance, "location", None))
        site = attrs.get("site", getattr(self.instance, "site", None))
        if location is not None and site is not None \
                and location.site_id != site.id:
            raise serializers.ValidationError(
                {"location_id": "Pick a location within the rack's site."}
            )
        return attrs

    def get_device_count(self, obj) -> int:
        return obj.devices.count()

    def get_used_units(self, obj) -> int:
        # Distinct units occupied by any device — two half-width devices
        # sharing a U count it once.
        units: set[int] = set()
        for d in obj.devices.select_related("device_type").all():
            if d.position is None:
                continue
            if d.device_type and d.device_type.exclude_from_utilization:
                continue  # blanking panels / cable management don't count
            h = (d.device_type.u_height if d.device_type else 1) or 1
            units.update(range(d.position, d.position + h))
        return len(units)

    total_weight_kg = serializers.SerializerMethodField()
    max_weight_kg = serializers.SerializerMethodField()

    def get_total_weight_kg(self, obj):
        # Sum of the racked devices' type weights, normalised to kg. Devices
        # whose type has no weight contribute 0 — the UI notes the count.
        total = 0.0
        for d in obj.devices.select_related("device_type").all():
            dt = d.device_type
            kg = weight_kg(dt.weight, dt.weight_unit) if dt else None
            if kg:
                total += kg
        return round(total, 2)

    def get_max_weight_kg(self, obj):
        return weight_kg(obj.max_weight, obj.max_weight_unit)

    power = serializers.SerializerMethodField()

    def get_power(self, obj):
        """Rack power rollup. Supply = primary feeds delivered to the rack
        (V × A × max-utilisation%, three-phase × √3, NetBox semantics).
        Demand = the racked devices' power-port draws — allocated where
        recorded, with the nameplate (maximum) sum alongside."""
        available = 0.0
        for f in obj.power_feeds.all():
            if f.type != "primary" or not f.voltage or not f.amperage:
                continue
            watts = abs(f.voltage) * f.amperage * (f.max_utilization / 100)
            if f.phase == "three":
                watts *= 1.732
            available += watts
        allocated = maximum = 0
        for d in obj.devices.all():
            for pp in d.power_ports.all():
                allocated += pp.allocated_draw or 0
                maximum += pp.maximum_draw or 0
        return {
            "available_w": round(available),
            "allocated_w": allocated,
            "maximum_w": maximum,
        }

    class Meta:
        model = Rack
        fields = ["id", "numid", "name", "facility_id", "site", "site_id", "role",
                  "role_id", "status", "status_id", "location", "location_id",
                  "width", "u_height",
                  "max_weight", "max_weight_unit",
                  "total_weight_kg", "max_weight_kg", "power",
                  "starting_unit", "desc_units", "description",
                  "device_count", "used_units",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "device_count", "used_units",
                            "created_at", "updated_at"]


# ─── Device roles + platforms ────────────────────────────────────────────────
class DeviceRoleMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = DeviceRole
        fields = ["id", "name", "slug", "color", "is_patch_panel", "has_fov"]


class DeviceRoleSerializer(TaggableSerializerMixin, CustomFieldsSerializerMixin, NumIdModelSerializer):
    cf_model = "devicerole"
    slug = serializers.SlugField(required=False, allow_blank=True)
    config_template = serializers.SerializerMethodField()
    config_template_id = TenantScopedPrimaryKeyRelatedField(
        source="config_template", queryset=ExportTemplate.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    device_count = serializers.SerializerMethodField()
    vm_count = serializers.SerializerMethodField()
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_config_template(self, obj):
        t = obj.config_template
        return {"id": str(t.id), "name": t.name} if t else None

    def get_device_count(self, obj) -> int:
        return obj.devices.count()

    def get_vm_count(self, obj) -> int:
        return obj.virtual_machines.count()

    class Meta:
        model = DeviceRole
        fields = ["id", "name", "slug", "color", "is_patch_panel", "has_fov",
                  "description", "custom_fields", "tags", "tag_ids",
                  "config_template", "config_template_id",
                  "device_count", "vm_count", "created_at", "updated_at"]
        read_only_fields = ["id", "device_count", "vm_count",
                            "created_at", "updated_at"]


class PlatformGroupMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = PlatformGroup
        fields = ["id", "name", "slug"]


class PlatformGroupSerializer(NumIdModelSerializer):
    slug = serializers.SlugField(required=False, allow_blank=True)
    parent = PlatformGroupMiniSerializer(read_only=True)
    parent_id = TenantScopedPrimaryKeyRelatedField(
        source="parent", queryset=PlatformGroup.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    platform_count = serializers.SerializerMethodField()
    child_count = serializers.SerializerMethodField()

    def get_platform_count(self, obj) -> int:
        v = getattr(obj, "platform_count_annotated", None)
        return v if v is not None else obj.platforms.count()

    def get_child_count(self, obj) -> int:
        return obj.children.count()

    def validate_parent_id(self, value):
        if value and self.instance:
            node = value
            while node is not None:
                if node.pk == self.instance.pk:
                    raise serializers.ValidationError(
                        "This would create a cycle."
                    )
                node = node.parent
        return value

    class Meta:
        model = PlatformGroup
        fields = ["id", "name", "slug", "parent", "parent_id", "description",
                  "platform_count", "child_count", "created_at", "updated_at"]
        read_only_fields = ["id", "platform_count", "child_count",
                            "created_at", "updated_at"]


class PlatformMiniSerializer(NumIdModelSerializer):
    lifecycle_state = serializers.ReadOnlyField()

    class Meta:
        model = Platform
        fields = ["id", "name", "slug",
                  "release_date", "end_of_support", "lifecycle_state"]


class PlatformSerializer(TaggableSerializerMixin, NumIdModelSerializer):
    slug = serializers.SlugField(required=False, allow_blank=True)
    group = PlatformGroupMiniSerializer(read_only=True)
    group_id = TenantScopedPrimaryKeyRelatedField(
        source="group", queryset=PlatformGroup.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    manufacturer = ManufacturerMiniSerializer(read_only=True)
    manufacturer_id = TenantScopedPrimaryKeyRelatedField(
        source="manufacturer", queryset=Manufacturer.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    config_template = serializers.SerializerMethodField()
    config_template_id = TenantScopedPrimaryKeyRelatedField(
        source="config_template", queryset=ExportTemplate.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    device_count = serializers.SerializerMethodField()
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_config_template(self, obj):
        t = obj.config_template
        return {"id": str(t.id), "name": t.name} if t else None

    def get_device_count(self, obj) -> int:
        return obj.devices.count()

    lifecycle_state = serializers.ReadOnlyField()

    class Meta:
        model = Platform
        fields = ["id", "name", "slug", "group", "group_id",
                  "manufacturer", "manufacturer_id",
                  "config_template", "config_template_id",
                  "description", "tags", "tag_ids", *LIFECYCLE_FIELDS,
                  "device_count", "created_at", "updated_at"]
        read_only_fields = ["id", "device_count", "lifecycle_state",
                            "created_at", "updated_at"]


# ─── Services ────────────────────────────────────────────────────────────────
class ServiceSerializer(TaggableSerializerMixin, NumIdModelSerializer):
    protocol_display = serializers.CharField(
        source="get_protocol_display", read_only=True
    )
    device = serializers.SerializerMethodField()
    virtual_machine = serializers.SerializerMethodField()
    ip_address = serializers.SerializerMethodField()
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    virtual_machine_id = TenantScopedPrimaryKeyRelatedField(
        source="virtual_machine", queryset=VirtualMachine.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    ip_address_id = TenantScopedPrimaryKeyRelatedField(
        source="ip_address", queryset=IPAddress.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )
    # Ports actually scheduled right now — 0 with monitored=True means no target
    # IP yet (set the service's IP or the parent's primary IP).
    check_count = serializers.SerializerMethodField()

    def validate_ports(self, value):
        if not isinstance(value, list) or not value:
            raise serializers.ValidationError("List at least one port.")
        for p in value:
            if not isinstance(p, int) or not (1 <= p <= 65535):
                raise serializers.ValidationError("Ports must be 1–65535.")
        return value

    def get_device(self, obj):
        d = obj.device
        return {"id": str(d.id), "name": d.name} if d else None

    def get_virtual_machine(self, obj):
        v = obj.virtual_machine
        return {"id": str(v.id), "name": v.name} if v else None

    def get_ip_address(self, obj):
        ip = obj.ip_address
        return {"id": str(ip.id), "ip_address": ip.ip_address} if ip else None

    def get_check_count(self, obj) -> int:
        # Prefetched in ServiceViewSet.get_queryset — len() avoids a per-row query.
        return len(obj.check_assignments.all())

    class Meta:
        model = Service
        fields = ["id", "name", "protocol", "protocol_display", "ports",
                  "device", "device_id", "virtual_machine", "virtual_machine_id",
                  "ip_address", "ip_address_id", "monitored", "check_count",
                  "description",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "check_count", "created_at", "updated_at"]


# ─── Service templates (reusable service definitions) ────────────────────────
class ServiceTemplateMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = ServiceTemplate
        fields = ["id", "name", "protocol", "ports"]


class ServiceTemplateSerializer(NumIdModelSerializer):
    slug = serializers.SlugField(required=False, allow_blank=True)
    protocol_display = serializers.CharField(
        source="get_protocol_display", read_only=True
    )
    # Required so the "at least one port" rule can't be bypassed by omitting
    # the field (model default=list would otherwise let it slip through).
    ports = serializers.JSONField(required=True)
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def validate_ports(self, value):
        if not isinstance(value, list) or not value:
            raise serializers.ValidationError("List at least one port.")
        for p in value:
            if not isinstance(p, int) or not (1 <= p <= 65535):
                raise serializers.ValidationError("Ports must be 1–65535.")
        return value

    class Meta:
        model = ServiceTemplate
        fields = ["id", "name", "slug", "protocol", "protocol_display", "ports",
                  "description", "tags", "tag_ids", "custom_fields",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class DeviceTypeServiceSerializer(NumIdModelSerializer):
    """A service defined on a device type — materialises a Service onto every
    new device of the type. ``?device_type=`` scoped, like the component
    templates."""

    protocol_display = serializers.CharField(
        source="get_protocol_display", read_only=True
    )
    ports = serializers.JSONField(required=True)
    device_type_id = TenantScopedPrimaryKeyRelatedField(
        source="device_type", queryset=DeviceType.objects.all(), write_only=True,
    )

    def validate_ports(self, value):
        if not isinstance(value, list) or not value:
            raise serializers.ValidationError("List at least one port.")
        for p in value:
            if not isinstance(p, int) or not (1 <= p <= 65535):
                raise serializers.ValidationError("Ports must be 1–65535.")
        return value

    class Meta:
        model = DeviceTypeService
        fields = ["id", "device_type_id", "name", "protocol", "protocol_display",
                  "ports", "monitor", "description", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


# ─── IP ranges ───────────────────────────────────────────────────────────────
class IPRangeSerializer(StatusSerializerMixin, CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    cf_model = "iprange"

    vrf = VRFMiniSerializer(read_only=True)
    prefix = PrefixMiniSerializer(read_only=True)
    role = IPRoleMiniSerializer(read_only=True)
    tags = TagSerializer(many=True, read_only=True)
    family = serializers.IntegerField(read_only=True, allow_null=True)
    size = serializers.IntegerField(read_only=True, allow_null=True)

    vrf_id = TenantScopedPrimaryKeyRelatedField(
        source="vrf", queryset=VRF.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    prefix_id = TenantScopedPrimaryKeyRelatedField(
        source="prefix", queryset=Prefix.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    role_id = TenantScopedPrimaryKeyRelatedField(
        source="role", queryset=IPRole.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def validate(self, attrs):
        import ipaddress as _ip

        start = attrs.get("start_address", getattr(self.instance, "start_address", None))
        end = attrs.get("end_address", getattr(self.instance, "end_address", None))
        if start and end:
            try:
                s, e = _ip.ip_address(start), _ip.ip_address(end)
            except ValueError:
                raise serializers.ValidationError("Invalid IP address.")
            if s.version != e.version:
                raise serializers.ValidationError(
                    "Start and end must be the same IP family."
                )
            if int(e) < int(s):
                raise serializers.ValidationError(
                    "End address must not be before the start address."
                )
        # A range under a prefix lives in that prefix's VRF — keep them in sync
        # (mirrors IPAddress, which denormalises vrf from its prefix).
        prefix = attrs.get("prefix", getattr(self.instance, "prefix", None))
        if prefix is not None:
            attrs["vrf"] = prefix.vrf
        return attrs

    class Meta:
        model = IPRange
        fields = ["id", "start_address", "end_address", "status", "status_id",
                   "family", "size",
                  "vrf", "vrf_id", "prefix", "prefix_id", "role", "role_id",
                  "description", "tags", "tag_ids", "custom_fields",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


# ─── RIRs + Aggregates ───────────────────────────────────────────────────────
class RIRMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = RIR
        fields = ["id", "name", "slug", "is_private"]


class RIRSerializer(NumIdModelSerializer):
    slug = serializers.SlugField(required=False, allow_blank=True)
    aggregate_count = serializers.SerializerMethodField()

    def get_aggregate_count(self, obj) -> int:
        v = getattr(obj, "aggregate_count_annotated", None)
        return v if v is not None else obj.aggregates.count()

    class Meta:
        model = RIR
        fields = ["id", "name", "slug", "is_private", "description",
                  "aggregate_count", "created_at", "updated_at"]
        read_only_fields = ["id", "aggregate_count", "created_at", "updated_at"]


class AggregateSerializer(CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    cf_model = "aggregate"

    rir = RIRMiniSerializer(read_only=True)
    tags = TagSerializer(many=True, read_only=True)
    family = serializers.IntegerField(read_only=True, allow_null=True)
    utilisation_pct = serializers.IntegerField(read_only=True, allow_null=True)

    rir_id = TenantScopedPrimaryKeyRelatedField(
        source="rir", queryset=RIR.objects.all(), write_only=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def validate_prefix(self, value):
        import ipaddress as _ip

        try:
            _ip.ip_network(value, strict=False)
        except ValueError:
            raise serializers.ValidationError("Enter a valid CIDR prefix.")
        return value

    class Meta:
        model = Aggregate
        fields = ["id", "prefix", "family", "utilisation_pct",
                  "rir", "rir_id", "date_added", "description",
                  "tags", "tag_ids", "custom_fields",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


# ─── ASNs ────────────────────────────────────────────────────────────────────
class ASNSerializer(CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    cf_model = "asn"

    rir = RIRMiniSerializer(read_only=True)
    sites = SiteMiniSerializer(many=True, read_only=True)
    tags = TagSerializer(many=True, read_only=True)

    rir_id = TenantScopedPrimaryKeyRelatedField(
        source="rir", queryset=RIR.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    site_ids = TenantScopedPrimaryKeyRelatedField(
        source="sites", queryset=Site.objects.all(),
        write_only=True, required=False, many=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def validate_asn(self, value):
        if not (1 <= value <= 4294967295):
            raise serializers.ValidationError("ASN must be 1…4294967295.")
        return value

    def validate(self, attrs):
        # Tenant-scoped uniqueness (tenant isn't a serializer field, so DRF
        # can't auto-generate the validator) — return a clean 400, not a 500.
        from api.views import _get_active_tenant

        asn = attrs.get("asn", getattr(self.instance, "asn", None))
        request = self.context.get("request")
        tenant = _get_active_tenant(request) if request is not None else None
        if asn is not None and tenant is not None:
            clash = ASN.objects.filter(tenant=tenant, asn=asn)
            if self.instance is not None:
                clash = clash.exclude(pk=self.instance.pk)
            if clash.exists():
                raise serializers.ValidationError(
                    {"asn": "An ASN with this number already exists."}
                )
        return attrs

    class Meta:
        model = ASN
        fields = ["id", "asn", "rir", "rir_id", "sites", "site_ids",
                  "description", "tags", "tag_ids", "custom_fields",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


# ─── VLAN groups ─────────────────────────────────────────────────────────────
class VLANGroupMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = VLANGroup
        fields = ["id", "name", "slug", "min_vid", "max_vid"]


class VLANGroupSerializer(NumIdModelSerializer):
    slug = serializers.SlugField(required=False, allow_blank=True)
    site = SiteMiniSerializer(read_only=True)
    cluster = serializers.SerializerMethodField()
    vlan_count = serializers.SerializerMethodField()

    site_id = TenantScopedPrimaryKeyRelatedField(
        source="site", queryset=Site.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    cluster_id = TenantScopedPrimaryKeyRelatedField(
        source="cluster", queryset=Cluster.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    def get_cluster(self, obj):
        c = obj.cluster
        return {"id": str(c.id), "name": c.name} if c else None

    def get_vlan_count(self, obj) -> int:
        v = getattr(obj, "vlan_count_annotated", None)
        return v if v is not None else obj.vlans.count()

    def validate(self, attrs):
        lo = attrs.get("min_vid", getattr(self.instance, "min_vid", 1))
        hi = attrs.get("max_vid", getattr(self.instance, "max_vid", 4094))
        if not (1 <= lo <= 4094) or not (1 <= hi <= 4094):
            raise serializers.ValidationError("VIDs must be within 1–4094.")
        if lo > hi:
            raise serializers.ValidationError(
                {"max_vid": "Max VID must be ≥ min VID."}
            )
        return attrs

    class Meta:
        model = VLANGroup
        fields = ["id", "name", "slug", "site", "site_id",
                  "cluster", "cluster_id", "min_vid", "max_vid",
                  "description", "vlan_count", "created_at", "updated_at"]
        read_only_fields = ["id", "vlan_count", "created_at", "updated_at"]


# ─── FHRP groups ─────────────────────────────────────────────────────────────
class FHRPGroupAssignmentSerializer(NumIdModelSerializer):
    interface = InterfaceMiniSerializer(read_only=True)
    vm_interface = serializers.SerializerMethodField()
    interface_id = TenantScopedPrimaryKeyRelatedField(
        source="interface", queryset=Interface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    vm_interface_id = TenantScopedPrimaryKeyRelatedField(
        source="vm_interface", queryset=VMInterface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    fhrp_group_id = TenantScopedPrimaryKeyRelatedField(
        source="fhrp_group", queryset=FHRPGroup.objects.all(), write_only=True,
    )

    def get_vm_interface(self, obj):
        vi = obj.vm_interface
        if not vi:
            return None
        return {"id": str(vi.id), "name": vi.name,
                "vm": {"id": str(vi.vm_id), "name": vi.vm.name}}

    def validate(self, attrs):
        iface = attrs.get("interface", getattr(self.instance, "interface", None))
        vmi = attrs.get("vm_interface", getattr(self.instance, "vm_interface", None))
        if bool(iface) == bool(vmi):
            raise serializers.ValidationError(
                "Provide exactly one of interface_id / vm_interface_id."
            )
        return attrs

    class Meta:
        model = FHRPGroupAssignment
        fields = ["id", "fhrp_group_id", "interface", "interface_id",
                  "vm_interface", "vm_interface_id", "priority",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]
        # Drop DRF's auto UniqueTogetherValidators — they'd force both
        # interface_id and vm_interface_id to be supplied. Exactly-one is
        # checked in validate(); the DB UniqueConstraints still protect dupes.
        validators = []


class FHRPGroupSerializer(CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    cf_model = "fhrpgroup"

    protocol_display = serializers.CharField(
        source="get_protocol_display", read_only=True
    )
    auth_type_display = serializers.CharField(
        source="get_auth_type_display", read_only=True
    )
    virtual_ip = IPMiniSerializer(read_only=True)
    assignments = FHRPGroupAssignmentSerializer(many=True, read_only=True)
    assignment_count = serializers.SerializerMethodField()
    tags = TagSerializer(many=True, read_only=True)

    virtual_ip_id = TenantScopedPrimaryKeyRelatedField(
        source="virtual_ip", queryset=IPAddress.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_assignment_count(self, obj) -> int:
        return obj.assignments.count()

    def validate_group_id(self, value):
        if not (0 <= value <= 255):
            raise serializers.ValidationError("Group ID must be 0–255.")
        return value

    class Meta:
        model = FHRPGroup
        fields = ["id", "name", "protocol", "protocol_display",
                  "group_id", "auth_type", "auth_type_display", "auth_key",
                  "virtual_ip", "virtual_ip_id",
                  "assignments", "assignment_count",
                  "description", "tags", "tag_ids", "custom_fields",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


# ─── Contacts ────────────────────────────────────────────────────────────────
class ContactGroupMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = ContactGroup
        fields = ["id", "name", "slug"]


class ContactGroupMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = ContactGroup
        fields = ["id", "name", "slug"]


class ContactGroupSerializer(NumIdModelSerializer):
    slug = serializers.SlugField(required=False, allow_blank=True)
    parent = ContactGroupMiniSerializer(read_only=True)
    parent_id = TenantScopedPrimaryKeyRelatedField(
        source="parent", queryset=ContactGroup.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    contact_count = serializers.SerializerMethodField()
    child_count = serializers.SerializerMethodField()

    def get_contact_count(self, obj) -> int:
        v = getattr(obj, "contact_count_annotated", None)
        return v if v is not None else obj.contacts.count()

    def get_child_count(self, obj) -> int:
        return obj.children.count()

    def validate_parent_id(self, value):
        if value and self.instance:
            node = value
            while node is not None:
                if node.pk == self.instance.pk:
                    raise serializers.ValidationError(
                        "This would create a cycle."
                    )
                node = node.parent
        return value

    class Meta:
        model = ContactGroup
        fields = ["id", "name", "slug", "parent", "parent_id", "description",
                  "contact_count", "child_count", "created_at", "updated_at"]
        read_only_fields = ["id", "contact_count", "child_count",
                            "created_at", "updated_at"]


class ContactRoleMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = ContactRole
        fields = ["id", "name", "slug"]


class ContactRoleSerializer(NumIdModelSerializer):
    slug = serializers.SlugField(required=False, allow_blank=True)
    assignment_count = serializers.SerializerMethodField()

    def get_assignment_count(self, obj) -> int:
        return obj.assignments.count()

    class Meta:
        model = ContactRole
        fields = ["id", "name", "slug", "description", "assignment_count",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "assignment_count", "created_at", "updated_at"]


class ContactMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = Contact
        fields = ["id", "name", "title", "email", "phone"]


class ContactSerializer(CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer):
    cf_model = "contact"

    group = ContactGroupMiniSerializer(read_only=True)
    tags = TagSerializer(many=True, read_only=True)
    assignment_count = serializers.SerializerMethodField()

    group_id = TenantScopedPrimaryKeyRelatedField(
        source="group", queryset=ContactGroup.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_assignment_count(self, obj) -> int:
        return obj.assignments.count()

    class Meta:
        model = Contact
        fields = ["id", "name", "title", "phone", "email", "address", "link",
                  "comments", "group", "group_id", "assignment_count",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "assignment_count", "created_at", "updated_at"]


class ContactAssignmentSerializer(NumIdModelSerializer):
    contact = ContactMiniSerializer(read_only=True)
    role = ContactRoleMiniSerializer(read_only=True)
    priority_display = serializers.CharField(
        source="get_priority_display", read_only=True
    )

    contact_id = TenantScopedPrimaryKeyRelatedField(
        source="contact", queryset=Contact.objects.all(), write_only=True,
    )
    role_id = TenantScopedPrimaryKeyRelatedField(
        source="role", queryset=ContactRole.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    def validate_object_type(self, value):
        from .models import CONTACTABLE_TYPES

        if value not in CONTACTABLE_TYPES:
            raise serializers.ValidationError(
                f"Unknown object type. One of: {', '.join(CONTACTABLE_TYPES)}."
            )
        return value

    class Meta:
        model = ContactAssignment
        fields = ["id", "contact", "contact_id", "role", "role_id",
                  "object_type", "object_id", "priority", "priority_display",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]
        # Drop DRF's auto unique-together validator (object_type/object_id/
        # contact/role) — role is optional, so a clean re-POST would otherwise
        # be wrongly required; the DB constraint still guards dupes.
        validators = []


# ─── Circuits ────────────────────────────────────────────────────────────────
class ProviderMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = Provider
        fields = ["id", "name", "slug"]


class ProviderSerializer(
    CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer
):
    cf_model = "provider"
    slug = serializers.SlugField(required=False, allow_blank=True)
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )
    circuit_count = serializers.SerializerMethodField()

    def get_circuit_count(self, obj) -> int:
        v = getattr(obj, "circuit_count_annotated", None)
        return v if v is not None else obj.circuits.count()

    class Meta:
        model = Provider
        fields = ["id", "name", "slug", "account", "portal_url", "noc_email",
                  "noc_phone", "comments", "circuit_count", "tags", "tag_ids",
                  "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "circuit_count", "created_at", "updated_at"]


class CircuitTypeMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = CircuitType
        fields = ["id", "name", "slug", "color"]


class CircuitTypeSerializer(NumIdModelSerializer):
    slug = serializers.SlugField(required=False, allow_blank=True)
    circuit_count = serializers.SerializerMethodField()

    def get_circuit_count(self, obj) -> int:
        v = getattr(obj, "circuit_count_annotated", None)
        return v if v is not None else obj.circuits.count()

    class Meta:
        model = CircuitType
        fields = ["id", "name", "slug", "color", "description", "circuit_count",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "circuit_count", "created_at", "updated_at"]


class ProviderNetworkMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = ProviderNetwork
        fields = ["id", "name"]


class ProviderNetworkSerializer(
    CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer
):
    cf_model = "providernetwork"
    provider = ProviderMiniSerializer(read_only=True)
    tags = TagSerializer(many=True, read_only=True)
    circuit_count = serializers.SerializerMethodField()

    provider_id = TenantScopedPrimaryKeyRelatedField(
        source="provider", queryset=Provider.objects.all(), write_only=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_circuit_count(self, obj) -> int:
        return obj.circuit_terminations.count()

    class Meta:
        model = ProviderNetwork
        fields = ["id", "name", "provider", "provider_id", "service_id",
                  "description", "comments", "circuit_count",
                  "tags", "tag_ids", "custom_fields",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class CircuitTerminationSerializer(serializers.ModelSerializer):
    """One end (A/Z) of a circuit — exactly one of site / provider_network."""

    site = SiteMiniSerializer(read_only=True)
    provider_network = ProviderNetworkMiniSerializer(read_only=True)

    circuit_id = serializers.PrimaryKeyRelatedField(
        source="circuit", queryset=Circuit.objects.all(), write_only=True,
    )
    site_id = TenantScopedPrimaryKeyRelatedField(
        source="site", queryset=Site.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    provider_network_id = TenantScopedPrimaryKeyRelatedField(
        source="provider_network", queryset=ProviderNetwork.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    def validate(self, attrs):
        site = attrs.get("site", getattr(self.instance, "site", None))
        pn = attrs.get(
            "provider_network", getattr(self.instance, "provider_network", None)
        )
        if bool(site) == bool(pn):
            raise serializers.ValidationError(
                "A termination lands on exactly one of a site or a provider network."
            )
        return attrs

    class Meta:
        model = CircuitTermination
        fields = ["id", "circuit_id", "term_side", "site", "site_id",
                  "provider_network", "provider_network_id",
                  "port_speed_kbps", "upstream_speed_kbps", "xconnect_id",
                  "pp_info", "description", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class CircuitSerializer(StatusSerializerMixin,
    CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer
):
    cf_model = "circuit"

    provider = ProviderMiniSerializer(read_only=True)
    type = CircuitTypeMiniSerializer(read_only=True)
    terminations = CircuitTerminationSerializer(many=True, read_only=True)
    tags = TagSerializer(many=True, read_only=True)

    provider_id = TenantScopedPrimaryKeyRelatedField(
        source="provider", queryset=Provider.objects.all(), write_only=True,
    )
    type_id = TenantScopedPrimaryKeyRelatedField(
        source="type", queryset=CircuitType.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    class Meta:
        model = Circuit
        fields = ["id", "cid", "provider", "provider_id", "type", "type_id",
                  "status", "status_id",  "install_date", "termination_date",
                  "commit_rate_kbps", "terminations", "description",
                  "comments", "tags", "tag_ids", "custom_fields",
                  "created_at", "updated_at"]
        read_only_fields = ["id",  "created_at", "updated_at"]


# ─── Power ───────────────────────────────────────────────────────────────────
class PowerPanelMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = PowerPanel
        fields = ["id", "name"]


class PowerPanelSerializer(
    CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer
):
    cf_model = "powerpanel"
    site = SiteMiniSerializer(read_only=True)
    tags = TagSerializer(many=True, read_only=True)
    feed_count = serializers.SerializerMethodField()

    site_id = TenantScopedPrimaryKeyRelatedField(
        source="site", queryset=Site.objects.all(), write_only=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_feed_count(self, obj) -> int:
        v = getattr(obj, "feed_count_annotated", None)
        return v if v is not None else obj.power_feeds.count()

    class Meta:
        model = PowerPanel
        fields = ["id", "name", "site", "site_id", "comments", "feed_count",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "feed_count", "created_at", "updated_at"]


class PowerFeedSerializer(StatusSerializerMixin, 
    CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer
):
    cf_model = "powerfeed"
    power_panel = PowerPanelMiniSerializer(read_only=True)
    rack = RackMiniSerializer(read_only=True)
    type_display = serializers.CharField(source="get_type_display", read_only=True)
    supply_display = serializers.CharField(source="get_supply_display", read_only=True)
    phase_display = serializers.CharField(source="get_phase_display", read_only=True)
    tags = TagSerializer(many=True, read_only=True)

    power_panel_id = TenantScopedPrimaryKeyRelatedField(
        source="power_panel", queryset=PowerPanel.objects.all(), write_only=True,
    )
    rack_id = TenantScopedPrimaryKeyRelatedField(
        source="rack", queryset=Rack.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    class Meta:
        model = PowerFeed
        fields = ["id", "name", "power_panel", "power_panel_id", "rack", "rack_id",
                  "status", "status_id",  "type", "type_display",
                  "supply", "supply_display", "phase", "phase_display",
                  "voltage", "amperage", "max_utilization", "comments",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id",  "type_display",
                            "supply_display", "phase_display",
                            "created_at", "updated_at"]


# ─── Wireless ────────────────────────────────────────────────────────────────
class WirelessLANGroupMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = WirelessLANGroup
        fields = ["id", "name", "slug"]


class WirelessLANGroupSerializer(NumIdModelSerializer):
    slug = serializers.SlugField(required=False, allow_blank=True)
    wlan_count = serializers.SerializerMethodField()

    def get_wlan_count(self, obj) -> int:
        v = getattr(obj, "wlan_count_annotated", None)
        return v if v is not None else obj.wireless_lans.count()

    class Meta:
        model = WirelessLANGroup
        fields = ["id", "name", "slug", "description", "wlan_count",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "wlan_count", "created_at", "updated_at"]


class WirelessLANSerializer(StatusSerializerMixin, 
    CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer
):
    cf_model = "wirelesslan"
    group = WirelessLANGroupMiniSerializer(read_only=True)
    vlan = VLANMiniSerializer(read_only=True)
    auth_type_display = serializers.CharField(
        source="get_auth_type_display", read_only=True
    )
    tags = TagSerializer(many=True, read_only=True)

    group_id = TenantScopedPrimaryKeyRelatedField(
        source="group", queryset=WirelessLANGroup.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    vlan_id = TenantScopedPrimaryKeyRelatedField(
        source="vlan", queryset=VLAN.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    class Meta:
        model = WirelessLAN
        fields = ["id", "ssid", "group", "group_id", "status", "status_id", 
                  "vlan", "vlan_id", "auth_type", "auth_type_display",
                  "auth_cipher", "description", "comments",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id",  "auth_type_display",
                            "created_at", "updated_at"]


# ─── VPN ─────────────────────────────────────────────────────────────────────
class TunnelGroupMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = TunnelGroup
        fields = ["id", "name", "slug"]


class TunnelGroupSerializer(NumIdModelSerializer):
    slug = serializers.SlugField(required=False, allow_blank=True)
    tunnel_count = serializers.SerializerMethodField()

    def get_tunnel_count(self, obj) -> int:
        v = getattr(obj, "tunnel_count_annotated", None)
        return v if v is not None else obj.tunnels.count()

    class Meta:
        model = TunnelGroup
        fields = ["id", "name", "slug", "description", "tunnel_count",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "tunnel_count", "created_at", "updated_at"]


class IPSecProfileMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = IPSecProfile
        fields = ["id", "name"]


class IPSecProfileSerializer(NumIdModelSerializer):
    ike_version_display = serializers.CharField(
        source="get_ike_version_display", read_only=True
    )
    encryption_display = serializers.CharField(
        source="get_encryption_display", read_only=True
    )
    authentication_display = serializers.CharField(
        source="get_authentication_display", read_only=True
    )
    tunnel_count = serializers.SerializerMethodField()

    def get_tunnel_count(self, obj) -> int:
        v = getattr(obj, "tunnel_count_annotated", None)
        return v if v is not None else obj.tunnels.count()

    class Meta:
        model = IPSecProfile
        fields = ["id", "name", "ike_version", "ike_version_display",
                  "encryption", "encryption_display", "authentication",
                  "authentication_display", "dh_group", "pfs_group",
                  "sa_lifetime", "description", "tunnel_count",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "ike_version_display", "encryption_display",
                            "authentication_display", "tunnel_count",
                            "created_at", "updated_at"]


class TunnelTerminationSerializer(serializers.ModelSerializer):
    """One end of a tunnel — exactly one of interface / vm_interface, plus the
    underlay outside IP."""

    interface = serializers.SerializerMethodField()
    vm_interface = serializers.SerializerMethodField()
    outside_ip = serializers.SerializerMethodField()
    role_display = serializers.CharField(source="get_role_display", read_only=True)

    tunnel_id = serializers.PrimaryKeyRelatedField(
        source="tunnel", queryset=Tunnel.objects.all(), write_only=True,
    )
    interface_id = serializers.PrimaryKeyRelatedField(
        source="interface", queryset=Interface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    vm_interface_id = serializers.PrimaryKeyRelatedField(
        source="vm_interface", queryset=VMInterface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    outside_ip_id = TenantScopedPrimaryKeyRelatedField(
        source="outside_ip", queryset=IPAddress.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    def get_interface(self, obj):
        i = obj.interface
        if i is None:
            return None
        return {"id": str(i.id), "name": i.name,
                "device": {"id": str(i.device_id), "name": i.device.name}}

    def get_vm_interface(self, obj):
        i = obj.vm_interface
        if i is None:
            return None
        return {"id": str(i.id), "name": i.name,
                "vm": {"id": str(i.vm_id), "name": i.vm.name}}

    def get_outside_ip(self, obj):
        ip = obj.outside_ip
        return {"id": str(ip.id), "ip_address": ip.ip_address} if ip else None

    def validate(self, attrs):
        iface = attrs.get("interface", getattr(self.instance, "interface", None))
        vmi = attrs.get(
            "vm_interface", getattr(self.instance, "vm_interface", None)
        )
        if bool(iface) == bool(vmi):
            raise serializers.ValidationError(
                "A termination binds exactly one of an interface or a VM interface."
            )
        return attrs

    class Meta:
        model = TunnelTermination
        fields = ["id", "tunnel_id", "role", "role_display",
                  "interface", "interface_id", "vm_interface",
                  "vm_interface_id", "outside_ip", "outside_ip_id",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class TunnelSerializer(StatusSerializerMixin,
    CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer
):
    cf_model = "tunnel"
    group = TunnelGroupMiniSerializer(read_only=True)
    ipsec_profile = IPSecProfileMiniSerializer(read_only=True)
    terminations = TunnelTerminationSerializer(many=True, read_only=True)
    encapsulation_display = serializers.CharField(
        source="get_encapsulation_display", read_only=True
    )
    tags = TagSerializer(many=True, read_only=True)

    group_id = TenantScopedPrimaryKeyRelatedField(
        source="group", queryset=TunnelGroup.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    ipsec_profile_id = TenantScopedPrimaryKeyRelatedField(
        source="ipsec_profile", queryset=IPSecProfile.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    class Meta:
        model = Tunnel
        fields = ["id", "name", "status", "status_id",  "encapsulation",
                  "encapsulation_display", "tunnel_id", "group", "group_id",
                  "ipsec_profile", "ipsec_profile_id", "terminations",
                  "description", "comments",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id",  "encapsulation_display",
                            "created_at", "updated_at"]


# ─── Regions & Locations ─────────────────────────────────────────────────────
class RegionMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = Region
        fields = ["id", "name", "slug"]


class RegionSerializer(NumIdModelSerializer):
    slug = serializers.SlugField(required=False, allow_blank=True)
    parent = RegionMiniSerializer(read_only=True)
    parent_id = TenantScopedPrimaryKeyRelatedField(
        source="parent", queryset=Region.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    site_count = serializers.SerializerMethodField()
    child_count = serializers.SerializerMethodField()

    def get_site_count(self, obj) -> int:
        return obj.sites.count()

    def get_child_count(self, obj) -> int:
        return obj.children.count()

    def validate_parent_id(self, value):
        if value and self.instance and value.pk == self.instance.pk:
            raise serializers.ValidationError("A region can't be its own parent.")
        return value

    class Meta:
        model = Region
        fields = ["id", "name", "slug", "parent", "parent_id", "description",
                  "site_count", "child_count", "created_at", "updated_at"]
        read_only_fields = ["id", "site_count", "child_count",
                            "created_at", "updated_at"]


class LocationMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = Location
        fields = ["id", "name", "slug"]


class LocationSerializer(StatusSerializerMixin, NumIdModelSerializer):
    slug = serializers.SlugField(required=False, allow_blank=True)
    site = SiteMiniSerializer(read_only=True)
    parent = LocationMiniSerializer(read_only=True)
    child_count = serializers.SerializerMethodField()

    site_id = TenantScopedPrimaryKeyRelatedField(
        source="site", queryset=Site.objects.all(), write_only=True,
    )
    parent_id = TenantScopedPrimaryKeyRelatedField(
        source="parent", queryset=Location.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    def get_child_count(self, obj) -> int:
        return obj.children.count()

    def validate(self, attrs):
        parent = attrs.get("parent", getattr(self.instance, "parent", None))
        site = attrs.get("site", getattr(self.instance, "site", None))
        if parent is not None:
            if self.instance and parent.pk == self.instance.pk:
                raise serializers.ValidationError(
                    {"parent_id": "A location can't be its own parent."}
                )
            if site is not None and parent.site_id != site.id:
                raise serializers.ValidationError(
                    {"parent_id": "Parent location must be in the same site."}
                )
        return attrs

    class Meta:
        model = Location
        fields = ["id", "name", "slug", "site", "site_id", "parent", "parent_id",
                  "status", "status_id",  "description", "child_count",
                  "created_at", "updated_at"]
        read_only_fields = ["id",  "child_count",
                            "created_at", "updated_at"]


# ─── Config Contexts ─────────────────────────────────────────────────────────
class ConfigContextSerializer(NumIdModelSerializer):
    regions = RegionMiniSerializer(many=True, read_only=True)
    sites = SiteMiniSerializer(many=True, read_only=True)
    device_roles = serializers.SerializerMethodField()
    platforms = serializers.SerializerMethodField()

    region_ids = TenantScopedPrimaryKeyRelatedField(
        source="regions", queryset=Region.objects.all(),
        many=True, write_only=True, required=False,
    )
    site_ids = TenantScopedPrimaryKeyRelatedField(
        source="sites", queryset=Site.objects.all(),
        many=True, write_only=True, required=False,
    )
    device_role_ids = TenantScopedPrimaryKeyRelatedField(
        source="device_roles", queryset=DeviceRole.objects.all(),
        many=True, write_only=True, required=False,
    )
    platform_ids = TenantScopedPrimaryKeyRelatedField(
        source="platforms", queryset=Platform.objects.all(),
        many=True, write_only=True, required=False,
    )

    def get_device_roles(self, obj):
        return [{"id": str(r.id), "name": r.name} for r in obj.device_roles.all()]

    def get_platforms(self, obj):
        return [{"id": str(p.id), "name": p.name} for p in obj.platforms.all()]

    def validate_data(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("Data must be a JSON object.")
        return value

    class Meta:
        model = ConfigContext
        fields = ["id", "name", "weight", "is_active", "description", "data",
                  "regions", "region_ids", "sites", "site_ids",
                  "device_roles", "device_role_ids", "platforms", "platform_ids",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


# ─── Export templates ────────────────────────────────────────────────────────
class ExportTemplateSerializer(NumIdModelSerializer):
    object_type_label = serializers.SerializerMethodField()

    def get_object_type_label(self, obj) -> str:
        from auth_api.object_types import _registry

        entry = _registry().get(obj.object_type)
        return entry["label"] if entry else obj.object_type

    def validate_object_type(self, value):
        from auth_api.object_types import is_registered

        if not is_registered(value):
            raise serializers.ValidationError("Unknown object type.")
        return value

    def validate_template_code(self, value):
        # Compile-check the template so syntax errors surface on save, not render.
        from jinja2.sandbox import SandboxedEnvironment
        from jinja2 import TemplateSyntaxError

        try:
            SandboxedEnvironment().from_string(value or "")
        except TemplateSyntaxError as exc:
            raise serializers.ValidationError(f"Template syntax error: {exc}")
        return value

    class Meta:
        model = ExportTemplate
        fields = ["id", "name", "object_type", "object_type_label", "description",
                  "template_code", "mime_type", "file_extension", "as_attachment",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "object_type_label", "created_at", "updated_at"]


# ─── Virtual chassis (switch stacks) ─────────────────────────────────────────
class VirtualChassisMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = VirtualChassis
        fields = ["id", "name", "domain"]


class VirtualChassisSerializer(
    CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer
):
    cf_model = "virtualchassis"
    master = DeviceMiniSerializer(read_only=True)
    master_id = TenantScopedPrimaryKeyRelatedField(
        source="master", queryset=Device.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    members = serializers.SerializerMethodField()
    member_count = serializers.SerializerMethodField()
    # The stack's management addresses come from its master device.
    primary_ip = serializers.SerializerMethodField()
    oob_ip = serializers.SerializerMethodField()
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    @staticmethod
    def _ip_mini(ip):
        return (
            {"id": str(ip.id), "ip_address": ip.ip_address} if ip else None
        )

    def get_primary_ip(self, obj):
        return self._ip_mini(obj.master.primary_ip if obj.master_id else None)

    def get_oob_ip(self, obj):
        return self._ip_mini(obj.master.oob_ip if obj.master_id else None)

    def get_members(self, obj):
        return [
            {
                "id": str(d.id), "name": d.name,
                "vc_position": d.vc_position, "vc_priority": d.vc_priority,
                "is_master": obj.master_id == d.pk,
                "serial_number": d.serial_number,
                # For the stack faceplates — saved layouts live on the type.
                "device_type_id": str(d.device_type_id) if d.device_type_id else None,
                "status": (
                    {"id": str(d.status_id), "name": d.status.name,
                     "color": d.status.color,
                     "text_color": d.status.text_color}
                    if d.status_id else None
                ),
            }
            for d in obj.members.select_related("status").order_by(
                "vc_position", "name"
            )
        ]

    def get_member_count(self, obj) -> int:
        return obj.members.count()

    def validate_master_id(self, value):
        # The master must be (or become) a member of this chassis.
        if value is not None and self.instance is not None:
            if value.virtual_chassis_id != self.instance.pk:
                raise serializers.ValidationError(
                    "The master must be a member of this chassis."
                )
        return value

    class Meta:
        model = VirtualChassis
        fields = ["id", "name", "domain", "master", "master_id",
                  "members", "member_count", "primary_ip", "oob_ip",
                  "description", "comments",
                  "tags", "tag_ids", "custom_fields",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "members", "member_count",
                            "created_at", "updated_at"]


# ─── L2VPN (EVPN / VXLAN / VPWS overlays) ────────────────────────────────────
class L2VPNMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = L2VPN
        fields = ["id", "name", "slug", "type"]


class L2VPNTerminationSerializer(serializers.ModelSerializer):
    l2vpn_id = TenantScopedPrimaryKeyRelatedField(
        source="l2vpn", queryset=L2VPN.objects.all(), write_only=True,
    )
    l2vpn = L2VPNMiniSerializer(read_only=True)
    vlan = serializers.SerializerMethodField()
    interface = serializers.SerializerMethodField()
    vm_interface = serializers.SerializerMethodField()
    vlan_id = TenantScopedPrimaryKeyRelatedField(
        source="vlan", queryset=VLAN.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    interface_id = serializers.PrimaryKeyRelatedField(
        source="interface", queryset=Interface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    vm_interface_id = serializers.PrimaryKeyRelatedField(
        source="vm_interface", queryset=VMInterface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    def get_vlan(self, obj):
        v = obj.vlan
        return (
            {"id": str(v.id), "vlan_id": v.vlan_id, "name": v.name}
            if v else None
        )

    def get_interface(self, obj):
        i = obj.interface
        if i is None:
            return None
        return {"id": str(i.id), "name": i.name,
                "device": {"id": str(i.device_id), "name": i.device.name}}

    def get_vm_interface(self, obj):
        i = obj.vm_interface
        if i is None:
            return None
        return {"id": str(i.id), "name": i.name,
                "vm": {"id": str(i.vm_id), "name": i.vm.name}}

    def validate(self, attrs):
        vlan = attrs.get("vlan", getattr(self.instance, "vlan", None))
        iface = attrs.get("interface", getattr(self.instance, "interface", None))
        vmi = attrs.get(
            "vm_interface", getattr(self.instance, "vm_interface", None)
        )
        if sum(1 for x in (vlan, iface, vmi) if x is not None) != 1:
            raise serializers.ValidationError(
                "A termination attaches exactly one of a VLAN, an interface, "
                "or a VM interface."
            )
        # Endpoints terminate at most one L2VPN.
        for field, obj in (("vlan", vlan), ("interface", iface),
                           ("vm_interface", vmi)):
            if obj is None:
                continue
            clash = L2VPNTermination.objects.filter(**{field: obj})
            if self.instance is not None:
                clash = clash.exclude(pk=self.instance.pk)
            if clash.exists():
                raise serializers.ValidationError(
                    {f"{field}_id": f"{obj} already terminates an L2VPN."}
                )
        return attrs

    class Meta:
        model = L2VPNTermination
        fields = ["id", "l2vpn", "l2vpn_id", "vlan", "vlan_id",
                  "interface", "interface_id",
                  "vm_interface", "vm_interface_id",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class L2VPNSerializer(StatusSerializerMixin,
    CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer
):
    cf_model = "l2vpn"
    slug = serializers.SlugField(required=False, allow_blank=True)
    type_display = serializers.CharField(
        source="get_type_display", read_only=True
    )
    import_targets = RouteTargetMiniSerializer(many=True, read_only=True)
    export_targets = RouteTargetMiniSerializer(many=True, read_only=True)
    import_target_ids = TenantScopedPrimaryKeyRelatedField(
        source="import_targets", queryset=RouteTarget.objects.all(),
        write_only=True, required=False, many=True,
    )
    export_target_ids = TenantScopedPrimaryKeyRelatedField(
        source="export_targets", queryset=RouteTarget.objects.all(),
        write_only=True, required=False, many=True,
    )
    terminations = L2VPNTerminationSerializer(many=True, read_only=True)
    termination_count = serializers.SerializerMethodField()
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_termination_count(self, obj) -> int:
        return obj.terminations.count()

    class Meta:
        model = L2VPN
        fields = ["id", "name", "slug", "type", "type_display", "identifier",
                  "status", "status_id", "import_targets", "import_target_ids",
                  "export_targets", "export_target_ids",
                  "terminations", "termination_count",
                  "description", "comments", "tags", "tag_ids",
                  "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "type_display", "terminations",
                            "termination_count", "created_at", "updated_at"]


# ─── Floor plans ─────────────────────────────────────────────────────────────
class FloorTileTypeMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = FloorTileType
        fields = ["id", "name", "slug", "color", "icon",
                  "default_width", "default_height", "is_zone", "has_fov"]


class SiteMarkerSerializer(serializers.ModelSerializer):
    """A free marker on the geographic Site map. ``type`` mirrors the
    floor-plan tile contract: exactly one of tile_type_id / role_type_id."""

    tile_type_id = TenantScopedPrimaryKeyRelatedField(
        source="tile_type", queryset=FloorTileType.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    role_type_id = TenantScopedPrimaryKeyRelatedField(
        source="role_type", queryset=DeviceRole.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    device = serializers.SerializerMethodField()
    type = serializers.SerializerMethodField()

    def get_device(self, obj):
        d = obj.device
        return {"id": str(d.id), "name": d.name} if d else None

    def get_type(self, obj):
        t = obj.type_obj
        if t is None:
            return None
        return {
            "id": str(t.id),
            "name": t.name,
            "color": getattr(t, "color", "") or "",
            "icon": getattr(t, "icon", "") or "",
            "has_fov": bool(getattr(t, "has_fov", False)),
            "kind": "tile_type" if obj.tile_type_id else "role",
        }

    def validate(self, attrs):
        tile = attrs.get("tile_type", getattr(self.instance, "tile_type", None))
        role = attrs.get("role_type", getattr(self.instance, "role_type", None))
        if bool(tile) == bool(role):
            raise serializers.ValidationError(
                {"tile_type_id": "Pick exactly one of tile type or device role."}
            )
        return attrs

    class Meta:
        model = SiteMarker
        fields = ["id", "latitude", "longitude", "tile_type_id", "role_type_id",
                  "type", "device", "device_id", "label", "description",
                  "fov_direction", "fov_deg", "fov_distance_m", "fov_ptz",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class FloorTileTypeSerializer(NumIdModelSerializer):
    slug = serializers.SlugField(required=False, allow_blank=True)
    tile_count = serializers.SerializerMethodField()

    def get_tile_count(self, obj) -> int:
        return obj.tiles.count()

    class Meta:
        model = FloorTileType
        fields = ["id", "numid", "name", "slug", "color", "icon",
                  "default_width", "default_height", "is_zone", "has_fov",
                  "description", "tile_count", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "tile_count",
                            "created_at", "updated_at"]


class FloorPlanMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = FloorPlan
        fields = ["id", "name", "grid_width", "grid_height"]


class FloorPlanSerializer(
    CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer
):
    cf_model = "floorplan"

    location = LocationMiniSerializer(read_only=True)
    location_id = TenantScopedPrimaryKeyRelatedField(
        source="location", queryset=Location.objects.all(), write_only=True
    )
    site = serializers.SerializerMethodField()
    background_image = serializers.SerializerMethodField()
    tile_count = serializers.SerializerMethodField()
    state = serializers.JSONField(required=False)
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_site(self, obj):
        if obj.location_id is None:
            return None
        return SiteMiniSerializer(obj.location.site).data

    def get_background_image(self, obj):
        return _img_url(self, obj.background_image)

    def get_tile_count(self, obj) -> int:
        return obj.tiles.count()

    def validate_state(self, v):
        if not isinstance(v, dict):
            raise serializers.ValidationError("state must be an object")
        return v

    def validate(self, attrs):
        # Friendly duplicate check ahead of the DB unique constraint.
        location = attrs.get("location", getattr(self.instance, "location", None))
        name = attrs.get("name", getattr(self.instance, "name", None))
        if location is not None and name:
            clash = FloorPlan.objects.filter(
                tenant=location.tenant, location=location, name=name
            )
            if self.instance is not None:
                clash = clash.exclude(pk=self.instance.pk)
            if clash.exists():
                raise serializers.ValidationError(
                    {"name": "This location already has a plan with that name."}
                )
        return attrs

    class Meta:
        model = FloorPlan
        fields = ["id", "numid", "name", "location", "location_id", "site",
                  "grid_width", "grid_height", "background_image",
                  "background_opacity", "state", "description", "tile_count",
                  "tags", "tag_ids", "custom_fields",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "site", "background_image",
                            "tile_count", "created_at", "updated_at"]


class FloorPlanTileSerializer(NumIdModelSerializer):
    """A placed tile. The link is written as ``link_kind`` + ``link_id``
    (resolved to the right FK, tenant-checked — the CableSerializer
    reference-kind approach) and read back as a compact ``linked`` object
    ``{kind, id, name, route}`` for the canvas to render + deep-link."""

    _LINK_MODELS = {
        "rack": Rack,
        "device": Device,
        "powerpanel": PowerPanel,
        "powerfeed": PowerFeed,
        "floorplan": FloorPlan,
    }
    _LINK_ROUTES = {
        "rack": "/racks/{id}",
        "device": "/devices/{id}",
        # Panels/feeds have no detail page — their edit page is the deep-link.
        "powerpanel": "/power-panels/{id}/edit",
        "powerfeed": "/power-feeds/{id}/edit",
        "floorplan": "/floorplans/{id}",
    }

    floor_plan = FloorPlanMiniSerializer(read_only=True)
    floor_plan_id = TenantScopedPrimaryKeyRelatedField(
        source="floor_plan", queryset=FloorPlan.objects.all(),
        write_only=True, required=False,
    )
    tile_type = FloorTileTypeMiniSerializer(read_only=True)
    tile_type_id = TenantScopedPrimaryKeyRelatedField(
        source="tile_type", queryset=FloorTileType.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    role_type = DeviceRoleMiniSerializer(read_only=True)
    role_type_id = TenantScopedPrimaryKeyRelatedField(
        source="role_type", queryset=DeviceRole.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    link_kind = serializers.CharField(required=False, allow_blank=True)
    link_id = serializers.CharField(
        write_only=True, required=False, allow_null=True, allow_blank=True
    )
    linked = serializers.SerializerMethodField()

    def get_linked(self, obj):
        field = FloorPlanTile.LINK_FIELDS.get(obj.link_kind)
        target = getattr(obj, field) if field else None
        if target is None:
            return None
        return {
            "kind": obj.link_kind,
            "id": str(target.pk),
            "name": str(target),
            "route": self._LINK_ROUTES[obj.link_kind].format(id=target.pk),
        }

    def validate(self, attrs):
        from api.views import _get_active_tenant

        # Exactly one of tile_type / role_type (matches the DB constraint,
        # but with a friendly message).
        tile_type = attrs.get(
            "tile_type", getattr(self.instance, "tile_type", None)
        )
        role_type = attrs.get(
            "role_type", getattr(self.instance, "role_type", None)
        )
        if (tile_type is None) == (role_type is None):
            raise serializers.ValidationError(
                {"tile_type_id": "Set exactly one of tile_type_id / role_type_id."}
            )

        # Resolve the link when the payload touches it.
        if "link_kind" in attrs or "link_id" in attrs:
            kind = attrs.get("link_kind") or ""
            link_id = attrs.pop("link_id", None) or ""
            for field in FloorPlanTile.LINK_FIELDS.values():
                attrs[field] = None
            attrs["link_kind"] = ""
            if kind:
                model = self._LINK_MODELS.get(kind)
                if model is None:
                    raise serializers.ValidationError(
                        {"link_kind": f"Unknown link kind {kind!r}."}
                    )
                if not link_id:
                    raise serializers.ValidationError(
                        {"link_id": "A link needs both link_kind and link_id."}
                    )
                obj = model.objects.filter(pk=link_id).first()
                if obj is None:
                    raise serializers.ValidationError(
                        {"link_id": f"Unknown {kind} {link_id}."}
                    )
                request = self.context.get("request")
                tenant = _get_active_tenant(request) if request is not None else None
                if tenant is not None and obj.tenant_id != tenant.id:
                    raise serializers.ValidationError(
                        {"link_id": "Pick an object in the current tenant."}
                    )
                plan = attrs.get(
                    "floor_plan", getattr(self.instance, "floor_plan", None)
                )
                if kind == "floorplan" and plan is not None and obj.pk == plan.pk:
                    raise serializers.ValidationError(
                        {"link_id": "A tile can't link to its own floor plan."}
                    )
                attrs[FloorPlanTile.LINK_FIELDS[kind]] = obj
                attrs["link_kind"] = kind
        return attrs

    class Meta:
        model = FloorPlanTile
        fields = ["id", "floor_plan", "floor_plan_id", "x", "y", "width", "height",
                  "tile_type", "tile_type_id", "role_type", "role_type_id",
                  "orientation", "label", "color", "status",
                  "link_kind", "link_id", "linked",
                  "fov_deg", "fov_distance", "fov_direction", "fov_anchor",
                  "fov_ptz",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "linked", "created_at", "updated_at"]


class FloorPlanTraySerializer(NumIdModelSerializer):
    """A tray/conduit run on a plan. Cables are assigned manually in v1 —
    the tray lists the physical cables routed through it."""

    floor_plan_id = TenantScopedPrimaryKeyRelatedField(
        source="floor_plan", queryset=FloorPlan.objects.all(),
        write_only=True, required=False,
    )
    points = serializers.JSONField(required=False)
    cables = serializers.SerializerMethodField()
    cable_ids = TenantScopedPrimaryKeyRelatedField(
        source="cables", queryset=Cable.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_cables(self, obj):
        return [
            {
                "id": str(c.id),
                "numid": c.numid,
                "label": str(c),
                "type": c.type,
                "color": c.color,
            }
            for c in obj.cables.all()
        ]

    def validate_points(self, v):
        # Trays route on a half-cell lattice (twice as fine as the tile grid),
        # so cells can carry parallel/crossing runs. Values are in cell units
        # snapped to the nearest 0.5.
        if not isinstance(v, list) or not (2 <= len(v) <= 256):
            raise serializers.ValidationError(
                "points must be a list of 2–256 [x, y] pairs"
            )
        for p in v:
            if (
                not isinstance(p, (list, tuple))
                or len(p) != 2
                or not all(isinstance(n, (int, float)) for n in p)
                or not all(0 <= n <= 512 for n in p)
            ):
                raise serializers.ValidationError(
                    "each point must be an [x, y] pair within the grid"
                )
        return [[round(p[0] * 2) / 2, round(p[1] * 2) / 2] for p in v]

    class Meta:
        model = FloorPlanTray
        fields = ["id", "floor_plan_id", "name", "kind", "color", "points",
                  "description", "cables", "cable_ids",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "cables", "created_at", "updated_at"]


class CableRouteSerializer(NumIdModelSerializer):
    """A geographic duct/aerial/trench run on the site map. Cables are
    assigned manually in v1 — the route lists the cables that follow it."""

    waypoints = serializers.JSONField(required=False)
    cables = serializers.SerializerMethodField()
    cable_ids = TenantScopedPrimaryKeyRelatedField(
        source="cables", queryset=Cable.objects.all(),
        write_only=True, required=False, many=True,
    )

    def get_cables(self, obj):
        return [
            {
                "id": str(c.id),
                "numid": c.numid,
                "label": str(c),
                "type": c.type,
                "color": c.color,
            }
            for c in obj.cables.all()
        ]

    def validate_waypoints(self, v):
        if not isinstance(v, list) or not (2 <= len(v) <= 256):
            raise serializers.ValidationError(
                "waypoints must be a list of 2–256 [lat, lng] pairs"
            )
        for p in v:
            if (
                not isinstance(p, (list, tuple))
                or len(p) != 2
                or not all(isinstance(n, (int, float)) for n in p)
                or not (-90 <= p[0] <= 90)
                or not (-180 <= p[1] <= 180)
            ):
                raise serializers.ValidationError(
                    "each waypoint must be a [lat, lng] pair in range"
                )
        return [[round(p[0], 6), round(p[1], 6)] for p in v]

    class Meta:
        model = CableRoute
        fields = ["id", "name", "kind", "color", "waypoints",
                  "description", "cables", "cable_ids",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "cables", "created_at", "updated_at"]
