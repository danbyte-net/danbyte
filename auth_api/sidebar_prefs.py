"""The personal sidebar layout (#285) and its tenant default.

A user's layout is the ``sidebar`` preference in :mod:`auth_api.user_prefs`:
it lives on ``UserProfile.prefs``, so it follows the user across browsers and
tenants, and it cascades user → ``Tenant.prefs`` → none like every other
preference. ``PUT /api/me/prefs/ {"sidebar": …}`` saves it and
``{"sidebar": null}`` resets it.

Only ids are stored - hidden ids, the section order and the entry order per
section - never a snapshot of the menu. The client merges them over the menu
it ships, so a page added in a later release still shows up for someone with a
saved layout. Section and entry ids are frontend concepts and are not checked
against a catalog here; the client ignores ids it does not know.

Hiding is a menu convenience only: routes and permissions are untouched.

  * ``GET    /api/prefs/sidebar/default/`` - the tenant default (admins).
  * ``PUT    /api/prefs/sidebar/default/`` - publish one.
  * ``DELETE /api/prefs/sidebar/default/`` - clear it.
"""
from __future__ import annotations

import json

from django.http import HttpResponseBadRequest, JsonResponse
from django.views.decorators.http import require_http_methods

from .permissions import can_manage_admin

KEY = "sidebar"
VERSION = 1
_MAX_IDS = 500
_MAX_ID_LEN = 200
_MAX_SECTIONS = 100


def _ids(value, field: str) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f"{field} must be a list of ids")
    if len(value) > _MAX_IDS:
        raise ValueError(f"{field} holds at most {_MAX_IDS} ids")
    out: list[str] = []
    seen: set[str] = set()
    for v in value:
        if not isinstance(v, str) or not v or len(v) > _MAX_ID_LEN:
            raise ValueError(f"{field} ids must be non-empty strings of at most "
                             f"{_MAX_ID_LEN} characters")
        if v not in seen:
            seen.add(v)
            out.append(v)
    return out


def clean_layout(data) -> dict:
    """A ``{v: 1, order, hidden, items}`` layout, validated and stripped to
    known keys. Raises ``ValueError`` with a readable message."""
    if not isinstance(data, dict) or data.get("v") != VERSION:
        raise ValueError(f"sidebar must be a {{v: {VERSION}, …}} layout")
    items = data.get("items", {})
    if not isinstance(items, dict):
        raise ValueError("items must be an object of section id → entry ids")
    if len(items) > _MAX_SECTIONS:
        raise ValueError(f"items holds at most {_MAX_SECTIONS} sections")
    clean_items = {}
    for section, entries in items.items():
        if not isinstance(section, str) or not section or len(section) > _MAX_ID_LEN:
            raise ValueError("items keys must be section ids")
        clean_items[section] = _ids(entries, f"items.{section}")
    return {
        "v": VERSION,
        "order": _ids(data.get("order", []), "order"),
        "hidden": _ids(data.get("hidden", []), "hidden"),
        "items": clean_items,
    }


@require_http_methods(["GET", "PUT", "DELETE"])
def sidebar_default(request):
    """Admin-only: read, publish or clear the active tenant's default layout -
    what members with no layout of their own get."""
    from api.views import _get_active_tenant

    from .user_prefs import set_tenant

    if not request.user.is_authenticated:
        return JsonResponse({"error": "auth required"}, status=401)
    tenant = _get_active_tenant(request)
    if not can_manage_admin(request.user, tenant):
        return JsonResponse({"error": "needs admin access"}, status=403)
    if tenant is None:
        return JsonResponse({"error": "no active tenant"}, status=400)

    if request.method == "GET":
        return JsonResponse({"data": (tenant.prefs or {}).get(KEY)})

    if request.method == "DELETE":
        set_tenant(tenant, KEY, None)
        return JsonResponse({"ok": True, "deleted": True})

    try:
        layout = clean_layout(json.loads(request.body or b"{}"))
    except (ValueError, json.JSONDecodeError) as e:
        return HttpResponseBadRequest(str(e))
    set_tenant(tenant, KEY, layout)
    return JsonResponse({"ok": True, "data": layout})
