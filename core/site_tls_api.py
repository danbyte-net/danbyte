"""The site-certificate card's API - superuser only, like service control.

Everything here is about the host Danbyte runs on, not tenant data: what
``:443`` serves, what was dropped for the root unit, and the four ways to
put a new pair there. Keys arrive in a request body and leave through
``core.site_tls.drop_pair`` into one 0600 file; no endpoint returns one.
"""
from __future__ import annotations

from django.http import Http404, HttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from . import site_tls
from .models import SiteCertificate


def _require_superuser(request):
    return bool(getattr(request.user, "is_superuser", False))


def _denied():
    return Response({"detail": "Superuser required."}, status=403)


@extend_schema(
    summary="The certificate Danbyte is served on: what :443 presents, what was dropped, the apply state (superuser only)",
    tags=["services"], request=None,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT, description="Site certificate status."),
)
@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticated])
def site_certificate(request):
    if not _require_superuser(request):
        return _denied()
    if request.method == "PATCH":
        row = SiteCertificate.load()
        if "auto_renew" in request.data:
            row.auto_renew = bool(request.data.get("auto_renew"))
            row.updated_by = request.user
            row.save(update_fields=["auto_renew", "updated_by", "updated_at"])
    return Response(site_tls.status())


@extend_schema(
    summary="Install an uploaded certificate pair (superuser only)", tags=["services"],
    request=OpenApiTypes.OBJECT,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT, description="The new certificate's facts."),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def site_certificate_upload(request):
    """``{cert, key, chain?}`` as PEM text. The pair is validated (match,
    validity, chain) and dropped for the root unit; the key is not kept."""
    if not _require_superuser(request):
        return _denied()
    cert, key = request.data.get("cert") or "", request.data.get("key") or ""
    if not (isinstance(cert, str) and isinstance(key, str) and cert.strip() and key.strip()):
        return Response({"detail": "cert and key are both needed, as PEM text."}, status=400)
    try:
        facts = site_tls.drop_pair(
            cert, key, chain_pem=str(request.data.get("chain") or ""),
            source=SiteCertificate.Source.UPLOAD, reason="uploaded", user=request.user,
        )
    except site_tls.SiteTlsError as exc:
        return Response({"detail": str(exc)}, status=400)
    return Response(_facts_json(facts), status=201)


@extend_schema(
    summary="Regenerate the self-signed certificate (superuser only)", tags=["services"],
    request=OpenApiTypes.OBJECT,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT, description="The new certificate's facts."),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def site_certificate_self_signed(request):
    """``{names?: [...]}`` - defaults to every name served now plus the
    public host, so a regeneration never narrows how the site is reached."""
    if not _require_superuser(request):
        return _denied()
    names = request.data.get("names")
    if names is not None and not (isinstance(names, list) and all(isinstance(n, str) for n in names)):
        return Response({"detail": "names must be a list of strings."}, status=400)
    try:
        cert_pem, key_pem = site_tls.make_self_signed(names or site_tls.current_names())
        facts = site_tls.drop_pair(
            cert_pem, key_pem, source=SiteCertificate.Source.SELF_SIGNED,
            reason="regenerated", user=request.user,
        )
    except site_tls.SiteTlsError as exc:
        return Response({"detail": str(exc)}, status=400)
    return Response(_facts_json(facts), status=201)


@extend_schema(
    summary="Get the site's certificate from an ACME issuer (superuser only)", tags=["services"],
    request=OpenApiTypes.OBJECT,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT, description="The order that was opened."),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def site_certificate_acme(request):
    """``{issuer | letsencrypt: true, email?, challenge_type: "http-01"|"dns-01",
    names?: [...]}`` - a request and an order for the site's names, issued
    in the background. ``letsencrypt`` makes the tenant's Let's Encrypt
    issuer on first use; otherwise ``issuer`` is one of the active tenant's."""
    from api.views import _get_active_tenant
    from monitoring.models import AcmeOrder, Issuer

    if not _require_superuser(request):
        return _denied()
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    try:
        if request.data.get("letsencrypt"):
            issuer = site_tls.letsencrypt_issuer(
                tenant, request.user, str(request.data.get("email") or request.user.email or ""))
        else:
            issuer = Issuer.objects.filter(
                tenant=tenant, id=request.data.get("issuer"), enabled=True).first()
            if issuer is None:
                return Response({"issuer": "Not found."}, status=400)
    except site_tls.SiteTlsError as exc:
        return Response({"detail": str(exc)}, status=400)
    except (ValueError, TypeError):
        return Response({"issuer": "Not found."}, status=400)
    challenge = request.data.get("challenge_type") or AcmeOrder.Challenge.HTTP01
    if challenge not in {c.value for c in AcmeOrder.Challenge}:
        return Response({"challenge_type": "http-01 or dns-01."}, status=400)
    names = request.data.get("names")
    if names is not None and not (isinstance(names, list) and all(isinstance(n, str) for n in names)):
        return Response({"detail": "names must be a list of strings."}, status=400)
    try:
        order = site_tls.start_acme(tenant, request.user, issuer, challenge,
                                    names or [site_tls.public_host()])
    except site_tls.SiteTlsError as exc:
        return Response({"detail": str(exc)}, status=400)
    except Exception as exc:  # noqa: BLE001 - the secret store, mostly
        return Response({"detail": str(exc)[:300]}, status=400)
    return Response({"order": str(order.id), "status": order.status}, status=202)


@extend_schema(
    summary="Watch the site's own endpoint for expiry (superuser only)", tags=["services"],
    request=None,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT, description="The watched endpoint."),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def site_certificate_watch(request):
    """A watched endpoint for the public host in the active tenant, so the
    existing expiry alerting covers the site's own certificate."""
    from api.views import _get_active_tenant
    from monitoring.models import WatchedEndpoint

    if not _require_superuser(request):
        return _denied()
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    host = site_tls.public_host()
    ep, created = WatchedEndpoint.objects.get_or_create(
        tenant=tenant, host=host, port=443, server_name="",
        defaults={"allow_self_signed": True},
    )
    return Response({"id": str(ep.id), "host": host, "created": created}, status=201 if created else 200)


def _facts_json(f: dict) -> dict:
    return {**f, "not_before": f["not_before"].isoformat(), "not_after": f["not_after"].isoformat()}


@csrf_exempt
@require_GET
def acme_challenge(request, token: str):
    """``/.well-known/acme-challenge/<token>`` - HTTP-01 answered by Danbyte
    itself, from the open orders. Public by nature: the CA fetches it. Only
    a pending token answers; everything else is 404."""
    content = site_tls.challenge_content(token)
    if content is None:
        raise Http404
    return HttpResponse(content, content_type="text/plain")
