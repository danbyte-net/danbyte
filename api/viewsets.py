"""DRF viewsets — JSON endpoints for the v2 React frontend.

Scoped to the user's active tenant via ``_get_active_tenant`` (same rule
the old Django UI used) so a user can never see another tenant's data.
"""
from __future__ import annotations

from django.db import transaction
from django.db.models import Count, Q
from django.utils.text import slugify
from rest_framework import permissions, status as drf_status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.pagination import PageNumberPagination
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response

from audit.bulk import apply_and_log_bulk_tags, log_bulk_delete, log_bulk_update
from auth_api.drf import RBACViewSetMixin, restrict_for_view
from core.models import Organization, Tag, Tenant, TenantGroup
from customization.models import CustomField, CustomFieldGroup
from .models import (
    Aggregate, ASN, AuxPort, AuxPortTemplate,
    Cable, CableRoute, Circuit, CircuitTermination, CircuitType, Cluster,
    ClusterGroup, ClusterType,
    ConsolePort, ConsolePortTemplate, ConsoleServerPort,
    ConsoleServerPortTemplate,
    Contact, ContactAssignment, ContactGroup, ContactRole, Device, DeviceType,
    FHRPGroup, FHRPGroupAssignment,
    FiberSettings,
    FloorPlan, FloorPlanTile, FloorPlanTray, FloorTileType, SiteMarker,
    FrontPort, FrontPortTemplate,
    InterfaceTemplate, DeviceTypeService,
    IPAddress, IPRange, IPRole, Status, Interface, MACAddress, Manufacturer,
    DeviceBay, DeviceBayTemplate, InventoryItem, InventoryItemTemplate,
    TopologyView,
    Module, ModuleBay, ModuleBayTemplate, ModuleInterfaceTemplate, ModuleType,
    install_module, uninstall_module,
    PowerFeed, PowerOutlet, PowerOutletTemplate, PowerPanel, PowerPort,
    PowerPortTemplate, Prefix, Provider, ProviderNetwork, RearPort,
    RearPortTemplate,
    DeviceRole, Platform, Rack, RackRole, RIR, RouteTarget, Service, ServiceTemplate, Site, VirtualMachine, VMInterface, VLAN, VLANGroup, VRF, Zone,
    WirelessLAN, WirelessLANGroup,
    Tunnel, TunnelGroup, TunnelTermination, IPSecProfile,
    L2VPN, L2VPNTermination, VirtualChassis,
    Region, Location, ConfigContext, ExportTemplate,
    materialize_device_components, resolve_config_template,
    sync_positional_interface_names,
    diff_device_components, sync_device_components,
)
from .serializers import (
    CableRouteSerializer,
    CableSerializer,
    FiberSettingsSerializer,
    FloorPlanMiniSerializer,
    FloorPlanTraySerializer,
    FloorPlanSerializer,
    FloorPlanTileSerializer,
    SiteMarkerSerializer,
    FloorTileTypeMiniSerializer,
    FloorTileTypeSerializer,
    L2VPNSerializer,
    L2VPNTerminationSerializer,
    TenantGroupSerializer,
    VirtualChassisSerializer,
    ProviderSerializer,
    ProviderMiniSerializer,
    ProviderNetworkSerializer,
    CircuitTypeSerializer,
    CircuitTypeMiniSerializer,
    CircuitSerializer,
    CircuitTerminationSerializer,
    TunnelTerminationSerializer,
    AuxPortSerializer,
    AuxPortTemplateSerializer,
    DeviceBaySerializer,
    DeviceBayTemplateSerializer,
    InventoryItemSerializer,
    InventoryItemTemplateSerializer,
    ModuleBaySerializer,
    ModuleBayTemplateSerializer,
    ModuleInterfaceTemplateSerializer,
    ModuleSerializer,
    ModuleTypeMiniSerializer,
    TopologyViewSerializer,
    ModuleTypeSerializer,
    ConsolePortSerializer,
    ConsoleServerPortSerializer,
    PowerPortSerializer,
    PowerOutletSerializer,
    InterfaceTemplateSerializer,
    DeviceTypeServiceSerializer,
    ConsolePortTemplateSerializer,
    ConsoleServerPortTemplateSerializer,
    PowerPortTemplateSerializer,
    PowerOutletTemplateSerializer,
    RearPortTemplateSerializer,
    FrontPortTemplateSerializer,
    WirelessLANGroupSerializer,
    WirelessLANGroupMiniSerializer,
    WirelessLANSerializer,
    TunnelGroupSerializer,
    TunnelGroupMiniSerializer,
    IPSecProfileSerializer,
    IPSecProfileMiniSerializer,
    TunnelSerializer,
    RegionSerializer,
    RegionMiniSerializer,
    LocationSerializer,
    LocationMiniSerializer,
    ConfigContextSerializer,
    ExportTemplateSerializer,
    PowerPanelSerializer,
    PowerPanelMiniSerializer,
    PowerFeedSerializer,
    ClusterGroupSerializer,
    ClusterGroupMiniSerializer,
    ClusterSerializer,
    ClusterTypeSerializer,
    ClusterTypeMiniSerializer,
    VirtualMachineSerializer,
    VirtualMachineMiniSerializer,
    VMInterfaceSerializer,
    MACAddressSerializer,
    RackSerializer,
    RackRoleSerializer,
    RackRoleMiniSerializer,
    DeviceRoleSerializer,
    PlatformSerializer,
    ServiceSerializer,
    ServiceTemplateSerializer,
    IPRangeSerializer,
    AggregateSerializer,
    ASNSerializer,
    RIRSerializer,
    RIRMiniSerializer,
    VLANGroupSerializer,
    VLANGroupMiniSerializer,
    FHRPGroupSerializer,
    FHRPGroupAssignmentSerializer,
    ContactSerializer,
    ContactMiniSerializer,
    ContactGroupSerializer,
    ContactGroupMiniSerializer,
    ContactRoleSerializer,
    ContactRoleMiniSerializer,
    ContactAssignmentSerializer,
    CustomFieldSerializer,
    CustomFieldGroupSerializer,
    DevicePickerSerializer,
    DeviceVcPickerSerializer,
    DeviceSerializer,
    DeviceTypeMiniSerializer,
    DeviceTypeSerializer,
    FrontPortSerializer,
    ManufacturerMiniSerializer,
    ManufacturerSerializer,
    InterfacePickerSerializer,
    RearPortSerializer,
    IPAddressSerializer,
    IPRolePickerSerializer,
    IPRoleSerializer,
    ZonePickerSerializer,
    ZoneSerializer,
    StatusPickerSerializer,
    StatusSerializer,
    InterfaceSerializer,
    PrefixSerializer,
    RouteTargetPickerSerializer,
    RouteTargetSerializer,
    SitePickerSerializer,
    SiteSerializer,
    TagManageSerializer,
    TagPickerSerializer,
    TenantPickerSerializer,
    TenantSerializer,
    VLANPickerSerializer,
    VLANSerializer,
    VRFPickerSerializer,
    VRFSerializer,
)


def _apply_lifecycle_filter(qs, value: str):
    """``?lifecycle=`` buckets for LifecycleMixin models. Buckets are
    exclusive and mirror ``lifecycle_state``: eol · security_ended · eos ·
    supported (dates set, none passed) · none (no dates at all)."""
    from django.utils import timezone

    today = timezone.localdate()
    no_dates = dict(
        release_date__isnull=True, end_of_sale__isnull=True,
        end_of_security_updates__isnull=True, end_of_support__isnull=True,
    )
    if value == "eol":
        return qs.filter(end_of_support__lte=today)
    if value == "security_ended":
        return (qs.filter(end_of_security_updates__lte=today)
                .exclude(end_of_support__lte=today))
    if value == "eos":
        return (qs.filter(end_of_sale__lte=today)
                .exclude(end_of_support__lte=today)
                .exclude(end_of_security_updates__lte=today))
    if value == "supported":
        return (qs.exclude(**no_dates)
                .exclude(end_of_sale__lte=today)
                .exclude(end_of_security_updates__lte=today)
                .exclude(end_of_support__lte=today))
    if value == "none":
        return qs.filter(**no_dates)
    return qs


def _apply_custom_field_scope(request, qs, model_slug: str):
    field_id = request.query_params.get("custom_field") or request.query_params.get("cf")
    if not field_id:
        return qs
    try:
        field = CustomField.objects.get(pk=field_id)
    except (CustomField.DoesNotExist, ValueError):
        return qs.none()
    from customization.scopes import apply_scope_to_queryset

    return apply_scope_to_queryset(qs, model_slug, field.scope_rules or {})
from .views import _build_space_map, _get_active_tenant, _next_available_ips, _subnet_details


class StandardPagination(PageNumberPagination):
    # The SPA loads the full result set and paginates/filters client-side (the
    # DataTable pager uses the user's page_size preference), so return everything
    # by default rather than a 50-row first page that silently hid the rest.
    # Bounded so a pathological table can't dump unlimited rows; ?page_size= wins.
    page_size = 10000
    page_size_query_param = "page_size"
    max_page_size = 10000  # cap client-requested size at the default (anti-DoS)


class TenantScopedReadViewSet(RBACViewSetMixin, viewsets.ReadOnlyModelViewSet):
    """Read-only base — filters by active tenant. Anonymous → empty."""

    permission_classes = [permissions.IsAuthenticated]
    pagination_class = StandardPagination
    tenant_field = "tenant"

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return self.queryset.none()
        if not self.tenant_field:
            qs = self.queryset
        else:
            qs = self.queryset.filter(**{self.tenant_field: tenant})
        return restrict_for_view(self, qs)


class TenantScopedViewSet(RBACViewSetMixin, viewsets.ModelViewSet):
    """Read+write base.

    Same tenant filter on the queryset as the read-only base, plus a
    ``perform_create`` that stamps the active tenant onto the new row.
    Write endpoints reject anonymous calls and refuse to touch rows from
    a different tenant (defence-in-depth — the queryset filter already
    hides them, but a hand-crafted PATCH could try).

    RBAC: action grants are checked by ``RBACObjectPermission`` (via the
    mixin) and row constraints applied in ``get_queryset`` below.
    """

    permission_classes = [permissions.IsAuthenticated]
    pagination_class = StandardPagination
    tenant_field = "tenant"

    def _tenant_or_403(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            raise PermissionDenied("No active tenant selected.")
        return tenant

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return self.queryset.none()
        if not self.tenant_field:
            qs = self.queryset
        else:
            qs = self.queryset.filter(**{self.tenant_field: tenant})
        return restrict_for_view(self, qs)

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        kwargs = {self.tenant_field: tenant} if self.tenant_field else {}
        kwargs.update(self._site_default_kwargs(serializer))
        serializer.save(**kwargs)

    def _site_default_kwargs(self, serializer, field_name="site") -> dict:
        """Under enhanced site separation, default a *missing* direct ``site``
        (or a catalog's ``owning_site``) to a single-site user's own site — so
        local IT's creates just work instead of 403ing on the post-save guard
        (an omitted site would land NULL, which site-scoped users may never
        write). Multi-site users still pick; an explicit value (even null) in
        the payload is never overridden; flag OFF is a strict no-op. Also
        covers IPAddress: the stamped site is the creator's, matching what
        prefix auto-assign would derive.
        """
        from core.effective_settings import separation_enabled

        model = self.queryset.model
        field = next(
            (f for f in model._meta.fields
             if f.name == field_name and f.is_relation),
            None,
        )
        if field is None or field_name in getattr(serializer, "validated_data", {}):
            return {}
        user = getattr(self.request, "user", None)
        if user is None or not user.is_authenticated or user.is_superuser:
            return {}
        tenant = _get_active_tenant(self.request)
        if tenant is None or not separation_enabled(tenant):
            return {}
        if not hasattr(self.request, "_rbac_editable_sites"):
            from auth_api import rbac

            self.request._rbac_editable_sites = rbac.editable_sites(user, tenant)
        editable = self.request._rbac_editable_sites
        if not isinstance(editable, set) or len(editable) != 1:
            return {}
        site = Site.objects.filter(tenant=tenant, pk=next(iter(editable))).first()
        return {field_name: site} if site else {}

    # ── Site-scope write enforcement ────────────────────────────────────────
    # The queryset filter scopes *reads* (and so edit/delete of existing rows).
    # Create/move need their own guard: a site-scoped editor must not place or
    # re-parent an object into a site outside their scope. We wrap create/update
    # (the entry points subclasses don't override — many override perform_create)
    # and re-check the *saved* object against the same restrict_queryset logic,
    # inside a transaction so a violation rolls back. Reusing restrict_queryset
    # means it also covers IPs (site is derived in save) and indirect paths.
    def create(self, request, *args, **kwargs):
        with transaction.atomic():
            response = super().create(request, *args, **kwargs)
            self._assert_write_in_site_scope(response, "add")
        return response

    def update(self, request, *args, **kwargs):
        with transaction.atomic():
            response = super().update(request, *args, **kwargs)
            self._assert_write_in_site_scope(response, "change")
        return response

    def _assert_write_in_site_scope(self, response, action):
        from auth_api import rbac
        from auth_api.drf import _object_type

        user = getattr(self.request, "user", None)
        if user is None or not user.is_authenticated or user.is_superuser:
            return
        tenant = _get_active_tenant(self.request)
        slug = _object_type(self)
        if slug is None:
            return
        pk = (response.data or {}).get("id") if hasattr(response, "data") else None
        if pk is None:
            return
        base = self.queryset.model._default_manager.filter(pk=pk)
        if not rbac.restrict_queryset(base, user, tenant, slug, action).exists():
            raise PermissionDenied(
                "The created or updated object is outside your permission scope."
            )

    def _assert_bulk_write_in_site_scope(self, pks, action="change"):
        """Set-based mirror of ``_assert_write_in_site_scope`` for the bulk
        endpoints, which mutate via ``qs.update(...)`` and so skip the
        create/update wrappers. The *selection* is already scoped by
        ``get_queryset``; this re-checks the rows **after** the update so a
        site-scoped user can't move their own objects into a foreign site
        (e.g. ``fields.site_id``). Call inside the caller's transaction —
        a violation rolls the whole bulk write back.
        """
        from auth_api import rbac
        from auth_api.drf import _object_type

        user = getattr(self.request, "user", None)
        if user is None or not user.is_authenticated or user.is_superuser:
            return
        tenant = _get_active_tenant(self.request)
        slug = _object_type(self)
        if slug is None:
            return
        pks = {getattr(p, "pk", p) for p in pks}
        if not pks:
            return
        base = self.queryset.model._default_manager.filter(pk__in=pks)
        if rbac.restrict_queryset(base, user, tenant, slug, action).count() != len(pks):
            raise PermissionDenied(
                "This update would move objects outside your permission scope."
            )


class CatalogLocalityMixin:
    """Local/global behavior for catalog viewsets (enhanced site separation).

    Creates by a single-site user default ``owning_site`` to their site (the
    post-save guard would otherwise refuse the NULL they can't write).
    ``POST /<id>/promote/`` clears ``owning_site`` (→ global);
    ``POST /<id>/assign-site/ {site_id}`` re-homes an entry. Both are
    HQ-only: they require a change grant that is NOT limited to sites.
    With separation off, catalog locality is inert (site_path_for returns
    None) but the actions still work for admins pre-staging locality.
    """

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        kwargs = {self.tenant_field: tenant} if self.tenant_field else {}
        kwargs.update(self._site_default_kwargs(serializer, field_name="owning_site"))
        serializer.save(**kwargs)

    def _require_unscoped_change(self, request):
        from auth_api import rbac
        from auth_api.drf import _object_type

        user = request.user
        if user.is_superuser:
            return
        tenant = _get_active_tenant(request)
        slug = _object_type(self)
        # site_scope: None = unrestricted; set()/{ids} = ungranted or scoped.
        if rbac.site_scope(user, tenant, slug, "change") is not None:
            raise PermissionDenied(
                "Changing an entry's locality (local ↔ global) requires a "
                "tenant-wide change grant."
            )

    @action(detail=True, methods=["post"], url_path="promote")
    def promote(self, request, pk=None):
        """Make a site-local catalog entry global (owning_site → NULL)."""
        self._require_unscoped_change(request)
        obj = self.get_object()
        obj.owning_site = None
        obj.save()
        return Response(self.get_serializer(obj).data)

    @action(detail=True, methods=["post"], url_path="assign-site")
    def assign_site(self, request, pk=None):
        """Re-home a catalog entry to a site (global → local, or move)."""
        self._require_unscoped_change(request)
        obj = self.get_object()
        site_id = (request.data or {}).get("site_id")
        site = None
        if site_id:
            site = Site.objects.filter(
                pk=site_id, tenant=_get_active_tenant(request)
            ).first()
            if site is None:
                raise ValidationError({"site_id": "Not found in this tenant."})
        obj.owning_site = site
        obj.save()
        return Response(self.get_serializer(obj).data)


class ComponentBulkMixin:
    """``bulk-update`` + ``bulk-delete`` for component viewsets (interfaces,
    ports, VM interfaces, device-type component templates).

    POST ``bulk-update`` {ids: [...], fields: {...}} — only keys present in
    ``fields`` are touched, and only keys the viewset allow-lists are
    accepted (an unknown key is a 400, never silently dropped). Tenant-scoped
    FKs re-validate against the active tenant since ``qs.update`` bypasses
    the serializer's scoped fields. Selection is scoped by ``get_queryset``
    (tenant + RBAC rows), so foreign ids silently fall out.

    POST ``bulk-delete`` {ids: [...]} — same scoping; audited.
    """

    bulk_str_fields: tuple = ()
    bulk_bool_fields: tuple = ()
    bulk_int_fields: tuple = ()          # nullable ints
    bulk_fk_fields: dict = {}            # "vlan_id" → tenant-scoped model
    bulk_tags = False                    # add_tag_ids / remove_tag_ids
    rbac_action_map = {"bulk_update": "change", "bulk_delete": "delete"}

    def _bulk_ids(self, request):
        ids = request.data.get("ids") or []
        if not isinstance(ids, list) or not ids:
            raise ValidationError({"ids": "Provide a non-empty list of ids."})
        if len(ids) > 1000:
            raise ValidationError({"ids": "At most 1000 ids per call."})
        return ids

    @action(detail=False, methods=["post"], url_path="bulk-update")
    def bulk_update(self, request):
        ids = self._bulk_ids(request)
        fields = request.data.get("fields") or {}
        if not isinstance(fields, dict) or not fields:
            raise ValidationError({"fields": "Provide at least one field to update."})

        allowed = {
            *self.bulk_str_fields, *self.bulk_bool_fields,
            *self.bulk_int_fields, *self.bulk_fk_fields,
        }
        tag_keys = {"add_tag_ids", "remove_tag_ids"} if self.bulk_tags else set()
        unknown = set(fields) - allowed - tag_keys
        if unknown:
            raise ValidationError({
                k: f"Not bulk-editable here. Allowed: {sorted(allowed | tag_keys)}"
                for k in sorted(unknown)
            })

        tenant = _get_active_tenant(request)
        model = self.get_queryset().model
        updates = {}
        for k in self.bulk_str_fields:
            if k in fields:
                v = "" if fields[k] is None else str(fields[k])
                # Choice-backed CharFields validate against the model's own
                # choice list (flatchoices flattens the grouped ones), so a
                # typo'd slug is a 400 rather than a silently written value.
                # "" always passes — it's how bulk edit clears the field.
                valid = dict(model._meta.get_field(k).flatchoices)
                if valid and v and v not in valid:
                    # Short lists name their options; the long ones (216 interface
                    # types) would bury the message, so point at the endpoint.
                    opts = sorted(valid)
                    hint = (
                        ", ".join(opts) if len(opts) <= 12
                        else "see /api/dcim/choices/"
                    )
                    raise ValidationError(
                        {k: f"'{v}' is not a valid choice. Options: {hint}"}
                    )
                updates[k] = v
        for k in self.bulk_bool_fields:
            if k in fields:
                if not isinstance(fields[k], bool):
                    raise ValidationError({k: "Must be true or false."})
                updates[k] = fields[k]
        for k in self.bulk_int_fields:
            if k in fields:
                v = fields[k]
                if v is not None and not isinstance(v, int):
                    raise ValidationError({k: "Must be an integer or null."})
                updates[k] = v
        for k, model in self.bulk_fk_fields.items():
            if k in fields:
                v = fields[k]
                if v and not model.objects.filter(pk=v, tenant=tenant).exists():
                    raise ValidationError({k: "Not found in this tenant."})
                updates[k] = v or None

        qs = self.get_queryset().filter(pk__in=ids)
        with transaction.atomic():
            _rows = list(qs)
            updated = qs.update(**updates) if updates else qs.count()
            if updates:
                log_bulk_update(_rows, updates)
            if self.bulk_tags:
                apply_and_log_bulk_tags(
                    qs,
                    fields.get("add_tag_ids") or [],
                    fields.get("remove_tag_ids") or [],
                    tenant=tenant,
                )
            self._assert_bulk_write_in_site_scope(
                [row.pk for row in _rows], action="change"
            )
        return Response({"updated": updated}, status=drf_status.HTTP_200_OK)

    @action(detail=False, methods=["post"], url_path="bulk-delete")
    def bulk_delete(self, request):
        ids = self._bulk_ids(request)
        with transaction.atomic():
            _qs = self.get_queryset().filter(pk__in=ids)
            _rows = list(_qs)
            deleted, _ = _qs.delete()
            log_bulk_delete(_rows)
        return Response({"deleted": deleted}, status=drf_status.HTTP_200_OK)


class CloneableMixin:
    """Adds ``GET /<type>/<id>/clone/`` → an initial-values payload for the
    create form, seeded from an existing object.

    Only the fields named in ``clone_fields`` are carried over — an **allowlist**,
    so a newly-added unique/sensitive field is never leaked into a clone by
    accident. The identifying/unique fields (name, address, serial, the human
    ``numid``, …) are deliberately omitted, so the clone can't collide: the user
    supplies the new identifier on the create form and saves through the normal
    create path (all validation + uniqueness run there). Tags and custom-field
    values are copied when the model has them.

    The payload uses the read serializer's field names/shape (nested FK objects),
    so the SPA create form seeds from it exactly as it seeds for edit — just
    without an ``id``, so it POSTs a new object.

    Requires ``view`` on the source (``get_object`` is tenant- and
    row-constraint-scoped); the create itself is separately ``add``-gated.
    """

    #: Read-serializer field names to carry into the clone. Empty → not cloneable.
    clone_fields: tuple[str, ...] = ()

    @action(detail=True, methods=["get"], url_path="clone")
    def clone(self, request, pk=None):
        if not self.clone_fields:
            return Response(
                {"detail": "This object type is not cloneable."},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )
        obj = self.get_object()
        data = self.get_serializer(obj).data
        payload = {k: data[k] for k in self.clone_fields if k in data}
        # Tags + custom-field values are non-identifying user data — always carry
        # them when present (matches the "copy everything but the identity").
        for extra in ("tags", "custom_fields"):
            if extra in data and extra not in payload:
                payload[extra] = data[extra]
        return Response({"initial": payload})


class ImageAttachmentMixin:
    """Adds NetBox-style image attachments to any tenant-scoped detail viewset.

    Mix it into a viewset and its objects gain an ``images`` nested endpoint:

        GET    /api/<parent>/{id}/images/            → list (ordered)
        POST   /api/<parent>/{id}/images/            → upload (multipart)
        PATCH  /api/<parent>/{id}/images/{image_id}/ → rename / reorder
        DELETE /api/<parent>/{id}/images/{image_id}/ → remove

    Reads map to "view <parent>", writes to "change <parent>" (a custom @action
    that mutates → change, via the RBAC drf helper), so no separate image
    resource/permission is needed. Attachments are scoped to the parent object
    by (content_type, object_id) and inherit the parent's tenant."""

    @action(detail=True, methods=["get", "post"], url_path="images",
            parser_classes=[MultiPartParser, FormParser])
    def images(self, request, pk=None):
        from django.contrib.contenttypes.models import ContentType

        from .models import ImageAttachment
        from .serializers import ImageAttachmentSerializer

        obj = self.get_object()
        ct = ContentType.objects.get_for_model(obj)
        if request.method == "POST":
            upload = request.FILES.get("image")
            if upload is None:
                return Response({"detail": "No image file provided."},
                                status=drf_status.HTTP_400_BAD_REQUEST)
            img = ImageAttachment.objects.create(
                tenant=obj.tenant,
                content_type=ct,
                object_id=obj.pk,
                image=upload,
                name=request.data.get("name", ""),
                sort_order=request.data.get("sort_order") or 0,
            )
            return Response(
                ImageAttachmentSerializer(img, context={"request": request}).data,
                status=drf_status.HTTP_201_CREATED,
            )
        qs = ImageAttachment.objects.filter(content_type=ct, object_id=obj.pk)
        return Response({
            "count": qs.count(),
            "results": ImageAttachmentSerializer(
                qs, many=True, context={"request": request}
            ).data,
        })

    @action(detail=True, methods=["patch", "delete"],
            url_path="images/(?P<image_id>[^/.]+)")
    def image_detail(self, request, pk=None, image_id=None):
        from django.contrib.contenttypes.models import ContentType

        from .models import ImageAttachment
        from .serializers import ImageAttachmentSerializer

        obj = self.get_object()
        ct = ContentType.objects.get_for_model(obj)
        img = ImageAttachment.objects.filter(
            content_type=ct, object_id=obj.pk, pk=image_id
        ).first()
        if img is None:
            return Response({"detail": "Image not found."},
                            status=drf_status.HTTP_404_NOT_FOUND)
        if request.method == "DELETE":
            img.image.delete(save=False)
            img.delete()
            return Response(status=drf_status.HTTP_204_NO_CONTENT)
        ser = ImageAttachmentSerializer(
            img, data=request.data, partial=True, context={"request": request}
        )
        ser.is_valid(raise_exception=True)
        ser.save()
        return Response(ser.data)


class PrefixViewSet(CloneableMixin, TenantScopedViewSet):
    queryset = (
        Prefix.objects
        .select_related("site", "vlan__zone", "vrf", "location")
        .prefetch_related("tags")
        .all()
    )
    serializer_class = PrefixSerializer
    rbac_action_map = {"bulk_delete": "delete"}
    # Clone carries the routing/classification context; the CIDR is the unique
    # identifier and is left blank for the user to fill.
    clone_fields = (
        "status", "site", "vlan", "vrf", "location", "description",
        "auto_discover", "auto_assign_site", "monitoring_engine",
    )

    def perform_create(self, serializer):
        prefix = serializer.save(
            **{self.tenant_field: self._tenant_or_403()},
            **self._site_default_kwargs(serializer),
        )
        # Site gateway-policy autospawn: register a role=gateway IP at the
        # first/last usable address. Best-effort — never block prefix creation.
        try:
            from .views import _autospawn_gateway

            _autospawn_gateway(prefix, request=self.request)
        except Exception:  # noqa: BLE001
            pass

    def _assert_write_in_site_scope(self, response, action):
        # Base check: the new/edited prefix's own site must be in scope.
        super()._assert_write_in_site_scope(response, action)
        # Prefix-specific rule for site-scoped users: "don't steal anyone
        # else's space." The new CIDR may either carve *within* their own
        # site's existing prefixes (a sub-allocation), OR be a brand-new range
        # that overlaps NOTHING — a "dark"/non-routed subnet (e.g. a private
        # 192.168.x). What it must never do is overlap a prefix belonging to
        # the shared (site-less) space or another site.
        import ipaddress

        from auth_api import rbac

        user = getattr(self.request, "user", None)
        if user is None or not user.is_authenticated or user.is_superuser:
            return
        tenant = _get_active_tenant(self.request)
        sites = rbac.site_scope(user, tenant, "prefix", action)
        if sites is None:
            return  # unrestricted → no containment requirement
        pk = (response.data or {}).get("id") if hasattr(response, "data") else None
        p = Prefix.objects.filter(pk=pk).first() if pk else None
        if p is None:
            return
        try:
            net = ipaddress.ip_network(p.cidr, strict=False)
        except ValueError:
            return  # serializer validation owns malformed CIDRs
        others = (
            Prefix.objects.filter(tenant=tenant, vrf_id=p.vrf_id)
            .exclude(pk=p.pk)
            .values_list("cidr", "site_id")
        )
        for cidr, other_site in others:
            try:
                on = ipaddress.ip_network(cidr, strict=False)
            except (ValueError, TypeError):
                continue
            if net.version != on.version or not net.overlaps(on):
                continue
            if other_site in sites:
                continue  # carving inside our own site's space → allowed
            where = "another site" if other_site else "the shared space"
            raise PermissionDenied(
                f"Site-scoped access: {p.cidr} overlaps {cidr}, which belongs "
                f"to {where}. You can create a new range that overlaps nothing, "
                "or allocate within your own site's space."
            )
        # Overlaps nothing owned by anyone else → a fresh dark subnet. Allowed;
        # it was stamped to the user's own site on create.

    def get_queryset(self):
        qs = super().get_queryset()
        if not self.request:
            return qs
        search = self.request.query_params.get("search", "").strip()
        if search:
            qs = qs.filter(cidr__icontains=search) | qs.filter(description__icontains=search)
        # Quick filters used by detail-page panes.
        for key, field in (
            ("vlan", "vlan_id"), ("vrf", "vrf_id"),
            ("site", "site_id"), ("location", "location_id"),
        ):
            v = self.request.query_params.get(key)
            if v:
                qs = qs.filter(**{field: v})
        qs = _apply_custom_field_scope(self.request, qs, "prefix")
        # Numeric address order, not the lexicographic CharField sort (which
        # puts 10.0.0.10 before 10.0.0.2). Postgres `inet` sorts by address
        # then mask → parent before child, v4 before v6. `::inet` (not
        # `::cidr`) tolerates a stored host-bits value like "10.0.0.5/24".
        from django.db.models.expressions import RawSQL

        return qs.annotate(_net=RawSQL("cidr::inet", ())).order_by("_net")

    # ── Space map (existing) ────────────────────────────────────────────
    @action(detail=True, methods=["get"], url_path="space-map")
    def space_map(self, request, pk=None):
        import ipaddress

        def _int_param(name):
            try:
                return int(request.query_params[name])
            except (KeyError, ValueError, TypeError):
                return None

        max_v4 = _int_param("v4_max")
        max_v6 = _int_param("v6_max")

        prefix = self.get_object()
        net = prefix.network

        # Optionally re-root the map at a sub-network of this prefix (the
        # frontend "descend into a free cell" interaction). It must be a real
        # network inside the prefix.
        map_net = net
        within = request.query_params.get("within")
        if within:
            try:
                wn = ipaddress.ip_network(within, strict=False)
            except (ValueError, TypeError):
                wn = None
            if wn is None or net is None or not (wn == net or wn.subnet_of(net)):
                return Response(
                    {"detail": "within must be a network inside this prefix."},
                    status=400,
                )
            map_net = wn

        deepest = 31 if (map_net and map_net.version == 4) else 128
        if map_net is None or map_net.prefixlen >= deepest:
            return Response({
                "supported": False,
                "root": str(map_net) if map_net else None,
                "subnet_details": _subnet_details(prefix),
                "next_available": _next_available_ips(prefix, count=8),
                "rows": [],
            })

        # child_nets are ipaddress network instances; cidr_to_pk lets the
        # frontend deep-link a "used" cell to /prefixes/{id}/ without a second
        # round trip.
        child_nets = []
        cidr_to_pk: dict[str, str] = {}
        for sib in (
            Prefix.objects
            .filter(tenant=prefix.tenant, vrf=prefix.vrf)
            .exclude(pk=prefix.pk)
            .only("id", "cidr")
        ):
            sn = sib.network
            if sn is None:
                continue
            try:
                if sn.subnet_of(map_net):
                    child_nets.append(sn)
                    cidr_to_pk[str(sn)] = str(sib.id)
            except (TypeError, ValueError):
                continue

        rows = _build_space_map(
            map_net, child_nets=child_nets, tenant=prefix.tenant,
            vrf=prefix.vrf, max_v4=max_v4, max_v6=max_v6,
        )
        # Stamp prefix_id onto every "used" cell so the React map can link
        # the right cell to the right detail page.
        for row in rows:
            for cell in row["cells"]:
                if cell["used"] and cell["overlap_with"]:
                    cell["prefix_id"] = cidr_to_pk.get(cell["overlap_with"][0])
        return Response({
            "supported": True,
            "root": str(map_net),
            "subnet_details": _subnet_details(prefix),
            "next_available": _next_available_ips(prefix, count=8),
            "rows": rows,
        })

    # ── Nested IPs ──────────────────────────────────────────────────────
    @action(detail=True, methods=["get"], url_path="ips")
    def ips(self, request, pk=None):
        """List every IP address registered inside this prefix.

        Sorted by numeric address so contiguous ranges show together. No
        pagination yet — typical prefixes have hundreds of IPs at most;
        we'll add it when a customer pushes that envelope.
        """
        import ipaddress as ip
        prefix = self.get_object()
        qs = (
            IPAddress.objects
            .filter(prefix=prefix)
            .select_related("status", "role", "assigned_device")
            .prefetch_related("tags")
        )
        # IPAddressField is a string; sort numerically so 10.0.0.2 lands
        # before 10.0.0.10 — Django's default lexicographic sort doesn't.
        rows = sorted(qs, key=lambda r: int(ip.ip_address(r.ip_address)))
        ser = IPAddressSerializer(rows, many=True)
        return Response({"count": len(rows), "results": ser.data})

    # ── Bulk delete ─────────────────────────────────────────────────────
    @action(detail=False, methods=["post"], url_path="bulk-delete")
    def bulk_delete(self, request):
        """POST {ids: [...]} → 204. IDs not in tenant are silently skipped."""
        ids = request.data.get("ids") or []
        if not isinstance(ids, list) or not ids:
            raise ValidationError({"ids": "Provide a non-empty list of prefix IDs."})
        with transaction.atomic():
            _qs = self.get_queryset().filter(pk__in=ids)
            _rows = list(_qs)
            deleted, _ = _qs.delete()
            log_bulk_delete(_rows)
        return Response({"deleted": deleted}, status=drf_status.HTTP_200_OK)

    # ── Bulk patch ──────────────────────────────────────────────────────
    @action(detail=False, methods=["post"], url_path="bulk-update")
    def bulk_update(self, request):
        """POST {ids: [...], fields: {status_id, vrf_id, site_id, vlan_id}} → 200.

        Only the keys present in ``fields`` are touched. Tags are handled
        as add/remove sets rather than overwriting so a bulk edit can't
        accidentally wipe per-row tagging. ``status`` is a ``Status`` FK
        (post-0047): the field is ``status_id`` and carries a catalog row id.
        """
        ids = request.data.get("ids") or []
        fields = request.data.get("fields") or {}
        if not isinstance(ids, list) or not ids:
            raise ValidationError({"ids": "Provide a non-empty list of prefix IDs."})
        if not isinstance(fields, dict) or not fields:
            raise ValidationError({"fields": "Provide at least one field to update."})

        # Reject cross-tenant FK assignment — each *_id must resolve within the
        # active tenant (the bulk path bypasses the serializer's scoped fields).
        tenant = _get_active_tenant(self.request)
        for key, model in (
            ("status_id", Status), ("vrf_id", VRF),
            ("site_id", Site), ("vlan_id", VLAN),
        ):
            val = fields.get(key)
            if val and not model.objects.filter(pk=val, tenant=tenant).exists():
                raise ValidationError({key: "Not found in this tenant."})

        qs = self.get_queryset().filter(pk__in=ids)
        updates = {}
        if "status_id" in fields:
            updates["status_id"] = fields["status_id"]
        if "vrf_id" in fields:
            updates["vrf_id"] = fields["vrf_id"]
        if "site_id" in fields:
            updates["site_id"] = fields["site_id"]
        if "vlan_id" in fields:
            updates["vlan_id"] = fields["vlan_id"]
        if "description" in fields:
            updates["description"] = fields["description"]

        with transaction.atomic():
            _rows = list(qs)
            updated_count = qs.update(**updates) if updates else qs.count()
            if updates:
                log_bulk_update(_rows, updates)
            apply_and_log_bulk_tags(
                qs,
                fields.get("add_tag_ids") or [],
                fields.get("remove_tag_ids") or [],
                tenant=_get_active_tenant(self.request),
            )
            self._assert_bulk_write_in_site_scope(_rows)

        return Response({"updated": updated_count}, status=drf_status.HTTP_200_OK)


class IPAddressViewSet(CloneableMixin, TenantScopedViewSet):
    queryset = (
        IPAddress.objects
        # prefix__vlan__zone: PrefixMiniSerializer nests the VLAN (+ its zone
        # chip) — without the joins every IP row lazy-loads them.
        .select_related(
            "status", "role", "assigned_device", "prefix__vlan__zone",
            "prefix__vrf", "prefix__site", "site",
        )
        .prefetch_related("tags")
        .all()
    )
    serializer_class = IPAddressSerializer
    rbac_action_map = {"bulk_delete": "delete"}
    # The address itself + its device/interface assignment are identity; a clone
    # keeps the classification and lands unassigned at a fresh address.
    clone_fields = (
        "prefix", "status", "role", "dns_name", "description",
        "reservation_note", "flap_exclude",
    )

    def get_queryset(self):
        """Tenant/RBAC-scoped, with optional server-side narrowing so the
        IP-assign picker scales to very large address spaces (filter, don't
        ship millions of rows): ``?search=`` (address or DNS), ``?prefix=``,
        ``?vrf=``, ``?site=``, ``?assigned_interface=``."""
        qs = super().get_queryset()
        if not self.request:
            return qs
        p = self.request.query_params
        search = p.get("search", "").strip()
        if search:
            qs = qs.filter(
                Q(ip_address__icontains=search) | Q(dns_name__icontains=search)
            )
        if prefix := p.get("prefix"):
            qs = qs.filter(prefix_id=prefix)
        if vrf := p.get("vrf"):
            qs = qs.filter(prefix__vrf_id=vrf)
        if site := p.get("site"):
            qs = qs.filter(prefix__site_id=site)
        if iface := p.get("assigned_interface"):
            qs = qs.filter(assigned_interface_id=iface)
        if role := p.get("role"):
            qs = qs.filter(role_id=role)
        if status := p.get("status"):
            qs = qs.filter(status_id=status)
        return _apply_custom_field_scope(self.request, qs, "ipaddress")

    @action(detail=False, methods=["post"], url_path="bulk-delete")
    def bulk_delete(self, request):
        ids = request.data.get("ids") or []
        if not isinstance(ids, list) or not ids:
            raise ValidationError({"ids": "Provide a non-empty list of IP IDs."})
        with transaction.atomic():
            _qs = self.get_queryset().filter(pk__in=ids)
            _rows = list(_qs)
            deleted, _ = _qs.delete()
            log_bulk_delete(_rows)
        return Response({"deleted": deleted}, status=drf_status.HTTP_200_OK)

    @action(detail=False, methods=["post"], url_path="bulk-update")
    def bulk_update(self, request):
        """POST {ids, fields:{status_id, role_id, add_tag_ids, remove_tag_ids}}."""
        ids = request.data.get("ids") or []
        fields = request.data.get("fields") or {}
        if not isinstance(ids, list) or not ids:
            raise ValidationError({"ids": "Provide a non-empty list of IP IDs."})
        if not isinstance(fields, dict) or not fields:
            raise ValidationError({"fields": "Provide at least one field to update."})

        # Reject cross-tenant FK assignment — the bulk path bypasses the
        # serializer's tenant-scoped fields (issue #59).
        tenant = _get_active_tenant(self.request)
        for key, model in (("status_id", Status), ("role_id", IPRole)):
            val = fields.get(key)
            if val and not model.objects.filter(pk=val, tenant=tenant).exists():
                raise ValidationError({key: "Not found in this tenant."})

        qs = self.get_queryset().filter(pk__in=ids)
        updates = {}
        if "status_id" in fields:
            updates["status_id"] = fields["status_id"]
        if "role_id" in fields:
            updates["role_id"] = fields["role_id"]
        if "description" in fields:
            updates["description"] = fields["description"]

        with transaction.atomic():
            _rows = list(qs)
            updated_count = qs.update(**updates) if updates else qs.count()
            if updates:
                log_bulk_update(_rows, updates)
            apply_and_log_bulk_tags(
                qs,
                fields.get("add_tag_ids") or [],
                fields.get("remove_tag_ids") or [],
                tenant=_get_active_tenant(self.request),
            )
            self._assert_bulk_write_in_site_scope(_rows)

        return Response({"updated": updated_count}, status=drf_status.HTTP_200_OK)


# ─── Pickers ────────────────────────────────────────────────────────────
#
# Light list endpoints used by the React form pickers. No pagination —
# pickers always show every option in the active tenant so the user can
# scroll/search inside the combobox.

class _PickerPagination(PageNumberPagination):
    page_size = 500
    max_page_size = 5000


class VRFViewSet(CatalogLocalityMixin, CloneableMixin, TenantScopedViewSet):
    queryset = (
        VRF.objects
        .prefetch_related("import_targets", "export_targets", "tags")
        .all()
        .order_by("name")
    )
    serializer_class = VRFSerializer
    pagination_class = StandardPagination
    rbac_action_map = {"bulk_delete": "delete"}
    # Name + RD are the unique identity; carry the policy/target wiring.
    clone_fields = (
        "color", "description", "enforce_unique",
        "import_targets", "export_targets",
    )

    def get_serializer_class(self):
        if self.action == "list" and self.request and self.request.query_params.get("picker") == "1":
            return VRFPickerSerializer
        return VRFSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if not self.request:
            return qs
        search = self.request.query_params.get("search", "").strip()
        if search:
            qs = (
                qs.filter(name__icontains=search)
                | qs.filter(rd__icontains=search)
                | qs.filter(description__icontains=search)
            )
        rt = self.request.query_params.get("rt")
        if rt:
            qs = qs.filter(import_targets__id=rt) | qs.filter(export_targets__id=rt)
            qs = qs.distinct()
        return qs

    @action(detail=False, methods=["post"], url_path="bulk-delete")
    def bulk_delete(self, request):
        ids = request.data.get("ids") or []
        if not isinstance(ids, list) or not ids:
            raise ValidationError({"ids": "Provide a non-empty list of VRF IDs."})
        with transaction.atomic():
            _qs = self.get_queryset().filter(pk__in=ids)
            _rows = list(_qs)
            deleted, _ = _qs.delete()
            log_bulk_delete(_rows)
        return Response({"deleted": deleted}, status=drf_status.HTTP_200_OK)


class RouteTargetViewSet(CatalogLocalityMixin, TenantScopedViewSet):
    queryset = (
        RouteTarget.objects
        .prefetch_related("importing_vrfs", "exporting_vrfs", "tags")
        .all()
        .order_by("name")
    )
    serializer_class = RouteTargetSerializer
    pagination_class = StandardPagination
    rbac_action_map = {"bulk_delete": "delete"}

    def get_serializer_class(self):
        if self.action == "list" and self.request and self.request.query_params.get("picker") == "1":
            return RouteTargetPickerSerializer
        return RouteTargetSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if not self.request:
            return qs
        search = self.request.query_params.get("search", "").strip()
        if search:
            qs = qs.filter(name__icontains=search) | qs.filter(description__icontains=search)
        return qs

    @action(detail=False, methods=["post"], url_path="bulk-delete")
    def bulk_delete(self, request):
        ids = request.data.get("ids") or []
        if not isinstance(ids, list) or not ids:
            raise ValidationError({"ids": "Provide a non-empty list of RT IDs."})
        with transaction.atomic():
            _qs = self.get_queryset().filter(pk__in=ids)
            _rows = list(_qs)
            deleted, _ = _qs.delete()
            log_bulk_delete(_rows)
        return Response({"deleted": deleted}, status=drf_status.HTTP_200_OK)


class SiteViewSet(ImageAttachmentMixin, TenantScopedViewSet):
    queryset = Site.objects.prefetch_related("tags", "vrfs").all().order_by("name")
    serializer_class = SiteSerializer
    pagination_class = StandardPagination
    rbac_action_map = {"bulk_delete": "delete"}

    def get_serializer_class(self):
        if self.action == "list" and self.request and self.request.query_params.get("picker") == "1":
            return SitePickerSerializer
        return SiteSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if not self.request:
            return qs
        search = self.request.query_params.get("search", "").strip()
        if search:
            qs = (
                qs.filter(name__icontains=search)
                | qs.filter(location__icontains=search)
                | qs.filter(description__icontains=search)
            )
        return qs

    @action(detail=False, methods=["post"], url_path="bulk-delete")
    def bulk_delete(self, request):
        ids = request.data.get("ids") or []
        if not isinstance(ids, list) or not ids:
            raise ValidationError({"ids": "Provide a non-empty list of site IDs."})
        with transaction.atomic():
            _qs = self.get_queryset().filter(pk__in=ids)
            _rows = list(_qs)
            deleted, _ = _qs.delete()
            log_bulk_delete(_rows)
        return Response({"deleted": deleted}, status=drf_status.HTTP_200_OK)

    @action(detail=False, methods=["post"], url_path="bulk-update")
    def bulk_update(self, request):
        ids = request.data.get("ids") or []
        fields = request.data.get("fields") or {}
        if not isinstance(ids, list) or not ids:
            raise ValidationError({"ids": "Provide a non-empty list of site IDs."})
        if not isinstance(fields, dict) or not fields:
            raise ValidationError({"fields": "Provide at least one field to update."})

        qs = self.get_queryset().filter(pk__in=ids)
        updates = {}
        if "gateway_policy" in fields: updates["gateway_policy"] = fields["gateway_policy"]
        if "location" in fields: updates["location"] = fields["location"]

        with transaction.atomic():
            _rows = list(qs)
            updated_count = qs.update(**updates) if updates else qs.count()
            if updates:
                log_bulk_update(_rows, updates)
            apply_and_log_bulk_tags(
                qs,
                fields.get("add_tag_ids") or [],
                fields.get("remove_tag_ids") or [],
                tenant=_get_active_tenant(self.request),
            )
        return Response({"updated": updated_count}, status=drf_status.HTTP_200_OK)


class VLANViewSet(CloneableMixin, TenantScopedViewSet):
    queryset = VLAN.objects.select_related("site", "group", "zone").prefetch_related("tags").all().order_by("vlan_id")
    serializer_class = VLANSerializer
    pagination_class = StandardPagination
    rbac_action_map = {"bulk_delete": "delete"}
    # The VID (vlan_id) + name are the identity; carry site/group/description.
    clone_fields = ("site", "group", "description")

    def get_serializer_class(self):
        # Picker callers pass ?picker=1 for the lightweight shape used in
        # form combos. List/detail use the full read+write serializer.
        if self.action == "list" and self.request and self.request.query_params.get("picker") == "1":
            return VLANPickerSerializer
        return VLANSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if not self.request:
            return qs
        search = self.request.query_params.get("search", "").strip()
        if search:
            qs = qs.filter(name__icontains=search) | qs.filter(description__icontains=search)
            if search.isdigit():
                qs = qs | super().get_queryset().filter(vlan_id=int(search))
        site = self.request.query_params.get("site")
        if site:
            qs = qs.filter(site_id=site)
        group = self.request.query_params.get("group")
        if group:
            qs = qs.filter(group_id=group)
        return _apply_custom_field_scope(self.request, qs, "vlan")

    @action(detail=False, methods=["post"], url_path="bulk-delete")
    def bulk_delete(self, request):
        ids = request.data.get("ids") or []
        if not isinstance(ids, list) or not ids:
            raise ValidationError({"ids": "Provide a non-empty list of VLAN IDs."})
        with transaction.atomic():
            _qs = self.get_queryset().filter(pk__in=ids)
            _rows = list(_qs)
            deleted, _ = _qs.delete()
            log_bulk_delete(_rows)
        return Response({"deleted": deleted}, status=drf_status.HTTP_200_OK)

    @action(detail=False, methods=["post"], url_path="bulk-update")
    def bulk_update(self, request):
        ids = request.data.get("ids") or []
        fields = request.data.get("fields") or {}
        if not isinstance(ids, list) or not ids:
            raise ValidationError({"ids": "Provide a non-empty list of VLAN IDs."})
        if not isinstance(fields, dict) or not fields:
            raise ValidationError({"fields": "Provide at least one field to update."})

        # Reject cross-tenant FK assignment (issue #59).
        tenant = _get_active_tenant(self.request)
        val = fields.get("site_id")
        if val and not Site.objects.filter(pk=val, tenant=tenant).exists():
            raise ValidationError({"site_id": "Not found in this tenant."})
        zval = fields.get("zone_id")
        if zval and not Zone.objects.filter(pk=zval, tenant=tenant).exists():
            raise ValidationError({"zone_id": "Not found in this tenant."})

        qs = self.get_queryset().filter(pk__in=ids)
        updates = {}
        if "site_id" in fields: updates["site_id"] = fields["site_id"]
        if "zone_id" in fields: updates["zone_id"] = fields["zone_id"]
        if "description" in fields: updates["description"] = fields["description"]

        with transaction.atomic():
            _rows = list(qs)
            updated_count = qs.update(**updates) if updates else qs.count()
            if updates:
                log_bulk_update(_rows, updates)
            apply_and_log_bulk_tags(
                qs,
                fields.get("add_tag_ids") or [],
                fields.get("remove_tag_ids") or [],
                tenant=_get_active_tenant(self.request),
            )
            self._assert_bulk_write_in_site_scope(_rows)
        return Response({"updated": updated_count}, status=drf_status.HTTP_200_OK)


class TagViewSet(CatalogLocalityMixin, TenantScopedViewSet):
    """Read+write Tags — tenant-scoped, plus legacy deployment-global rows.

    A tag belongs to the tenant that created it; rows with ``tenant=NULL``
    predate tag scoping and stay visible to every tenant but writable only by
    superusers (who can adopt or delete them). RBAC (`tag` add/change/delete)
    and, under enhanced site separation, owning-site locality both come from
    the tenant-scoped base + catalog mixin.

    ``?picker=1`` returns the light picker shape (no usage count); the default
    list/detail shape carries a ``usage_count`` annotated in one GROUP BY.
    """

    permission_classes = [permissions.IsAuthenticated]
    pagination_class = _PickerPagination
    queryset = Tag.objects.all().order_by("name")
    serializer_class = TagManageSerializer

    def get_serializer_class(self):
        if self.action == "list" and self.request and self.request.query_params.get("picker") == "1":
            return TagPickerSerializer
        return TagManageSerializer

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return Tag.objects.none()
        qs = (
            Tag.objects.filter(Q(tenant=tenant) | Q(tenant__isnull=True))
            .order_by("name")
        )
        if self.request:
            search = self.request.query_params.get("search", "").strip()
            if search:
                qs = qs.filter(name__icontains=search)
        qs = restrict_for_view(self, qs)
        return qs.annotate(usage_count_annotated=Count("tagged_items"))

    def _guard_legacy(self, obj):
        if obj.tenant_id is None and not self.request.user.is_superuser:
            raise PermissionDenied(
                "This is a legacy global tag (it predates tag scoping) — "
                "only a superuser can edit or delete it."
            )

    def perform_update(self, serializer):
        self._guard_legacy(serializer.instance)
        serializer.save()

    def perform_destroy(self, instance):
        self._guard_legacy(instance)
        instance.delete()

    @action(detail=True, methods=["get"], url_path="usage")
    def usage(self, request, pk=None):
        """The objects carrying this tag, in the active tenant.

        Tags are global, but the objects they're attached to are tenant-
        scoped — so the breakdown is limited to the current tenant. Returns
        ``{count, results:[{type, type_label, id, name, url}]}`` where ``url``
        is the frontend detail path.
        """
        tag = self.get_object()
        tenant = _get_active_tenant(request)
        if tenant is None:
            return Response({"count": 0, "results": []})
        # (slug, label, model, name fn, frontend base path)
        specs = [
            ("prefix",      "Prefix",       Prefix,      lambda o: o.cidr,                    "/prefixes/"),
            ("ipaddress",   "IP address",   IPAddress,   lambda o: o.ip_address,              "/ips/"),
            ("vlan",        "VLAN",         VLAN,         lambda o: f"{o.vlan_id} · {o.name}", "/vlans/"),
            ("vrf",         "VRF",          VRF,          lambda o: o.name,                    "/vrfs/"),
            ("site",        "Site",         Site,         lambda o: o.name,                    "/sites/"),
            ("routetarget", "Route target", RouteTarget,  lambda o: o.name,                    "/route-targets/"),
            ("device",      "Device",       Device,       lambda o: o.name,                    "/devices/"),
        ]
        results = []
        for slug, label, model, name_fn, base in specs:
            for o in model.objects.filter(tags=tag, tenant=tenant).distinct():
                results.append({
                    "type": slug,
                    "type_label": label,
                    "id": str(o.id),
                    "name": name_fn(o),
                    "url": f"{base}{o.id}",
                })
        return Response({"count": len(results), "results": results})


class CustomFieldViewSet(CatalogLocalityMixin, TenantScopedViewSet):
    """Tenant-scoped CRUD for custom-field definitions."""

    queryset = CustomField.objects.all().order_by("weight", "label")
    serializer_class = CustomFieldSerializer

    def get_queryset(self):
        # select_related the group so the serializer's group_name/weight/collapsed
        # reads don't fire one query per field on the list/picker path.
        qs = super().get_queryset().select_related("group")
        if not self.request:
            return qs
        search = self.request.query_params.get("search", "").strip()
        if search:
            qs = qs.filter(label__icontains=search) | qs.filter(key__icontains=search)
        model = self.request.query_params.get("model")
        if model:
            qs = qs.filter(applies_to__contains=[model])
        return qs

    def _assert_key_unique(self, key, exclude_pk=None):
        tenant = self._tenant_or_403()
        qs = CustomField.objects.filter(tenant=tenant, key=key)
        if exclude_pk is not None:
            qs = qs.exclude(pk=exclude_pk)
        if qs.exists():
            raise ValidationError({"key": "A custom field with this key already exists."})

    def perform_create(self, serializer):
        self._assert_key_unique(serializer.validated_data.get("key"))
        serializer.save(
            tenant=self._tenant_or_403(),
            **self._site_default_kwargs(serializer, field_name="owning_site"),
        )

    def perform_update(self, serializer):
        key = serializer.validated_data.get("key", serializer.instance.key)
        self._assert_key_unique(key, exclude_pk=serializer.instance.pk)
        serializer.save()

    @action(detail=True, methods=["get"], url_path="scope-preview")
    def scope_preview(self, request, pk=None):
        field = self.get_object()
        model_slug = request.query_params.get("model") or (
            field.related_model if field.type == "object" else (field.applies_to or [""])[0]
        )
        from customization.object_registry import reference_model
        from customization.scopes import apply_scope_to_queryset, scope_summary

        ref = reference_model(model_slug)
        if ref is None:
            return Response({"results": [], "summary": scope_summary(field.scope_rules or {})})
        tenant = self._tenant_or_403()
        qs = ref.model.objects.all()
        if ref.tenant_field:
            qs = qs.filter(**{ref.tenant_field: tenant})
        qs = apply_scope_to_queryset(qs, model_slug, field.scope_rules or {})[:20]
        results = []
        for obj in qs:
            label = getattr(obj, ref.label_field, None) or str(obj)
            results.append({"id": str(obj.pk), "label": str(label)})
        return Response({"results": results, "summary": scope_summary(field.scope_rules or {})})


class CustomFieldGroupViewSet(CatalogLocalityMixin, TenantScopedViewSet):
    """Tenant-scoped CRUD for custom-field section headings. Deleting a group
    just un-groups its fields (FK is SET_NULL), so no destroy guard is needed."""

    queryset = CustomFieldGroup.objects.all().order_by("weight", "name")
    serializer_class = CustomFieldGroupSerializer

    def get_queryset(self):
        qs = super().get_queryset().annotate(field_count_annotated=Count("fields"))
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
        return qs.order_by("weight", "name")

    def _slug(self, serializer, tenant):
        data = serializer.validated_data
        name = data.get("name") or (
            serializer.instance.name if serializer.instance else ""
        )
        slug = data.get("slug") or slugify(name)
        data["slug"] = slug
        clash = CustomFieldGroup.objects.filter(tenant=tenant, slug=slug)
        if serializer.instance is not None:
            clash = clash.exclude(pk=serializer.instance.pk)
        if clash.exists():
            raise ValidationError({"slug": "Name already in use."})

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        self._slug(serializer, tenant)
        serializer.save(tenant=tenant, **self._site_default_kwargs(serializer, field_name="owning_site"))

    def perform_update(self, serializer):
        self._slug(serializer, self._tenant_or_403())
        serializer.save()


# ─── Tenants ────────────────────────────────────────────────────────────
#
# Tenants are the scoping boundary itself, so this viewset is NOT tenant-
# filtered. Any authenticated user gets the list of tenants they're allowed
# to switch into; access control is delegated to user permissions in a
# later pass. The /switch/ action flips the session's active tenant.


class TenantGroupViewSet(viewsets.ModelViewSet):
    """Org-scoped tenant grouping tree. Visible to any authenticated member
    (groups are navigation metadata); writes ride the same surface that
    manages tenants themselves."""

    permission_classes = [permissions.IsAuthenticated]
    pagination_class = StandardPagination
    queryset = TenantGroup.objects.select_related("parent").order_by("name")
    serializer_class = TenantGroupSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if not self.request:
            return qs
        user = getattr(self.request, "user", None)
        if not (user and user.is_superuser):
            from auth_api.permissions import user_tenants

            qs = qs.filter(
                org__in=user_tenants(user).values("org_id")
            )
        search = self.request.query_params.get("search", "").strip()
        if search:
            qs = qs.filter(name__icontains=search) | qs.filter(slug__icontains=search)
        return qs

    def perform_create(self, serializer):
        org = Organization.objects.first()
        if org is None:
            org = Organization.objects.create(
                name="Default Organization", slug="default"
            )
        serializer.save(org=org)


class TenantViewSet(viewsets.ModelViewSet):
    """Tenants. Reads + ``switch``/``active`` stay open to every member (the
    tenant switcher must work for users with no explicit tenant grant), but
    WRITES are RBAC-gated on the registered ``tenant`` type — without this,
    any member of a tenant could DELETE it (single or bulk) or mint new ones,
    since the base permission is only ``IsAuthenticated``.
    """

    permission_classes = [permissions.IsAuthenticated]
    pagination_class = StandardPagination
    queryset = Tenant.objects.all().order_by("name")
    serializer_class = TenantSerializer
    rbac_action_map = {"bulk_delete": "delete"}

    def get_permissions(self):
        perms = super().get_permissions()
        if getattr(self, "action", None) in ("switch", "active"):
            return perms
        if self.request and self.request.method in permissions.SAFE_METHODS:
            return perms
        from auth_api.drf import RBACObjectPermission

        return [*perms, RBACObjectPermission()]

    def get_serializer_class(self):
        if self.action == "list" and self.request and self.request.query_params.get("picker") == "1":
            return TenantPickerSerializer
        return TenantSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if not self.request:
            return qs
        # A user may only see/act on tenants they're granted — without this any
        # authed user could GET /api/tenants/<id>/ for any tenant's metadata.
        user = getattr(self.request, "user", None)
        if not (user and user.is_superuser):
            from auth_api.permissions import user_tenants

            qs = qs.filter(pk__in=user_tenants(user).values("pk"))
        search = self.request.query_params.get("search", "").strip()
        if search:
            qs = qs.filter(name__icontains=search) | qs.filter(slug__icontains=search)
        return qs

    def perform_create(self, serializer):
        # Stamp the first (and only) Organization onto every new tenant so
        # the FK isn't required from the React form. Mirrors the assumption
        # made everywhere else in the codebase. On a fresh install there is no
        # Organization yet and no setup wizard to make one, so auto-create a
        # default one here (idempotent — only when the table is empty). Run
        # ``manage.py bootstrap`` to provision it explicitly instead.
        org = Organization.objects.first()
        if org is None:
            org = Organization.objects.create(
                name="Default Organization", slug="default"
            )
        tenant = serializer.save(org=org)
        # Seed the built-in Status catalog for the new tenant. The 0047 data
        # migration only seeded tenants that existed when it ran, so a tenant
        # created at runtime would otherwise start with an empty catalog
        # (forms would offer statuses that don't exist as rows). Idempotent.
        from .status_registry import seed_builtin_statuses
        from .role_seeds import seed_builtin_roles

        seed_builtin_statuses(tenant)
        # Same story for IP roles (gateway/HA/etc.) — migrations only seeded
        # pre-existing tenants, so seed them here too (needed for the gateway
        # role + site gateway-policy autospawn).
        seed_builtin_roles(tenant)

    @action(detail=True, methods=["post"], url_path="switch")
    def switch(self, request, pk=None):
        tenant = self.get_object()
        if not tenant.is_active:
            raise ValidationError({"detail": f"Tenant '{tenant.name}' is inactive."})
        request.session["current_tenant_id"] = str(tenant.id)
        return Response({"id": str(tenant.id), "name": tenant.name})

    @action(detail=False, methods=["get"], url_path="active")
    def active(self, request):
        tid = request.session.get("current_tenant_id")
        if not tid:
            return Response({"id": None})
        try:
            tenant = Tenant.objects.get(pk=tid)
        except Tenant.DoesNotExist:
            return Response({"id": None})
        return Response(TenantPickerSerializer(tenant).data)

    @action(detail=False, methods=["post"], url_path="bulk-delete")
    def bulk_delete(self, request):
        ids = request.data.get("ids") or []
        if not isinstance(ids, list) or not ids:
            raise ValidationError({"ids": "Provide a non-empty list of tenant IDs."})
        with transaction.atomic():
            _qs = self.get_queryset().filter(pk__in=ids)
            _rows = list(_qs)
            deleted, _ = _qs.delete()
            log_bulk_delete(_rows)
        return Response({"deleted": deleted}, status=drf_status.HTTP_200_OK)


class _IpCatalogViewSet(CatalogLocalityMixin, TenantScopedViewSet):
    """Shared CRUD for the Status / IPRole per-tenant catalogs.

    Handles slug autogen (from name when omitted), per-tenant slug uniqueness,
    search, and a ``usage_count`` annotation (IPs referencing the row). The
    list action serves a light picker shape on ``?picker=1``.
    """

    pagination_class = _PickerPagination
    picker_serializer_class = None
    # Single reverse relation to count for usage_count; None = let the serializer
    # sum across many relations (Status references 13 models, not just ips).
    usage_relation = "ips"

    def get_serializer_class(self):
        if (self.action == "list" and self.request
                and self.request.query_params.get("picker") == "1"):
            return self.picker_serializer_class
        return self.serializer_class

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            search = self.request.query_params.get("search", "").strip()
            if search:
                qs = qs.filter(name__icontains=search) | qs.filter(description__icontains=search)
        if self.usage_relation:
            qs = qs.annotate(usage_count_annotated=Count(self.usage_relation))
        return qs

    def _prepare(self, serializer):
        tenant = self._tenant_or_403()
        data = serializer.validated_data
        name = data.get("name") or (serializer.instance.name if serializer.instance else "")
        slug = data.get("slug") or slugify(name)
        data["slug"] = slug
        model = self.queryset.model
        clash = model.objects.filter(tenant=tenant, slug=slug)
        if serializer.instance is not None:
            clash = clash.exclude(pk=serializer.instance.pk)
        if clash.exists():
            raise ValidationError({"slug": "A row with this name already exists."})
        return tenant

    def perform_create(self, serializer):
        tenant = self._prepare(serializer)
        self._after_save(serializer.save(
            tenant=tenant,
            **self._site_default_kwargs(serializer, field_name="owning_site"),
        ))

    def perform_update(self, serializer):
        self._prepare(serializer)
        self._after_save(serializer.save())

    def _after_save(self, obj):
        pass


class StatusViewSet(_IpCatalogViewSet):
    queryset = Status.objects.all().order_by("weight", "name")
    serializer_class = StatusSerializer
    picker_serializer_class = StatusPickerSerializer
    # usage spans 13 models — the serializer sums them (no single-relation count).
    usage_relation = None

    def get_queryset(self):
        qs = super().get_queryset()
        # Per-object-type picker: ?available_to=device → statuses usable on devices.
        if self.request:
            avail = self.request.query_params.get("available_to")
            if avail:
                qs = qs.filter(available_to__contains=[avail])
        return qs

    def _after_save(self, obj):
        # At most one default status per (tenant, object-type): strip each slug
        # in this row's default_for from every other row's default_for.
        if obj.default_for:
            for other in Status.objects.filter(tenant=obj.tenant).exclude(pk=obj.pk):
                pruned = [s for s in (other.default_for or []) if s not in obj.default_for]
                if pruned != (other.default_for or []):
                    other.default_for = pruned
                    other.save(update_fields=["default_for"])


class IPRoleViewSet(_IpCatalogViewSet):
    queryset = IPRole.objects.all().order_by("weight", "name")
    serializer_class = IPRoleSerializer
    picker_serializer_class = IPRolePickerSerializer

    def _after_save(self, obj):
        # At most one gateway role per tenant.
        if obj.is_gateway:
            IPRole.objects.filter(tenant=obj.tenant, is_gateway=True).exclude(
                pk=obj.pk
            ).update(is_gateway=False)


class ZoneViewSet(_IpCatalogViewSet):
    """Security zones (zone-based firewalling). Zero pre-filled — users
    define their own zone catalog; VLANs link to zones via ``VLAN.zone``."""

    queryset = Zone.objects.all().order_by("weight", "name")
    serializer_class = ZoneSerializer
    picker_serializer_class = ZonePickerSerializer
    usage_relation = "vlans"


class ManufacturerViewSet(CatalogLocalityMixin, TenantScopedViewSet):
    queryset = Manufacturer.objects.all().order_by("name")
    serializer_class = ManufacturerSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and self.request.query_params.get("picker") == "1":
            return ManufacturerMiniSerializer
        return ManufacturerSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
        return qs.annotate(device_type_count_annotated=Count("device_types"))

    def _slug(self, serializer, tenant):
        data = serializer.validated_data
        name = data.get("name") or (serializer.instance.name if serializer.instance else "")
        slug = data.get("slug") or slugify(name)
        data["slug"] = slug
        clash = Manufacturer.objects.filter(tenant=tenant, slug=slug)
        if serializer.instance is not None:
            clash = clash.exclude(pk=serializer.instance.pk)
        if clash.exists():
            raise ValidationError({"slug": "A manufacturer with this name already exists."})

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        self._slug(serializer, tenant)
        serializer.save(tenant=tenant, **self._site_default_kwargs(serializer, field_name="owning_site"))

    def perform_update(self, serializer):
        self._slug(serializer, self._tenant_or_403())
        serializer.save()

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.device_types.count()
        if n:
            return Response(
                {"detail": f"{n} device type{'s' if n != 1 else ''} use this "
                           "manufacturer — reassign or delete them first."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


def _check_unique_name(model, serializer, tenant, noun):
    name = serializer.validated_data.get("name") or (
        serializer.instance.name if serializer.instance else ""
    )
    clash = model.objects.filter(tenant=tenant, name=name)
    if serializer.instance is not None:
        clash = clash.exclude(pk=serializer.instance.pk)
    if clash.exists():
        raise ValidationError({"name": f"A {noun} with this name already exists."})


class DeviceTypeViewSet(CatalogLocalityMixin, CloneableMixin, TenantScopedViewSet):
    queryset = (
        DeviceType.objects.select_related("manufacturer").prefetch_related("tags").all().order_by("name")
    )
    serializer_class = DeviceTypeSerializer
    pagination_class = StandardPagination
    # Model name is the identity; carry the physical spec. Faceplate/images are
    # not copied (rebuilt on the new type).
    clone_fields = (
        "manufacturer", "u_height", "rack_width", "is_full_depth", "airflow",
        "weight", "weight_unit", "subdevice_role", "exclude_from_utilization",
        "description",
        "release_date", "end_of_sale", "end_of_security_updates",
        "end_of_support", "lifecycle_url",
    )

    @action(detail=False, methods=["post"], url_path="import-yaml")
    def import_yaml(self, request):
        """Import device types from NetBox devicetype-library YAML.

        Body: {"items": ["<yaml or github url>", …], "stack_positions": bool}.
        Each item is either a raw YAML document or a URL to one (github.com
        blob links are converted to raw automatically). Returns one report
        per item; content problems never abort the batch.
        """
        from core.ssrf import SSRFError, safe_get

        from .devicetype_import import import_yaml_auto, to_raw_url

        tenant = self._tenant_or_403()
        body = request.data or {}
        items = body.get("items")
        if not isinstance(items, list) or not items or len(items) > 100:
            return Response(
                {"detail": "items must be a non-empty list (max 100)."},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )
        stack = bool(body.get("stack_positions"))

        # Enhanced site separation: a site-scoped importer's new device types
        # (and any manufacturers minted along the way) are LOCAL to their
        # site — this raw path skips the post-save guard, so force it here.
        from core.effective_settings import separation_enabled

        owning_site = None
        if not request.user.is_superuser and separation_enabled(tenant):
            from auth_api import rbac

            editable = rbac.editable_sites(request.user, tenant)
            if isinstance(editable, set):
                if len(editable) != 1:
                    raise PermissionDenied(
                        "Site-scoped import needs exactly one editable site — "
                        "yours spans several, so imported types have no home."
                    )
                owning_site = Site.objects.filter(
                    tenant=tenant, pk=next(iter(editable))
                ).first()

        results = []
        for item in items:
            text = str(item or "").strip()
            if text.startswith(("http://", "https://")):
                url = to_raw_url(text)
                try:
                    # SSRF-guarded fetch (validates the host is public + pins
                    # the connection + no redirects) — a tenant user must not
                    # be able to make the server read cloud metadata / internal
                    # services via an import URL.
                    resp = safe_get(url, timeout=10)
                    resp.raise_for_status()
                    text = resp.text
                except SSRFError as exc:
                    results.append({
                        "ok": False, "name": url, "id": None, "created": {},
                        "skipped": [], "error": f"Refused: {exc}",
                        "kind": "device-type",
                    })
                    continue
                except Exception as exc:  # noqa: BLE001 — report, don't abort
                    results.append({
                        "ok": False, "name": url, "id": None, "created": {},
                        "skipped": [], "error": f"Fetch failed: {exc}",
                        "kind": "device-type",
                    })
                    continue
            results.append(
                import_yaml_auto(
                    tenant, text, stack_positions=stack, owning_site=owning_site
                )
            )
        return Response({"results": results})

    def get_serializer_class(self):
        if self.action == "list" and self.request and self.request.query_params.get("picker") == "1":
            return DeviceTypeMiniSerializer
        return DeviceTypeSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = (qs.filter(name__icontains=s) | qs.filter(model__icontains=s)
                      | qs.filter(part_number__icontains=s))
            mfr = self.request.query_params.get("manufacturer")
            if mfr:
                qs = qs.filter(manufacturer_id=mfr)
            lc = self.request.query_params.get("lifecycle")
            if lc:
                qs = _apply_lifecycle_filter(qs, lc)
        return qs.annotate(device_count_annotated=Count("device"))

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        _check_unique_name(DeviceType, serializer, tenant, "device type")
        serializer.save(tenant=tenant, **self._site_default_kwargs(serializer, field_name="owning_site"))

    def perform_update(self, serializer):
        _check_unique_name(DeviceType, serializer, self._tenant_or_403(), "device type")
        serializer.save()

    @action(detail=True, methods=["post"], url_path="images",
            parser_classes=[MultiPartParser, FormParser])
    def images(self, request, pk=None):
        """Upload / clear the front & rear rack-face images (multipart). Send a
        `front_image` / `rear_image` file to set, or `clear_front=1` /
        `clear_rear=1` to remove. Rendered in rack elevations."""
        dt = self.get_object()
        if "front_image" in request.FILES:
            dt.front_image = request.FILES["front_image"]
        if "rear_image" in request.FILES:
            dt.rear_image = request.FILES["rear_image"]
        if request.data.get("clear_front"):
            dt.front_image = None
        if request.data.get("clear_rear"):
            dt.rear_image = None
        dt.save()
        return Response(DeviceTypeSerializer(dt, context={"request": request}).data)


def _region_and_descendant_ids(region_id):
    """All region ids in the subtree rooted at ``region_id`` (inclusive).

    Region is a plain self-referential adjacency list (no MPTT / tree-queries),
    so we walk ``children`` breadth-first in Python — one query per tree depth,
    which is cheap for the handful of levels a region tree ever has. Returns an
    empty list if the region id is unknown, so the caller's ``__in`` filter
    matches nothing rather than everything.
    """
    from .models import Region

    root_ids = list(Region.objects.filter(id=region_id).values_list("id", flat=True))
    if not root_ids:
        return []
    ids = list(root_ids)
    frontier = list(root_ids)
    while frontier:
        children = list(
            Region.objects.filter(parent_id__in=frontier)
            .exclude(id__in=ids)  # cycle guard (clean() prevents these, be safe)
            .values_list("id", flat=True)
        )
        if not children:
            break
        ids.extend(children)
        frontier = children
    return ids


class DeviceViewSet(CloneableMixin, ImageAttachmentMixin, TenantScopedViewSet):
    queryset = (
        Device.objects.select_related("device_type", "site", "primary_ip")
        .prefetch_related("tags").all().order_by("name")
    )
    serializer_class = DeviceSerializer
    pagination_class = StandardPagination
    # Name/serial/asset-tag/IPs are identity; rack placement is left blank so the
    # clone doesn't fight for the source's rack unit. Carry type/role/site/etc.
    clone_fields = (
        "device_type", "role", "platform", "status", "site", "location",
        "cluster", "airflow", "description", "comments",
    )

    @action(detail=True, methods=["get"], url_path="config-context")
    def config_context(self, request, pk=None):
        from .config_context import render_config_context

        return Response(render_config_context(self.get_object()))

    @action(detail=True, methods=["get"])
    def render(self, request, pk=None):
        """Render an export template for this device → intended config text.
        `?template=<export-template-id>` (must be object_type=device). With no
        template param, falls back to the device's bound config template
        (device → role → platform resolution).
        """
        from jinja2 import TemplateError

        from .export_templates import render_device_config
        from .models import ExportTemplate, resolve_config_template
        from .views import _get_active_tenant

        tenant = _get_active_tenant(request)
        tid = request.query_params.get("template")
        tmpl = ExportTemplate.objects.filter(
            id=tid, tenant=tenant
        ).first() if (tid and tenant) else None
        if tmpl is None and not tid:
            tmpl = resolve_config_template(self.get_object())
        if tmpl is None:
            return Response({"detail": "Unknown template."}, status=drf_status.HTTP_400_BAD_REQUEST)
        try:
            output = render_device_config(tmpl, self.get_object(), tmpl.tenant)
        except (TemplateError, ValueError) as exc:
            return Response({"detail": str(exc)}, status=drf_status.HTTP_400_BAD_REQUEST)
        return Response({"output": output, "template": tmpl.name})

    @action(detail=True, methods=["get"])
    def inventory(self, request, pk=None):
        """What Ansible sees for this one device — its groups + hostvars, the
        same data the /api/inventory/ansible/ export carries for this host."""
        from .inventory_views import (
            device_groups, device_hostvars, with_inventory_relations,
        )

        # get_object() enforces tenant + RBAC; re-load that same row with the
        # inventory relations so the helpers below stay query-light.
        obj = self.get_object()
        d = with_inventory_relations(
            Device.objects.filter(pk=obj.pk)
        ).first() or obj
        return Response({
            "host": d.name,
            "ansible_host": d.primary_ip.ip_address if d.primary_ip_id else None,
            "groups": sorted(device_groups(d)),
            "hostvars": device_hostvars(d),
        })

    @action(detail=True, methods=["post"])
    def deploy(self, request, pk=None):
        """Dispatch a deploy for this device to an AutomationTarget.
        Body: {"target_id": "<id>"}.
        """
        from integrations.dispatch import enqueue_deploy
        from integrations.models import AutomationTarget
        from .views import _get_active_tenant

        tenant = _get_active_tenant(request)
        tid = (request.data or {}).get("target_id")
        target = AutomationTarget.objects.filter(
            id=tid, tenant=tenant, enabled=True
        ).first() if (tid and tenant) else None
        if target is None:
            return Response({"detail": "Unknown or disabled target."},
                            status=drf_status.HTTP_400_BAD_REQUEST)
        device = self.get_object()
        run = enqueue_deploy(target, [device.id], event="manual")
        from integrations.api import DeployRunSerializer
        return Response(DeployRunSerializer(run).data, status=202)

    @action(detail=True, methods=["get", "post"], url_path="config-state")
    def config_state(self, request, pk=None):
        """Read or report this device's intended-vs-actual config drift (P3).

        GET  → the latest stored state (404 if never reported).
        POST → the runner reports actual config. Body:
               {"actual_config": "...", "intended_config"?: "...",
                "template"?: "<export-template-id>", "source"?: "ansible"}.
               If `intended_config` is omitted but `template` is given, Danbyte
               renders it; otherwise drift is `unknown`. Danbyte diffs and stores.
        """
        from django.utils import timezone

        from integrations.api import DeviceConfigStateSerializer
        from integrations.drift import compute_drift
        from integrations.models import DeviceConfigState
        from .views import _get_active_tenant

        device = self.get_object()
        if request.method == "GET":
            state = DeviceConfigState.objects.filter(device=device).first()
            if state is None:
                return Response({"detail": "No config state reported yet."},
                                status=drf_status.HTTP_404_NOT_FOUND)
            return Response(DeviceConfigStateSerializer(state).data)

        tenant = _get_active_tenant(request)
        data = request.data or {}
        actual = data.get("actual_config") or ""
        intended = data.get("intended_config") or ""
        tmpl = None
        tid = data.get("template")
        if tid:
            from .models import ExportTemplate
            tmpl = ExportTemplate.objects.filter(id=tid, tenant=tenant).first()
        # If no intended config was posted, render it from the named template.
        if not intended and tmpl is not None:
            from jinja2 import TemplateError
            from .export_templates import render_device_config
            try:
                intended = render_device_config(tmpl, device, tmpl.tenant)
            except (TemplateError, ValueError):
                intended = ""
        status_val, diff = compute_drift(intended, actual)
        state, _ = DeviceConfigState.objects.update_or_create(
            device=device,
            defaults={
                "tenant": device.tenant,
                "template": tmpl,
                "status": status_val,
                "intended_config": intended,
                "actual_config": actual,
                "diff": diff,
                "source": (data.get("source") or "")[:64],
                "reported_at": timezone.now(),
            },
        )
        return Response(DeviceConfigStateSerializer(state).data,
                        status=drf_status.HTTP_200_OK)

    def get_serializer_class(self):
        if self.action == "list" and self.request and self.request.query_params.get("picker") == "1":
            if self.request.query_params.get("with_vc") == "1":
                return DeviceVcPickerSerializer
            return DevicePickerSerializer
        return DeviceSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = (qs.filter(name__icontains=s) | qs.filter(serial_number__icontains=s)
                      | qs.filter(asset_tag__icontains=s) | qs.filter(description__icontains=s))
            # The with_vc picker reads each device's chassis — pull it in one join.
            if self.request.query_params.get("with_vc") == "1":
                qs = qs.select_related("virtual_chassis")
            for key, field in (("site", "site_id"), ("device_type", "device_type_id"),
                               ("status", "status"), ("rack", "rack_id"),
                               ("role", "role_id"), ("platform", "platform_id"),
                               ("location", "location_id"),
                               ("manufacturer", "device_type__manufacturer_id")):
                v = self.request.query_params.get(key)
                if v:
                    qs = qs.filter(**{field: v})
            # Region is an adjacency-list tree (no MPTT), so filtering by a
            # region must include devices in its descendant regions' sites.
            region = self.request.query_params.get("region")
            if region:
                qs = qs.filter(site__region_id__in=_region_and_descendant_ids(region))
            # ?tag=<slug> (repeatable) — AND semantics, matching the HTML list
            # pages' tag rail (see api/filters.apply_tag_filter).
            tag_slugs = [t for t in self.request.query_params.getlist("tag") if t]
            for slug in tag_slugs:
                qs = qs.filter(tags__slug=slug)
            if tag_slugs:
                qs = qs.distinct()
            qs = _apply_custom_field_scope(self.request, qs, "device")
        return qs

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        _check_unique_name(Device, serializer, tenant, "device")
        serializer.save(tenant=tenant)
        # Stamp the device's components out of its type's templates (NetBox
        # semantics: a C9300-48P type materialises its 48 interfaces + console
        # + PSU inlets on every new device of the type).
        materialize_device_components(serializer.instance)

    def perform_update(self, serializer):
        _check_unique_name(Device, serializer, self._tenant_or_403(), "device")
        # Stack membership before the save — if the position (or membership)
        # changes, positional interface names ({position} templates) follow.
        old = serializer.instance
        old_in_stack = old.virtual_chassis_id is not None
        old_pos = old.vc_position if old_in_stack else None
        serializer.save()
        new = serializer.instance
        new_in_stack = new.virtual_chassis_id is not None
        new_pos = new.vc_position if new_in_stack else None
        if (old_in_stack, old_pos) != (new_in_stack, new_pos):
            renamed = sync_positional_interface_names(new, old_pos, new_pos)
            # Surfaced by DeviceSerializer.vc_renamed_interfaces so the UI can
            # toast "Renamed N interfaces to position X".
            new._vc_renamed_interfaces = renamed
        # Reconcile monitored services — e.g. a just-set primary IP now gives a
        # target to services that materialised before the device had one.
        from monitoring.service_checks import sync_service_checks

        for svc in new.services.filter(monitored=True):
            sync_service_checks(svc)

    @action(detail=True, methods=["post"], url_path="sync-from-type")
    def sync_from_type(self, request, pk=None):
        """Re-materialise a device from its type's current component templates.

        ``apply=false`` (default) → dry-run: return the name-level diff plus a
        risk summary so the UI can preview before touching anything.
        ``apply=true`` → add missing components; with ``remove_extra=true`` also
        delete components the type no longer defines (destructive — cascades
        cabling / IP links)."""
        from auth_api import rbac
        from .views import _get_active_tenant

        device = self.get_object()
        tenant = _get_active_tenant(request)
        if not rbac.can_act_on(request.user, tenant, "device", "change", device):
            return Response({"detail": "device.change required."}, status=403)
        if device.device_type_id is None:
            return Response(
                {"detail": "This device has no device type to sync from."},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )

        diff = diff_device_components(device)
        # Risk: extra interfaces that carry IPs — deleting them drops the links.
        extra_ifaces = diff.get("interfaces", {}).get("extra", [])
        risk = {
            "interfaces_with_ips": (
                device.interfaces.filter(
                    name__in=extra_ifaces, ip_addresses__isnull=False
                ).distinct().count()
                if extra_ifaces else 0
            ),
        }
        apply = bool(request.data.get("apply"))
        remove_extra = bool(request.data.get("remove_extra"))
        if not apply:
            return Response({"applied": False, "diff": diff, "risk": risk})
        result = sync_device_components(device, remove_extra=remove_extra)
        return Response(
            {"applied": True, "diff": diff, "risk": risk, "result": result}
        )

    @action(detail=True, methods=["get"], url_path="ips")
    def ips(self, request, pk=None):
        from auth_api import rbac

        device = self.get_object()
        qs = (IPAddress.objects.filter(assigned_device=device)
              .select_related("status", "role", "prefix").prefetch_related("tags"))
        qs = rbac.restrict_queryset(
            qs, request.user, device.tenant, "ipaddress", "view"
        )
        return Response({"count": qs.count(), "results": IPAddressSerializer(qs, many=True).data})

    @action(detail=True, methods=["get"], url_path="interfaces")
    def interfaces(self, request, pk=None):
        from auth_api import rbac

        device = self.get_object()
        qs = (
            device.interfaces.select_related("vlan", "parent", "lag", "bridge")
            .prefetch_related("tags", "ip_addresses", "children", "lag_members")
            .order_by("name")
        )
        qs = rbac.restrict_queryset(
            qs, request.user, device.tenant, "interface", "view"
        )
        return Response({
            "count": qs.count(),
            "results": InterfaceSerializer(
                qs, many=True, context={"request": request}
            ).data,
        })

    @action(detail=True, methods=["get"], url_path="map")
    def map(self, request, pk=None):
        """Device-level topology: trace through any patch panels and show the
        chain of devices reached, collapsing front/rear ports away."""
        from .topology_views import device_trace_map
        return Response(device_trace_map(self.get_object()))

    @action(detail=True, methods=["get"], url_path="paths")
    def paths(self, request, pk=None):
        from .topology_views import device_paths
        return Response(device_paths(self.get_object()))


class InterfaceViewSet(ComponentBulkMixin, TenantScopedViewSet):
    """Interfaces have no direct tenant FK — scope via device.tenant."""

    # Interface has no description column (yet) — don't offer one.
    bulk_str_fields = ("type", "mode", "speed", "duplex")
    bulk_bool_fields = ("enabled", "mgmt_only")
    bulk_int_fields = ("mtu",)
    bulk_fk_fields = {"vlan_id": VLAN, "vrf_id": VRF}
    bulk_tags = True

    queryset = (
        Interface.objects.select_related(
            "device", "vlan", "vrf", "parent", "lag", "bridge"
        )
        .prefetch_related(
            "tags", "terminations__cable", "ip_addresses", "children",
            "lag_members", "tagged_vlans", "mac_addresses"
        )
        .order_by("device__name", "name")
    )
    serializer_class = InterfaceSerializer
    pagination_class = StandardPagination
    tenant_field = None
    rbac_action_map = {
        "bulk_create": "add",
        "bulk_update": "change",
        "bulk_delete": "delete",
    }

    def get_serializer_class(self):
        if self.action == "list" and self.request and self.request.query_params.get("picker") == "1":
            return InterfacePickerSerializer
        return InterfaceSerializer

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return self.queryset.none()
        qs = self.queryset.filter(device__tenant=tenant)
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(device__name__icontains=s)
            device_id = self.request.query_params.get("device")
            if device_id:
                qs = qs.filter(device_id=device_id)
        return restrict_for_view(self, qs)

    def _check(self, serializer):
        tenant = self._tenant_or_403()
        device = serializer.validated_data.get("device") or (
            serializer.instance.device if serializer.instance else None
        )
        if device is None or device.tenant_id != tenant.id:
            raise ValidationError({"device_id": "Pick a device in the current tenant."})
        name = serializer.validated_data.get("name") or (
            serializer.instance.name if serializer.instance else ""
        )
        clash = Interface.objects.filter(device=device, name=name)
        if serializer.instance is not None:
            clash = clash.exclude(pk=serializer.instance.pk)
        if clash.exists():
            raise ValidationError({"name": "This device already has an interface with that name."})

    def perform_create(self, serializer):
        self._check(serializer)
        serializer.save()

    def perform_update(self, serializer):
        self._check(serializer)
        serializer.save()

    @action(detail=True, methods=["get"], url_path="ips")
    def ips(self, request, pk=None):
        """IPs assigned to this interface — backs the IP section on the
        interface detail page."""
        iface = self.get_object()  # tenant-scoped via device__tenant
        qs = (
            IPAddress.objects.filter(
                assigned_interface=iface, tenant=iface.device.tenant
            )
            .select_related("status", "role", "prefix")
            .prefetch_related("tags")
            .order_by("ip_address")
        )
        from auth_api import rbac

        qs = rbac.restrict_queryset(
            qs, request.user, iface.device.tenant, "ipaddress", "view"
        )
        return Response({
            "count": qs.count(),
            "results": IPAddressSerializer(
                qs, many=True, context={"request": request}
            ).data,
        })

    @action(detail=False, methods=["post"], url_path="bulk-create")
    def bulk_create(self, request):
        """Create many interfaces on one device at once.

        Body: ``{device_id, names:[...], speed?, mtu?, enabled?, vlan_id?,
        tag_ids?}``. Names that already exist on the device are skipped (not an
        error). The frontend expands a pattern like ``eth[0-47]`` into names.
        """
        tenant = self._tenant_or_403()
        data = request.data
        device_id = data.get("device_id")
        names = data.get("names") or []
        if not device_id:
            raise ValidationError({"device_id": "Pick a device."})
        if not isinstance(names, list) or not names:
            raise ValidationError({"names": "Provide at least one interface name."})
        if len(names) > 512:
            raise ValidationError({"names": "Too many at once (max 512)."})
        device = Device.objects.filter(pk=device_id, tenant=tenant).first()
        if device is None:
            raise ValidationError({"device_id": "Pick a device in the current tenant."})
        # This raw path bypasses create(), so authorize the saved rows inside
        # the same transaction. That enforces both site scope and arbitrary add
        # constraints, not just the target device's site.
        from auth_api import rbac as _rbac

        mtu = data.get("mtu")
        if mtu in ("", None):
            mtu = None
        else:
            try:
                mtu = int(mtu)
            except (TypeError, ValueError):
                raise ValidationError({"mtu": "Must be a number."})
        speed = (data.get("speed") or "").strip()
        enabled = bool(data.get("enabled", True))
        vlan_id = data.get("vlan_id") or None
        # This raw path bypasses the tenant-scoped serializer field — validate
        # the VLAN belongs to the active tenant (issue #59 FK smuggling).
        if vlan_id and not VLAN.objects.filter(pk=vlan_id, tenant=tenant).exists():
            raise ValidationError({"vlan_id": "Not found in this tenant."})
        tag_ids = data.get("tag_ids") or []

        existing = set(device.interfaces.values_list("name", flat=True))
        created, created_ids, skipped = [], [], []
        with transaction.atomic():
            for raw in names:
                nm = str(raw).strip()
                if not nm or nm in existing:
                    skipped.append(nm)
                    continue
                existing.add(nm)
                iface = Interface.objects.create(
                    device=device, name=nm, speed=speed, mtu=mtu,
                    enabled=enabled, vlan_id=vlan_id,
                )
                if tag_ids:
                    iface.tags.add(*tag_ids)
                created.append(nm)
                created_ids.append(iface.pk)
            allowed = _rbac.restrict_queryset(
                Interface.objects.filter(pk__in=created_ids),
                request.user,
                tenant,
                "interface",
                "add",
            ).count()
            if allowed != len(created_ids):
                raise PermissionDenied(
                    "One or more interfaces are outside your permission scope."
                )
        return Response(
            {"created": len(created), "created_names": created, "skipped": skipped},
            status=drf_status.HTTP_200_OK,
        )

    @action(detail=True, methods=["get"], url_path="trace")
    def trace(self, request, pk=None):
        from .trace import trace as run_trace
        from .topology_views import trace_device_graph
        iface = self.get_object()
        graph = run_trace([("interface", iface)])
        return Response({
            "origin": {"type": "interface", "id": str(iface.id)},
            "device_graph": trace_device_graph(iface.device.tenant, graph),
            **graph,
        })


class MACAddressViewSet(TenantScopedViewSet):
    """First-class MAC address objects. Filter by ``?interface=``, ``?device=``,
    or ``?search=`` (MAC substring)."""

    queryset = (
        MACAddress.objects.select_related("assigned_interface__device")
        .prefetch_related("tags")
        .order_by("mac_address")
    )
    serializer_class = MACAddressSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = super().get_queryset()
        if not self.request:
            return qs
        p = self.request.query_params
        if p.get("interface"):
            qs = qs.filter(assigned_interface_id=p["interface"])
        if p.get("device"):
            qs = qs.filter(assigned_interface__device_id=p["device"])
        search = p.get("search", "").strip()
        if search:
            qs = qs.filter(mac_address__icontains=search.lower())
        return restrict_for_view(self, qs)


class CableViewSet(TenantScopedViewSet):
    queryset = (
        Cable.objects.prefetch_related(
            "terminations__interface__device",
            "terminations__front_port__device",
            "terminations__rear_port__device",
            "tags",
        ).order_by("-created_at")
    )
    serializer_class = CableSerializer
    pagination_class = StandardPagination
    # Tenant + termination validation live in CableSerializer; the base
    # perform_create stamps the tenant (passed into serializer.create).

    def get_queryset(self):
        from auth_api.drf import _action_for

        from .cable_scope import restrict_cables

        qs = super().get_queryset()
        tenant = _get_active_tenant(self.request) if self.request else None
        if tenant is not None:
            qs = restrict_cables(
                qs, self.request.user, tenant, _action_for(self, self.request)
            )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = (qs.filter(description__icontains=s)
                      | qs.filter(type__icontains=s)
                      | qs.filter(terminations__interface__name__icontains=s)
                      | qs.filter(terminations__interface__device__name__icontains=s)
                      | qs.filter(terminations__front_port__name__icontains=s)
                      | qs.filter(terminations__rear_port__name__icontains=s))
            device_id = self.request.query_params.get("device")
            if device_id:
                qs = (qs.filter(terminations__interface__device_id=device_id)
                      | qs.filter(terminations__front_port__device_id=device_id)
                      | qs.filter(terminations__rear_port__device_id=device_id))
        return qs.distinct()

    def _assert_write_in_site_scope(self, response, action):
        from .cable_scope import can_act_on_cable

        super()._assert_write_in_site_scope(response, action)
        if self.request.user.is_superuser:
            return
        tenant = self._tenant_or_403()
        pk = (response.data or {}).get("id") if hasattr(response, "data") else None
        cable = Cable.objects.filter(pk=pk, tenant=tenant).first() if pk else None
        if not can_act_on_cable(self.request.user, tenant, action, cable):
            raise PermissionDenied(
                "Your cable permission does not cover every termination site."
            )

    @action(detail=True, methods=["get"], url_path="trace")
    def trace(self, request, pk=None):
        from .trace import trace as run_trace, point_from_termination
        from .topology_views import trace_device_graph
        cable = self.get_object()
        starts = [point_from_termination(t) for t in cable.terminations.all()]
        graph = run_trace(starts)
        return Response({
            "origin": {"type": "cable", "id": str(cable.id)},
            "device_graph": trace_device_graph(cable.tenant, graph),
            **graph,
        })

    @action(detail=True, methods=["get"], url_path="strand")
    def strand(self, request, pk=None):
        """End-to-end path of one fibre strand: /api/cables/<id>/strand/?n=7."""
        from .topology_views import cable_strand_path

        try:
            n = int(request.query_params.get("n", "1"))
        except (TypeError, ValueError):
            return Response({"detail": "n must be an integer"}, status=400)
        cable = self.get_object()
        if n < 1 or (cable.fiber_count and n > cable.fiber_count):
            return Response({"detail": "strand out of range"}, status=400)
        return Response(cable_strand_path(cable, n))

    @action(detail=True, methods=["get"], url_path="floor-plan")
    def floor_plan(self, request, pk=None):
        """The floor plan where this cable can be traced — a plan whose trays
        carry it, else one that tiles either of its devices (or their racks).
        `{plan_id: <id|null>}` — powers the "trace on map" button."""
        from .models import FloorPlan, FloorPlanTile

        cable = self.get_object()
        # 1) A plan that routes this cable through a tray.
        tray = cable.trays.select_related("floor_plan").first()
        if tray is not None:
            return Response({"plan_id": str(tray.floor_plan_id)})
        # 2) A plan that tiles either end's device, or that device's rack.
        device_ids, rack_ids = set(), set()
        for term in cable.terminations.all():
            point = term.point
            dev_id = getattr(point, "device_id", None)
            if dev_id is None:
                continue
            device_ids.add(dev_id)
        if device_ids:
            for rid in Device.objects.filter(id__in=device_ids).values_list(
                "rack_id", flat=True
            ):
                if rid:
                    rack_ids.add(rid)
        tile = (
            FloorPlanTile.objects.filter(floor_plan__tenant=cable.tenant)
            .filter(Q(device_id__in=device_ids) | Q(rack_id__in=rack_ids))
            .select_related("floor_plan")
            .first()
        )
        return Response(
            {"plan_id": str(tile.floor_plan_id) if tile is not None else None}
        )


class _DevicePortViewSet(ComponentBulkMixin, TenantScopedViewSet):
    """Shared base for FrontPort / RearPort — no direct tenant FK; scope via
    device.tenant, like interfaces."""

    pagination_class = StandardPagination
    tenant_field = None
    bulk_str_fields = ("type", "description")
    bulk_tags = True

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return self.queryset.none()
        qs = self.queryset.filter(device__tenant=tenant)
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(device__name__icontains=s)
            device_id = self.request.query_params.get("device")
            if device_id:
                qs = qs.filter(device_id=device_id)
        return restrict_for_view(self, qs)

    def _check(self, serializer):
        tenant = self._tenant_or_403()
        device = serializer.validated_data.get("device") or (
            serializer.instance.device if serializer.instance else None
        )
        if device is None or device.tenant_id != tenant.id:
            raise ValidationError({"device_id": "Pick a device in the current tenant."})
        name = serializer.validated_data.get("name") or (
            serializer.instance.name if serializer.instance else ""
        )
        model = self.queryset.model
        clash = model.objects.filter(device=device, name=name)
        if serializer.instance is not None:
            clash = clash.exclude(pk=serializer.instance.pk)
        if clash.exists():
            raise ValidationError({"name": "This device already has a port with that name."})

    def perform_create(self, serializer):
        self._check(serializer)
        serializer.save()

    def perform_update(self, serializer):
        self._check(serializer)
        serializer.save()


class FiberSettingsViewSet(viewsets.ViewSet):
    """The tenant's fibre colour palette — a singleton. GET reads it (creating
    the TIA-598-C default on first access); POST saves an edited palette."""

    permission_classes = [permissions.IsAuthenticated]

    def _obj(self):
        return FiberSettings.for_tenant(_get_active_tenant(self.request))

    def list(self, request):
        return Response(FiberSettingsSerializer(self._obj()).data)

    def create(self, request):
        ser = FiberSettingsSerializer(
            self._obj(), data=request.data, partial=True
        )
        ser.is_valid(raise_exception=True)
        ser.save()
        return Response(ser.data)


class RearPortViewSet(_DevicePortViewSet):
    queryset = (
        RearPort.objects.select_related("device")
        .prefetch_related("tags", "terminations__cable", "front_ports")
        .order_by("device__name", "name")
    )
    serializer_class = RearPortSerializer
    bulk_int_fields = ("positions",)


class FrontPortViewSet(_DevicePortViewSet):
    queryset = (
        FrontPort.objects.select_related("device", "rear_port")
        .prefetch_related("tags", "terminations__cable")
        .order_by("device__name", "name")
    )
    serializer_class = FrontPortSerializer


class ConsolePortViewSet(_DevicePortViewSet):
    queryset = (
        ConsolePort.objects.select_related("device")
        .prefetch_related("tags", "terminations__cable")
        .order_by("device__name", "name")
    )
    serializer_class = ConsolePortSerializer


class AuxPortViewSet(_DevicePortViewSet):
    queryset = (
        AuxPort.objects.select_related("device")
        .prefetch_related("tags")  # not cable-terminable — no terminations
        .order_by("device__name", "name")
    )
    serializer_class = AuxPortSerializer


class ConsoleServerPortViewSet(_DevicePortViewSet):
    queryset = (
        ConsoleServerPort.objects.select_related("device")
        .prefetch_related("tags", "terminations__cable")
        .order_by("device__name", "name")
    )
    serializer_class = ConsoleServerPortSerializer
    bulk_int_fields = ("speed",)


class PowerPortViewSet(_DevicePortViewSet):
    queryset = (
        PowerPort.objects.select_related("device")
        .prefetch_related("tags", "terminations__cable", "outlets")
        .order_by("device__name", "name")
    )
    serializer_class = PowerPortSerializer


class PowerOutletViewSet(_DevicePortViewSet):
    queryset = (
        PowerOutlet.objects.select_related("device", "power_port")
        .prefetch_related("tags", "terminations__cable")
        .order_by("device__name", "name")
    )
    serializer_class = PowerOutletSerializer
    bulk_str_fields = ("type", "description", "feed_leg")

    def _check(self, serializer):
        super()._check(serializer)
        # The feeding inlet must live on the same device as the outlet.
        port = serializer.validated_data.get("power_port") or (
            serializer.instance.power_port if serializer.instance else None
        )
        device = serializer.validated_data.get("device") or (
            serializer.instance.device if serializer.instance else None
        )
        if port is not None and device is not None and port.device_id != device.id:
            raise ValidationError(
                {"power_port_id": "Pick an inlet on the same device."}
            )


# ─── Device-type component templates ─────────────────────────────────────────
class _ComponentTemplateViewSet(ComponentBulkMixin, TenantScopedViewSet):
    """Shared base for the per-device-type component templates — no direct
    tenant FK; scope via device_type.tenant. Filter with ?device_type=."""

    pagination_class = StandardPagination
    tenant_field = None
    bulk_str_fields = ("description",)

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return self.queryset.none()
        qs = self.queryset.filter(device_type__tenant=tenant)
        if self.request:
            dt = self.request.query_params.get("device_type")
            if dt:
                qs = qs.filter(device_type_id=dt)
        return restrict_for_view(self, qs)

    def _check(self, serializer):
        tenant = self._tenant_or_403()
        dt = serializer.validated_data.get("device_type") or (
            serializer.instance.device_type if serializer.instance else None
        )
        if dt is None or dt.tenant_id != tenant.id:
            raise ValidationError(
                {"device_type_id": "Pick a device type in the current tenant."}
            )
        name = serializer.validated_data.get("name") or (
            serializer.instance.name if serializer.instance else ""
        )
        model = self.queryset.model
        clash = model.objects.filter(device_type=dt, name=name)
        if serializer.instance is not None:
            clash = clash.exclude(pk=serializer.instance.pk)
        if clash.exists():
            raise ValidationError(
                {"name": "This device type already has a template with that name."}
            )

    def perform_create(self, serializer):
        self._check(serializer)
        serializer.save()

    def perform_update(self, serializer):
        self._check(serializer)
        serializer.save()


class InterfaceTemplateViewSet(_ComponentTemplateViewSet):
    queryset = InterfaceTemplate.objects.select_related("device_type").order_by("name")
    serializer_class = InterfaceTemplateSerializer
    bulk_str_fields = ("type", "description")
    bulk_bool_fields = ("enabled", "mgmt_only")


class DeviceTypeServiceViewSet(_ComponentTemplateViewSet):
    """Service templates on a device type — materialise onto new devices as
    Services (see ``materialize_device_components``)."""

    queryset = DeviceTypeService.objects.select_related("device_type").order_by("name")
    serializer_class = DeviceTypeServiceSerializer


class ConsolePortTemplateViewSet(_ComponentTemplateViewSet):
    queryset = ConsolePortTemplate.objects.select_related("device_type").order_by("name")
    serializer_class = ConsolePortTemplateSerializer


class AuxPortTemplateViewSet(_ComponentTemplateViewSet):
    queryset = AuxPortTemplate.objects.select_related("device_type").order_by("name")
    serializer_class = AuxPortTemplateSerializer


class InventoryItemTemplateViewSet(_ComponentTemplateViewSet):
    queryset = (
        InventoryItemTemplate.objects
        .select_related("device_type", "manufacturer").order_by("name")
    )
    serializer_class = InventoryItemTemplateSerializer


class InventoryItemViewSet(_DevicePortViewSet):
    queryset = (
        InventoryItem.objects
        .select_related("device", "manufacturer", "parent")
        .prefetch_related("tags")
        .order_by("device__name", "name")
    )
    serializer_class = InventoryItemSerializer
    # InventoryItem has no `type` column — its own allowlist.
    bulk_str_fields = ("description", "part_id", "serial_number", "asset_tag")


class DeviceBayTemplateViewSet(_ComponentTemplateViewSet):
    queryset = DeviceBayTemplate.objects.select_related("device_type").order_by("name")
    serializer_class = DeviceBayTemplateSerializer


class DeviceBayViewSet(_DevicePortViewSet):
    queryset = (
        DeviceBay.objects.select_related("device", "installed_device")
        .prefetch_related("tags")
        .order_by("device__name", "name")
    )
    serializer_class = DeviceBaySerializer


class ModuleBayTemplateViewSet(_ComponentTemplateViewSet):
    queryset = ModuleBayTemplate.objects.select_related("device_type").order_by("name")
    serializer_class = ModuleBayTemplateSerializer


class TopologyViewViewSet(TenantScopedViewSet):
    queryset = TopologyView.objects.all().order_by("name")
    serializer_class = TopologyViewSerializer
    pagination_class = StandardPagination

    def perform_create(self, serializer):
        serializer.save(tenant=self._tenant_or_403())


class ModuleTypeViewSet(TenantScopedViewSet):
    queryset = (
        ModuleType.objects.select_related("manufacturer")
        .prefetch_related("tags").order_by("name")
    )
    serializer_class = ModuleTypeSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return ModuleTypeMiniSerializer
        return ModuleTypeSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = (qs.filter(name__icontains=s)
                      | qs.filter(part_number__icontains=s))
            mfr = self.request.query_params.get("manufacturer")
            if mfr:
                qs = qs.filter(manufacturer_id=mfr)
        return restrict_for_view(self, qs)

    def perform_create(self, serializer):
        serializer.save(tenant=self._tenant_or_403())


class ModuleInterfaceTemplateViewSet(TenantScopedViewSet):
    """Interface templates on a MODULE type — scope via module_type.tenant;
    filter with ?module_type=."""

    queryset = ModuleInterfaceTemplate.objects.select_related("module_type").order_by("name")
    serializer_class = ModuleInterfaceTemplateSerializer
    pagination_class = StandardPagination
    tenant_field = None

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return self.queryset.none()
        qs = self.queryset.filter(module_type__tenant=tenant)
        if self.request:
            mt = self.request.query_params.get("module_type")
            if mt:
                qs = qs.filter(module_type_id=mt)
        return restrict_for_view(self, qs)

    def _check(self, serializer):
        tenant = self._tenant_or_403()
        mt = serializer.validated_data.get("module_type") or (
            serializer.instance.module_type if serializer.instance else None
        )
        if mt is None or mt.tenant_id != tenant.id:
            raise ValidationError(
                {"module_type_id": "Pick a module type in the current tenant."}
            )

    def perform_create(self, serializer):
        self._check(serializer)
        serializer.save()

    def perform_update(self, serializer):
        self._check(serializer)
        serializer.save()


class ModuleBayViewSet(_DevicePortViewSet):
    queryset = (
        ModuleBay.objects.select_related("device")
        .prefetch_related("tags", "module__module_type")
        .order_by("device__name", "name")
    )
    serializer_class = ModuleBaySerializer


class ModuleViewSet(TenantScopedViewSet):
    """Installed modules. Creating one stamps the module type's interfaces
    onto the host device; deleting removes them again (by rendered name)."""

    queryset = (
        Module.objects.select_related(
            "device", "module_bay", "module_type"
        ).prefetch_related("tags").order_by("device__name", "module_bay__name")
    )
    serializer_class = ModuleSerializer
    pagination_class = StandardPagination
    tenant_field = None

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return self.queryset.none()
        qs = self.queryset.filter(device__tenant=tenant)
        if self.request:
            device = self.request.query_params.get("device")
            if device:
                qs = qs.filter(device_id=device)
        return restrict_for_view(self, qs)

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        device = serializer.validated_data.get("device")
        if device is None or device.tenant_id != tenant.id:
            raise ValidationError(
                {"device_id": "Pick a device in the current tenant."}
            )
        serializer.save()
        # Stamp the module's interfaces onto the host device.
        self._created_interfaces = install_module(serializer.instance)

    def create(self, request, *args, **kwargs):
        resp = super().create(request, *args, **kwargs)
        if resp.status_code == 201:
            resp.data["created_interfaces"] = getattr(
                self, "_created_interfaces", 0
            )
        return resp

    def perform_destroy(self, instance):
        uninstall_module(instance)
        instance.delete()


class ConsoleServerPortTemplateViewSet(_ComponentTemplateViewSet):
    queryset = ConsoleServerPortTemplate.objects.select_related("device_type").order_by("name")
    serializer_class = ConsoleServerPortTemplateSerializer


class PowerPortTemplateViewSet(_ComponentTemplateViewSet):
    queryset = PowerPortTemplate.objects.select_related("device_type").order_by("name")
    serializer_class = PowerPortTemplateSerializer


class PowerOutletTemplateViewSet(_ComponentTemplateViewSet):
    queryset = (
        PowerOutletTemplate.objects
        .select_related("device_type", "power_port_template").order_by("name")
    )
    serializer_class = PowerOutletTemplateSerializer


class RearPortTemplateViewSet(_ComponentTemplateViewSet):
    queryset = RearPortTemplate.objects.select_related("device_type").order_by("name")
    serializer_class = RearPortTemplateSerializer


class FrontPortTemplateViewSet(_ComponentTemplateViewSet):
    queryset = (
        FrontPortTemplate.objects
        .select_related("device_type", "rear_port_template").order_by("name")
    )
    serializer_class = FrontPortTemplateSerializer


# ─── Virtualization ──────────────────────────────────────────────────────────
class _SlugCatalogViewSet(TenantScopedViewSet):
    """Shared create/update slug handling for the simple cluster catalogs."""

    pagination_class = StandardPagination
    model = None
    count_rel = None  # related_name to count for the *_count field

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(
                    description__icontains=s
                )
        return qs.annotate(
            cluster_count_annotated=Count(self.count_rel)
        ).order_by("name")

    def _slug(self, serializer, tenant):
        data = serializer.validated_data
        name = data.get("name") or (
            serializer.instance.name if serializer.instance else ""
        )
        slug = data.get("slug") or slugify(name)
        data["slug"] = slug
        clash = self.model.objects.filter(tenant=tenant, slug=slug)
        if serializer.instance is not None:
            clash = clash.exclude(pk=serializer.instance.pk)
        if clash.exists():
            raise ValidationError({"slug": "Name already in use."})

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        self._slug(serializer, tenant)
        serializer.save(tenant=tenant)

    def perform_update(self, serializer):
        self._slug(serializer, self._tenant_or_403())
        serializer.save()

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = getattr(obj, self.count_rel).count()
        if n:
            return Response(
                {"detail": f"{n} cluster{'s' if n != 1 else ''} use this — "
                           "reassign or delete them first."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


class ClusterTypeViewSet(_SlugCatalogViewSet):
    queryset = ClusterType.objects.all().order_by("name")
    serializer_class = ClusterTypeSerializer
    model = ClusterType
    count_rel = "clusters"

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return ClusterTypeMiniSerializer
        return ClusterTypeSerializer


class ClusterGroupViewSet(_SlugCatalogViewSet):
    queryset = ClusterGroup.objects.all().order_by("name")
    serializer_class = ClusterGroupSerializer
    model = ClusterGroup
    count_rel = "clusters"

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return ClusterGroupMiniSerializer
        return ClusterGroupSerializer


class ClusterViewSet(TenantScopedViewSet):
    queryset = Cluster.objects.all().order_by("name")
    serializer_class = ClusterSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            from .serializers import ClusterMiniSerializer
            return ClusterMiniSerializer
        return ClusterSerializer

    def get_queryset(self):
        qs = (
            super()
            .get_queryset()
            .select_related("type", "group", "site")
            .prefetch_related("tags")
            .annotate(vm_count_annotated=Count("virtual_machines"))
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(
                    description__icontains=s
                )
        if self.request:
            ctype = self.request.query_params.get("type")
            if ctype:
                qs = qs.filter(type_id=ctype)
            group = self.request.query_params.get("group")
            if group:
                qs = qs.filter(group_id=group)
        return restrict_for_view(self, qs)

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.virtual_machines.count()
        if n:
            return Response(
                {"detail": f"{n} virtual machine{'s' if n != 1 else ''} run on "
                           "this cluster — reassign or delete them first."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


class VirtualMachineViewSet(CloneableMixin, TenantScopedViewSet):
    queryset = VirtualMachine.objects.all().order_by("name")
    serializer_class = VirtualMachineSerializer
    pagination_class = StandardPagination
    # Name + primary IP are identity; carry placement + sizing.
    clone_fields = (
        "cluster", "role", "platform", "device", "site", "status",
        "vcpus", "memory_mb", "disk_gb", "description",
    )

    @action(detail=True, methods=["get"], url_path="config-context")
    def config_context(self, request, pk=None):
        from .config_context import render_config_context

        return Response(render_config_context(self.get_object()))

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return VirtualMachineMiniSerializer
        return VirtualMachineSerializer

    def get_queryset(self):
        qs = (
            super()
            .get_queryset()
            .select_related("cluster", "device", "site", "primary_ip")
            .prefetch_related("tags")
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(
                    description__icontains=s
                )
            cluster = self.request.query_params.get("cluster")
            if cluster:
                qs = qs.filter(cluster_id=cluster)
            for k, f in (("role", "role_id"), ("platform", "platform_id")):
                v = self.request.query_params.get(k)
                if v:
                    qs = qs.filter(**{f: v})
        return qs


class VMInterfaceViewSet(ComponentBulkMixin, TenantScopedViewSet):
    queryset = VMInterface.objects.all().order_by("name")
    serializer_class = VMInterfaceSerializer
    pagination_class = StandardPagination
    # Tenant is reached through the VM (VMInterface has no direct tenant FK).
    tenant_field = "vm__tenant"
    bulk_str_fields = ("mode", "description")
    bulk_bool_fields = ("enabled",)
    bulk_int_fields = ("mtu",)
    bulk_fk_fields = {"vlan_id": VLAN, "vrf_id": VRF}
    bulk_tags = True

    def perform_create(self, serializer):
        # VM is supplied in the payload; tenant is implied by it. Just save.
        serializer.save()

    def get_queryset(self):
        qs = (
            super()
            .get_queryset()
            .select_related("vm")
            .prefetch_related("tags", "ip_addresses")
        )
        if self.request:
            vm = self.request.query_params.get("vm")
            if vm:
                qs = qs.filter(vm_id=vm)
        return qs


# ─── Racks ───────────────────────────────────────────────────────────────────
class RackRoleViewSet(_SlugCatalogViewSet):
    queryset = RackRole.objects.all().order_by("name")
    serializer_class = RackRoleSerializer
    model = RackRole
    count_rel = "racks"

    def get_queryset(self):
        qs = TenantScopedViewSet.get_queryset(self)
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
        from django.db.models import Count as _C
        return qs.annotate(rack_count_annotated=_C("racks")).order_by("name")

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return RackRoleMiniSerializer
        return RackRoleSerializer

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.racks.count()
        if n:
            return Response(
                {"detail": f"{n} rack{'s' if n != 1 else ''} use this role."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return TenantScopedViewSet.destroy(self, request, *args, **kwargs)


class RackViewSet(ImageAttachmentMixin, TenantScopedViewSet):
    queryset = Rack.objects.all().order_by("site__name", "name")
    serializer_class = RackSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            from .serializers import RackMiniSerializer
            return RackMiniSerializer
        return RackSerializer

    def get_queryset(self):
        qs = (
            super().get_queryset()
            .select_related("site", "role", "location")
            .prefetch_related(
                "tags", "devices__device_type",
                "devices__power_ports", "power_feeds",
            )
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(facility_id__icontains=s)
            site = self.request.query_params.get("site")
            if site:
                qs = qs.filter(site_id=site)
            location = self.request.query_params.get("location")
            if location:
                qs = qs.filter(location_id=location)
            role = self.request.query_params.get("role")
            if role:
                qs = qs.filter(role_id=role)
        return qs

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.devices.count()
        if n:
            return Response(
                {"detail": f"{n} device{'s' if n != 1 else ''} are racked here — "
                           "remove them first."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


# ─── Device roles + platforms ────────────────────────────────────────────────
class DeviceRoleViewSet(TenantScopedViewSet):
    queryset = DeviceRole.objects.all().order_by("name")
    serializer_class = DeviceRoleSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            from .serializers import DeviceRoleMiniSerializer
            return DeviceRoleMiniSerializer
        return DeviceRoleSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
        return qs

    def _slug(self, serializer, tenant):
        data = serializer.validated_data
        name = data.get("name") or (serializer.instance.name if serializer.instance else "")
        slug = data.get("slug") or slugify(name)
        data["slug"] = slug
        clash = DeviceRole.objects.filter(tenant=tenant, slug=slug)
        if serializer.instance is not None:
            clash = clash.exclude(pk=serializer.instance.pk)
        if clash.exists():
            raise ValidationError({"slug": "Name already in use."})

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        self._slug(serializer, tenant)
        serializer.save(tenant=tenant)

    def perform_update(self, serializer):
        self._slug(serializer, self._tenant_or_403())
        serializer.save()

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.devices.count() + obj.virtual_machines.count()
        if n:
            return Response(
                {"detail": f"{n} object{'s' if n != 1 else ''} use this role."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


class PlatformViewSet(DeviceRoleViewSet):
    queryset = Platform.objects.all().order_by("name")
    serializer_class = PlatformSerializer

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            from .serializers import PlatformMiniSerializer
            return PlatformMiniSerializer
        return PlatformSerializer

    def get_queryset(self):
        qs = TenantScopedViewSet.get_queryset(self).select_related("manufacturer")
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
            lc = self.request.query_params.get("lifecycle")
            if lc:
                qs = _apply_lifecycle_filter(qs, lc)
        return qs.order_by("name")

    def _slug(self, serializer, tenant):
        data = serializer.validated_data
        name = data.get("name") or (serializer.instance.name if serializer.instance else "")
        slug = data.get("slug") or slugify(name)
        data["slug"] = slug
        clash = Platform.objects.filter(tenant=tenant, slug=slug)
        if serializer.instance is not None:
            clash = clash.exclude(pk=serializer.instance.pk)
        if clash.exists():
            raise ValidationError({"slug": "Name already in use."})

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.devices.count() + obj.virtual_machines.count()
        if n:
            return Response(
                {"detail": f"{n} object{'s' if n != 1 else ''} use this platform."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return TenantScopedViewSet.destroy(self, request, *args, **kwargs)


# ─── Services ────────────────────────────────────────────────────────────────
class ServiceViewSet(TenantScopedViewSet):
    queryset = Service.objects.all().order_by("name")
    serializer_class = ServiceSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = (
            super().get_queryset()
            .select_related("device", "virtual_machine", "ip_address")
            .prefetch_related("tags", "check_assignments")
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
            for key, field in (("device", "device_id"), ("vm", "virtual_machine_id")):
                v = self.request.query_params.get(key)
                if v:
                    qs = qs.filter(**{field: v})
        return qs

    def perform_create(self, serializer):
        super().perform_create(serializer)
        self._reconcile(serializer.instance)

    def perform_update(self, serializer):
        super().perform_update(serializer)
        self._reconcile(serializer.instance)

    def _reconcile(self, svc):
        """Keep the service's monitoring checks in step with its ``monitored``
        flag / ports / IP after any write."""
        from monitoring.service_checks import sync_service_checks

        sync_service_checks(svc, created_by=self.request.user)

    @action(detail=True, methods=["post"], url_path="monitor")
    def monitor(self, request, pk=None):
        """Turn on monitoring for the service and reconcile its checks — a
        convenience alias for ``PATCH {monitored: true}``. Kept for backward
        compatibility; the Services tab uses the flag directly."""
        from monitoring.service_checks import sync_service_checks

        svc = self.get_object()
        if not svc.monitored:
            svc.monitored = True
            svc.save(update_fields=["monitored", "updated_at"])
        result = sync_service_checks(svc, created_by=request.user)
        if result["ip"] is None:
            return Response(
                {"detail": "No IP to monitor — set the service's IP or a "
                           "primary IP on its device / VM."},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )
        return Response(result)


# ─── Service templates (reusable service definitions) ────────────────────────
class ServiceTemplateViewSet(TenantScopedViewSet):
    queryset = ServiceTemplate.objects.all().order_by("name")
    serializer_class = ServiceTemplateSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            from .serializers import ServiceTemplateMiniSerializer
            return ServiceTemplateMiniSerializer
        return ServiceTemplateSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
        return qs

    def _slug(self, serializer, tenant):
        data = serializer.validated_data
        name = data.get("name") or (serializer.instance.name if serializer.instance else "")
        slug = data.get("slug") or slugify(name)
        data["slug"] = slug
        clash = ServiceTemplate.objects.filter(tenant=tenant, slug=slug)
        if serializer.instance is not None:
            clash = clash.exclude(pk=serializer.instance.pk)
        if clash.exists():
            raise ValidationError({"slug": "Name already in use."})

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        self._slug(serializer, tenant)
        serializer.save(tenant=tenant)

    def perform_update(self, serializer):
        self._slug(serializer, self._tenant_or_403())
        serializer.save()


class IPRangeViewSet(TenantScopedViewSet):
    """CRUD for IP ranges, plus an ``available`` action that lists the free
    addresses inside the span (those not already registered as IPs in the
    same tenant + VRF)."""

    queryset = IPRange.objects.all()
    serializer_class = IPRangeSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = (
            super()
            .get_queryset()
            .select_related("vrf", "role", "prefix")
            .prefetch_related("tags")
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = (
                    qs.filter(start_address__icontains=s)
                    | qs.filter(end_address__icontains=s)
                    | qs.filter(description__icontains=s)
                )
            for key, field in (
                ("vrf", "vrf_id"),
                ("status", "status"),
                ("role", "role_id"),
                ("prefix", "prefix_id"),
            ):
                v = self.request.query_params.get(key)
                if v:
                    qs = qs.filter(**{field: v})
        return qs

    @action(detail=True, methods=["get"], url_path="available")
    def available(self, request, pk=None):
        """List addresses in the range not yet recorded as IPs.

        Enumeration is capped (large/IPv6 ranges) — ``truncated`` flags when
        the list was cut short. ``size`` / ``used`` give the full accounting.
        """
        import ipaddress as ip

        LIMIT = 256
        rng = self.get_object()
        s, e = rng._start_ip, rng._end_ip
        if s is None or e is None or s.version != e.version or int(e) < int(s):
            return Response(
                {"detail": "Range has malformed start/end addresses."},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )
        total = int(e) - int(s) + 1
        # Used = IPs in the same tenant+VRF whose address falls in the span.
        used_set = set()
        for row in (
            IPAddress.objects
            .filter(tenant_id=rng.tenant_id, vrf_id=rng.vrf_id)
            .only("ip_address")
        ):
            try:
                a = ip.ip_address(row.ip_address)
            except ValueError:
                continue
            if a.version == s.version and int(s) <= int(a) <= int(e):
                used_set.add(int(a))
        out = []
        cur = int(s)
        while cur <= int(e) and len(out) < LIMIT:
            if cur not in used_set:
                out.append(str(ip.ip_address(cur)))
            cur += 1
        return Response({
            "size": total,
            "used": len(used_set),
            "available": max(0, total - len(used_set)),
            "results": out,
            "truncated": cur <= int(e),
        })


# ─── RIRs + Aggregates ───────────────────────────────────────────────────────
class RIRViewSet(TenantScopedViewSet):
    queryset = RIR.objects.all().order_by("name")
    serializer_class = RIRSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return RIRMiniSerializer
        return RIRSerializer

    def get_queryset(self):
        qs = super().get_queryset().annotate(
            aggregate_count_annotated=Count("aggregates")
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
        return qs.order_by("name")

    def _slug(self, serializer, tenant):
        data = serializer.validated_data
        name = data.get("name") or (serializer.instance.name if serializer.instance else "")
        slug = data.get("slug") or slugify(name)
        data["slug"] = slug
        clash = RIR.objects.filter(tenant=tenant, slug=slug)
        if serializer.instance is not None:
            clash = clash.exclude(pk=serializer.instance.pk)
        if clash.exists():
            raise ValidationError({"slug": "Name already in use."})

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        self._slug(serializer, tenant)
        serializer.save(tenant=tenant)

    def perform_update(self, serializer):
        self._slug(serializer, self._tenant_or_403())
        serializer.save()

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.aggregates.count()
        if n:
            return Response(
                {"detail": f"{n} aggregate{'s' if n != 1 else ''} reference this "
                           "RIR — reassign or delete them first."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


class AggregateViewSet(TenantScopedViewSet):
    queryset = Aggregate.objects.all()
    serializer_class = AggregateSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = (
            super()
            .get_queryset()
            .select_related("rir")
            .prefetch_related("tags")
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(prefix__icontains=s) | qs.filter(description__icontains=s)
            rir = self.request.query_params.get("rir")
            if rir:
                qs = qs.filter(rir_id=rir)
        # Numeric address order (see PrefixViewSet) — the CharField `prefix`
        # otherwise sorts lexicographically.
        from django.db.models.expressions import RawSQL

        return qs.annotate(_net=RawSQL("prefix::inet", ())).order_by("_net")


# ─── ASNs ────────────────────────────────────────────────────────────────────
class ASNViewSet(TenantScopedViewSet):
    queryset = ASN.objects.all()
    serializer_class = ASNSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = (
            super()
            .get_queryset()
            .select_related("rir")
            .prefetch_related("tags", "sites")
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(description__icontains=s)
                if s.lstrip("asAS").isdigit():
                    qs = qs | super().get_queryset().filter(
                        asn=int(s.lstrip("asAS"))
                    )
            rir = self.request.query_params.get("rir")
            if rir:
                qs = qs.filter(rir_id=rir)
            site = self.request.query_params.get("site")
            if site:
                qs = qs.filter(sites__id=site)
        return qs.distinct()


# ─── VLAN groups ─────────────────────────────────────────────────────────────
class VLANGroupViewSet(TenantScopedViewSet):
    queryset = VLANGroup.objects.all().order_by("name")
    serializer_class = VLANGroupSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return VLANGroupMiniSerializer
        return VLANGroupSerializer

    def get_queryset(self):
        qs = (
            super()
            .get_queryset()
            .select_related("site", "cluster")
            .annotate(vlan_count_annotated=Count("vlans"))
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
            site = self.request.query_params.get("site")
            if site:
                qs = qs.filter(site_id=site)
        return qs.order_by("name")

    def _slug(self, serializer, tenant):
        data = serializer.validated_data
        name = data.get("name") or (serializer.instance.name if serializer.instance else "")
        slug = data.get("slug") or slugify(name)
        data["slug"] = slug
        clash = VLANGroup.objects.filter(tenant=tenant, slug=slug)
        if serializer.instance is not None:
            clash = clash.exclude(pk=serializer.instance.pk)
        if clash.exists():
            raise ValidationError({"slug": "Name already in use."})

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        self._slug(serializer, tenant)
        serializer.save(tenant=tenant)

    def perform_update(self, serializer):
        self._slug(serializer, self._tenant_or_403())
        serializer.save()

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.vlans.count()
        if n:
            return Response(
                {"detail": f"{n} VLAN{'s' if n != 1 else ''} belong to this "
                           "group — reassign or delete them first."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


# ─── FHRP groups ─────────────────────────────────────────────────────────────
class FHRPGroupViewSet(TenantScopedViewSet):
    queryset = FHRPGroup.objects.all()
    serializer_class = FHRPGroupSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = (
            super()
            .get_queryset()
            .select_related("virtual_ip")
            .prefetch_related(
                "tags",
                "assignments__interface__device",
                "assignments__vm_interface__vm",
            )
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
                if s.isdigit():
                    qs = qs | super().get_queryset().filter(group_id=int(s))
            proto = self.request.query_params.get("protocol")
            if proto:
                qs = qs.filter(protocol=proto)
        return qs.distinct()


class FHRPGroupAssignmentViewSet(TenantScopedViewSet):
    """Bind/unbind interfaces to an FHRP group. Tenant is reached through the
    group (no direct tenant FK on the assignment)."""

    queryset = FHRPGroupAssignment.objects.all()
    serializer_class = FHRPGroupAssignmentSerializer
    pagination_class = StandardPagination
    tenant_field = "fhrp_group__tenant"

    def perform_create(self, serializer):
        # Group carries the tenant; just save.
        serializer.save()

    def get_queryset(self):
        qs = (
            super()
            .get_queryset()
            .select_related("interface__device", "vm_interface__vm", "fhrp_group")
        )
        if self.request:
            g = self.request.query_params.get("fhrp_group")
            if g:
                qs = qs.filter(fhrp_group_id=g)
        return qs


# ─── Contacts ────────────────────────────────────────────────────────────────
class _ContactCatalogViewSet(TenantScopedViewSet):
    """Shared slug-catalog handling for ContactGroup / ContactRole."""

    pagination_class = StandardPagination
    model = None
    picker_serializer = None

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return self.picker_serializer
        return self.serializer_class

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
        return qs.order_by("name")

    def _slug(self, serializer, tenant):
        data = serializer.validated_data
        name = data.get("name") or (serializer.instance.name if serializer.instance else "")
        slug = data.get("slug") or slugify(name)
        data["slug"] = slug
        clash = self.model.objects.filter(tenant=tenant, slug=slug)
        if serializer.instance is not None:
            clash = clash.exclude(pk=serializer.instance.pk)
        if clash.exists():
            raise ValidationError({"slug": "Name already in use."})

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        self._slug(serializer, tenant)
        serializer.save(tenant=tenant)

    def perform_update(self, serializer):
        self._slug(serializer, self._tenant_or_403())
        serializer.save()


class ContactGroupViewSet(_ContactCatalogViewSet):
    queryset = ContactGroup.objects.all().order_by("name")
    serializer_class = ContactGroupSerializer
    picker_serializer = ContactGroupMiniSerializer
    model = ContactGroup

    def get_queryset(self):
        return super().get_queryset().annotate(
            contact_count_annotated=Count("contacts")
        )

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.contacts.count()
        if n:
            return Response(
                {"detail": f"{n} contact{'s' if n != 1 else ''} belong to this "
                           "group — reassign or delete them first."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


class ContactRoleViewSet(_ContactCatalogViewSet):
    queryset = ContactRole.objects.all().order_by("name")
    serializer_class = ContactRoleSerializer
    picker_serializer = ContactRoleMiniSerializer
    model = ContactRole

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.assignments.count()
        if n:
            return Response(
                {"detail": f"{n} assignment{'s' if n != 1 else ''} use this "
                           "role — reassign them first."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


class ContactViewSet(TenantScopedViewSet):
    queryset = Contact.objects.all().order_by("name")
    serializer_class = ContactSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return ContactMiniSerializer
        return ContactSerializer

    def get_queryset(self):
        qs = (
            super()
            .get_queryset()
            .select_related("group")
            .prefetch_related("tags")
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = (
                    qs.filter(name__icontains=s)
                    | qs.filter(title__icontains=s)
                    | qs.filter(email__icontains=s)
                )
            group = self.request.query_params.get("group")
            if group:
                qs = qs.filter(group_id=group)
        return qs


class ContactAssignmentViewSet(TenantScopedViewSet):
    """Attach/detach contacts to any object. Filter by ``object_type`` +
    ``object_id`` to fetch the contacts on one object's detail page."""

    queryset = ContactAssignment.objects.all()
    serializer_class = ContactAssignmentSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = (
            super()
            .get_queryset()
            .select_related("contact", "role")
        )
        if self.request:
            ot = self.request.query_params.get("object_type")
            oid = self.request.query_params.get("object_id")
            if ot:
                qs = qs.filter(object_type=ot)
            if oid:
                qs = qs.filter(object_id=oid)
            contact = self.request.query_params.get("contact")
            if contact:
                qs = qs.filter(contact_id=contact)
        return qs

    def _check_target(self, serializer):
        """The generic (object_type, object_id) target must belong to the
        active tenant — otherwise a tenant could attach a contact to another
        tenant's object (issue #59 cross-tenant reference)."""
        from django.apps import apps

        ot = serializer.validated_data.get("object_type") or (
            serializer.instance.object_type if serializer.instance else None
        )
        oid = serializer.validated_data.get("object_id") or (
            serializer.instance.object_id if serializer.instance else None
        )
        if not ot or not oid:
            return
        tenant = self._tenant_or_403()
        if ot == "core.tenant":
            if str(oid) != str(tenant.id):
                raise ValidationError({"object_id": "Not found in this tenant."})
            return
        try:
            model = apps.get_model(*ot.split("."))
        except (LookupError, ValueError):
            raise ValidationError({"object_type": "Unknown object type."})
        if not model.objects.filter(pk=oid, tenant=tenant).exists():
            raise ValidationError({"object_id": "Not found in this tenant."})

    def perform_create(self, serializer):
        self._check_target(serializer)
        super().perform_create(serializer)

    def perform_update(self, serializer):
        self._check_target(serializer)
        super().perform_update(serializer)


# ─── Circuits ────────────────────────────────────────────────────────────────
class ProviderViewSet(TenantScopedViewSet):
    queryset = Provider.objects.all().order_by("name")
    serializer_class = ProviderSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return ProviderMiniSerializer
        return ProviderSerializer

    def get_queryset(self):
        qs = super().get_queryset().prefetch_related("tags").annotate(
            circuit_count_annotated=Count("circuits")
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = (
                    qs.filter(name__icontains=s)
                    | qs.filter(account__icontains=s)
                    | qs.filter(noc_email__icontains=s)
                )
        return qs.order_by("name")

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.circuits.count()
        if n:
            return Response(
                {"detail": f"{n} circuit{'s' if n != 1 else ''} belong to this "
                           "provider — delete them first."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


class CircuitTypeViewSet(TenantScopedViewSet):
    queryset = CircuitType.objects.all().order_by("name")
    serializer_class = CircuitTypeSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return CircuitTypeMiniSerializer
        return CircuitTypeSerializer

    def get_queryset(self):
        qs = super().get_queryset().annotate(
            circuit_count_annotated=Count("circuits")
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
        return qs.order_by("name")

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.circuits.count()
        if n:
            return Response(
                {"detail": f"{n} circuit{'s' if n != 1 else ''} use this type — "
                           "reassign them first."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


class CircuitViewSet(TenantScopedViewSet):
    queryset = Circuit.objects.all().order_by("cid")
    serializer_class = CircuitSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = (
            super()
            .get_queryset()
            .select_related("provider", "type")
            .prefetch_related(
                "tags", "terminations__site", "terminations__provider_network"
            )
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(cid__icontains=s) | qs.filter(description__icontains=s)
            for param, field in (
                ("provider", "provider_id"),
                ("type", "type_id"),
                ("status", "status"),
            ):
                val = self.request.query_params.get(param)
                if val:
                    qs = qs.filter(**{field: val})
        return qs


class ProviderNetworkViewSet(TenantScopedViewSet):
    queryset = (
        ProviderNetwork.objects.select_related("provider")
        .prefetch_related("tags").order_by("name")
    )
    serializer_class = ProviderNetworkSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(service_id__icontains=s)
            provider = self.request.query_params.get("provider")
            if provider:
                qs = qs.filter(provider_id=provider)
        return qs


class CircuitTerminationViewSet(TenantScopedViewSet):
    """A/Z ends of circuits — no direct tenant FK; scoped via circuit.tenant.
    Filter with ?circuit=."""

    queryset = (
        CircuitTermination.objects
        .select_related("circuit", "site", "provider_network")
        .order_by("term_side")
    )
    serializer_class = CircuitTerminationSerializer
    pagination_class = StandardPagination
    tenant_field = None

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return self.queryset.none()
        qs = self.queryset.filter(circuit__tenant=tenant)
        if self.request:
            circuit = self.request.query_params.get("circuit")
            if circuit:
                qs = qs.filter(circuit_id=circuit)
        return qs

    def _check(self, serializer):
        tenant = self._tenant_or_403()
        circuit = serializer.validated_data.get("circuit") or (
            serializer.instance.circuit if serializer.instance else None
        )
        if circuit is None or circuit.tenant_id != tenant.id:
            raise ValidationError(
                {"circuit_id": "Pick a circuit in the current tenant."}
            )
        side = serializer.validated_data.get("term_side") or (
            serializer.instance.term_side if serializer.instance else ""
        )
        clash = CircuitTermination.objects.filter(circuit=circuit, term_side=side)
        if serializer.instance is not None:
            clash = clash.exclude(pk=serializer.instance.pk)
        if clash.exists():
            raise ValidationError(
                {"term_side": f"This circuit already has a {side} termination."}
            )

    def perform_create(self, serializer):
        self._check(serializer)
        serializer.save()

    def perform_update(self, serializer):
        self._check(serializer)
        serializer.save()


# ─── Power ───────────────────────────────────────────────────────────────────
class PowerPanelViewSet(TenantScopedViewSet):
    queryset = PowerPanel.objects.all().order_by("name")
    serializer_class = PowerPanelSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return PowerPanelMiniSerializer
        return PowerPanelSerializer

    def get_queryset(self):
        qs = super().get_queryset().select_related("site").prefetch_related(
            "tags"
        ).annotate(feed_count_annotated=Count("power_feeds"))
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s)
            site = self.request.query_params.get("site")
            if site:
                qs = qs.filter(site_id=site)
        return qs.order_by("name")

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.power_feeds.count()
        if n:
            return Response(
                {"detail": f"{n} feed{'s' if n != 1 else ''} draw from this "
                           "panel — delete them first."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


class PowerFeedViewSet(TenantScopedViewSet):
    queryset = PowerFeed.objects.all().order_by("name")
    serializer_class = PowerFeedSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = (
            super()
            .get_queryset()
            .select_related("power_panel", "rack")
            .prefetch_related("tags")
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s)
            for param, field in (
                ("power_panel", "power_panel_id"),
                ("rack", "rack_id"),
                ("status", "status"),
            ):
                val = self.request.query_params.get(param)
                if val:
                    qs = qs.filter(**{field: val})
        return qs


# ─── Wireless ────────────────────────────────────────────────────────────────
class WirelessLANGroupViewSet(TenantScopedViewSet):
    queryset = WirelessLANGroup.objects.all().order_by("name")
    serializer_class = WirelessLANGroupSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return WirelessLANGroupMiniSerializer
        return WirelessLANGroupSerializer

    def get_queryset(self):
        qs = super().get_queryset().annotate(
            wlan_count_annotated=Count("wireless_lans")
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
        return qs.order_by("name")

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.wireless_lans.count()
        if n:
            return Response(
                {"detail": f"{n} wireless LAN{'s' if n != 1 else ''} use this "
                           "group — reassign them first."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


class WirelessLANViewSet(TenantScopedViewSet):
    queryset = WirelessLAN.objects.all().order_by("ssid")
    serializer_class = WirelessLANSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = (
            super()
            .get_queryset()
            .select_related("group", "vlan")
            .prefetch_related("tags")
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(ssid__icontains=s) | qs.filter(description__icontains=s)
            for param, field in (
                ("group", "group_id"),
                ("status", "status"),
                ("vlan", "vlan_id"),
            ):
                val = self.request.query_params.get(param)
                if val:
                    qs = qs.filter(**{field: val})
        return qs


# ─── VPN ─────────────────────────────────────────────────────────────────────
class TunnelGroupViewSet(TenantScopedViewSet):
    queryset = TunnelGroup.objects.all().order_by("name")
    serializer_class = TunnelGroupSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return TunnelGroupMiniSerializer
        return TunnelGroupSerializer

    def get_queryset(self):
        qs = super().get_queryset().annotate(
            tunnel_count_annotated=Count("tunnels")
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
        return qs.order_by("name")

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.tunnels.count()
        if n:
            return Response(
                {"detail": f"{n} tunnel{'s' if n != 1 else ''} use this group — "
                           "reassign them first."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


class IPSecProfileViewSet(TenantScopedViewSet):
    queryset = IPSecProfile.objects.all().order_by("name")
    serializer_class = IPSecProfileSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return IPSecProfileMiniSerializer
        return IPSecProfileSerializer

    def get_queryset(self):
        qs = super().get_queryset().annotate(
            tunnel_count_annotated=Count("tunnels")
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
        return qs.order_by("name")

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.tunnels.count()
        if n:
            return Response(
                {"detail": f"{n} tunnel{'s' if n != 1 else ''} use this profile "
                           "— reassign them first."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


class TunnelViewSet(TenantScopedViewSet):
    queryset = Tunnel.objects.all().order_by("name")
    serializer_class = TunnelSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = (
            super()
            .get_queryset()
            .select_related("group", "ipsec_profile")
            .prefetch_related("tags")
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
            for param, field in (
                ("group", "group_id"),
                ("status", "status"),
                ("encapsulation", "encapsulation"),
            ):
                val = self.request.query_params.get(param)
                if val:
                    qs = qs.filter(**{field: val})
            device = self.request.query_params.get("device")
            if device:
                qs = qs.filter(
                    terminations__interface__device_id=device
                ).distinct()
        return qs


class TunnelTerminationViewSet(TenantScopedViewSet):
    """Tunnel ends — no direct tenant FK; scoped via tunnel.tenant. Filter
    with ?tunnel=."""

    queryset = (
        TunnelTermination.objects
        .select_related(
            "tunnel", "interface__device", "vm_interface__vm", "outside_ip"
        )
        .order_by("created_at")
    )
    serializer_class = TunnelTerminationSerializer
    pagination_class = StandardPagination
    tenant_field = None

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return self.queryset.none()
        qs = self.queryset.filter(tunnel__tenant=tenant)
        if self.request:
            tunnel = self.request.query_params.get("tunnel")
            if tunnel:
                qs = qs.filter(tunnel_id=tunnel)
            device = self.request.query_params.get("device")
            if device:
                qs = qs.filter(interface__device_id=device)
        return qs

    def _check(self, serializer):
        tenant = self._tenant_or_403()
        tunnel = serializer.validated_data.get("tunnel") or (
            serializer.instance.tunnel if serializer.instance else None
        )
        if tunnel is None or tunnel.tenant_id != tenant.id:
            raise ValidationError({"tunnel_id": "Pick a tunnel in the current tenant."})
        iface = serializer.validated_data.get("interface")
        if iface is not None and iface.device.tenant_id != tenant.id:
            raise ValidationError({"interface_id": "Pick an interface in the current tenant."})
        vmi = serializer.validated_data.get("vm_interface")
        if vmi is not None and vmi.vm.tenant_id != tenant.id:
            raise ValidationError({"vm_interface_id": "Pick a VM interface in the current tenant."})

    def perform_create(self, serializer):
        self._check(serializer)
        serializer.save()

    def perform_update(self, serializer):
        self._check(serializer)
        serializer.save()


class L2VPNViewSet(TenantScopedViewSet):
    queryset = (
        L2VPN.objects
        .select_related("status")
        .prefetch_related(
            "import_targets", "export_targets", "tags",
            "terminations__vlan", "terminations__interface__device",
            "terminations__vm_interface__vm",
        )
        .order_by("name")
    )
    serializer_class = L2VPNSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            search = self.request.query_params.get("search", "").strip()
            if search:
                qs = (qs.filter(name__icontains=search)
                      | qs.filter(slug__icontains=search)
                      | qs.filter(description__icontains=search))
            t = self.request.query_params.get("type")
            if t:
                qs = qs.filter(type=t)
        return qs


class L2VPNTerminationViewSet(TenantScopedViewSet):
    """L2VPN attachments — no direct tenant FK; scoped via l2vpn.tenant.
    Filter with ?l2vpn=."""

    queryset = (
        L2VPNTermination.objects
        .select_related(
            "l2vpn", "vlan", "interface__device", "vm_interface__vm"
        )
        .order_by("created_at")
    )
    serializer_class = L2VPNTerminationSerializer
    pagination_class = StandardPagination
    tenant_field = None

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return self.queryset.none()
        qs = self.queryset.filter(l2vpn__tenant=tenant)
        if self.request:
            l2vpn = self.request.query_params.get("l2vpn")
            if l2vpn:
                qs = qs.filter(l2vpn_id=l2vpn)
        return qs

    def _check(self, serializer):
        tenant = self._tenant_or_403()
        l2vpn = serializer.validated_data.get("l2vpn") or (
            serializer.instance.l2vpn if serializer.instance else None
        )
        if l2vpn is None or l2vpn.tenant_id != tenant.id:
            raise ValidationError({"l2vpn_id": "Pick an L2VPN in the current tenant."})
        iface = serializer.validated_data.get("interface")
        if iface is not None and iface.device.tenant_id != tenant.id:
            raise ValidationError({"interface_id": "Pick an interface in the current tenant."})
        vmi = serializer.validated_data.get("vm_interface")
        if vmi is not None and vmi.vm.tenant_id != tenant.id:
            raise ValidationError({"vm_interface_id": "Pick a VM interface in the current tenant."})

    def perform_create(self, serializer):
        self._check(serializer)
        serializer.save()

    def perform_update(self, serializer):
        self._check(serializer)
        serializer.save()


class VirtualChassisViewSet(TenantScopedViewSet):
    queryset = (
        VirtualChassis.objects
        .select_related("master")
        .prefetch_related("members__status", "tags")
        .order_by("name")
    )
    serializer_class = VirtualChassisSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            search = self.request.query_params.get("search", "").strip()
            if search:
                qs = (qs.filter(name__icontains=search)
                      | qs.filter(domain__icontains=search)
                      | qs.filter(description__icontains=search))
        return qs

    def perform_destroy(self, instance):
        # Deleting a stack releases its members (SET_NULL on the FK) — also
        # clear their stale position/priority so they read as standalone.
        instance.members.update(vc_position=None, vc_priority=None)
        super().perform_destroy(instance)


# ─── Regions & Locations ─────────────────────────────────────────────────────
class RegionViewSet(TenantScopedViewSet):
    queryset = Region.objects.all().order_by("name")
    serializer_class = RegionSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return RegionMiniSerializer
        return RegionSerializer

    def get_queryset(self):
        qs = super().get_queryset().select_related("parent")
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
            parent = self.request.query_params.get("parent")
            if parent:
                qs = qs.filter(parent_id=parent)
        return qs.order_by("name")

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.children.count() + obj.sites.count()
        if n:
            return Response(
                {"detail": "This region still has sub-regions or sites — "
                           "reassign them first."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


class LocationViewSet(ImageAttachmentMixin, TenantScopedViewSet):
    queryset = Location.objects.all().order_by("site__name", "name")
    serializer_class = LocationSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return LocationMiniSerializer
        return LocationSerializer

    def get_queryset(self):
        qs = super().get_queryset().select_related("site", "parent")
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
            for param, field in (("site", "site_id"), ("parent", "parent_id"),
                                 ("status", "status")):
                val = self.request.query_params.get(param)
                if val:
                    qs = qs.filter(**{field: val})
        return qs

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        if obj.children.count():
            return Response(
                {"detail": "This location has sub-locations — delete them first."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


# ─── Config Contexts ─────────────────────────────────────────────────────────
class ConfigContextViewSet(TenantScopedViewSet):
    queryset = ConfigContext.objects.all().order_by("weight", "name")
    serializer_class = ConfigContextSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = super().get_queryset().prefetch_related(
            "regions", "sites", "device_roles", "platforms"
        )
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
        return qs.order_by("weight", "name")


# ─── Export templates ────────────────────────────────────────────────────────
class ExportTemplateViewSet(TenantScopedViewSet):
    queryset = ExportTemplate.objects.all().order_by("name")
    serializer_class = ExportTemplateSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
            ot = self.request.query_params.get("object_type")
            if ot:
                qs = qs.filter(object_type=ot)
        return qs

    def _render(self, request):
        from jinja2 import TemplateError

        from .export_templates import render_export_template
        from .views import _get_active_tenant

        tmpl = self.get_object()
        tenant = _get_active_tenant(request)
        try:
            return render_export_template(tmpl, tenant), tmpl
        except (ValueError, TemplateError) as exc:
            return None, exc

    @action(detail=True, methods=["get"])
    def preview(self, request, pk=None):
        """Render and return the text as JSON (for the editor preview pane)."""
        out, info = self._render(request)
        if out is None:
            return Response({"detail": str(info)}, status=drf_status.HTTP_400_BAD_REQUEST)
        return Response({"output": out})

    @action(detail=True, methods=["get"])
    def render(self, request, pk=None):
        """Render and return as a downloadable file."""
        from django.http import HttpResponse

        out, info = self._render(request)
        if out is None:
            return Response({"detail": str(info)}, status=drf_status.HTTP_400_BAD_REQUEST)
        tmpl = info
        resp = HttpResponse(out, content_type=tmpl.mime_type or "text/plain")
        if tmpl.as_attachment:
            ext = (tmpl.file_extension or "txt").lstrip(".")
            fname = f"{tmpl.name}.{ext}"
            resp["Content-Disposition"] = f'attachment; filename="{fname}"'
        return resp


# ─── Floor plans ─────────────────────────────────────────────────────────────
class FloorTileTypeViewSet(TenantScopedViewSet):
    """The user-created floor-tile palette. Ships empty — zero built-ins."""

    queryset = FloorTileType.objects.all().order_by("name")
    serializer_class = FloorTileTypeSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return FloorTileTypeMiniSerializer
        return FloorTileTypeSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
        return qs

    def _slug(self, serializer, tenant):
        data = serializer.validated_data
        name = data.get("name") or (serializer.instance.name if serializer.instance else "")
        slug = data.get("slug") or slugify(name)
        data["slug"] = slug
        clash = FloorTileType.objects.filter(tenant=tenant, slug=slug)
        if serializer.instance is not None:
            clash = clash.exclude(pk=serializer.instance.pk)
        if clash.exists():
            raise ValidationError({"slug": "Name already in use."})

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        self._slug(serializer, tenant)
        serializer.save(tenant=tenant)

    def perform_update(self, serializer):
        self._slug(serializer, self._tenant_or_403())
        serializer.save()

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.tiles.count()
        if n:
            return Response(
                {"detail": f"{n} placed tile{'s' if n != 1 else ''} use this type."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


class FloorPlanViewSet(TenantScopedViewSet):
    queryset = (
        FloorPlan.objects.select_related("location", "location__site")
        .prefetch_related("tags")
        .order_by("name")
    )
    serializer_class = FloorPlanSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return FloorPlanMiniSerializer
        return FloorPlanSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s)
            loc = self.request.query_params.get("location")
            if loc:
                qs = qs.filter(location_id=loc)
            site = self.request.query_params.get("site")
            if site:
                qs = qs.filter(location__site_id=site)
        return qs

    def perform_create(self, serializer):
        serializer.save(tenant=self._tenant_or_403())

    @action(detail=True, methods=["get"], url_path="state")
    def state(self, request, pk=None):
        """Live per-tile metrics for linked objects, keyed by tile id.

        Rack tiles → space (used_units/u_height), power rollup, and the worst
        monitoring status across the rack's devices' IPs; device tiles →
        object status + monitoring rollup. The canvas polls/refetches this to
        paint overlays without re-reading the whole plan."""
        from django.utils import timezone

        from monitoring.models import CheckState
        from monitoring.rollup import worst_status

        plan = self.get_object()
        tiles = list(
            plan.tiles.exclude(rack=None, device=None).select_related(
                "rack", "device__status"
            )
        )
        rack_ids = {t.rack_id for t in tiles if t.rack_id}
        racks = {
            r.id: r
            for r in Rack.objects.filter(id__in=rack_ids).prefetch_related(
                "devices__device_type", "power_feeds"
            )
        }

        # Monitoring rollup: device → its IPs' check states, worst wins;
        # a rack rolls up the worst across its racked devices.
        device_ids = {t.device_id for t in tiles if t.device_id}
        rack_devices: dict = {}
        for r in racks.values():
            rack_devices[r.id] = [d.id for d in r.devices.all()]
            device_ids.update(rack_devices[r.id])
        ip_to_device = dict(
            IPAddress.objects.filter(
                assigned_device_id__in=device_ids
            ).values_list("id", "assigned_device_id")
        )
        statuses_by_device: dict = {}
        for ip_id, st in CheckState.objects.filter(
            target_ip_id__in=ip_to_device
        ).values_list("target_ip_id", "status"):
            statuses_by_device.setdefault(ip_to_device[ip_id], []).append(st)

        def device_check(device_id):
            return worst_status(statuses_by_device.get(device_id, []))

        rs = RackSerializer()
        out = {}
        for t in tiles:
            if t.rack_id and t.rack_id in racks:
                rack = racks[t.rack_id]
                checks = [device_check(d) for d in rack_devices[rack.id]]
                out[str(t.id)] = {
                    "kind": "rack",
                    "used_units": rs.get_used_units(rack),
                    "u_height": rack.u_height,
                    "power": rs.get_power(rack),
                    "total_weight_kg": rs.get_total_weight_kg(rack),
                    "max_weight_kg": rs.get_max_weight_kg(rack),
                    "device_count": len(rack_devices[rack.id]),
                    "check": worst_status(s for s in checks if s),
                }
            elif t.device_id and t.device is not None:
                out[str(t.id)] = {
                    "kind": "device",
                    "status": t.device.status.name if t.device.status else None,
                    "check": device_check(t.device_id),
                }
        return Response({"as_of": timezone.now().isoformat(), "tiles": out})

    @action(detail=True, methods=["get"], url_path="cable-paths")
    def cable_paths(self, request, pk=None):
        """Resolve each cable on this plan to its two endpoint tiles — a
        device-linked tile, else the device's rack tile — so the canvas can
        draw the physical A↔B run. Includes cables routed through a tray here,
        AND any cable whose ends are both placed on the plan (drawn straight
        when it has no tray)."""
        from .models import Cable, CableTermination, Device

        plan = self.get_object()
        # tile lookups: device → tile, rack → tile (first placed wins).
        device_tile: dict = {}
        rack_tile: dict = {}
        for t in plan.tiles.all():
            if t.device_id:
                device_tile.setdefault(t.device_id, str(t.id))
            if t.rack_id:
                rack_tile.setdefault(t.rack_id, str(t.id))

        # Devices reachable on this plan: directly tiled, or in a tiled rack.
        placed_device_ids = set(device_tile)
        if rack_tile:
            placed_device_ids.update(
                Device.objects.filter(rack_id__in=rack_tile).values_list(
                    "id", flat=True
                )
            )
        # Cables to show: routed through a tray here, OR touching a placed
        # device (so a device↔device run shows even with no tray).
        touches_placed = Q()
        for field in CableTermination.POINT_FIELDS:
            if field == "power_feed":
                continue  # feeds aren't devices
            touches_placed |= Q(**{f"terminations__{field}__device_id__in": placed_device_ids})
        cables = (
            Cable.objects.filter(Q(trays__floor_plan=plan) | touches_placed)
            .distinct()
            .prefetch_related("terminations", "trays")
        )
        # Devices we may need a rack for (those not directly tiled).
        wanted_devices = set()
        term_cache = {}
        for cable in cables:
            terms = []
            for term in cable.terminations.all():
                point = term.point
                dev_id = getattr(point, "device_id", None)
                if dev_id is not None:
                    wanted_devices.add(dev_id)
                terms.append((term.end, dev_id))
            term_cache[cable.id] = terms
        device_rack = dict(
            Device.objects.filter(id__in=wanted_devices).values_list(
                "id", "rack_id"
            )
        )

        def tile_for(dev_id):
            if dev_id is None:
                return None
            if dev_id in device_tile:
                return device_tile[dev_id]
            rack_id = device_rack.get(dev_id)
            return rack_tile.get(rack_id) if rack_id else None

        result = []
        for cable in cables:
            a_tiles, b_tiles = [], []
            for end, dev_id in term_cache[cable.id]:
                tile_id = tile_for(dev_id)
                if tile_id is None:
                    continue
                (a_tiles if end == "A" else b_tiles).append(tile_id)
            result.append(
                {
                    "id": str(cable.id),
                    "label": str(cable),
                    "color": cable.color,
                    "type": cable.type,
                    "a_tiles": list(dict.fromkeys(a_tiles)),
                    "b_tiles": list(dict.fromkeys(b_tiles)),
                    "tray_ids": [
                        str(tr.id)
                        for tr in cable.trays.all()
                        if tr.floor_plan_id == plan.id
                    ],
                }
            )
        return Response({"cables": result})

    @action(detail=True, methods=["post"], url_path="background",
            parser_classes=[MultiPartParser, FormParser])
    def background(self, request, pk=None):
        """Upload / clear the blueprint image (multipart). Send a
        `background_image` file to set, or `clear=1` to remove."""
        plan = self.get_object()
        if "background_image" in request.FILES:
            plan.background_image = request.FILES["background_image"]
        if request.data.get("clear"):
            plan.background_image = None
        plan.save()
        return Response(FloorPlanSerializer(plan, context={"request": request}).data)

    @action(detail=True, methods=["post"], url_path="tiles/bulk")
    def tiles_bulk(self, request, pk=None):
        """Apply many tile edits in one transaction — the editor mutates many
        tiles at once (drag several, paint a wall run). Payload
        ``{create: [...], update: [{id, ...}], delete: [ids]}`` → the fresh
        tile list. Deletes run first so a move-recreate can't collide."""
        plan = self.get_object()
        creates = request.data.get("create") or []
        updates = request.data.get("update") or []
        deletes = request.data.get("delete") or []
        if not isinstance(creates, list) or not isinstance(updates, list) \
                or not isinstance(deletes, list):
            raise ValidationError({"detail": "create/update/delete must be lists."})

        def _tile_or_none(tile_pk):
            from django.core.exceptions import ValidationError as DjangoValidationError
            try:
                return plan.tiles.filter(pk=tile_pk).first()
            except (DjangoValidationError, ValueError):  # malformed UUID → 400/skip
                return None

        with transaction.atomic():
            for pk_ in deletes:
                tile = _tile_or_none(pk_)
                if tile is not None:
                    tile.delete()
            for item in updates:
                if not isinstance(item, dict) or not item.get("id"):
                    raise ValidationError({"update": "Each update needs an id."})
                tile = _tile_or_none(item["id"])
                if tile is None:
                    raise ValidationError({"update": f"Unknown tile {item['id']}."})
                ser = FloorPlanTileSerializer(
                    tile, data=item, partial=True, context={"request": request}
                )
                ser.is_valid(raise_exception=True)
                ser.save()
            for item in creates:
                ser = FloorPlanTileSerializer(data=item, context={"request": request})
                ser.is_valid(raise_exception=True)
                ser.save(floor_plan=plan)
        tiles = plan.tiles.select_related(
            "tile_type", "role_type", "rack", "device",
            "power_panel", "power_feed", "linked_floor_plan",
        ).order_by("y", "x")
        return Response(
            FloorPlanTileSerializer(tiles, many=True, context={"request": request}).data
        )


class SiteMarkerViewSet(TenantScopedViewSet):
    """Free markers on the geographic Site map (tile-type / device-role
    vocabulary, like unlinked floor-plan tiles). Tenant-scoped; audited."""

    queryset = SiteMarker.objects.select_related(
        "tile_type", "role_type"
    ).order_by("label")
    serializer_class = SiteMarkerSerializer
    pagination_class = StandardPagination


class FloorPlanTileViewSet(TenantScopedViewSet):
    """Tiles are scoped through their plan's tenant (they carry no tenant FK
    themselves) — same shape as ModuleInterfaceTemplateViewSet."""

    queryset = FloorPlanTile.objects.select_related(
        "floor_plan", "tile_type", "role_type", "rack", "device",
        "power_panel", "power_feed", "linked_floor_plan",
    ).order_by("y", "x")
    serializer_class = FloorPlanTileSerializer
    pagination_class = StandardPagination
    tenant_field = None

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return self.queryset.none()
        qs = self.queryset.filter(floor_plan__tenant=tenant)
        if self.request:
            for param, field in (
                ("floor_plan", "floor_plan_id"),
                ("rack", "rack_id"),
                ("device", "device_id"),
            ):
                val = self.request.query_params.get(param)
                if val:
                    qs = qs.filter(**{field: val})
        return restrict_for_view(self, qs)

    def perform_create(self, serializer):
        if serializer.validated_data.get("floor_plan") is None:
            raise ValidationError({"floor_plan_id": "This field is required."})
        serializer.save()


class CableRouteViewSet(TenantScopedViewSet):
    """Geographic duct/aerial/trench runs on the site map."""

    queryset = CableRoute.objects.prefetch_related("cables").order_by("name")
    serializer_class = CableRouteSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            cable = self.request.query_params.get("cable")
            if cable:
                qs = qs.filter(cables__id=cable)
        return qs


class FloorPlanTrayViewSet(TenantScopedViewSet):
    """Tray/conduit runs — scoped through their plan's tenant, like tiles."""

    queryset = FloorPlanTray.objects.select_related("floor_plan").prefetch_related(
        "cables"
    ).order_by("name")
    serializer_class = FloorPlanTraySerializer
    pagination_class = StandardPagination
    tenant_field = None

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return self.queryset.none()
        qs = self.queryset.filter(floor_plan__tenant=tenant)
        if self.request:
            fp = self.request.query_params.get("floor_plan")
            if fp:
                qs = qs.filter(floor_plan_id=fp)
        return restrict_for_view(self, qs)

    def perform_create(self, serializer):
        if serializer.validated_data.get("floor_plan") is None:
            raise ValidationError({"floor_plan_id": "This field is required."})
        serializer.save()


class CableRouteViewSet(TenantScopedViewSet):
    """Geographic duct/aerial/trench runs on the site map."""

    queryset = CableRoute.objects.prefetch_related("cables").order_by("name")
    serializer_class = CableRouteSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            cable = self.request.query_params.get("cable")
            if cable:
                qs = qs.filter(cables__id=cable)
        return qs
