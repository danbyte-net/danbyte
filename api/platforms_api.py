"""Platforms over the API.

``/api/platforms/`` - CRUD, ``?picker=1``, ``?search=``, ``?group=``,
``?lifecycle=`` and the end-of-life status filters, plus the shared bulk
endpoints of :class:`~api.bulk_edit.BulkEditMixin`:

* ``bulk-update`` / ``bulk-edit-fields`` - group, manufacturer, config
  template, target version, description and tags;
* ``bulk-delete`` - a platform devices or virtual machines run is kept, as
  its single delete refuses it; a device profile that names it keeps it too
  (``PROTECT``).

Platforms are a tenant-wide catalog: no ``owning_site``, so they are not in
``CATALOG_SITE_PATHS``.
"""
from __future__ import annotations

from django.db.models import Count
from django.utils.text import slugify
from rest_framework import status as drf_status
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from core.tags import TAGS

from . import software_versions
from .bulk_delete import plural_label
from .bulk_edit import BulkEditMixin, BulkEditSpec
from .cf_search import cf_text_q
from .models import Device, Platform, VirtualMachine
from .serializers import PlatformSerializer
from .viewsets import (
    NATURAL_NAME,
    DeviceRoleViewSet,
    TenantScopedViewSet,
    _apply_lifecycle_filter,
    _visible_n,
)


class PlatformViewSet(BulkEditMixin, DeviceRoleViewSet):
    queryset = Platform.objects.all().order_by(NATURAL_NAME)
    serializer_class = PlatformSerializer
    bulk_edit = BulkEditSpec(fields=(
        "group_id", "manufacturer_id", "config_template_id", "target_version",
        "description",
    ))

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            from .serializers import PlatformMiniSerializer
            return PlatformMiniSerializer
        return PlatformSerializer

    def get_queryset(self):
        qs = TenantScopedViewSet.get_queryset(self).select_related(
            "manufacturer", "group", "eol_mapping", "config_template"
        ).prefetch_related(TAGS)
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(description__icontains=s) | qs.filter(cf_text_q(qs.model, s))
            g = self.request.query_params.get("group")
            if g:
                qs = qs.filter(group_id=g)
            lc = self.request.query_params.get("lifecycle")
            if lc:
                qs = _apply_lifecycle_filter(qs, lc)
            from compliance.eol import apply_status_filter

            qs = apply_status_filter(qs, self.request, "eol_mapping__")
        if getattr(self, "action", None) in ("list", "retrieve"):
            # One query for the list's VM counts, not one per platform.
            qs = qs.annotate(
                device_count_annotated=_visible_n(self, "devices"),
                vm_count_annotated=_visible_n(self, "virtual_machines"),
            )
        return qs.order_by(NATURAL_NAME)

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

    def perform_create(self, serializer):
        super().perform_create(serializer)
        if serializer.instance.version_pattern:
            software_versions.enqueue_reextract(serializer.instance)

    def perform_update(self, serializer):
        before = serializer.instance.version_pattern
        super().perform_update(serializer)
        # A new pattern reads the stored sysDescr again (#451).
        if serializer.instance.version_pattern != before:
            software_versions.enqueue_reextract(serializer.instance)

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        n = obj.devices.count() + obj.virtual_machines.count()
        if n:
            return Response(
                {"detail": f"{n} object{'s' if n != 1 else ''} use this platform."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return TenantScopedViewSet.destroy(self, request, *args, **kwargs)

    def bulk_blockers(self, rows) -> dict:
        """The single delete's rule for every row at once: a platform any
        device or virtual machine runs stays - counted across the tenant,
        not only the rows the caller may view."""
        out = super().bulk_blockers(rows)
        ids = [r.pk for r in rows]
        uses: dict = {}
        for model in (Device, VirtualMachine):
            found = (
                model._base_manager.filter(platform_id__in=ids)
                .values("platform_id").annotate(n=Count("pk"))
            )
            for row in found:
                n = row["n"]
                label = plural_label(model) if n != 1 else str(model._meta.verbose_name)
                uses.setdefault(row["platform_id"], []).append(f"{n} {label}")
        for pk, parts in uses.items():
            out.setdefault(pk, "In use: " + ", ".join(parts) + ".")
        return out
