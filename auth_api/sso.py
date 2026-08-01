"""Single sign-on — OpenID Connect login + JIT provisioning.

OIDC providers are DB-driven (:class:`auth_api.models.IdentityProvider`). We
discover endpoints from the issuer's ``/.well-known/openid-configuration``, run
the standard authorization-code flow with ``state`` + ``nonce``, validate the ID
token against the IdP's JWKS, then match — or, when ``jit_provisioning`` is on,
create — the Danbyte user and re-sync their group membership from the asserted
groups via :class:`SsoGroupMapping`. Only *mapped* IdP groups grant anything.

The IdP is operator-configured (same trust tier as LDAP / the Vault address), so
HTTP to it is direct with TLS verification — not through the tenant SSRF guard.
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
    # Groups often aren't in the ID token — pull userinfo if the mapped claim
    # is absent and the provider exposes a userinfo endpoint.
    if provider.claim_groups and provider.claim_groups not in claims:
        info = _userinfo(doc, data.get("access_token"))
        if info:
            claims = {**info, **claims}
    return claims


def _validate_id_token(id_token, provider, doc, nonce) -> dict:
    from authlib.jose import JsonWebKey, jwt
    from authlib.jose.errors import JoseError

    try:
        jwks = requests.get(doc["jwks_uri"], timeout=HTTP_TIMEOUT).json()
        key = JsonWebKey.import_key_set(jwks)
        claims = jwt.decode(id_token, key)
        claims.validate()  # exp / iat / nbf
    except (requests.RequestException, JoseError, ValueError) as exc:
        raise SsoError(f"ID token validation failed: {exc}") from exc

    if claims.get("iss") != doc.get("issuer"):
        raise SsoError("ID token issuer mismatch.")
    aud = claims.get("aud")
    auds = aud if isinstance(aud, list) else [aud]
    if provider.oidc_client_id not in auds:
        raise SsoError("ID token audience mismatch.")
    if nonce and claims.get("nonce") != nonce:
        raise SsoError("ID token nonce mismatch — possible replay.")
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

def resolve_user(provider, claims):
    """Match or (JIT) create the Danbyte user for these claims, sync names,
    groups, and tenant. Raises :class:`SsoError` when JIT is off and the user is
    unknown, or the claims carry no usable identity."""
    from django.contrib.auth.models import User

    email = (claims.get(provider.claim_email) or "").strip()
    username = (claims.get(provider.claim_username) or email).strip()
    if not username:
        raise SsoError("The identity provider returned no username or email.")

    user = User.objects.filter(username__iexact=username).first()
    if user is None and email:
        user = User.objects.filter(email__iexact=email).first()
    if user is None:
        if not provider.jit_provisioning:
            raise SsoError(
                "This account isn't provisioned in Danbyte. Ask an administrator "
                "to create it first."
            )
        user = User.objects.create_user(username=username, email=email)
        user.set_unusable_password()
        user.save()

    _sync_names(user, provider, claims)
    _apply_profile_and_groups(provider, user, claims)
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


def _apply_profile_and_groups(provider, user, claims) -> None:
    from .ldap import group_is_tenant_safe
    from .models import SsoGroupMapping, UserProfile

    prof, _ = UserProfile.objects.get_or_create(user=user)
    if prof.auth_source != "sso":
        prof.auth_source = "sso"
        prof.save(update_fields=["auth_source"])

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
                "SSO: skipping mapping %r for %s — group %r not narrowed to tenant",
                m.idp_group, provider.slug, m.group.name,
            )
            continue
        groups.append(m.group)
    # A baseline group (if configured) so a new SSO user always has some access,
    # not just whatever the mappings grant.
    if provider.default_group_id:
        groups.append(provider.default_group)
    user.groups.set(groups)

    prov_tenant = provider.provisioning_tenant()
    if prov_tenant is not None:
        prof.tenants.add(prov_tenant)
        if prof.current_tenant_id is None:
            prof.current_tenant = prov_tenant
            prof.save(update_fields=["current_tenant"])
