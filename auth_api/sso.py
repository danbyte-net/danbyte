"""Single sign-on - OpenID Connect login + JIT provisioning.

OIDC providers are DB-driven (:class:`auth_api.models.IdentityProvider`). We
discover endpoints from the issuer's ``/.well-known/openid-configuration``, run
the standard authorization-code flow with ``state`` + ``nonce``, validate the ID
token against the IdP's JWKS, then match - or, when ``jit_provisioning`` is on,
create - the Danbyte user and re-sync their group membership from the asserted
groups via :class:`SsoGroupMapping`. Only *mapped* IdP groups grant anything.

The IdP is operator-configured (same trust tier as LDAP / the Vault address), so
HTTP to it is direct with TLS verification - not through the tenant SSRF guard.
"""
from __future__ import annotations

import logging
import time
from urllib.parse import urlencode

import requests

log = logging.getLogger("danbyte.sso")

HTTP_TIMEOUT = 10
_DISCOVERY_TTL = 3600
_discovery_cache: dict[str, tuple[float, dict]] = {}


class SsoError(RuntimeError):
    """An SSO login could not be completed (config, network, or validation)."""


def discover(issuer: str) -> dict:
    """The IdP's OpenID configuration document, cached for an hour."""
    issuer = (issuer or "").rstrip("/")
    if not issuer:
        raise SsoError("This provider has no issuer URL configured.")
    now = time.time()
    hit = _discovery_cache.get(issuer)
    if hit and hit[0] > now:
        return hit[1]
    try:
        r = requests.get(
            f"{issuer}/.well-known/openid-configuration", timeout=HTTP_TIMEOUT
        )
    except requests.RequestException as exc:
        raise SsoError(f"Could not reach the identity provider: {exc}") from exc
    if r.status_code != 200:
        raise SsoError(f"OIDC discovery failed ({r.status_code}).")
    doc = r.json()
    _discovery_cache[issuer] = (now + _DISCOVERY_TTL, doc)
    return doc


def build_authorize_url(provider, redirect_uri, state, nonce) -> str:
    """The IdP authorization URL to redirect the browser to."""
    doc = discover(provider.oidc_issuer)
    params = {
        "response_type": "code",
        "client_id": provider.oidc_client_id,
        "redirect_uri": redirect_uri,
        "scope": provider.oidc_scopes or "openid email profile",
        "state": state,
        "nonce": nonce,
    }
    return f"{doc['authorization_endpoint']}?{urlencode(params)}"


def exchange_code(provider, code, redirect_uri, nonce) -> dict:
    """Exchange the authorization code for tokens and return the validated ID-
    token claims (merged with userinfo when groups aren't in the ID token)."""
    doc = discover(provider.oidc_issuer)
    try:
        resp = requests.post(
            doc["token_endpoint"],
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": provider.oidc_client_id,
                "client_secret": provider.client_secret,
            },
            headers={"Accept": "application/json"},
            timeout=HTTP_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise SsoError(f"Token exchange failed: {exc}") from exc
    if resp.status_code != 200:
        raise SsoError(f"Token exchange failed ({resp.status_code}).")
    data = resp.json()
    id_token = data.get("id_token")
    if not id_token:
        raise SsoError("The identity provider returned no ID token.")
    claims = _validate_id_token(id_token, provider, doc, nonce)
    # Groups often aren't in the ID token - pull userinfo if the mapped claim
    # is absent and the provider exposes a userinfo endpoint.
    if provider.claim_groups and provider.claim_groups not in claims:
        info = _userinfo(doc, data.get("access_token"))
        if info:
            claims = {**info, **claims}
    return claims


def _validate_id_token(id_token, provider, doc, nonce) -> dict:
    from authlib.jose import JsonWebKey, jwt
    from authlib.jose.errors import JoseError

    jwks_uri = doc.get("jwks_uri")
    if not jwks_uri:
        raise SsoError("OIDC discovery document has no jwks_uri.")
    try:
        jwks = requests.get(jwks_uri, timeout=HTTP_TIMEOUT).json()
        key = JsonWebKey.import_key_set(jwks)
        claims = jwt.decode(id_token, key)
        claims.validate()  # exp / iat / nbf
    except (requests.RequestException, JoseError, ValueError, KeyError) as exc:
        raise SsoError(f"ID token validation failed: {exc}") from exc

    if claims.get("iss") != doc.get("issuer"):
        raise SsoError("ID token issuer mismatch.")
    aud = claims.get("aud")
    auds = aud if isinstance(aud, list) else [aud]
    if provider.oidc_client_id not in auds:
        raise SsoError("ID token audience mismatch.")
    # With multiple audiences the token MUST name the authorized party, and it
    # must be us - otherwise a token minted for another client could be replayed.
    if len(auds) > 1:
        if claims.get("azp") != provider.oidc_client_id:
            raise SsoError("ID token azp mismatch.")
    if nonce and claims.get("nonce") != nonce:
        raise SsoError("ID token nonce mismatch - possible replay.")
    return dict(claims)


def _userinfo(doc, access_token) -> dict:
    endpoint = doc.get("userinfo_endpoint")
    if not endpoint or not access_token:
        return {}
    try:
        r = requests.get(
            endpoint,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=HTTP_TIMEOUT,
        )
        return r.json() if r.status_code == 200 else {}
    except (requests.RequestException, ValueError):
        return {}


# ── Provisioning ─────────────────────────────────────────────────────────────

def _subject(claims) -> str:
    """The IdP's stable, immutable identifier for the user - OIDC ``sub`` or SAML
    ``NameID``. This, not a mutable email, is what an account is bound to."""
    return (str(claims.get("sub") or claims.get("nameid") or "")).strip()


def _email_verified(claims) -> bool:
    v = claims.get("email_verified")
    return v is True or str(v).strip().lower() == "true"


def _guard_safe_link(user, provider, subject) -> None:
    """Refuse to attach this SSO identity to an existing account when doing so
    could hijack it - the core defence against an IdP asserting someone else's
    email/username to seize their Danbyte account."""
    prof = getattr(user, "profile", None)
    if (prof is not None and prof.sso_provider_id == provider.id
            and prof.sso_subject and subject and prof.sso_subject != subject):
        raise SsoError("This account is linked to a different SSO identity.")
    # A usable password means it's a local login already in use; never let an
    # IdP assertion silently take it over. An admin must link it deliberately.
    if user.has_usable_password():
        raise SsoError(
            "An account with this name already exists. Ask an administrator to "
            "link it to SSO."
        )


def resolve_user(provider, claims):
    """Match or (JIT) create the Danbyte user for these claims, sync names,
    groups, and tenant. Raises :class:`SsoError` when JIT is off and the user is
    unknown, or the claims carry no usable identity.

    Matching is by the IdP's stable **subject** first; an existing local account
    is only linked when it is safe to (:func:`_guard_safe_link`), and an
    unverified email never links an account."""
    from django.contrib.auth.models import User

    from .models import UserProfile

    subject = _subject(claims)
    email = (claims.get(provider.claim_email) or "").strip()
    username = (claims.get(provider.claim_username) or email).strip()
    if not username and not subject:
        raise SsoError("The identity provider returned no usable identity.")

    user = None
    # 1. Fast, hijack-proof path: an account already bound to this exact subject.
    if subject:
        prof = (
            UserProfile.objects
            .filter(sso_provider=provider, sso_subject=subject)
            .select_related("user").first()
        )
        if prof is not None:
            user = prof.user

    # 2. First login for this subject: link an existing account, but only safely.
    if user is None:
        candidate = None
        if username:
            candidate = User.objects.filter(username__iexact=username).first()
        if candidate is None and email and _email_verified(claims):
            candidate = User.objects.filter(email__iexact=email).first()
        if candidate is not None:
            _guard_safe_link(candidate, provider, subject)
            user = candidate

    # 3. Nothing to link → JIT create, or refuse when JIT is off.
    if user is None:
        if not provider.jit_provisioning:
            raise SsoError(
                "This account isn't provisioned in Danbyte. Ask an administrator "
                "to create it first."
            )
        user = User.objects.create_user(username=username or subject, email=email)
        user.set_unusable_password()
        user.save()

    _sync_names(user, provider, claims)
    _apply_profile_and_groups(provider, user, claims, subject)
    return user


def _sync_names(user, provider, claims) -> None:
    email = (claims.get(provider.claim_email) or "").strip()
    fn = (claims.get(provider.claim_first_name) or "").strip()
    ln = (claims.get(provider.claim_last_name) or "").strip()
    changed = []
    if email and user.email != email:
        user.email = email
        changed.append("email")
    if fn and user.first_name != fn:
        user.first_name = fn
        changed.append("first_name")
    if ln and user.last_name != ln:
        user.last_name = ln
        changed.append("last_name")
    if changed:
        user.save(update_fields=changed)


def _apply_profile_and_groups(provider, user, claims, subject="") -> None:
    from .ldap import group_is_tenant_safe
    from .models import SsoGroupMapping, UserProfile

    prof, _ = UserProfile.objects.get_or_create(user=user)
    changed = []
    if prof.auth_source != "sso":
        prof.auth_source = "sso"
        changed.append("auth_source")
    # Bind the stable IdP subject so future logins match by it, not by email.
    if subject and (prof.sso_subject != subject or prof.sso_provider_id != provider.id):
        prof.sso_subject = subject
        prof.sso_provider = provider
        changed += ["sso_subject", "sso_provider"]
    if changed:
        prof.save(update_fields=changed)

    # Asserted groups → mapped Danbyte groups. Values compared case-insensitively.
    raw = claims.get(provider.claim_groups) or []
    if isinstance(raw, str):
        raw = [raw]
    wanted = {str(g).strip().lower() for g in raw if str(g).strip()}
    tenant = provider.tenant  # tenant-scoped provider guards mapped groups
    groups = []
    for m in SsoGroupMapping.objects.filter(provider=provider).select_related("group"):
        if m.idp_group.strip().lower() not in wanted:
            continue
        if tenant is not None and not group_is_tenant_safe(m.group, tenant):
            log.warning(
                "SSO: skipping mapping %r for %s - group %r not narrowed to tenant",
                m.idp_group, provider.slug, m.group.name,
            )
            continue
        groups.append(m.group)
    # A baseline group (if configured) so a new SSO user always has some access,
    # not just whatever the mappings grant - but a tenant-scoped provider may not
    # hand out a group that isn't narrowed to its tenant (same guard as mappings).
    if provider.default_group_id:
        dg = provider.default_group
        if tenant is None or group_is_tenant_safe(dg, tenant):
            groups.append(dg)
        else:
            log.warning(
                "SSO: skipping default group %r for %s - not narrowed to tenant",
                dg.name, provider.slug,
            )
    user.groups.set(groups)

    prov_tenant = provider.provisioning_tenant()
    if prov_tenant is not None:
        prof.tenants.add(prov_tenant)
        if prof.current_tenant_id is None:
            prof.current_tenant = prov_tenant
            prof.save(update_fields=["current_tenant"])
