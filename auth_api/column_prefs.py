"""JSON endpoints + helpers for per-user table column preferences.

Three operations live here, all scoped to ``(tenant, table_id)`` for the
currently-signed-in user:

  * ``GET  /auth/prefs/columns/<table_id>/`` — returns the effective pref
    (user's own row → tenant default → ``null``).
  * ``PUT  /auth/prefs/columns/<table_id>/`` — saves the user's row.
  * ``DELETE /auth/prefs/columns/<table_id>/`` — wipes the user's row (the
    next read falls back to the tenant default).

Plus an admin-only flavour:

  * ``PUT /auth/prefs/columns/<table_id>/default/`` — saves the tenant's
    default (the ``user=NULL`` row); needs the ``users.manage`` perm.
"""
from __future__ import annotations

import json

from django.contrib.auth.decorators import login_required
from django.http import JsonResponse, HttpResponseBadRequest
from django.views.decorators.http import require_http_methods

from api.views import _get_active_tenant
from .models import UserPreference


@login_required
@require_http_methods(["GET"])
def column_prefs_bulk(request):
    """Per-table pref *summary* for every table the user/tenant has a row for —
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
    return {"order": order, "hidden": hidden}


def _effective_pref(user, tenant, table_id):
    """The pref that should apply for this user/tenant/table.

    Resolution order (highest wins):

      1. A *forced* tenant default (``user=NULL`` + ``forced=True``) — locks
         everyone; the user's own row is ignored while it's forced.
      2. The user's own row.
      3. An ordinary (unforced) tenant default.
      4. ``None`` so the client uses its discovered order.

    Returns ``(data, source, is_forced)`` — ``data`` is ``None`` only for
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


@login_required
@require_http_methods(["GET", "PUT", "DELETE"])
def column_pref(request, table_id):
    tenant = _get_active_tenant(request)

    if request.method == "GET":
        # Every list page fetches its column prefs on load, including before a
        # tenant is selected (e.g. first login). Return the empty default with
        # 200 rather than 400 so first-load is clean — there are simply no
        # stored prefs yet.
        if tenant is None:
            return JsonResponse({"source": "none", "data": None, "is_forced": False})
        data, source, is_forced = _effective_pref(request.user, tenant, table_id)
        return JsonResponse({"source": source, "data": data, "is_forced": is_forced})

    # Mutations still require an active tenant — there's nowhere to store them.
    if tenant is None:
        return JsonResponse({"error": "no active tenant"}, status=400)

    # Both PUT and DELETE mutate the user's own row — refuse while a forced
    # tenant default is in effect so the admin lock can't be worked around.
    forced_default = UserPreference.objects.filter(
        user__isnull=True, tenant=tenant, table_id=table_id, forced=True
    ).first()

    if request.method == "DELETE":
        UserPreference.objects.filter(
            user=request.user, tenant=tenant, table_id=table_id
        ).delete()
        return JsonResponse({"ok": True, "deleted": True})

    # PUT — save the user's row.
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
