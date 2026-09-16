"""API-token authentication - 'Authorization: Token <key>' for non-interactive
callers. The token is scoped to a tenant (see ApiToken); _get_active_tenant
reads it off request.auth. A read-only token is refused for unsafe methods
here, before any view runs, so per-view permission classes can't widen it."""
from __future__ import annotations

from django.utils import timezone
from rest_framework.authentication import BaseAuthentication, get_authorization_header
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied
from rest_framework.permissions import SAFE_METHODS

_LAST_USED_THROTTLE = 300  # only stamp last_used_at every N seconds


class ApiTokenAuthentication(BaseAuthentication):
    keyword = b"token"

    def authenticate(self, request):
        header = get_authorization_header(request).split()
        if not header or header[0].lower() != self.keyword:
            return None
        if len(header) != 2:
            raise AuthenticationFailed("Malformed Token header.")
        key = header[1].decode("latin-1")

        from .models import ApiToken, hash_api_key

        token = (
            ApiToken.objects.select_related("user", "tenant")
            .filter(key_hash=hash_api_key(key))
            .first()
        )
        if token is None:
            raise AuthenticationFailed("Invalid API token.")
        if token.is_expired:
            raise AuthenticationFailed("API token has expired.")
        if not token.user.is_active:
            raise AuthenticationFailed("User is inactive.")
        if token.read_only and request.method not in SAFE_METHODS:
            raise PermissionDenied("This API token is read-only.")

        now = timezone.now()
        if (
            token.last_used_at is None
            or (now - token.last_used_at).total_seconds() > _LAST_USED_THROTTLE
        ):
            token.last_used_at = now
            token.save(update_fields=["last_used_at"])
        return (token.user, token)

    def authenticate_header(self, request):
        return "Token"
