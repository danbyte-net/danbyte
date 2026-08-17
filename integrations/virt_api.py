"""Virtualization review inbox: pending changes from review/manual sources,
resolved by accept (apply) or ignore (dismiss)."""
from __future__ import annotations

from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response

from api.viewsets import TenantScopedViewSet

from .models import VirtChange, VirtNetwork
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

    class Meta:
        model = VirtNetwork
        fields = ["id", "name", "ext_key", "vlan", "vswitch", "vswitch_name",
                  "vms", "last_seen_at"]

    def get_vlan(self, obj):
        if not obj.vlan_id:
            return None
        return {"id": str(obj.vlan_id), "vlan_id": obj.vlan.vlan_id,
                "name": obj.vlan.name}

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
                }
        return list(seen.values())


class VirtNetworkViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """Read-only synced networks; filter by ``?vswitch=`` or ``?source=``."""

    integration_keys = ("virtualization",)
    tenant_field = "source__tenant"
    http_method_names = ["get"]
    queryset = VirtNetwork.objects.select_related(
        "source", "vlan", "vswitch"
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
