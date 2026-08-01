"""SSO HTTP endpoints — OIDC login initiation, callback, and a public list of
enabled providers for the login page.

The browser hits ``/api/auth/sso/<slug>/login/`` (from a login-page button),
gets redirected to the IdP, and comes back to ``/api/auth/sso/<slug>/callback/``
where we validate and establish the Django session, then land on the SPA. State
+ nonce live in the server-side session across the round trip.
"""
from __future__ import annotations

from datetime import timedelta
from urllib.parse import quote

from django.contrib.auth import login as auth_login
from django.http import HttpResponse, HttpResponseRedirect
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from .models import IdentityProvider
from .sso import SsoError, build_authorize_url, exchange_code, resolve_user

MODEL_BACKEND = "django.contrib.auth.backends.ModelBackend"
# How long a SP-initiated SAML AuthnRequest stays valid for its response.
SAML_REQUEST_MAX_AGE = timedelta(minutes=10)


def _base_url(request) -> str:
    return request.build_absolute_uri("/").rstrip("/")


def _acs_uri(request, slug: str) -> str:
    return request.build_absolute_uri(f"/api/auth/sso/{slug}/acs/")


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
    """Enabled SSO providers, for rendering login-page buttons (pre-auth).

    Only deployment-wide providers are advertised on the shared, unauthenticated
    login page; tenant-scoped providers aren't exposed to anonymous callers."""
    provs = list(
        IdentityProvider.objects.filter(enabled=True, tenant__isnull=True)
        .order_by("name")
        .values("name", "slug", "protocol")
    )
    return Response({"providers": provs})


@require_GET
def sso_login(request, slug):
    """Kick off SSO — OIDC authorize redirect, or SAML AuthnRequest redirect."""
    import secrets as pysecrets

    provider = IdentityProvider.objects.filter(slug=slug, enabled=True).first()
    if provider is None:
        return _login_redirect("Unknown or disabled SSO provider.")

    if provider.protocol == IdentityProvider.Protocol.SAML:
        from .models import SamlLoginState
        from .saml import SamlError, build_authn_request_redirect

        try:
            url, request_id = build_authn_request_redirect(
                provider, _acs_uri(request, slug), _base_url(request), relay_state=slug
            )
        except SamlError as exc:
            return _login_redirect(str(exc))
        # Record the outstanding request in the DB (not the session) — the IdP's
        # ACS POST is cross-site and the SameSite=Lax session cookie won't ride
        # along, so the ACS matches the response by InResponseTo against this row.
        SamlLoginState.objects.create(request_id=request_id, provider=provider)
        SamlLoginState.objects.filter(
            created_at__lt=timezone.now() - SAML_REQUEST_MAX_AGE
        ).delete()
        return HttpResponseRedirect(url)

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
def sso_metadata(request, slug):
    """SP metadata XML for a SAML provider — hand this to the IdP."""
    provider = IdentityProvider.objects.filter(
        slug=slug, protocol=IdentityProvider.Protocol.SAML
    ).first()
    if provider is None:
        return HttpResponse("Not found", status=404)
    from .saml import sp_metadata_xml

    xml = sp_metadata_xml(provider, _base_url(request), _acs_uri(request, slug))
    return HttpResponse(xml, content_type="application/samlmetadata+xml")


@csrf_exempt
@require_POST
def sso_acs(request, slug):
    """SAML assertion consumer — the IdP POSTs the signed Response here. CSRF-
    exempt (cross-site POST); security is the signed, audience/recipient/
    InResponseTo-checked assertion, not a CSRF token."""
    provider = IdentityProvider.objects.filter(
        slug=slug, enabled=True, protocol=IdentityProvider.Protocol.SAML
    ).first()
    if provider is None:
        return _login_redirect("Unknown or disabled SSO provider.")

    saml_response = request.POST.get("SAMLResponse")
    if not saml_response:
        return _login_redirect("Missing SAML response.")

    from .models import SamlLoginState
    from .saml import SamlError, parse_and_validate

    def _consume(in_response_to: str) -> None:
        """Single-use, atomic check that this response answers a request we
        issued recently and haven't already consumed (replay protection)."""
        now = timezone.now()
        claimed = SamlLoginState.objects.filter(
            request_id=in_response_to, provider=provider,
            consumed_at__isnull=True,
            created_at__gte=now - SAML_REQUEST_MAX_AGE,
        ).update(consumed_at=now)
        if not claimed:
            raise SamlError(
                "This SAML login is unknown, expired, or already used. Start "
                "again from Danbyte's sign-in page."
            )

    try:
        claims = parse_and_validate(
            provider, saml_response, _acs_uri(request, slug),
            _base_url(request), consume_request_id=_consume,
        )
        user = resolve_user(provider, claims)
    except (SamlError, SsoError) as exc:
        return _login_redirect(str(exc))

    request.session.pop("sso_slug", None)
    if not user.is_active:
        return _login_redirect("This account is disabled.")
    auth_login(request, user, backend=MODEL_BACKEND)
    return HttpResponseRedirect("/")


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
