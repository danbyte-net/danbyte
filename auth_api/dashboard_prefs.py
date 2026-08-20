"""The per-user dashboard layout, stored server-side (#41).

A sibling of :mod:`column_prefs` reusing the same :class:`UserPreference`
model and resolution helper - one row per ``(user, tenant)`` with
``table_id="dashboard"``. A separate view rather than the column one because
the payloads validate differently: columns are ``{order, hidden}``, a
dashboard layout is ``{v: 2, items: [{id, x, y, w, h}]}``.

  * ``GET    /api/prefs/dashboard/`` - the user's effective layout
    (own row → ``null``; the tenant default rides in the dashboard payload).
  * ``PUT    /api/prefs/dashboard/`` - save the user's layout.
  * ``DELETE /api/prefs/dashboard/`` - reset: next read falls back to the
    tenant default, then the built-in layout.

Widget ids are not validated here - the catalog is a frontend concept, and
the client drops unknown ids on read anyway. Geometry is: a span outside
1..12 or 60k items is a broken client, not a preference.
"""
from __future__ import annotations

import json

from django.contrib.auth.decorators import login_required
from django.http import HttpResponseBadRequest, JsonResponse
from django.views.decorators.http import require_http_methods

from api.views import _get_active_tenant

from .column_prefs import _effective_pref
from .models import UserPreference

TABLE_ID = "dashboard"
_MAX_ITEMS = 100
_MAX_SPAN = 12


def _validate_layout(raw_body: bytes) -> dict:
    try:
        data = json.loads(raw_body or b"{}")
    except json.JSONDecodeError as e:
        raise ValueError(f"invalid JSON: {e}")
    if not isinstance(data, dict) or data.get("v") != 2:
        raise ValueError("body must be a {v: 2, items: [...]} layout")
    items = data.get("items")
    if not isinstance(items, list) or len(items) > _MAX_ITEMS:
        raise ValueError(f"items must be a list of at most {_MAX_ITEMS}")
    clean = []
    for it in items:
        if not isinstance(it, dict) or not isinstance(it.get("id"), str):
            raise ValueError("each item needs a string id")
        out = {"id": it["id"]}
        for key in ("x", "y", "w", "h"):
            v = it.get(key)
            if not isinstance(v, int) or v < 0 or v > max(_MAX_SPAN, 10_000):
                raise ValueError(f"item {it['id']}: {key} must be a small int")
            out[key] = v
        if out["w"] > _MAX_SPAN or out["h"] > _MAX_SPAN:
            raise ValueError(f"item {it['id']}: span too large")
        clean.append(out)
    return {"v": 2, "items": clean}


@login_required
@require_http_methods(["GET", "PUT", "DELETE"])
def dashboard_pref(request):
    tenant = _get_active_tenant(request)

    if request.method == "GET":
        if tenant is None:
            return JsonResponse({"source": "none", "data": None})
        data, source, _forced = _effective_pref(request.user, tenant, TABLE_ID)
        return JsonResponse({"source": source, "data": data})

    if tenant is None:
        return JsonResponse({"error": "no active tenant"}, status=400)

    if request.method == "DELETE":
        UserPreference.objects.filter(
            user=request.user, tenant=tenant, table_id=TABLE_ID
        ).delete()
        return JsonResponse({"ok": True, "deleted": True})

    try:
        payload = _validate_layout(request.body)
    except ValueError as e:
        return HttpResponseBadRequest(str(e))
    obj, _ = UserPreference.objects.update_or_create(
        user=request.user, tenant=tenant, table_id=TABLE_ID,
        defaults={"data": payload},
    )
    return JsonResponse({"ok": True, "source": "user", "data": obj.data})
