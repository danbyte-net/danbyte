"""Run tokens: one short-lived API key per run.

A sandboxed script reaches Danbyte the same way any client does, so it is
bound by the same tenant scoping, RBAC and audit trail. The token is minted
as the run-as user with the script's scope, dies when the run ends, and is
hidden from that user's own token list (``kind="run"``).
"""
from __future__ import annotations

import logging

from django.utils import timezone

from auth_api.models import ApiToken, generate_api_key, hash_api_key

logger = logging.getLogger(__name__)

# A little past the run's own timeout, so a script that is being killed
# still gets a clear 401 rather than a confusing mid-request expiry.
GRACE_SECONDS = 60


def mint(run) -> tuple[ApiToken, str]:
    """Return the token row and the raw key, which is never stored."""
    script = run.script
    key = generate_api_key()
    token = ApiToken.objects.create(
        user=run.run_as_user,
        tenant=script.tenant,
        name=f"script run {str(run.id)[:8]}",
        key_hash=hash_api_key(key),
        prefix=key[:11],
        scope=script.token_scope,
        kind="run",
        expires_at=timezone.now() + timezone.timedelta(
            seconds=script.effective_timeout + GRACE_SECONDS
        ),
    )
    return token, key


def revoke(token) -> None:
    if token is None:
        return
    try:
        ApiToken.objects.filter(pk=token.pk).delete()
    except Exception:  # noqa: BLE001 - the run's outcome matters more
        logger.warning("could not revoke run token %s", token.pk, exc_info=True)


def purge_expired(now=None) -> int:
    """Drop run tokens whose run is long over. Called by the scripts tick."""
    now = now or timezone.now()
    deleted, _ = ApiToken.objects.filter(kind="run", expires_at__lt=now).delete()
    return deleted
