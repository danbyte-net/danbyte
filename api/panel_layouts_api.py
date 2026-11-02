"""``/api/panel-layouts/``: the floor plan detail panels' layouts
(``api.panel_layouts``), a tenant display setting - tenant admins only.

- ``GET`` lists the tenant's layouts (``?object_kind=`` narrows them);
- ``POST`` adds one (``object_kind``, ``scope``, ``scope_id``, ``items``);
- ``PUT``/``PATCH`` on one changes its ``items`` (and ``callout``, the
  fields a 2D plan callout adds under the name); ``DELETE`` drops it, so its
  scope falls back to the next match;
- ``GET catalog/`` lists the fields each kind offers, the scopes in
  resolution order and the built-in defaults;
- ``POST preview/`` renders a panel with ``items`` for one object the caller
  may view - ``object_id``, else the first in the scope.
"""
from __future__ import annotations

from django.db import IntegrityError, transaction
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api import rbac
from auth_api.permissions import can_manage_admin

from . import panel_layouts
from .models import PanelLayout


def _row(r: PanelLayout) -> dict:
    return {
        "id": str(r.id),
        "object_kind": r.object_kind,
        "scope": r.scope,
        "scope_id": str(r.scope_id) if r.scope_id else None,
        "scope_name": panel_layouts.scope_name(r.scope, r.scope_id),
        "items": r.items,
        "callout": r.callout or [],
        "updated_at": r.updated_at.isoformat(),
    }


class PanelLayoutViewSet(viewsets.ViewSet):
    permission_classes = [IsAuthenticated]

    def _tenant(self, request):
        from .views import _get_active_tenant

        tenant = _get_active_tenant(request)
        if tenant is None:
            raise ValidationError({"detail": "No active tenant."})
        if not can_manage_admin(request.user, tenant):
            raise PermissionDenied("Tenant admin required.")
        return tenant

    def _get(self, tenant, pk):
        row = PanelLayout.objects.filter(tenant=tenant, pk=pk).first()
        if row is None:
            raise NotFound("No such layout.")
        return row

    def list(self, request):
        tenant = self._tenant(request)
        qs = PanelLayout.objects.filter(tenant=tenant)
        kind = request.query_params.get("object_kind")
        if kind:
            qs = qs.filter(object_kind=kind)
        return Response({"results": [_row(r) for r in qs]})

    def create(self, request):
        tenant = self._tenant(request)
        d = request.data
        kind, scope = d.get("object_kind"), d.get("scope", "default")
        scope_id = d.get("scope_id") or None
        items = panel_layouts.validate(tenant, kind, scope, scope_id, d.get("items", []))
        callout = panel_layouts.validate_callout(tenant, kind, d.get("callout", []))
        try:
            with transaction.atomic():
                row = PanelLayout.objects.create(
                    tenant=tenant, object_kind=kind, scope=scope, scope_id=scope_id,
                    items=items, callout=callout,
                )
        except IntegrityError:
            raise ValidationError({"scope": "That scope already has a layout."}) from None
        return Response(_row(row), status=201)

    def retrieve(self, request, pk=None):
        return Response(_row(self._get(self._tenant(request), pk)))

    def update(self, request, pk=None):
        tenant = self._tenant(request)
        row = self._get(tenant, pk)
        row.items = panel_layouts.validate(
            tenant, row.object_kind, row.scope, row.scope_id,
            request.data.get("items", row.items),
        )
        if "callout" in request.data:
            row.callout = panel_layouts.validate_callout(
                tenant, row.object_kind, request.data.get("callout")
            )
        row.save(update_fields=["items", "callout", "updated_at"])
        return Response(_row(row))

    partial_update = update

    def destroy(self, request, pk=None):
        self._get(self._tenant(request), pk).delete()
        return Response(status=204)

    @action(detail=False, methods=["get"])
    def catalog(self, request):
        self._tenant(request)
        return Response({
            kind: {
                "fields": [
                    {"key": k, "label": label, "computed": k in panel_layouts.COMPUTED}
                    for k, label in fields.items()
                ],
                "scopes": list(panel_layouts.SCOPES[kind]),
                "default": panel_layouts.DEFAULTS[kind],
                "cf_model": panel_layouts.CF_MODEL[kind],
                "callout_fields": list(panel_layouts.CALLOUT_FIELDS[kind]),
                "callout_max": panel_layouts.CALLOUT_MAX,
            }
            for kind, fields in panel_layouts.FIELDS.items()
        })

    @action(detail=False, methods=["post"])
    def preview(self, request):
        """The panel ``items`` would draw, for one object the caller may view."""
        from . import floor_plan_panels
        from .models import Cabinet, Device, Rack

        tenant = self._tenant(request)
        d = request.data
        kind, scope = d.get("object_kind"), d.get("scope", "default")
        scope_id = d.get("scope_id") or None
        items = panel_layouts.validate(tenant, kind, scope, scope_id, d.get("items", []))
        model, slug = {
            "device": (Device, "device"), "rack": (Rack, "rack"),
            "cabinet": (Cabinet, "cabinet"),
        }[kind]
        qs = rbac.restrict_queryset(
            model.objects.filter(tenant=tenant), request.user, tenant, slug, "view"
        )
        if d.get("object_id"):
            qs = qs.filter(pk=d["object_id"])
        elif scope != "default":
            field = {
                "device_type": "device_type_id", "device_role": "role_id",
                "profile": "device_profile_assignments__profile_id",
                "rack_type": "rack_type_id", "rack_role": "role_id",
                "cabinet_type": "cabinet_type_id", "cabinet_role": "role_id",
            }[scope]
            qs = qs.filter(**{field: scope_id})
        obj = qs.order_by("name").first()
        if obj is None:
            return Response({"kind": kind, "empty": True})
        build = {
            "device": floor_plan_panels.device_panel,
            "rack": floor_plan_panels.rack_panel,
            "cabinet": floor_plan_panels.cabinet_panel,
        }[kind]
        return Response(build(request, tenant, obj, items=items))
