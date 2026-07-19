"""Session login + MFA (email OTP / TOTP authenticator) for the React SPA.

Two-step login. The SPA POSTs credentials to ``/api/auth/login/``; if the
account has ``require_mfa`` set *and* a usable second factor, we stash the
**pending** user in the session and answer ``{mfa_required, methods}`` instead
of logging in. The SPA then POSTs the code to ``/api/auth/mfa/verify/`` which
finalises the session. TOTP enrolment (``/api/auth/mfa/totp/...``) is for an
already-signed-in user from the preferences page.

Sessions are server-side (DB-backed), so the email OTP and the pending-user
marker live safely in ``request.session`` — the client only holds the signed
cookie, never the code. Superusers can still use ``/admin/login/`` directly.
"""
from __future__ import annotations

import json
import os
import secrets as pysecrets
import time

from django.contrib.auth import (
    authenticate,
    login as auth_login,
    logout as auth_logout,
)
from django.contrib.auth.models import User
from django.core.cache import cache
from django.http import HttpResponseBadRequest, JsonResponse
from django.views.decorators.http import require_POST

from .models import UserProfile

EMAIL_CODE_TTL = 600  # seconds an emailed code stays valid
MFA_PENDING_TTL = 600  # seconds the half-finished login survives
SESSION_KEY = "mfa_pending"

# ── Anti-brute-force tunables ────────────────────────────────────────────────
# Password login: per-IP failure counter in the cache, then lock out.
LOGIN_MAX_FAILURES = 10
LOGIN_WINDOW = 900  # seconds the failure counter + lockout live
# MFA: cap wrong codes per pending login (the 6-digit OTP is otherwise brute-
# forceable within its TTL), and rate-limit email resends.
MAX_MFA_ATTEMPTS = 5
# Per-ACCOUNT MFA lockout — survives across pending-login blobs, so an attacker
# who holds the password can't reset the per-pending cap by re-authenticating.
MFA_MAX_ACCOUNT_FAILURES = 15
MFA_WINDOW = 900


def _mfa_locked(user) -> bool:
    return (cache.get(f"mfa-fail:{user.pk}") or 0) >= MFA_MAX_ACCOUNT_FAILURES


def _record_mfa_failure(user) -> None:
    key = f"mfa-fail:{user.pk}"
    try:
        cache.incr(key)
    except ValueError:
        cache.set(key, 1, MFA_WINDOW)


def _clear_mfa_failures(user) -> None:
    cache.delete(f"mfa-fail:{user.pk}")
RESEND_COOLDOWN = 30  # seconds between email-OTP resends


def _client_ip(request) -> str:
    """Client IP for rate-limiting, taken from a TRUSTED position in the
    X-Forwarded-For chain — NOT the leftmost hop (which the client controls and
    could spoof to dodge the lockout). nginx appends the real peer to the right,
    so we take the entry ``DANBYTE_TRUSTED_PROXY_DEPTH`` from the right (default
    1 = just nginx; set 2 if a cloud LB also fronts it). Falls back to
    REMOTE_ADDR."""
    xff = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            try:
                depth = max(1, int(os.getenv("DANBYTE_TRUSTED_PROXY_DEPTH", "1")))
            except ValueError:
                depth = 1
            return parts[max(0, len(parts) - depth)]
    return request.META.get("REMOTE_ADDR") or "unknown"


def _login_locked(request) -> bool:
    return (cache.get(f"login-fail:{_client_ip(request)}") or 0) >= LOGIN_MAX_FAILURES


def _record_login_failure(request) -> None:
    key = f"login-fail:{_client_ip(request)}"
    try:
        cache.incr(key)
    except ValueError:
        cache.set(key, 1, LOGIN_WINDOW)


def _clear_login_failures(request) -> None:
    cache.delete(f"login-fail:{_client_ip(request)}")


# ─── helpers ─────────────────────────────────────────────────────────────────
def _json(request):
    try:
        return json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return None


def _profile(user) -> UserProfile:
    prof, _ = UserProfile.objects.get_or_create(user=user)
    return prof


def _methods(profile: UserProfile, user) -> list[str]:
    """Which second factors this user can actually use, in offer order."""
    methods: list[str] = []
    if profile.mfa_totp_confirmed and (profile.secrets or {}).get("totp"):
        methods.append("totp")
    if profile.mfa_email and user.email:
        methods.append("email")
    return methods


def _mask_email(email: str) -> str:
    name, _, domain = email.partition("@")
    if not domain:
        return email
    head = name[0] if name else ""
    return f"{head}{'•' * max(len(name) - 1, 1)}@{domain}"


def _gen_code() -> str:
    return f"{pysecrets.randbelow(1_000_000):06d}"


def _send_email_code(user, code: str) -> None:
    from django.core.mail import EmailMessage

    from core.effective_settings import effective_email
    from core.models import DeploymentSettings
    from monitoring.notify import build_email_connection

    dep = DeploymentSettings.load()
    name = dep.deployment_name or "Danbyte"
    # No active tenant at login time — best-effort: the user's last tenant's
    # SMTP override, else the deployment relay. (No-tenant users → deployment.)
    profile = getattr(user, "profile", None)
    eff = effective_email(profile.current_tenant_id if profile else None)
    EmailMessage(
        subject=f"{name} sign-in code: {code}",
        body=(
            f"Your {name} verification code is {code}.\n\n"
            f"It expires in {EMAIL_CODE_TTL // 60} minutes. If you didn't try to "
            f"sign in, you can safely ignore this email.\n"
        ),
        from_email=eff.email_from or None,
        to=[user.email],
        connection=build_email_connection(eff),
    ).send(fail_silently=True)


def _begin_email_challenge(request, user) -> None:
    pending = request.session.get(SESSION_KEY) or {}
    pending["email_code"] = _gen_code()
    pending["email_exp"] = time.time() + EMAIL_CODE_TTL
    pending["email_sent_at"] = time.time()
    request.session[SESSION_KEY] = pending
    request.session.modified = True
    _send_email_code(user, pending["email_code"])


# ─── login / verify / logout ─────────────────────────────────────────────────
@require_POST
def login_api(request):
    if request.user.is_authenticated:
        return JsonResponse({"ok": True})
    # IP-based lockout after repeated password failures (brute-force guard).
    if _login_locked(request):
        return JsonResponse(
            {"detail": "Too many failed attempts. Try again later."}, status=429
        )
    data = _json(request)
    if data is None:
        return HttpResponseBadRequest("invalid JSON")
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    user = authenticate(request, username=username, password=password)
    if user is None:
        _record_login_failure(request)
        return JsonResponse(
            {"detail": "Invalid username or password."}, status=400
        )
    if not user.is_active:
        return JsonResponse({"detail": "This account is disabled."}, status=400)

    _clear_login_failures(request)
    profile = _profile(user)
    methods = _methods(profile, user)
    # require_mfa with no usable factor can't be enforced (e.g. no email, no
    # authenticator yet) — log in rather than lock the user out.
    if profile.require_mfa and methods:
        request.session[SESSION_KEY] = {
            "user_id": user.id,
            "exp": time.time() + MFA_PENDING_TTL,
            "methods": methods,
            # Remember which backend authenticated so the post-MFA login() can
            # name it — required once >1 AUTHENTICATION_BACKENDS exist (LDAP).
            "backend": getattr(user, "backend", None),
        }
        request.session.modified = True
        if "email" in methods:
            _begin_email_challenge(request, user)
        return JsonResponse(
            {
                "mfa_required": True,
                "methods": methods,
                "email_hint": _mask_email(user.email)
                if "email" in methods
                else None,
            }
        )

    auth_login(request, user)
    return JsonResponse({"ok": True})


@require_POST
def mfa_verify_api(request):
    pending = request.session.get(SESSION_KEY)
    if not pending or pending.get("exp", 0) < time.time():
        request.session.pop(SESSION_KEY, None)
        return JsonResponse(
            {"detail": "Your sign-in session expired — start again."}, status=400
        )
    data = _json(request) or {}
    method = data.get("method")
    code = (data.get("code") or "").strip()
    if method not in pending.get("methods", []):
        return JsonResponse(
            {"detail": "Unsupported verification method."}, status=400
        )
    user = User.objects.filter(id=pending["user_id"]).first()
    if user is None or not user.is_active:
        request.session.pop(SESSION_KEY, None)
        return JsonResponse({"detail": "Account not available."}, status=400)

    # Per-account lockout — independent of the pending blob, so re-authing with
    # the (known) password doesn't hand out a fresh batch of guesses.
    if _mfa_locked(user):
        request.session.pop(SESSION_KEY, None)
        return JsonResponse(
            {"detail": "Too many incorrect codes — try again later."}, status=429
        )

    ok = False
    if method == "email":
        ok = bool(
            code
            and code == pending.get("email_code")
            and pending.get("email_exp", 0) >= time.time()
        )
    elif method == "totp":
        import pyotp

        secret = (_profile(user).secrets or {}).get("totp")
        ok = bool(secret) and pyotp.TOTP(secret).verify(code, valid_window=1)

    if not ok:
        _record_mfa_failure(user)
        # Cap guesses per pending login so the 6-digit OTP / TOTP window can't be
        # brute-forced by someone who already has the password. Burn the pending
        # blob on lockout — they must restart (and re-enter the password).
        attempts = pending.get("attempts", 0) + 1
        if attempts >= MAX_MFA_ATTEMPTS:
            request.session.pop(SESSION_KEY, None)
            return JsonResponse(
                {"detail": "Too many incorrect codes — please sign in again."},
                status=429,
            )
        pending["attempts"] = attempts
        request.session[SESSION_KEY] = pending
        request.session.modified = True
        return JsonResponse({"detail": "Incorrect or expired code."}, status=400)

    _clear_mfa_failures(user)
    backend = pending.get("backend") or "django.contrib.auth.backends.ModelBackend"
    request.session.pop(SESSION_KEY, None)
    auth_login(request, user, backend=backend)
    return JsonResponse({"ok": True})


@require_POST
def mfa_resend_api(request):
    pending = request.session.get(SESSION_KEY)
    if (
        not pending
        or pending.get("exp", 0) < time.time()
        or "email" not in pending.get("methods", [])
    ):
        return JsonResponse({"detail": "Nothing to resend."}, status=400)
    # Cooldown so the resend endpoint can't be used to email-bomb the user.
    waited = time.time() - pending.get("email_sent_at", 0)
    if waited < RESEND_COOLDOWN:
        return JsonResponse(
            {"detail": f"Please wait {int(RESEND_COOLDOWN - waited)}s before "
                       "requesting another code."},
            status=429,
        )
    user = User.objects.filter(id=pending["user_id"]).first()
    if user is None:
        return JsonResponse({"detail": "Account not found."}, status=400)
    _begin_email_challenge(request, user)
    return JsonResponse({"ok": True})


@require_POST
def logout_api(request):
    auth_logout(request)
    return JsonResponse({"ok": True})


# ─── Invite / set-your-own-password (GDPR-friendly account creation) ──────────
def build_set_password_url(request, user) -> str:
    """A one-time set-password link for ``user``. The token is Django's signed
    password-reset token (tied to the current password hash + last_login), so it
    self-invalidates once the password is set."""
    from django.contrib.auth.tokens import default_token_generator
    from django.utils.encoding import force_bytes
    from django.utils.http import urlsafe_base64_encode

    from core.models import DeploymentSettings

    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = default_token_generator.make_token(user)
    path = f"/set-password?uid={uid}&token={token}"
    base = (DeploymentSettings.load().public_base_url or "").rstrip("/")
    return base + path if base else request.build_absolute_uri(path)


def send_invite_email(request, user) -> None:
    """Email a new user a link to choose their own password. The admin never
    sets or sees a credential — the account stays login-disabled until the user
    follows the link."""
    from django.core.mail import EmailMessage

    from core.effective_settings import effective_email
    from core.models import DeploymentSettings
    from monitoring.notify import build_email_connection

    dep = DeploymentSettings.load()
    name = dep.deployment_name or "Danbyte"
    # The inviting admin acts inside a tenant — use its SMTP override if any.
    from api.views import _get_active_tenant

    eff = effective_email(_get_active_tenant(request))
    url = build_set_password_url(request, user)
    EmailMessage(
        subject=f"You've been invited to {name}",
        body=(
            f"An administrator created a {name} account for you "
            f"({user.get_username()}).\n\n"
            f"Choose your password to activate it:\n{url}\n\n"
            f"If you weren't expecting this, you can ignore this email.\n"
        ),
        from_email=eff.email_from or None,
        to=[user.email],
        connection=build_email_connection(eff),
    ).send(fail_silently=True)


@require_POST
def set_password_api(request):
    """Finish an invite (or a reset): validate the signed token and set the
    user's chosen password. Not authenticated — the token *is* the auth."""
    from django.contrib.auth.password_validation import validate_password
    from django.contrib.auth.tokens import default_token_generator
    from django.core.exceptions import ValidationError
    from django.utils.encoding import force_str
    from django.utils.http import urlsafe_base64_decode

    data = _json(request) or {}
    uidb64 = data.get("uid") or ""
    token = data.get("token") or ""
    password = data.get("password") or ""

    try:
        uid = force_str(urlsafe_base64_decode(uidb64))
        user = User.objects.get(pk=uid)
    except (ValueError, TypeError, User.DoesNotExist):
        user = None
    if user is None or not default_token_generator.check_token(user, token):
        return JsonResponse(
            {"detail": "This link is invalid or has expired."}, status=400
        )
    try:
        validate_password(password, user)
    except ValidationError as exc:
        return JsonResponse({"detail": " ".join(exc.messages)}, status=400)

    user.set_password(password)
    user.is_active = True
    user.save()
    return JsonResponse({"ok": True, "username": user.get_username()})


# ─── TOTP enrolment (signed-in user, preferences page) ───────────────────────
@require_POST
def totp_setup_api(request):
    if not request.user.is_authenticated:
        return JsonResponse({"detail": "Authentication required."}, status=401)
    import pyotp

    from core.models import DeploymentSettings

    profile = _profile(request.user)
    secret = pyotp.random_base32()
    sec = dict(profile.secrets or {})
    sec["totp_pending"] = secret
    profile.secrets = sec
    profile.save(update_fields=["secrets"])

    issuer = DeploymentSettings.load().deployment_name or "Danbyte"
    label = request.user.email or request.user.get_username()
    uri = pyotp.TOTP(secret).provisioning_uri(name=label, issuer_name=issuer)
    return JsonResponse({"secret": secret, "otpauth_uri": uri})


@require_POST
def totp_confirm_api(request):
    if not request.user.is_authenticated:
        return JsonResponse({"detail": "Authentication required."}, status=401)
    import pyotp

    data = _json(request) or {}
    code = (data.get("code") or "").strip()
    profile = _profile(request.user)
    pending = (profile.secrets or {}).get("totp_pending")
    if not pending:
        return JsonResponse({"detail": "Start TOTP setup first."}, status=400)
    if not pyotp.TOTP(pending).verify(code, valid_window=1):
        return JsonResponse(
            {"detail": "Incorrect code — check your authenticator."}, status=400
        )
    sec = dict(profile.secrets or {})
    sec["totp"] = pending
    sec.pop("totp_pending", None)
    profile.secrets = sec
    profile.mfa_totp_confirmed = True
    profile.save(update_fields=["secrets", "mfa_totp_confirmed"])
    return JsonResponse({"ok": True})


@require_POST
def totp_disable_api(request):
    if not request.user.is_authenticated:
        return JsonResponse({"detail": "Authentication required."}, status=401)
    profile = _profile(request.user)
    sec = dict(profile.secrets or {})
    sec.pop("totp", None)
    sec.pop("totp_pending", None)
    profile.secrets = sec
    profile.mfa_totp_confirmed = False
    profile.save(update_fields=["secrets", "mfa_totp_confirmed"])
    return JsonResponse({"ok": True})
