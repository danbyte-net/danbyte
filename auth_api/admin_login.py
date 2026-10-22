"""The Django admin signs in through the app, never with its own form.

``/admin/login/`` used to take a password on its own, skipping the app's
sign-in: no second factor (admin-required or self-enrolled), no rate limit,
no SSO. It now answers every request with a redirect to ``/login`` carrying
where to go next, so one sign-in path guards the whole site. ``LOGIN_URL``
still points here, so the admin, ``django-rq`` and anything else built on
``login_required`` end up there too.
"""
from __future__ import annotations

from urllib.parse import urlencode

from django.core.exceptions import PermissionDenied
from django.http import HttpResponseRedirect
from django.utils.http import url_has_allowed_host_and_scheme

ADMIN_HOME = "/admin/"


def _safe_next(request) -> str:
    """A path on this site, or the admin home. Never another host, and never
    a protocol-relative ``//host`` or backslash form a browser reads as one."""
    nxt = request.GET.get("next") or ""
    if (
        nxt.startswith("/")
        and not nxt.startswith(("//", "/\\"))
        and url_has_allowed_host_and_scheme(
            nxt, allowed_hosts={request.get_host()}, require_https=request.is_secure()
        )
    ):
        return nxt
    return ADMIN_HOME


def admin_login(request, extra_context=None):
    """Replaces ``admin.site.login``. Any method: a POST with a password is
    not looked at."""
    nxt = _safe_next(request)
    user = request.user
    if user.is_authenticated:
        if user.is_active and user.is_staff:
            return HttpResponseRedirect(nxt)
        # Signed in but not admin material: sending them to /login would come
        # straight back here and loop.
        raise PermissionDenied("This account has no access to the admin site.")
    return HttpResponseRedirect("/login?" + urlencode({"redirect": nxt}))
