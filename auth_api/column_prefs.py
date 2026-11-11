"""JSON endpoints + helpers for per-user table column preferences.

Three operations live here, all scoped to ``(tenant, table_id)`` for the
currently-signed-in user:

  * ``GET  /auth/prefs/columns/<table_id>/`` - returns the effective pref
    (user's own row → tenant default → ``null``).
  * ``PUT  /auth/prefs/columns/<table_id>/`` - saves the user's row.
  * ``DELETE /auth/prefs/columns/<table_id>/`` - wipes the user's row (the
    next read falls back to the tenant default).

Plus an admin-only flavour:

  * ``PUT /auth/prefs/columns/<table_id>/default/`` - saves the tenant's
    default (the ``user=NULL`` row); needs the ``users.manage`` perm.
"""
from __future__ import annotations

import json

from django.contrib.auth.decorators import login_required
from django.db.models import Q
from django.http import JsonResponse, HttpResponseBadRequest
from django.views.decorators.http import require_http_methods

from api.views import _get_active_tenant
from .models import UserPreference


@login_required
@require_http_methods(["GET"])
def column_prefs_bulk(request):
    """Per-table pref *summary* for every table the user/tenant has a row for -
    one response instead of N per-table requests (the Preferences page only
    needs source/forced/has-own-row, not the full layout). Two queries total.
    """
    tenant = _get_active_tenant(request)
    if tenant is None:
        return JsonResponse({})
    defaults = {
        p.table_id: p
        for p in UserPreference.objects.filter(user__isnull=True, tenant=tenant)
    }
    own = {
        p.table_id: True
        for p in UserPreference.objects.filter(user=request.user, tenant=tenant)
    }
    out = {}
    for tid in set(defaults) | set(own):
        d = defaults.get(tid)
        has_own = tid in own
        if d is not None and d.forced:
            out[tid] = {"source": "tenant_forced", "is_forced": True,
                        "has_user_row": has_own}
        elif has_own:
            out[tid] = {"source": "user", "is_forced": False, "has_user_row": True}
        elif d is not None:
            out[tid] = {"source": "default", "is_forced": False,
                        "has_user_row": False}
    return JsonResponse(out)
from .permissions import can_manage_admin


def _validate_payload(raw_body: bytes) -> dict:
    try:
        data = json.loads(raw_body or b"{}")
    except json.JSONDecodeError as e:
        raise ValueError(f"invalid JSON: {e}")
    if not isinstance(data, dict):
        raise ValueError("body must be a JSON object")
    order = data.get("order", [])
    hidden = data.get("hidden", [])
    if not isinstance(order, list) or not all(isinstance(x, str) for x in order):
        raise ValueError("order must be a list of strings")
    if not isinstance(hidden, list) or not all(isinstance(x, str) for x in hidden):
        raise ValueError("hidden must be a list of strings")
    out = {"order": order, "hidden": hidden}
    # Columns pinned to the left edge, in pin order. Optional: a layout saved
    # before pins existed has no key and reads as "nothing pinned".
    if "pinned" in data:
        pinned = data["pinned"]
        if not isinstance(pinned, list) or not all(
            isinstance(x, str) for x in pinned
        ):
            raise ValueError("pinned must be a list of strings")
        out["pinned"] = list(dict.fromkeys(pinned))
    return out


def _effective_pref(user, tenant, table_id):
    """The pref that should apply for this user/tenant/table.

    Resolution order (highest wins):

      1. A *forced* tenant default (``user=NULL`` + ``forced=True``) - locks
         everyone; the user's own row is ignored while it's forced.
      2. The user's own row.
      3. An ordinary (unforced) tenant default.
      4. ``None`` so the client uses its discovered order.

    Returns ``(data, source, is_forced)`` - ``data`` is ``None`` only for
    the ``"none"`` source.
    """
    if tenant is None:
        return None, "none", False
    default = UserPreference.objects.filter(
        user__isnull=True, tenant=tenant, table_id=table_id
    ).first()
    if default is not None and default.forced:
        return default.data, "tenant_forced", True
    own = UserPreference.objects.filter(
        user=user, tenant=tenant, table_id=table_id
    ).first()
    if own is not None:
        return own.data, "user", False
    if default is not None:
        return default.data, "default", False
    return None, "none", False


def clean_layout(raw) -> dict | None:
    """A stored layout reduced to its known keys, or ``None`` when it is not a
    column layout at all. Tolerant: what a preset or an old row holds is read,
    never trusted to be well formed."""
    if not isinstance(raw, dict):
        return None
    out = {}
    for key in ("order", "hidden", "pinned"):
        val = raw.get(key)
        if val is None:
            continue
        if not isinstance(val, list):
            return None
        out[key] = [x for x in val if isinstance(x, str)]
    if "order" not in out and "hidden" not in out:
        return None
    out.setdefault("order", [])
    out.setdefault("hidden", [])
    return out


def preset_for(user, tenant, table_id):
    """The layout preset that supplies ``user``'s default for ``table_id``.

    Presets assigned to the user come first, then presets assigned to one of
    their groups, then presets for everyone in the tenant; within a level the
    lowest weight wins, then the name. One query.
    """
    from django.db.models import Case, Exists, IntegerField, OuterRef, Value, When

    from .models import LayoutPreset

    through_u = LayoutPreset.users.through
    through_g = LayoutPreset.groups.through
    by_user = Exists(
        through_u.objects.filter(layoutpreset_id=OuterRef("pk"), user_id=user.pk)
    )
    by_group = Exists(
        through_g.objects.filter(
            layoutpreset_id=OuterRef("pk"), group__user=user
        )
    )
    return (
        LayoutPreset.objects.filter(tenant=tenant, layouts__has_key=table_id)
        .annotate(by_user=by_user, by_group=by_group)
        .filter(Q(by_user=True) | Q(by_group=True) | Q(everyone=True))
        .annotate(
            level=Case(
                When(by_user=True, then=Value(0)),
                When(by_group=True, then=Value(1)),
                default=Value(2),
                output_field=IntegerField(),
            )
        )
        .order_by("level", "weight", "name")
        .only("id", "name", "layouts")
        .first()
    )


def resolve_pref(user, tenant, table_id):
    """The column layout for this user/tenant/table, and where it came from.

    Resolution order (highest wins):

      1. A *forced* tenant default - locks everyone.
      2. The user's own saved layout.
      3. A layout preset assigned to the user, then to their groups, then to
         everyone (:func:`preset_for`).
      4. The ordinary tenant default published before presets existed.
      5. ``None`` - the table's built-in layout.

    Returns ``(data, source, is_forced, preset)``; ``preset`` is
    ``{"id", "name"}`` of the preset that supplies the user's *default* (what
    Reset returns to) even when their own layout wins, else ``None``. Two
    queries.
    """
    if tenant is None:
        return None, "none", False, None
    rows = list(
        UserPreference.objects.filter(tenant=tenant, table_id=table_id).filter(
            Q(user=user) | Q(user__isnull=True)
        )
    )
    default = next((r for r in rows if r.user_id is None), None)
    own = next((r for r in rows if r.user_id is not None), None)
    if default is not None and default.forced:
        return default.data, "tenant_forced", True, None
    preset = preset_for(user, tenant, table_id)
    preset_layout = clean_layout(preset.layouts.get(table_id)) if preset else None
    if preset_layout is None:
        preset = None
    info = {"id": str(preset.pk), "name": preset.name} if preset else None
    if own is not None:
        return own.data, "user", False, info
    if preset is not None:
        return preset_layout, "preset", False, info
    if default is not None:
        return default.data, "default", False, None
    return None, "none", False, None


@login_required
@require_http_methods(["GET", "PUT", "DELETE"])
def column_pref(request, table_id):
    tenant = _get_active_tenant(request)

    if request.method == "GET":
        # Every list page fetches its column prefs on load, including before a
        # tenant is selected (e.g. first login). Return the empty default with
        # 200 rather than 400 so first-load is clean - there are simply no
        # stored prefs yet.
        if tenant is None:
            return JsonResponse(
                {"source": "none", "data": None, "is_forced": False, "preset": None}
            )
        data, source, is_forced, preset = resolve_pref(
            request.user, tenant, table_id
        )
        return JsonResponse({
            "source": source, "data": data, "is_forced": is_forced,
            "preset": preset,
        })

    # Mutations still require an active tenant - there's nowhere to store them.
    if tenant is None:
        return JsonResponse({"error": "no active tenant"}, status=400)

    # Both PUT and DELETE mutate the user's own row - refuse while a forced
    # tenant default is in effect so the admin lock can't be worked around.
    forced_default = UserPreference.objects.filter(
        user__isnull=True, tenant=tenant, table_id=table_id, forced=True
    ).first()

    if request.method == "DELETE":
        UserPreference.objects.filter(
            user=request.user, tenant=tenant, table_id=table_id
        ).delete()
        return JsonResponse({"ok": True, "deleted": True})

    # PUT - save the user's row.
    if forced_default is not None:
        return JsonResponse(
            {"error": "layout is locked by a tenant administrator",
             "is_forced": True},
            status=409,
        )
    try:
        payload = _validate_payload(request.body)
    except ValueError as e:
        return HttpResponseBadRequest(str(e))
    obj, _ = UserPreference.objects.update_or_create(
        user=request.user, tenant=tenant, table_id=table_id,
        defaults={"data": payload},
    )
    return JsonResponse(
        {"ok": True, "source": "user", "data": obj.data, "is_forced": False}
    )


@login_required
@require_http_methods(["PUT", "DELETE"])
def column_pref_default(request, table_id):
    """Admin-only: publish or clear the tenant-wide default for a table.

    The PUT body may carry ``"forced": true`` alongside ``order`` / ``hidden``
    to lock the layout for every user in the tenant.
    """
    tenant = _get_active_tenant(request)
    if not can_manage_admin(request.user, tenant):
        return JsonResponse({"error": "needs admin access"}, status=403)
    if tenant is None:
        return JsonResponse({"error": "no active tenant"}, status=400)

    if request.method == "DELETE":
        UserPreference.objects.filter(
            user__isnull=True, tenant=tenant, table_id=table_id
        ).delete()
        return JsonResponse({"ok": True, "deleted": True})

    try:
        raw = json.loads(request.body or b"{}")
        if not isinstance(raw, dict):
            raise ValueError("body must be a JSON object")
        payload = _validate_payload(request.body)
        forced = bool(raw.get("forced", False))
    except (ValueError, json.JSONDecodeError) as e:
        return HttpResponseBadRequest(str(e))
    obj, _ = UserPreference.objects.update_or_create(
        user=None, tenant=tenant, table_id=table_id,
        defaults={"data": payload, "forced": forced},
    )
    return JsonResponse(
        {"ok": True, "source": "default", "data": obj.data, "forced": obj.forced}
    )
