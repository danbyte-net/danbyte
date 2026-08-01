"""SSO HTTP endpoints — OIDC login initiation, callback, and a public list of
enabled providers for the login page.

The browser hits ``/api/auth/sso/<slug>/login/`` (from a login-page button),
gets redirected to the IdP, and comes back to ``/api/auth/sso/<slug>/callback/``
where we validate and establish the Django session, then land on the SPA. State
+ nonce live in the server-side session across the round trip.
"""
from __future__ import annotations

from urllib.parse import quote

from django.contrib.auth import login as auth_login
from django.http import HttpResponseRedirect
from django.views.decorators.http import require_GET
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from .models import IdentityProvider
from .sso import SsoError, build_authorize_url, exchange_code, resolve_user

MODEL_BACKEND = "django.contrib.auth.backends.ModelBackend"


def _login_redirect(error: str = "") -> HttpResponseRedirect:
    """Back to the SPA login page, optionally with an error to surface."""
    return HttpResponseRedirect(
        "/login" + (f"?sso_error={quote(error)}" if error else "")
    )


def _callback_uri(request, slug: str) -> str:
    # Absolute, honouring the X-Forwarded-Proto nginx sets — must match the
    # redirect URI registered at the IdP.
    return request.build_absolute_uri(f"/api/auth/sso/{slug}/callback/")


@api_view(["GET"])
@permission_classes([AllowAny])
def sso_providers(request):
    """Enabled SSO providers, for rendering login-page buttons (pre-auth)."""
    provs = list(
        IdentityProvider.objects.filter(enabled=True)
        .order_by("name")
        .values("name", "slug", "protocol")
    )
    return Response({"providers": provs})


@require_GET
def sso_login(request, slug):
    """Kick off OIDC: stash state+nonce, redirect to the IdP."""
    import secrets as pysecrets

    provider = IdentityProvider.objects.filter(
        slug=slug, enabled=True, protocol=IdentityProvider.Protocol.OIDC
    ).first()
    if provider is None:
        return _login_redirect("Unknown or disabled SSO provider.")

    state = pysecrets.token_urlsafe(24)
    nonce = pysecrets.token_urlsafe(24)
    request.session["sso_state"] = state
    request.session["sso_nonce"] = nonce
    request.session["sso_slug"] = slug
    try:
        url = build_authorize_url(provider, _callback_uri(request, slug), state, nonce)
    except SsoError as exc:
        return _login_redirect(str(exc))
    return HttpResponseRedirect(url)


@require_GET
def sso_callback(request, slug):
    """Validate the IdP response, provision/match the user, log them in."""
    provider = IdentityProvider.objects.filter(
        slug=slug, enabled=True, protocol=IdentityProvider.Protocol.OIDC
    ).first()
    if provider is None:
        return _login_redirect("Unknown or disabled SSO provider.")

    if request.GET.get("error"):
        return _login_redirect(
            request.GET.get("error_description") or request.GET["error"]
        )

    code = request.GET.get("code")
    state = request.GET.get("state")
    # state must match this session's, and belong to this provider — CSRF guard.
    if (
        not code
        or not state
        or state != request.session.get("sso_state")
        or slug != request.session.get("sso_slug")
    ):
        return _login_redirect("SSO state check failed — please try again.")
    nonce = request.session.get("sso_nonce")

    try:
        claims = exchange_code(provider, code, _callback_uri(request, slug), nonce)
        user = resolve_user(provider, claims)
    except SsoError as exc:
        return _login_redirect(str(exc))

    for key in ("sso_state", "sso_nonce", "sso_slug"):
        request.session.pop(key, None)

    if not user.is_active:
        return _login_redirect("This account is disabled.")
    # The IdP performed authentication; establish the session directly (no
    # password / local MFA — that's the IdP's job).
    auth_login(request, user, backend=MODEL_BACKEND)
    return HttpResponseRedirect("/")
