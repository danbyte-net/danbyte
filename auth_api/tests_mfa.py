"""Two-step login + MFA (email OTP / TOTP) regression tests."""
from __future__ import annotations

import json

import pyotp
from django.contrib.auth.models import User
from django.core.cache import cache
from django.test import Client, TestCase, override_settings

from auth_api.models import UserProfile
from auth_api.login_api import (
    LOGIN_MAX_FAILURES,
    MAX_MFA_ATTEMPTS,
)


def _post(client, url, **body):
    return client.post(url, data=json.dumps(body), content_type="application/json")


class LoginFlowTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            "alice", email="alice@example.com", password="pw12345!"
        )
        self.profile = UserProfile.objects.create(user=self.user)
        self.c = Client()  # CSRF not enforced by the test client

    def _authed(self):
        return "_auth_user_id" in self.c.session

    def test_plain_login_no_mfa(self):
        r = _post(self.c, "/api/auth/login/", username="alice", password="pw12345!")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["ok"])
        self.assertTrue(self._authed())

    def test_bad_password(self):
        r = _post(self.c, "/api/auth/login/", username="alice", password="nope")
        self.assertEqual(r.status_code, 400)
        self.assertFalse(self._authed())

    def test_email_mfa_challenge_then_verify(self):
        self.profile.require_mfa = True
        self.profile.mfa_email = True
        self.profile.save()
        r = _post(self.c, "/api/auth/login/", username="alice", password="pw12345!")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body["mfa_required"])
        self.assertEqual(body["methods"], ["email"])
        self.assertFalse(self._authed())  # not logged in yet

        code = self.c.session["mfa_pending"]["email_code"]
        # wrong code rejected
        bad = _post(self.c, "/api/auth/mfa/verify/", method="email", code="000000")
        self.assertEqual(bad.status_code, 400)
        self.assertFalse(self._authed())
        # right code finalises the session
        ok = _post(self.c, "/api/auth/mfa/verify/", method="email", code=code)
        self.assertEqual(ok.status_code, 200)
        self.assertTrue(self._authed())

    def test_totp_setup_confirm_and_login(self):
        # enrol (signed in)
        _post(self.c, "/api/auth/login/", username="alice", password="pw12345!")
        setup = _post(self.c, "/api/auth/mfa/totp/setup/").json()
        secret = setup["secret"]
        self.assertIn("otpauth://", setup["otpauth_uri"])
        conf = _post(
            self.c, "/api/auth/mfa/totp/confirm/", code=pyotp.TOTP(secret).now()
        )
        self.assertEqual(conf.status_code, 200)
        self.profile.refresh_from_db()
        self.assertTrue(self.profile.mfa_totp_confirmed)

        # now require MFA and log in with the authenticator
        self.profile.require_mfa = True
        self.profile.save()
        _post(self.c, "/api/auth/logout/")
        self.assertFalse(self._authed())
        chal = _post(
            self.c, "/api/auth/login/", username="alice", password="pw12345!"
        ).json()
        self.assertIn("totp", chal["methods"])
        ver = _post(
            self.c, "/api/auth/mfa/verify/", method="totp", code=pyotp.TOTP(secret).now()
        )
        self.assertEqual(ver.status_code, 200)
        self.assertTrue(self._authed())

    def test_invite_create_and_set_password(self):
        from urllib.parse import parse_qs, urlparse

        from django.test import RequestFactory

        from auth_api.login_api import build_set_password_url

        admin = User.objects.create_user("admin1", password="x", is_superuser=True)
        api = Client()
        api.force_login(admin)

        # create with invite, no password → account can't log in yet
        r = api.post(
            "/api/users/",
            data=json.dumps(
                {"username": "newbie", "email": "newbie@x.com", "send_invite": True}
            ),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 201)
        u = User.objects.get(username="newbie")
        self.assertFalse(u.has_usable_password())

        # invite with no email is rejected
        bad = api.post(
            "/api/users/",
            data=json.dumps({"username": "noemail", "send_invite": True}),
            content_type="application/json",
        )
        self.assertEqual(bad.status_code, 400)

        # neither password nor invite nor ldap is rejected
        none = api.post(
            "/api/users/",
            data=json.dumps({"username": "naked"}),
            content_type="application/json",
        )
        self.assertEqual(none.status_code, 400)

        # complete the invite via the set-password link
        url = build_set_password_url(RequestFactory().get("/"), u)
        q = parse_qs(urlparse(url).query)
        anon = Client()
        ok = anon.post(
            "/api/auth/set-password/",
            data=json.dumps(
                {"uid": q["uid"][0], "token": q["token"][0], "password": "Str0ngPazz99"}
            ),
            content_type="application/json",
        )
        self.assertEqual(ok.status_code, 200)
        u.refresh_from_db()
        self.assertTrue(u.has_usable_password())
        # token can't be reused
        again = anon.post(
            "/api/auth/set-password/",
            data=json.dumps(
                {"uid": q["uid"][0], "token": q["token"][0], "password": "Other0ne99"}
            ),
            content_type="application/json",
        )
        self.assertEqual(again.status_code, 400)

    def test_require_mfa_without_factor_logs_in(self):
        # require_mfa set but no email + no TOTP → can't enforce, must not lock out
        self.profile.require_mfa = True
        self.profile.mfa_email = False
        self.user.email = ""
        self.user.save()
        self.profile.save()
        r = _post(self.c, "/api/auth/login/", username="alice", password="pw12345!")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json().get("ok"))
        self.assertTrue(self._authed())


@override_settings(
    CACHES={
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
            "LOCATION": "bruteforce-test",
        }
    }
)
class BruteForceGuardTests(TestCase):
    """#55 — login lockout + MFA attempt cap + resend cooldown."""

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            "bob", email="bob@example.com", password="pw12345!"
        )
        self.profile = UserProfile.objects.create(
            user=self.user, require_mfa=True, mfa_email=True
        )
        self.c = Client()

    def test_login_ip_lockout(self):
        for _ in range(LOGIN_MAX_FAILURES):
            r = _post(self.c, "/api/auth/login/", username="bob", password="wrong")
            self.assertEqual(r.status_code, 400)
        # Locked now — even the correct password is refused.
        r = _post(self.c, "/api/auth/login/", username="bob", password="pw12345!")
        self.assertEqual(r.status_code, 429)

    def test_login_success_clears_counter(self):
        self.profile.require_mfa = False  # plain login so success logs in
        self.profile.save()
        for _ in range(LOGIN_MAX_FAILURES - 1):
            _post(self.c, "/api/auth/login/", username="bob", password="wrong")
        ok = _post(self.c, "/api/auth/login/", username="bob", password="pw12345!")
        self.assertEqual(ok.status_code, 200)  # success clears the failure counter
        self.c.post("/api/auth/logout/")
        # Counter reset → another near-full run of failures stays under the cap.
        for _ in range(LOGIN_MAX_FAILURES - 1):
            r = _post(self.c, "/api/auth/login/", username="bob", password="wrong")
            self.assertEqual(r.status_code, 400)

    def test_mfa_verify_attempt_cap(self):
        r = _post(self.c, "/api/auth/login/", username="bob", password="pw12345!")
        self.assertTrue(r.json()["mfa_required"])
        for _ in range(MAX_MFA_ATTEMPTS - 1):
            bad = _post(self.c, "/api/auth/mfa/verify/", method="email", code="000000")
            self.assertEqual(bad.status_code, 400)
        # The cap'th wrong code burns the pending login.
        locked = _post(self.c, "/api/auth/mfa/verify/", method="email", code="000000")
        self.assertEqual(locked.status_code, 429)
        self.assertNotIn("mfa_pending", self.c.session)
        # Pending gone → even a guess now reports an expired session, not a code error.
        again = _post(self.c, "/api/auth/mfa/verify/", method="email", code="000000")
        self.assertEqual(again.status_code, 400)

    def test_resend_cooldown(self):
        r = _post(self.c, "/api/auth/login/", username="bob", password="pw12345!")
        self.assertTrue(r.json()["mfa_required"])  # first email challenge sent
        again = _post(self.c, "/api/auth/mfa/resend/")
        self.assertEqual(again.status_code, 429)
