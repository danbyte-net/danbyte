"""Virtualization review inbox: pending changes from review/manual sources,
resolved by accept (apply) or ignore (dismiss)."""
from __future__ import annotations

from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response

from api.models import VRF, Location, Site
from api.serializers import TenantScopedPrimaryKeyRelatedField
from api.viewsets import TenantScopedViewSet

from .models import VirtChange, VirtNetwork, VirtPlacementRule
from .toggles import IntegrationToggleMixin


class VirtNetworkSerializer(serializers.ModelSerializer):
    """A synced hypervisor network (port-group / bridge) with the VLAN it maps
    to and the VMs currently attached — the switch→network→VM linkage that
    feeds the switch page and the virtual topology view."""

    vlan = serializers.SerializerMethodField()
    vms = serializers.SerializerMethodField()
    vswitch_name = serializers.CharField(
        source="vswitch.name", read_only=True, default=None
    )
    vrf_id = TenantScopedPrimaryKeyRelatedField(
        source="vrf", queryset=VRF.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    vrf = serializers.SerializerMethodField()

    def get_vrf(self, obj):
        """The routing context in force, and whether it was set here.

        A network that states nothing inherits its switch's VRF, so showing the
        bare field would read as "Global" when it is really "follow the
        switch". ``inherited`` is what lets the editor say which.
        """
        if obj.vrf_id:
            return {"id": str(obj.vrf_id), "name": obj.vrf.name,
                    "inherited": False}
        sw = obj.vswitch
        if sw is not None and sw.vrf_id:
            return {"id": str(sw.vrf_id), "name": sw.vrf.name,
                    "inherited": True}
        return None

    class Meta:
        model = VirtNetwork
        fields = ["id", "name", "ext_key", "vlan", "vswitch", "vswitch_name",
                  "vrf", "vrf_id", "vms", "last_seen_at"]
        # Everything else mirrors the hypervisor; the VRF is Danbyte's call.
        read_only_fields = [f for f in fields if f != "vrf_id"]

    def get_vlan(self, obj):
        if not obj.vlan_id:
            return None
        # Rail colour: the VLAN's own colour first, its zone's second (zones
        # carry firewall semantics but their colour is still meaningful),
        # frontend palette fallback when neither is set.
        zone = obj.vlan.zone
        return {"id": str(obj.vlan_id), "vlan_id": obj.vlan.vlan_id,
                "name": obj.vlan.name,
                "color": obj.vlan.color or (zone.color if zone else None)}

    def get_vms(self, obj):
        if not obj.vlan_id:
            return []
        from api.models import VMInterface

        seen: dict = {}
        for i in (
            VMInterface.objects.filter(vlan_id=obj.vlan_id)
            .select_related("vm", "vm__status")
        ):
            vm = i.vm
            if vm.id not in seen:
                seen[vm.id] = {
                    "id": str(vm.id), "name": vm.name,
                    "status": vm.status.name if vm.status_id else None,
                    # Which VM interface rides this network — the topology
                    # labels the connector leg with it.
                    "iface": i.name,
                }
        return list(seen.values())


class VirtNetworkViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """Synced networks; filter by ``?vswitch=`` or ``?source=``.

    Read-only except for the **VRF**: everything else mirrors the hypervisor,
    but which routing context a network's addresses belong to is Danbyte's
    call, so PATCH is allowed for that one field.
    """

    integration_keys = ("virtualization",)
    tenant_field = "source__tenant"
    http_method_names = ["get", "patch"]
    queryset = VirtNetwork.objects.select_related(
        "source", "vlan", "vlan__zone", "vswitch", "vrf", "vswitch__vrf"
    ).order_by("name", "ext_key")
    serializer_class = VirtNetworkSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        vs = self.request.query_params.get("vswitch")
        if vs:
            qs = qs.filter(vswitch_id=vs)
        src = self.request.query_params.get("source")
        if src:
            qs = qs.filter(source_id=src)
        return qs


class VirtChangeSerializer(serializers.ModelSerializer):
    kind_display = serializers.CharField(source="get_kind_display", read_only=True)
    source_name = serializers.CharField(source="source.name", read_only=True)
    vmid = serializers.IntegerField(source="guest.vmid", read_only=True)
    node = serializers.CharField(source="guest.node", read_only=True)
    vm_name = serializers.SerializerMethodField()

    def get_vm_name(self, obj):
        if obj.vm_id:
            return obj.vm.name
        return (obj.detail or {}).get("name", "")

    class Meta:
        model = VirtChange
        fields = ["id", "source", "source_name", "kind", "kind_display",
                  "vmid", "node", "vm", "vm_name", "detail", "ignored",
                  "last_seen_at"]
        read_only_fields = fields


class VirtChangeViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """Read + accept/ignore. Rows are only ever created by the sync engine."""

    integration_keys = ("virtualization",)
    tenant_field = "source__tenant"
    http_method_names = ["get", "post"]
    queryset = VirtChange.objects.select_related("source", "guest", "vm").order_by(
        "kind", "guest__vmid"
    )
    serializer_class = VirtChangeSerializer
    rbac_action_map = {"accept": "change", "ignore": "change"}

    def create(self, request, *args, **kwargs):
        from rest_framework.exceptions import MethodNotAllowed

        raise MethodNotAllowed("POST")

    def get_queryset(self):
        qs = super().get_queryset()
        source = self.request.query_params.get("source")
        if source:
            qs = qs.filter(source_id=source)
        if self.request.query_params.get("ignored") != "1":
            qs = qs.filter(ignored=False)
        return qs

    @action(detail=True, methods=["post"])
    def accept(self, request, pk=None):
        """Apply this change to the inventory."""
        from .virt_sync import apply_change

        change = self.get_object()
        apply_change(change)
        return Response({"ok": True})

    @action(detail=True, methods=["post"])
    def ignore(self, request, pk=None):
        """Dismiss this change until it changes again."""
        from .virt_sync import ignore_change

        change = self.get_object()
        ignore_change(change)
        return Response({"ok": True})


class VirtPlacementRuleSerializer(serializers.ModelSerializer):
    """A rule mapping the hypervisor's own structure to a Site."""

    scope_display = serializers.CharField(
        source="get_scope_display", read_only=True
    )
    site = serializers.SerializerMethodField()
    site_id = TenantScopedPrimaryKeyRelatedField(
        source="site", queryset=Site.objects.all(), write_only=True
    )
    location = serializers.SerializerMethodField()
    location_id = TenantScopedPrimaryKeyRelatedField(
        source="location", queryset=Location.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    def get_site(self, obj):
        return {"id": str(obj.site_id), "name": obj.site.name}

    def get_location(self, obj):
        if not obj.location_id:
            return None
        return {"id": str(obj.location_id), "name": obj.location.name}

    def validate(self, attrs):
        # The source is a plain FK in the payload, so it must be checked
        # against the active tenant — a posted id is never trusted.
        src = attrs.get("source") or getattr(self.instance, "source", None)
        request = self.context.get("request") if self.context else None
        if src is not None and request is not None:
            from api.views import _get_active_tenant

            tenant = _get_active_tenant(request)
            if tenant is not None and src.tenant_id != tenant.id:
                raise serializers.ValidationError(
                    {"source": "Unknown virtualization source."}
                )
        # A Location outside the rule's Site would place a device somewhere it
        # physically isn't; refuse it here rather than silently dropping it.
        site = attrs.get("site") or getattr(self.instance, "site", None)
        loc = attrs.get("location", getattr(self.instance, "location", None))
        if loc is not None and site is not None and loc.site_id != site.id:
            raise serializers.ValidationError(
                {"location_id": f"«{loc.name}» is not in site «{site.name}»."}
            )
        return attrs

    class Meta:
        model = VirtPlacementRule
        fields = ["id", "source", "scope", "scope_display", "pattern",
                  "site", "site_id", "location", "location_id", "weight",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "scope_display", "created_at", "updated_at"]


class VirtPlacementRuleViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """Placement rules for a source; filter with ``?source=``."""

    integration_keys = ("virtualization",)
    tenant_field = "source__tenant"
    queryset = VirtPlacementRule.objects.select_related(
        "site", "location", "source"
    ).order_by("scope", "weight", "pattern")
    serializer_class = VirtPlacementRuleSerializer

    def perform_create(self, serializer):
        # Tenant is implied by the source, so there is nothing to stamp —
        # the base class would try to pass the `source__tenant` traversal as a
        # model kwarg and blow up. `source` is validated below instead.
        serializer.save()

    def get_queryset(self):
        qs = super().get_queryset()
        src = self.request.query_params.get("source") if self.request else None
        return qs.filter(source_id=src) if src else qs
