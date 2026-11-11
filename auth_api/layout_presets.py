"""Layout presets - named sets of table column layouts an administrator
shares as the default for users, groups or the whole tenant.

    GET  /api/prefs/presets/                  every preset of the active tenant
    POST /api/prefs/presets/                  new preset from your own layouts
    GET|PATCH|DELETE /api/prefs/presets/<id>/
    POST /api/prefs/presets/<id>/reset/       drop assignees' own layouts for
                                              the preset's tables ({"dry_run"})

All of it is for deployment administrators only (``can_manage_deployment`` -
the gate the Settings → Table layouts page already uses); everyone else only
receives presets, through ``GET /api/prefs/columns/<table>/``
(``column_prefs.resolve_pref``). A preset belongs to one tenant: it is only
found, assigned and applied inside it.
"""
from __future__ import annotations

import json

from django.contrib.auth import get_user_model
from django.contrib.auth.decorators import login_required
from django.contrib.auth.models import Group
from django.db import IntegrityError, transaction
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods

from api.views import _get_active_tenant
from audit.models import ChangeAction
from audit.signals import _record

from .column_prefs import clean_layout
from .models import LayoutPreset, UserPreference
from .permissions import can_manage_deployment, user_tenants

MAX_TABLES = 500


class _Bad(ValueError):
    def __init__(self, field: str, msg: str):
        super().__init__(msg)
        self.field = field


def _gate(request):
    """``(tenant, None)`` for a deployment admin with an active tenant, else
    ``(None, error response)``. Default-closed."""
    if not can_manage_deployment(request.user):
        return None, JsonResponse({"error": "needs deployment admin"}, status=403)
    tenant = _get_active_tenant(request)
    if tenant is None:
        return None, JsonResponse({"error": "no active tenant"}, status=400)
    return tenant, None


def _body(request) -> dict:
    try:
        data = json.loads(request.body or b"{}")
    except json.JSONDecodeError as e:
        raise _Bad("non_field_errors", f"invalid JSON: {e}") from None
    if not isinstance(data, dict):
        raise _Bad("non_field_errors", "body must be a JSON object")
    return data


def _ids(data: dict, key: str) -> list[int] | None:
    if key not in data:
        return None
    val = data[key]
    if not isinstance(val, list) or not all(
        isinstance(x, int) and not isinstance(x, bool) for x in val
    ):
        raise _Bad(key, "must be a list of ids")
    return list(dict.fromkeys(val))


def _users_of_tenant(ids: list[int], tenant) -> list:
    """The users behind ``ids``, every one a member of ``tenant``. An id that
    is unknown or outside the tenant is refused, never silently kept."""
    users = list(get_user_model().objects.filter(pk__in=ids, is_active=True))
    if len(users) != len(ids):
        raise _Bad("user_ids", "unknown user")
    for u in users:
        if not user_tenants(u).filter(pk=tenant.pk).exists():
            raise _Bad("user_ids", f"{u.get_username()} is not in this tenant")
    return users


def _groups(ids: list[int]) -> list:
    groups = list(Group.objects.filter(pk__in=ids))
    if len(groups) != len(ids):
        raise _Bad("group_ids", "unknown group")
    return groups


def _my_layouts(user, tenant, tables) -> dict:
    """Your own saved column layouts in this tenant - every one, or the
    tables named. Rows that are not column layouts (the dashboard) are left
    out."""
    qs = UserPreference.objects.filter(user=user, tenant=tenant)
    if tables != "all":
        if not isinstance(tables, list) or not all(isinstance(t, str) for t in tables):
            raise _Bad("tables", 'must be "all" or a list of table ids')
        qs = qs.filter(table_id__in=tables)
    out = {}
    for row in qs:
        layout = clean_layout(row.data)
        if layout is not None:
            out[row.table_id] = layout
    return out


def _counts(layout: dict) -> dict:
    hidden = set(layout.get("hidden", []))
    order = layout.get("order", [])
    return {
        "shown": len([c for c in order if c not in hidden]),
        "hidden": len(hidden),
        "pinned": len(layout.get("pinned", [])),
    }


def _out(p: LayoutPreset) -> dict:
    return {
        "id": str(p.pk),
        "name": p.name,
        "description": p.description,
        "everyone": p.everyone,
        "weight": p.weight,
        "users": [
            {"id": u.pk, "username": u.get_username(),
             "display_name": u.get_full_name() or u.get_username()}
            for u in p.users.all()
        ],
        "groups": [{"id": g.pk, "name": g.name} for g in p.groups.all()],
        "tables": {tid: _counts(lay) for tid, lay in sorted(p.layouts.items())
                   if isinstance(lay, dict)},
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        "created_by": p.created_by.get_username() if p.created_by_id else None,
    }


def _apply(p: LayoutPreset, data: dict, user, tenant, *, creating: bool):
    """Write the editable fields from ``data`` onto ``p``; returns the M2M
    sets to apply after save (``None`` = unchanged)."""
    if creating or "name" in data:
        name = data.get("name")
        if not isinstance(name, str) or not name.strip():
            raise _Bad("name", "required")
        if len(name.strip()) > 100:
            raise _Bad("name", "at most 100 characters")
        p.name = name.strip()
    if "description" in data:
        if not isinstance(data["description"], str):
            raise _Bad("description", "must be text")
        p.description = data["description"]
    if "everyone" in data:
        if not isinstance(data["everyone"], bool):
            raise _Bad("everyone", "must be true or false")
        p.everyone = data["everyone"]
    if "weight" in data:
        w = data["weight"]
        if not isinstance(w, int) or isinstance(w, bool) or not 0 <= w <= 32767:
            raise _Bad("weight", "a whole number from 0 to 32767")
        p.weight = w
    layouts = dict(p.layouts or {})
    if creating or "capture" in data:
        layouts.update(_my_layouts(user, tenant, data.get("capture", "all")))
    remove = data.get("remove_tables")
    if remove is not None:
        if not isinstance(remove, list) or not all(isinstance(t, str) for t in remove):
            raise _Bad("remove_tables", "must be a list of table ids")
        for tid in remove:
            layouts.pop(tid, None)
    if len(layouts) > MAX_TABLES:
        raise _Bad("capture", "too many tables")
    p.layouts = layouts
    user_ids = _ids(data, "user_ids")
    group_ids = _ids(data, "group_ids")
    users = _users_of_tenant(user_ids, tenant) if user_ids is not None else None
    groups = _groups(group_ids) if group_ids is not None else None
    return users, groups


def _bad(e: _Bad) -> JsonResponse:
    return JsonResponse({e.field: [str(e)]}, status=400)


def _save(p, users, groups):
    try:
        with transaction.atomic():
            p.save()
            if users is not None:
                p.users.set(users)
            if groups is not None:
                p.groups.set(groups)
    except IntegrityError:
        raise _Bad("name", "a preset with this name already exists") from None


def _qs(tenant):
    return (
        LayoutPreset.objects.filter(tenant=tenant)
        .select_related("created_by")
        .prefetch_related("users", "groups")
    )


@login_required
@require_http_methods(["GET", "POST"])
def presets(request):
    tenant, err = _gate(request)
    if err:
        return err
    if request.method == "GET":
        return JsonResponse({"results": [_out(p) for p in _qs(tenant)]})
    try:
        data = _body(request)
        p = LayoutPreset(tenant=tenant, created_by=request.user)
        users, groups = _apply(p, data, request.user, tenant, creating=True)
        _save(p, users, groups)
    except _Bad as e:
        return _bad(e)
    return JsonResponse(_out(_qs(tenant).get(pk=p.pk)), status=201)


def _find(tenant, pk):
    return _qs(tenant).filter(pk=pk).first()


@login_required
@require_http_methods(["GET", "PATCH", "DELETE"])
def preset_detail(request, pk):
    tenant, err = _gate(request)
    if err:
        return err
    p = _find(tenant, pk)
    if p is None:
        return JsonResponse({"error": "not found"}, status=404)
    if request.method == "GET":
        return JsonResponse(_out(p))
    if request.method == "DELETE":
        p.delete()
        return JsonResponse({"ok": True, "deleted": True})
    try:
        data = _body(request)
        users, groups = _apply(p, data, request.user, tenant, creating=False)
        _save(p, users, groups)
    except _Bad as e:
        return _bad(e)
    return JsonResponse(_out(_find(tenant, pk)))


def _reset_rows(p: LayoutPreset):
    """The personal layouts a reset of ``p`` drops: its assignees' own rows
    for the tables it covers, in its tenant."""
    rows = UserPreference.objects.filter(
        tenant_id=p.tenant_id, user__isnull=False, table_id__in=list(p.layouts)
    )
    if p.everyone:
        return rows
    user_ids = set(p.users.values_list("pk", flat=True))
    user_ids |= set(
        get_user_model().objects.filter(groups__in=p.groups.all())
        .values_list("pk", flat=True)
    )
    return rows.filter(user_id__in=user_ids)


@login_required
@require_http_methods(["POST"])
def preset_reset(request, pk):
    """Drop the assignees' own layouts for the preset's tables so the preset
    applies to them too. ``{"dry_run": true}`` only counts."""
    tenant, err = _gate(request)
    if err:
        return err
    p = _find(tenant, pk)
    if p is None:
        return JsonResponse({"error": "not found"}, status=404)
    try:
        data = _body(request)
    except _Bad as e:
        return _bad(e)
    rows = _reset_rows(p)
    found = list(rows.values_list("user_id", "table_id"))
    counts = {
        "users": len({u for u, _ in found}),
        "tables": len({t for _, t in found}),
        "layouts": len(found),
    }
    if data.get("dry_run", False) is True:
        return JsonResponse({"dry_run": True, **counts})
    with transaction.atomic():
        rows.delete()
        _record(p, ChangeAction.UPDATE, {
            "personal_layouts_reset": {"old": None, "new": counts},
        })
    return JsonResponse({"dry_run": False, **counts})
