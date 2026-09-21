"""Routing REST surface. Registered on the api router under ``routing/`` so
bulk edit, planned changes, CSV import/export and the assistant see the
types with no extra wiring."""
from __future__ import annotations

from django.db import transaction
from django.db.models import Count, Q
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from api.cf_search import cf_text_q
from api.views import _get_active_tenant
from api.viewsets import (
    NATURAL_NAME,
    CloneableMixin,
    FieldWriteAllowList,
    SecretPSKViewSetMixin,
    StandardPagination,
    TenantScopedViewSet,
)
from audit.bulk import log_bulk_delete

from .models import (
    VTEP,
    ASPathList,
    ASPathListRule,
    BFDProfile,
    BGPAddressFamily,
    BGPInstance,
    BGPPeerGroup,
    BGPSession,
    Community,
    CommunityList,
    CommunityListRule,
    EIGRPInstance,
    EIGRPInterface,
    ISISInstance,
    ISISInterface,
    OSPFArea,
    OSPFInstance,
    OSPFInterface,
    PrefixList,
    PrefixListRule,
    Redistribution,
    RoutingKeychain,
    RoutingPolicy,
    RoutingPolicyRule,
    StaticRoute,
    VTEPMembership,
)
from .serializers import (
    ASPathListMiniSerializer,
    ASPathListRuleSerializer,
    ASPathListSerializer,
    BFDProfileMiniSerializer,
    BFDProfileSerializer,
    BGPAddressFamilySerializer,
    BGPInstanceSerializer,
    BGPPeerGroupMiniSerializer,
    BGPPeerGroupSerializer,
    BGPSessionSerializer,
    CommunityListMiniSerializer,
    CommunityListRuleSerializer,
    CommunityListSerializer,
    CommunityMiniSerializer,
    CommunitySerializer,
    EIGRPInstanceSerializer,
    EIGRPInterfaceSerializer,
    ISISInstanceSerializer,
    ISISInterfaceSerializer,
    OSPFAreaMiniSerializer,
    OSPFAreaSerializer,
    OSPFInstanceSerializer,
    OSPFInterfaceSerializer,
    PrefixListMiniSerializer,
    PrefixListRuleSerializer,
    PrefixListSerializer,
    RedistributionSerializer,
    RoutingKeychainMiniSerializer,
    RoutingKeychainSerializer,
    RoutingPolicyMiniSerializer,
    RoutingPolicyRuleSerializer,
    RoutingPolicySerializer,
    StaticRouteSerializer,
    VTEPMembershipSerializer,
    VTEPSerializer,
)


class _BulkDeleteMixin:
    rbac_action_map = {"bulk_delete": "delete"}

    @action(detail=False, methods=["post"], url_path="bulk-delete")
    def bulk_delete(self, request):
        ids = request.data.get("ids") or []
        if not isinstance(ids, list) or not ids:
            raise ValidationError({"ids": "Provide a non-empty list of ids."})
        with transaction.atomic():
            qs = self.get_queryset().filter(pk__in=ids)
            rows = list(qs)
            deleted, _ = qs.delete()
            log_bulk_delete(rows)
        return Response({"deleted": deleted})


class _CatalogViewSet(_BulkDeleteMixin, FieldWriteAllowList, CloneableMixin, TenantScopedViewSet):
    """A named tenant-wide list: search on name/description, ``?picker=1``
    mini rows, rule count annotated for the list page."""

    mini_serializer_class = None
    editable_str_fields = ("description",)
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if (
            self.mini_serializer_class is not None
            and self.action == "list" and self.request
            and self.request.query_params.get("picker") == "1"
        ):
            return self.mini_serializer_class
        return self.serializer_class

    def _search(self, qs, s):
        return qs.filter(
            Q(name__icontains=s) | Q(description__icontains=s) | cf_text_q(qs.model, s)
        )

    def get_queryset(self):
        qs = super().get_queryset().prefetch_related("tags")
        if hasattr(qs.model, "rules"):
            qs = qs.annotate(rule_count_annotated=Count("rules", distinct=True))
        if not self.request:
            return qs
        s = self.request.query_params.get("search", "").strip()
        if s:
            qs = self._search(qs, s)
        return qs.distinct()


class PrefixListViewSet(_CatalogViewSet):
    queryset = PrefixList.objects.all().order_by(NATURAL_NAME)
    serializer_class = PrefixListSerializer
    mini_serializer_class = PrefixListMiniSerializer
    clone_fields = ("family", "description", "rules")

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            fam = self.request.query_params.get("family")
            if fam:
                qs = qs.filter(family=fam)
        return qs


class CommunityViewSet(_CatalogViewSet):
    queryset = Community.objects.all().order_by("value")
    serializer_class = CommunitySerializer
    mini_serializer_class = CommunityMiniSerializer
    clone_fields = ("kind", "description")

    def _search(self, qs, s):
        return super()._search(qs, s) | qs.filter(value__icontains=s)

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            kind = self.request.query_params.get("kind")
            if kind:
                qs = qs.filter(kind=kind)
        return qs


class CommunityListViewSet(_CatalogViewSet):
    queryset = CommunityList.objects.all().order_by(NATURAL_NAME)
    serializer_class = CommunityListSerializer
    mini_serializer_class = CommunityListMiniSerializer
    clone_fields = ("kind", "description", "rules")


class ASPathListViewSet(_CatalogViewSet):
    queryset = ASPathList.objects.all().order_by(NATURAL_NAME)
    serializer_class = ASPathListSerializer
    mini_serializer_class = ASPathListMiniSerializer
    clone_fields = ("description", "rules")


class RoutingPolicyViewSet(_CatalogViewSet):
    queryset = RoutingPolicy.objects.all().order_by(NATURAL_NAME)
    serializer_class = RoutingPolicySerializer
    mini_serializer_class = RoutingPolicyMiniSerializer
    clone_fields = ("description", "rules")


class RoutingKeychainViewSet(SecretPSKViewSetMixin, _CatalogViewSet):
    """Keychains. The key is write-only and lives in the secret store; the
    mixin moves it and reveals it under audit."""

    psk_object_label = "Routing keychain"
    queryset = RoutingKeychain.objects.all().order_by(NATURAL_NAME)
    serializer_class = RoutingKeychainSerializer
    mini_serializer_class = RoutingKeychainMiniSerializer
    clone_fields = ("algorithm", "description")
    rbac_action_map = {
        **SecretPSKViewSetMixin.rbac_action_map,
        **_BulkDeleteMixin.rbac_action_map,
    }


# ─── Rule rows ───────────────────────────────────────────────────────────────

class _RuleViewSet(TenantScopedViewSet):
    """A rule row on its own - no tenant column, scoped through its list.
    Filter with ``?<parent>=``."""

    parent = ""
    tenant_field = None
    pagination_class = StandardPagination

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return self.queryset.none()
        qs = self.queryset.filter(**{f"{self.parent}__tenant": tenant})
        if self.request:
            pid = self.request.query_params.get(self.parent)
            if pid:
                qs = qs.filter(**{f"{self.parent}_id": pid})
        return qs

    def _check(self, serializer):
        tenant = self._tenant_or_403()
        parent = serializer.validated_data.get(self.parent) or (
            getattr(serializer.instance, self.parent) if serializer.instance else None
        )
        if parent is None or parent.tenant_id != tenant.id:
            raise ValidationError({f"{self.parent}_id": "Pick a list in the current tenant."})

    def perform_create(self, serializer):
        self._check(serializer)
        serializer.save()

    def perform_update(self, serializer):
        self._check(serializer)
        serializer.save()


class PrefixListRuleViewSet(_RuleViewSet):
    parent = "prefix_list"
    queryset = PrefixListRule.objects.select_related("prefix_list", "prefix_obj").order_by("sequence")
    serializer_class = PrefixListRuleSerializer


class CommunityListRuleViewSet(_RuleViewSet):
    parent = "community_list"
    queryset = (
        CommunityListRule.objects.select_related("community_list")
        .prefetch_related("communities").order_by("sequence")
    )
    serializer_class = CommunityListRuleSerializer


class ASPathListRuleViewSet(_RuleViewSet):
    parent = "as_path_list"
    queryset = ASPathListRule.objects.select_related("as_path_list").order_by("sequence")
    serializer_class = ASPathListRuleSerializer


class RoutingPolicyRuleViewSet(_RuleViewSet):
    parent = "policy"
    queryset = (
        RoutingPolicyRule.objects.select_related("policy", "match_next_hop")
        .prefetch_related(
            "match_prefix_lists", "match_community_lists", "match_as_path_lists",
            "set_communities",
        )
        .order_by("sequence")
    )
    serializer_class = RoutingPolicyRuleSerializer


# ─── Static routes ───────────────────────────────────────────────────────────

class StaticRouteViewSet(_BulkDeleteMixin, FieldWriteAllowList, CloneableMixin, TenantScopedViewSet):
    """Static routes per device. Filter with ``?device=``, ``?vrf=``
    (``global`` for the global table), ``?kind=``, ``?status=``,
    ``?prefix_obj=``, ``?site=``."""

    editable_str_fields = ("description",)
    editable_bool_fields = ("bfd",)
    editable_int_fields = ("distance", "metric", "tag")
    queryset = StaticRoute.objects.all()
    serializer_class = StaticRouteSerializer
    pagination_class = StandardPagination
    clone_fields = ("device", "vrf", "kind", "next_hop", "next_hop_interface",
                    "next_hop_vrf", "distance", "metric", "tag", "bfd", "status")

    def get_queryset(self):
        qs = (
            super().get_queryset()
            .select_related("device", "vrf", "prefix_obj", "next_hop_interface__device",
                            "next_hop_vrf", "status")
            .prefetch_related("tags")
        )
        if not self.request:
            return qs
        p = self.request.query_params
        s = p.get("search", "").strip()
        if s:
            qs = qs.filter(
                Q(prefix__icontains=s) | Q(next_hop__icontains=s)
                | Q(description__icontains=s) | Q(device__name__icontains=s)
                | Q(next_hop_interface__name__icontains=s) | cf_text_q(qs.model, s)
            )
        for key, field in (
            ("device", "device_id"),
            ("kind", "kind"),
            ("status", "status_id"),
            ("prefix_obj", "prefix_obj_id"),
            ("site", "device__site_id"),
            ("next_hop_interface", "next_hop_interface_id"),
        ):
            v = p.get(key)
            if v:
                qs = qs.filter(**{field: v})
        vrf = p.get("vrf")
        if vrf == "global":
            qs = qs.filter(vrf__isnull=True)
        elif vrf:
            qs = qs.filter(vrf_id=vrf)
        return qs.distinct()


# ─── BGP ─────────────────────────────────────────────────────────────────────

class BGPInstanceViewSet(_BulkDeleteMixin, FieldWriteAllowList, CloneableMixin, TenantScopedViewSet):
    """``router bgp`` per device and table. Filter with ``?device=``,
    ``?vrf=`` (``global``), ``?asn=``, ``?site=``, ``?status=``."""

    editable_str_fields = ("description", "router_id", "cluster_id")
    editable_bool_fields = ("bfd", "graceful_restart")
    queryset = BGPInstance.objects.all()
    serializer_class = BGPInstanceSerializer
    pagination_class = StandardPagination
    clone_fields = ("vrf", "asn", "cluster_id", "graceful_restart", "bfd", "status",
                    "distance_ebgp", "distance_ibgp", "distance_local",
                    "bestpath_multipath_relax")

    def get_queryset(self):
        qs = (
            super().get_queryset()
            .select_related("device", "vrf", "asn", "status")
            .prefetch_related(
                "tags", "address_families__import_policy",
                "address_families__export_policy",
                "address_families__redistributions__policy",
            )
            .annotate(session_count_annotated=Count("sessions", distinct=True))
        )
        if not self.request:
            return qs
        p = self.request.query_params
        s = p.get("search", "").strip()
        if s:
            qs = qs.filter(
                Q(device__name__icontains=s) | Q(asn__asn__icontains=s)
                | Q(router_id__icontains=s) | Q(description__icontains=s)
                | Q(vrf__name__icontains=s) | cf_text_q(qs.model, s)
            )
        for key, field in (
            ("device", "device_id"), ("asn", "asn_id"), ("status", "status_id"),
            ("site", "device__site_id"),
        ):
            v = p.get(key)
            if v:
                qs = qs.filter(**{field: v})
        vrf = p.get("vrf")
        if vrf == "global":
            qs = qs.filter(vrf__isnull=True)
        elif vrf:
            qs = qs.filter(vrf_id=vrf)
        return qs.distinct()


class BGPAddressFamilyViewSet(_RuleViewSet):
    """Address families of an instance. Filter with ``?instance=``."""

    parent = "instance"
    queryset = (
        BGPAddressFamily.objects.select_related("instance", "import_policy", "export_policy")
        .prefetch_related("redistributions__policy").order_by("afi_safi")
    )
    serializer_class = BGPAddressFamilySerializer


class RedistributionViewSet(TenantScopedViewSet):
    """Redistribution rows. Filter with ``?bgp_af=``."""

    tenant_field = None
    queryset = Redistribution.objects.select_related(
        "bgp_af", "ospf_instance", "isis_instance", "eigrp_instance", "policy"
    ).order_by("source")
    serializer_class = RedistributionSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return self.queryset.none()
        qs = self.queryset.filter(
            Q(bgp_af__instance__tenant=tenant) | Q(ospf_instance__tenant=tenant)
            | Q(isis_instance__tenant=tenant) | Q(eigrp_instance__tenant=tenant)
        )
        if self.request:
            for key in ("bgp_af", "ospf_instance", "isis_instance", "eigrp_instance"):
                v = self.request.query_params.get(key)
                if v:
                    qs = qs.filter(**{f"{key}_id": v})
        return qs

    def _check(self, serializer):
        tenant = self._tenant_or_403()
        vd = serializer.validated_data
        parents = [
            vd.get(k) or (getattr(serializer.instance, k) if serializer.instance else None)
            for k in ("bgp_af", "ospf_instance", "isis_instance", "eigrp_instance")
        ]
        present = [p for p in parents if p is not None]
        if len(present) != 1:
            raise ValidationError({"detail": "A redistribution has exactly one parent."})
        parent = present[0]
        owner = parent.instance.tenant_id if hasattr(parent, "instance") else parent.tenant_id
        if owner != tenant.id:
            raise ValidationError({"detail": "Pick a parent in the current tenant."})

    def perform_create(self, serializer):
        self._check(serializer)
        serializer.save()

    def perform_update(self, serializer):
        self._check(serializer)
        serializer.save()


class BGPPeerGroupViewSet(_CatalogViewSet):
    queryset = BGPPeerGroup.objects.all().order_by(NATURAL_NAME)
    serializer_class = BGPPeerGroupSerializer
    mini_serializer_class = BGPPeerGroupMiniSerializer
    clone_fields = ("description", "remote_asn", "remote_asn_mode", "local_asn",
                    "update_source", "address_families", "import_policy",
                    "export_policy", "bfd", "ebgp_multihop", "next_hop_self",
                    "route_reflector_client", "send_community", "keepalive",
                    "hold_time", "keychain", "capability_extended_nexthop",
                    "ttl_security_hops", "default_originate",
                    "default_originate_policy", "extra")

    def get_queryset(self):
        qs = (
            super().get_queryset()
            .select_related("local_asn", "import_policy", "export_policy", "keychain")
            .annotate(session_count_annotated=Count("sessions", distinct=True))
        )
        if self.request:
            asn = self.request.query_params.get("remote_asn")
            if asn:
                qs = qs.filter(remote_asn=asn)
        return qs


class BGPSessionViewSet(_BulkDeleteMixin, FieldWriteAllowList, CloneableMixin, TenantScopedViewSet):
    """Neighbours. Filter with ``?instance=``, ``?device=``, ``?site=``,
    ``?asn=`` (the local instance's), ``?remote_asn=``, ``?peer_group=``,
    ``?peer_device=``, ``?status=``, ``?af=``."""

    editable_str_fields = ("description", "name")
    editable_int_fields = ("remote_asn", "keepalive", "hold_time", "ebgp_multihop")
    queryset = BGPSession.objects.all()
    serializer_class = BGPSessionSerializer
    pagination_class = StandardPagination
    rbac_action_map = {**_BulkDeleteMixin.rbac_action_map, "create_peer": "add"}
    clone_fields = ("instance", "peer_group", "remote_asn", "remote_asn_mode",
                    "local_asn", "local_address", "address_families",
                    "import_policy", "export_policy", "bfd", "ebgp_multihop",
                    "next_hop_self", "route_reflector_client", "send_community",
                    "keepalive", "hold_time", "keychain", "status",
                    "capability_extended_nexthop", "ttl_security_hops",
                    "default_originate", "default_originate_policy", "extra")

    def get_queryset(self):
        qs = (
            super().get_queryset()
            .select_related(
                "instance__device", "instance__vrf", "instance__asn",
                "peer_group__import_policy", "peer_group__export_policy",
                "peer_group__keychain", "peer_group__local_asn",
                "local_asn", "local_address__assigned_interface", "interface__device",
                "remote_address_obj", "peer_device", "peer_session__instance__device",
                "import_policy", "export_policy", "keychain", "status",
            )
            .prefetch_related("tags")
        )
        if not self.request:
            return qs
        p = self.request.query_params
        s = p.get("search", "").strip()
        if s:
            qs = qs.filter(
                Q(name__icontains=s) | Q(remote_address__icontains=s)
                | Q(interface__name__icontains=s) | Q(description__icontains=s)
                | Q(instance__device__name__icontains=s)
                | Q(peer_device__name__icontains=s) | Q(peer_group__name__icontains=s)
                | cf_text_q(qs.model, s)
            )
            if s.isdigit():
                qs = qs | super().get_queryset().filter(
                    Q(remote_asn=int(s)) | Q(instance__asn__asn=int(s))
                )
        for key, field in (
            ("instance", "instance_id"), ("device", "instance__device_id"),
            ("site", "instance__device__site_id"), ("asn", "instance__asn_id"),
            ("remote_asn", "remote_asn"), ("peer_group", "peer_group_id"),
            ("peer_device", "peer_device_id"), ("status", "status_id"),
        ):
            v = p.get(key)
            if v:
                qs = qs.filter(**{field: v})
        vrf = p.get("vrf")
        if vrf == "global":
            qs = qs.filter(instance__vrf__isnull=True)
        elif vrf:
            qs = qs.filter(instance__vrf_id=vrf)
        af = p.get("af")
        if af:
            qs = qs.filter(Q(address_families__contains=[af]) | Q(peer_group__address_families__contains=[af]))
        return qs.distinct()

    @action(detail=True, methods=["post"], url_path="create-peer")
    def create_peer(self, request, pk=None):
        """Write the mirror session on the peer device and link both ends.
        Needs a peer device with an instance in the same table, this side's
        local address, and a far address Danbyte knows."""
        from django.db import transaction

        from api.models import IPAddress

        s = self.get_object()
        if s.peer_session_id:
            raise ValidationError({"detail": "This session already has its far end."})
        if not s.peer_device_id:
            raise ValidationError({"peer_device_id": "Set the peer device first."})
        if not s.local_address_id:
            raise ValidationError({"local_address_id": "Set this side's local address first."})
        far_inst = BGPInstance.objects.filter(device_id=s.peer_device_id, vrf_id=s.instance.vrf_id).first()
        if far_inst is None:
            raise ValidationError({"peer_device_id": "The peer device has no BGP instance in this table."})
        far_ip = s.remote_address_obj
        if far_ip is None and s.remote_address:
            far_ip = IPAddress.objects.filter(
                tenant_id=s.tenant_id, ip_address=s.remote_address, vrf_id=s.instance.vrf_id,
                assigned_device_id=s.peer_device_id,
            ).first()
        if far_ip is None:
            raise ValidationError({"remote_address": "The far address is not on the peer device in IPAM."})
        eff = s.effective()
        with transaction.atomic():
            mirror = BGPSession(
                tenant_id=s.tenant_id, instance=far_inst, name=s.name,
                peer_group=None,
                remote_asn=s.instance.asn.asn, remote_asn_mode="asn",
                local_address=far_ip, remote_address=s.local_address.ip_address,
                remote_address_obj=s.local_address, peer_device=s.instance.device,
                address_families=list(eff["address_families"] or []),
                bfd=eff["bfd"], ebgp_multihop=eff["ebgp_multihop"],
                keepalive=eff["keepalive"], hold_time=eff["hold_time"],
                send_community=eff["send_community"] or "", keychain=eff["keychain"],
                status=s.status, description=s.description,
            )
            mirror.full_clean()
            mirror.save()
            mirror.peer_session = s
            mirror.save(update_fields=["peer_session"])
            s.peer_session = mirror
            s.save(update_fields=["peer_session"])
        return Response(BGPSessionSerializer(mirror, context={"request": request}).data,
                        status=201)


# ─── OSPF / IS-IS ────────────────────────────────────────────────────────────

class BFDProfileViewSet(_CatalogViewSet):
    queryset = BFDProfile.objects.all().order_by(NATURAL_NAME)
    serializer_class = BFDProfileSerializer
    mini_serializer_class = BFDProfileMiniSerializer
    clone_fields = ("min_tx", "min_rx", "multiplier", "echo", "description")


class OSPFAreaViewSet(_CatalogViewSet):
    queryset = OSPFArea.objects.all().order_by(NATURAL_NAME)
    serializer_class = OSPFAreaSerializer
    mini_serializer_class = OSPFAreaMiniSerializer
    clone_fields = ("kind", "description")

    def _search(self, qs, s):
        return super()._search(qs, s) | qs.filter(area_id__icontains=s)

    def get_queryset(self):
        return super().get_queryset().annotate(
            interface_count_annotated=Count("interfaces", distinct=True)
        )


class _IGPInstanceViewSet(_BulkDeleteMixin, FieldWriteAllowList, CloneableMixin, TenantScopedViewSet):
    """Filter with ``?device=``, ``?vrf=`` (``global``), ``?site=``, ``?status=``."""

    editable_str_fields = ("description",)
    editable_bool_fields = ("bfd",)
    pagination_class = StandardPagination
    text_search_fields: tuple = ()

    def get_queryset(self):
        qs = (
            super().get_queryset()
            .select_related("device", "vrf", "status")
            .prefetch_related("tags", "redistributions__policy")
            .annotate(interface_count_annotated=Count("interfaces", distinct=True))
        )
        if not self.request:
            return qs
        p = self.request.query_params
        s = p.get("search", "").strip()
        if s:
            q = Q(device__name__icontains=s) | Q(description__icontains=s) | cf_text_q(qs.model, s)
            for f in self.text_search_fields:
                q |= Q(**{f"{f}__icontains": s})
            qs = qs.filter(q)
        for key, field in (
            ("device", "device_id"), ("status", "status_id"), ("site", "device__site_id"),
        ):
            v = p.get(key)
            if v:
                qs = qs.filter(**{field: v})
        vrf = p.get("vrf")
        if vrf == "global":
            qs = qs.filter(vrf__isnull=True)
        elif vrf:
            qs = qs.filter(vrf_id=vrf)
        return qs.distinct()


class OSPFInstanceViewSet(_IGPInstanceViewSet):
    queryset = OSPFInstance.objects.all().prefetch_related(
        "interfaces__interface__device", "interfaces__area", "interfaces__keychain"
    )
    serializer_class = OSPFInstanceSerializer
    text_search_fields = ("process_id", "router_id", "vrf__name")
    editable_str_fields = ("description", "router_id", "process_id")
    editable_bool_fields = ("bfd", "passive_by_default", "default_originate")
    clone_fields = ("vrf", "process_id", "version", "reference_bandwidth",
                    "passive_by_default", "default_originate", "bfd", "status")


class ISISInstanceViewSet(_IGPInstanceViewSet):
    queryset = ISISInstance.objects.all().select_related("keychain").prefetch_related(
        "interfaces__interface__device", "interfaces__keychain"
    )
    serializer_class = ISISInstanceSerializer
    text_search_fields = ("process", "net")
    editable_str_fields = ("description", "process", "net")
    clone_fields = ("vrf", "process", "level", "metric_style", "bfd",
                    "authentication", "keychain", "status",
                    "lsp_gen_interval", "spf_interval", "lsp_mtu",
                    "spf_init_delay", "spf_short_delay", "spf_long_delay",
                    "spf_holddown", "spf_time_to_learn", "log_adjacency_changes",
                    "default_originate_ipv4", "default_originate_ipv6")


class OSPFInterfaceViewSet(_RuleViewSet):
    """Interfaces enrolled in an OSPF instance. Filter with ``?instance=``,
    ``?interface=``, ``?area=``."""

    parent = "instance"
    queryset = OSPFInterface.objects.select_related(
        "instance__device", "interface__device", "area", "keychain"
    ).order_by("interface__name")
    serializer_class = OSPFInterfaceSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            for key in ("interface", "area"):
                v = self.request.query_params.get(key)
                if v:
                    qs = qs.filter(**{f"{key}_id": v})
        return qs


class ISISInterfaceViewSet(_RuleViewSet):
    """Interfaces enrolled in an IS-IS instance. Filter with ``?instance=``,
    ``?interface=``."""

    parent = "instance"
    queryset = ISISInterface.objects.select_related(
        "instance__device", "interface__device", "keychain"
    ).order_by("interface__name")
    serializer_class = ISISInterfaceSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            v = self.request.query_params.get("interface")
            if v:
                qs = qs.filter(interface_id=v)
        return qs


class EIGRPInstanceViewSet(_IGPInstanceViewSet):
    queryset = EIGRPInstance.objects.all().prefetch_related(
        "interfaces__interface__device", "interfaces__keychain"
    )
    serializer_class = EIGRPInstanceSerializer
    text_search_fields = ("name", "router_id", "vrf__name")
    editable_str_fields = ("description", "router_id", "name", "k_values")
    editable_bool_fields = ("bfd", "passive_by_default", "stub")
    clone_fields = ("vrf", "asn", "name", "k_values", "variance", "maximum_paths",
                    "passive_by_default", "stub", "bfd", "status")


class EIGRPInterfaceViewSet(_RuleViewSet):
    """Interfaces enrolled in an EIGRP instance. Filter with ``?instance=``,
    ``?interface=``."""

    parent = "instance"
    queryset = EIGRPInterface.objects.select_related(
        "instance__device", "interface__device", "keychain"
    ).order_by("interface__name")
    serializer_class = EIGRPInterfaceSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            v = self.request.query_params.get("interface")
            if v:
                qs = qs.filter(interface_id=v)
        return qs


# ─── Overlay: VTEPs ──────────────────────────────────────────────────────────

class VTEPViewSet(_BulkDeleteMixin, FieldWriteAllowList, CloneableMixin, TenantScopedViewSet):
    """One per device. Filter with ``?device=``, ``?site=``, ``?l2vpn=``
    (VTEPs carrying that overlay), ``?status=``."""

    editable_str_fields = ("description", "anycast_gateway_mac")
    editable_bool_fields = ("arp_suppression",)
    queryset = VTEP.objects.all()
    serializer_class = VTEPSerializer
    pagination_class = StandardPagination
    clone_fields = ("anycast_gateway_mac", "arp_suppression", "status")

    def get_queryset(self):
        qs = (
            super().get_queryset()
            .select_related("device__site", "source_interface__device", "source_ip",
                            "anycast_ip", "status")
            .prefetch_related(
                "tags", "memberships__l2vpn__vrf", "memberships__vlan",
                "memberships__l2vpn__terminations__vlan",
            )
        )
        if not self.request:
            return qs
        p = self.request.query_params
        s = p.get("search", "").strip()
        if s:
            qs = qs.filter(
                Q(device__name__icontains=s) | Q(description__icontains=s)
                | Q(source_ip__ip_address__icontains=s) | cf_text_q(qs.model, s)
            )
        for key, field in (
            ("device", "device_id"), ("site", "device__site_id"),
            ("status", "status_id"), ("l2vpn", "memberships__l2vpn_id"),
        ):
            v = p.get(key)
            if v:
                qs = qs.filter(**{field: v})
        return qs.distinct()


class VTEPMembershipViewSet(_RuleViewSet):
    """The VNIs a VTEP serves. Filter with ``?vtep=``, ``?l2vpn=``."""

    parent = "vtep"
    queryset = VTEPMembership.objects.select_related(
        "vtep__device", "l2vpn__vrf", "vlan"
    ).prefetch_related("l2vpn__terminations__vlan")
    serializer_class = VTEPMembershipSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            v = self.request.query_params.get("l2vpn")
            if v:
                qs = qs.filter(l2vpn_id=v)
        return qs
