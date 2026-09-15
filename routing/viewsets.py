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
    ASPathList,
    ASPathListRule,
    Community,
    CommunityList,
    CommunityListRule,
    PrefixList,
    PrefixListRule,
    RoutingKeychain,
    RoutingPolicy,
    RoutingPolicyRule,
    StaticRoute,
)
from .serializers import (
    ASPathListMiniSerializer,
    ASPathListRuleSerializer,
    ASPathListSerializer,
    CommunityListMiniSerializer,
    CommunityListRuleSerializer,
    CommunityListSerializer,
    CommunityMiniSerializer,
    CommunitySerializer,
    PrefixListMiniSerializer,
    PrefixListRuleSerializer,
    PrefixListSerializer,
    RoutingKeychainMiniSerializer,
    RoutingKeychainSerializer,
    RoutingPolicyMiniSerializer,
    RoutingPolicyRuleSerializer,
    RoutingPolicySerializer,
    StaticRouteSerializer,
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
