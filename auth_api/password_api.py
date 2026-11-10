"""Self-service password change and reset by email (#492).

* ``POST /api/auth/password/change/`` - a signed-in user changes their own
  password. Session + CSRF only: these are plain Django views, which never see
  an API token, and a request that carries an ``Authorization`` header is
  refused outright. A wrong current password counts against the same lockout
  as a failed sign-in. The current session stays signed in; every other
  session of the account ends. API tokens are left alone.
* ``POST /api/auth/password-reset/`` - "Forgot password?". Off unless
  ``PASSWORD_RESET_ENABLED`` is set and the deployment can send mail and has a
  public URL. It always answers the same text, does the same work whatever
  the identifier, and leaves finding the account and sending the mail to a
  background job, so the answer says nothing about which accounts exist.
* ``POST /api/auth/password-reset/confirm/`` - sets the password from the
  emailed link, ends every session of the account and does not sign anyone
  in: the next sign-in asks for the password and, as always, the second
  factor.

Only accounts with a local password take part. Directory (LDAP) and single
sign-on accounts are refused a change and never get a reset mail.
"""
from __future__ import annotations

import logging
from datetime import datetime
from importlib import import_module

from django.conf import settings
from django.contrib.auth import update_session_auth_hash
from django.contrib.auth.models import User
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.tokens import PasswordResetTokenGenerator
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.db import transaction
from django.http import JsonResponse
from django.utils.crypto import constant_time_compare
from django.utils.encoding import force_bytes, force_str
from django.utils.http import base36_to_int, urlsafe_base64_decode, urlsafe_base64_encode
from django.views.decorators.http import require_POST

from . import login_api
from .login_api import (
    LOGIN_MAX_ACCOUNT_FAILURES,
    LOGIN_MAX_FAILURES,
    LOGIN_WINDOW,
    _client_ip,
    _count_attempt,
    _json,
    _uncount_attempt,
)
from .login_api import (
    SESSION_KEY as MFA_PENDING_KEY,
)

logger = logging.getLogger("danbyte.auth")

#: The one answer a reset request gets, whether or not the account exists.
RESET_SENT_TEXT = (
    "If that account exists and can reset its password, a link is on its way."
)
INVALID_LINK_TEXT = "This link is invalid or has expired."
TOO_MANY_TEXT = "Too many failed attempts. Try again later."
#: At most one reset mail per account in this many seconds, so the endpoint
#: cannot be used to flood someone's inbox.
RESET_MAIL_COOLDOWN = 60
#: Accounts one identifier may match (an email address shared by accounts).
MAX_RESET_ACCOUNTS = 5


# ─── who may use a password at all ───────────────────────────────────────────
def password_source(user) -> str:
    """Where the account's password lives: ``local``, ``ldap``, ``sso``, or
    ``none`` for a local account without a usable password yet."""
    profile = getattr(user, "profile", None)
    source = getattr(profile, "auth_source", "local") or "local"
    if source == "local" and getattr(profile, "sso_provider_id", None):
        source = "sso"
    if source == "local" and not user.has_usable_password():
        return "none"
    return source


def has_local_password(user) -> bool:
    return password_source(user) == "local"


def reset_available() -> bool:
    """Whether "Forgot password?" is offered: switched on, and the deployment
    can send mail through its own relay to a link on its public URL."""
    if not getattr(settings, "PASSWORD_RESET_ENABLED", False):
        return False
    from core.models import DeploymentSettings

    dep = DeploymentSettings.load()
    if not dep.email_enabled or not _public_base(dep):
        return False
    return login_api.deployment_relay_configured()


def _public_base(dep) -> str:
    base = (dep.public_base_url or "").strip().rstrip("/")
    return base if base.startswith(("https://", "http://")) else ""


# ─── sessions + audit ────────────────────────────────────────────────────────
def end_sessions(user, keep: str | None = None) -> int:
    """End every session of ``user`` except ``keep``: signed-in ones and
    half-finished sign-ins waiting for a second factor. Returns how many.

    A changed password already makes Django refuse the other sessions on
    their next request (the session hash no longer matches); deleting them
    as well leaves nothing behind to be reused.
    """
    from django.contrib.sessions.models import Session
    from django.utils import timezone

    if settings.SESSION_ENGINE not in (
        "django.contrib.sessions.backends.db",
        "django.contrib.sessions.backends.cached_db",
    ):
        return 0
    store = import_module(settings.SESSION_ENGINE).SessionStore
    uid = str(user.pk)
    doomed = []
    rows = Session.objects.filter(expire_date__gt=timezone.now()).only(
        "session_key", "session_data"
    )
    for row in rows.iterator():
        if row.session_key == keep:
            continue
        data = row.get_decoded()
        pending = data.get(MFA_PENDING_KEY)
        if data.get("_auth_user_id") == uid or (
            isinstance(pending, dict) and str(pending.get("user_id")) == uid
        ):
            doomed.append(row.session_key)
    for key in doomed:
        store(session_key=key).delete()
    return len(doomed)


def _audit_password(user, actor, cause: str) -> None:
    """A change-log line saying the password changed - never the password."""
    from audit.context import current_request_id
    from audit.models import ChangeAction, ChangeLogEntry

    ChangeLogEntry.objects.create(
        tenant_id=None,
        user=actor,
        user_name=actor.get_username() if actor else "",
        action=ChangeAction.UPDATE,
        object_type="auth.user",
        object_label="User",
        object_id=str(user.pk),
        object_repr=user.get_username(),
        changes={"password": {"old": "", "new": "changed"}},
        request_id=current_request_id(),
        via="ui",
        cause=cause,
    )


def _validation_errors(password: str, user) -> list[str]:
    try:
        validate_password(password, user)
    except ValidationError as exc:
        return list(exc.messages)
    return []


# ─── change (signed in) ──────────────────────────────────────────────────────
@require_POST
def password_change_api(request):
    # A token never changes a password. These views only see the session, but
    # refuse a token-bearing request outright so that holds whatever
    # middleware is added later.
    if request.META.get("HTTP_AUTHORIZATION"):
        return JsonResponse(
            {"detail": "Sign in to change your password; API tokens can't."}, status=403
        )
    if not request.user.is_authenticated:
        return JsonResponse({"detail": "Authentication required."}, status=401)
    user = request.user
    source = password_source(user)
    if source != "local":
        detail = {
            "ldap": "Your password is managed by your company directory.",
            "sso": "Your password is managed by your identity provider.",
        }.get(source, "This account has no Danbyte password to change.")
        return JsonResponse({"detail": detail}, status=400)

    data = _json(request) or {}
    current = data.get("current_password") or ""
    new = data.get("new_password") or ""
    if not isinstance(current, str) or not isinstance(new, str):
        return JsonResponse({"detail": "Invalid request."}, status=400)
    if not new:
        return JsonResponse({"new_password": ["Enter a new password."]}, status=400)

    # The same counters as the sign-in form: a stolen session can't guess the
    # current password any faster than the login page allows.
    username = user.get_username()
    if not login_api._reserve_login_attempt(request, username):
        return JsonResponse({"detail": TOO_MANY_TEXT}, status=429)
    if not user.check_password(current):
        return JsonResponse(
            {"current_password": ["Your current password is incorrect."]}, status=400
        )
    login_api._release_login_attempt(request, username)
    login_api._clear_login_failures(request, username)

    if constant_time_compare(new, current):
        return JsonResponse(
            {"new_password": ["Choose a password different from the current one."]},
            status=400,
        )
    errors = _validation_errors(new, user)
    if errors:
        return JsonResponse({"new_password": errors}, status=400)

    user.set_password(new)
    user.save(update_fields=["password"])
    # Keeps this session signed in (and gives it a new key) ...
    update_session_auth_hash(request, user)
    # ... and ends every other one.
    ended = end_sessions(user, keep=request.session.session_key)
    _audit_password(user, user, "Password changed by the account owner")
    return JsonResponse({"ok": True, "sessions_ended": ended})


# ─── reset by email ──────────────────────────────────────────────────────────
class EmailResetTokenGenerator(PasswordResetTokenGenerator):
    """Django's reset token with its own salt and a short life.

    The token hashes the password and last sign-in, so it stops working once
    the password is set or the account signs in. Its own salt keeps it apart
    from invite links (``default_token_generator``, ``PASSWORD_RESET_TIMEOUT``).
    """

    key_salt = "danbyte.auth_api.password_api.EmailResetTokenGenerator"

    def check_token(self, user, token):
        if not (user and token) or not isinstance(token, str):
            return False
        try:
            ts_b36, _ = token.split("-")
            ts = base36_to_int(ts_b36)
        except ValueError:
            return False
        for secret in [self.secret, *self.secret_fallbacks]:
            if constant_time_compare(self._make_token_with_timestamp(user, ts, secret), token):
                break
        else:
            return False
        age = self._num_seconds(self._now()) - ts
        return 0 <= age <= settings.PASSWORD_RESET_LINK_TIMEOUT

    def _now(self):
        return datetime.now()


reset_token_generator = EmailResetTokenGenerator()


def _reset_keys(request, identifier: str) -> tuple[str, str]:
    who = (identifier or "").strip().lower()[:254]
    return (f"pwreset:{_client_ip(request)}:{who}", f"pwreset-user:{who}")


def _reserve_reset_request(request, identifier: str) -> bool:
    """The sign-in limits, on counters of their own: per client and account,
    and per account from everywhere. Every request counts - none "succeeds"."""
    pair, account = _reset_keys(request, identifier)
    if _count_attempt(pair, LOGIN_WINDOW) > LOGIN_MAX_FAILURES:
        return False
    if _count_attempt(account, LOGIN_WINDOW) > LOGIN_MAX_ACCOUNT_FAILURES:
        _uncount_attempt(pair)
        return False
    return True


@require_POST
def password_reset_request_api(request):
    if not reset_available():
        return JsonResponse({"detail": "Not found."}, status=404)
    data = _json(request) or {}
    identifier = data.get("identifier")
    identifier = identifier.strip()[:254] if isinstance(identifier, str) else ""
    if not identifier:
        return JsonResponse({"identifier": ["Enter your username or email."]}, status=400)
    if not _reserve_reset_request(request, identifier):
        return JsonResponse({"detail": TOO_MANY_TEXT}, status=429)
    # Nothing here looks at the account: the job finds it, or doesn't.
    try:
        import django_rq

        django_rq.get_queue("default").enqueue(
            "auth_api.password_api.send_reset_job", identifier
        )
    except Exception:  # noqa: BLE001 - the answer must not differ
        logger.warning("password reset: could not enqueue the mail job", exc_info=True)
    return JsonResponse({"detail": RESET_SENT_TEXT})


def _reset_accounts(identifier: str) -> list:
    qs = User.objects.select_related("profile").filter(is_active=True)
    users = list(qs.filter(username=identifier)[:1])
    if not users and "@" in identifier:
        users = list(qs.filter(email__iexact=identifier)[:MAX_RESET_ACCOUNTS])
    return [u for u in users if u.email and has_local_password(u)]


def build_reset_url(user, base: str) -> str:
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = reset_token_generator.make_token(user)
    return f"{base}/reset-password?uid={uid}&token={token}"


def send_reset_job(identifier: str) -> int:
    """RQ job: mail a reset link to each local, active account the identifier
    names. Silent for anything else. Returns how many mails went out."""
    if not reset_available():
        return 0
    from core import email as ek
    from core.models import DeploymentSettings

    dep = DeploymentSettings.load()
    base = _public_base(dep)
    name = dep.deployment_name or "Danbyte"
    minutes = max(1, settings.PASSWORD_RESET_LINK_TIMEOUT // 60)
    sent = 0
    for user in _reset_accounts(identifier):
        if not cache.add(f"pwreset-mail:{user.pk}", 1, RESET_MAIL_COOLDOWN):
            continue
        text = (
            f"Someone asked to reset the password of the {name} account "
            f"{user.get_username()}.\n\n"
            f"Choose a new password here:\n{build_reset_url(user, base)}\n\n"
            f"The link works once and expires in {minutes} minutes. Signing in "
            f"also cancels it.\n\n"
            f"If you didn't ask for this, ignore this email. Your password stays "
            f"as it is.\n"
        )
        profile = getattr(user, "profile", None)
        tenant = login_api.mail_tenant_for(
            user, profile.current_tenant_id if profile else None
        )
        if ek.send_text_email(
            f"Reset your {name} password", [user.email], text_body=text, tenant=tenant
        ):
            sent += 1
    return sent


@require_POST
def password_reset_confirm_api(request):
    if not reset_available():
        return JsonResponse({"detail": "Not found."}, status=404)
    data = _json(request) or {}
    uidb64, token, password = (data.get(k) for k in ("uid", "token", "password"))
    if not all(isinstance(v, str) for v in (uidb64, token, password)):
        return JsonResponse({"detail": INVALID_LINK_TEXT}, status=400)
    try:
        uid = int(force_str(urlsafe_base64_decode(uidb64)))
    except (ValueError, TypeError, OverflowError):
        return JsonResponse({"detail": INVALID_LINK_TEXT}, status=400)

    with transaction.atomic():
        # Locked, so two requests with the same link can't both set it.
        user = (
            User.objects.select_for_update().filter(pk=uid, is_active=True).first()
        )
        if (
            user is None
            or not has_local_password(user)
            or not reset_token_generator.check_token(user, token)
        ):
            return JsonResponse({"detail": INVALID_LINK_TEXT}, status=400)
        errors = _validation_errors(password, user)
        if errors:
            return JsonResponse({"password": errors, "detail": " ".join(errors)}, status=400)
        user.set_password(password)
        user.save(update_fields=["password"])
        _audit_password(user, user, "Password reset through an emailed link")
    end_sessions(user)
    return JsonResponse({"ok": True})
