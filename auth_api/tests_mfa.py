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
        # The confirming code was consumed; the next step's code signs in.
        from datetime import UTC, datetime

        ver = _post(
            self.c, "/api/auth/mfa/verify/", method="totp",
            code=pyotp.TOTP(secret).at(datetime.now(UTC), 1),
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

    def test_require_mfa_without_factor_forces_enrolment(self):
        """require_mfa with no usable factor no longer signs the account in
        (#320): the password step is accepted, then the authenticator must be
        enrolled before the session is finalised."""
        self.profile.require_mfa = True
        self.profile.mfa_email = False
        self.user.email = ""
        self.user.save()
        self.profile.save()
        r = _post(self.c, "/api/auth/login/", username="alice", password="pw12345!")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body["mfa_required"])
        self.assertTrue(body["enrol_required"])
        self.assertEqual(body["methods"], [])
        self.assertFalse(self._authed())
        # A code can't be verified - there is nothing to verify against.
        self.assertEqual(
            _post(self.c, "/api/auth/mfa/verify/", method="totp", code="000000").status_code,
            400,
        )
        # Enrol from the pending login: setup, then confirm finalises the session.
        setup = _post(self.c, "/api/auth/mfa/totp/setup/")
        self.assertEqual(setup.status_code, 200, setup.content)
        secret = setup.json()["secret"]
        bad = _post(self.c, "/api/auth/mfa/totp/confirm/", code="000000")
        self.assertEqual(bad.status_code, 400)
        self.assertFalse(self._authed())
        ok = _post(self.c, "/api/auth/mfa/totp/confirm/", code=pyotp.TOTP(secret).now())
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertTrue(self._authed())
        self.profile.refresh_from_db()
        self.assertTrue(self.profile.mfa_totp_confirmed)
        self.assertEqual(self.profile.secrets.get("totp"), secret)

    def test_enrolment_endpoints_need_a_session_or_pending_login(self):
        self.assertEqual(_post(self.c, "/api/auth/mfa/totp/setup/").status_code, 401)
        self.assertEqual(
            _post(self.c, "/api/auth/mfa/totp/confirm/", code="000000").status_code, 401
        )
        # A pending login that does NOT need enrolment (it has a factor) must
        # not reach the enrolment endpoints either.
        self.profile.require_mfa = True
        self.profile.save()
        chal = _post(self.c, "/api/auth/login/", username="alice", password="pw12345!")
        self.assertEqual(chal.json()["methods"], ["email"])
        self.assertEqual(_post(self.c, "/api/auth/mfa/totp/setup/").status_code, 401)
        self.assertFalse(self._authed())


class TotpHardeningTests(TestCase):
    """#320 - removing the authenticator needs the password or a current code,
    a code is accepted once, and the last factor stays while MFA is required."""

    def setUp(self):
        self.user = User.objects.create_user(
            "carol", email="carol@example.com", password="pw12345!"
        )
        self.secret = pyotp.random_base32()
        self.profile = UserProfile.objects.create(
            user=self.user, require_mfa=True, mfa_email=True,
            mfa_totp_confirmed=True, secrets={"totp": self.secret},
        )
        self.totp = pyotp.TOTP(self.secret)
        self.c = Client()

    def _authed(self, c=None):
        return "_auth_user_id" in (c or self.c).session

    def _login_totp(self, code, c=None):
        c = c or self.c
        chal = _post(c, "/api/auth/login/", username="carol", password="pw12345!")
        self.assertIn("totp", chal.json()["methods"])
        return _post(c, "/api/auth/mfa/verify/", method="totp", code=code)

    def _signed_in(self):
        c = Client()
        c.force_login(self.user)
        return c

    def test_disable_needs_password_or_code(self):
        c = self._signed_in()
        for body in ({}, {"password": "wrong"}, {"code": "000000"}):
            r = _post(c, "/api/auth/mfa/totp/disable/", **body)
            self.assertEqual(r.status_code, 400, (body, r.content))
            self.profile.refresh_from_db()
            self.assertTrue(self.profile.mfa_totp_confirmed)
            self.assertEqual(self.profile.secrets.get("totp"), self.secret)

    def test_disable_with_password(self):
        c = self._signed_in()
        r = _post(c, "/api/auth/mfa/totp/disable/", password="pw12345!")
        self.assertEqual(r.status_code, 200, r.content)
        self.profile.refresh_from_db()
        self.assertFalse(self.profile.mfa_totp_confirmed)
        self.assertNotIn("totp", self.profile.secrets)

    def test_disable_with_current_code(self):
        c = self._signed_in()
        r = _post(c, "/api/auth/mfa/totp/disable/", code=self.totp.now())
        self.assertEqual(r.status_code, 200, r.content)
        self.profile.refresh_from_db()
        self.assertFalse(self.profile.mfa_totp_confirmed)

    def test_disable_refused_when_it_is_the_last_required_factor(self):
        self.user.email = ""
        self.user.save()
        c = self._signed_in()
        r = _post(c, "/api/auth/mfa/totp/disable/", password="pw12345!")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("required", r.json()["detail"])
        self.profile.refresh_from_db()
        self.assertTrue(self.profile.mfa_totp_confirmed)
        # With MFA no longer required the same request goes through.
        self.profile.require_mfa = False
        self.profile.save()
        r = _post(c, "/api/auth/mfa/totp/disable/", password="pw12345!")
        self.assertEqual(r.status_code, 200, r.content)

    def test_disable_refused_when_email_codes_are_off(self):
        self.profile.mfa_email = False
        self.profile.save()
        c = self._signed_in()
        r = _post(c, "/api/auth/mfa/totp/disable/", password="pw12345!")
        self.assertEqual(r.status_code, 400, r.content)

    def test_totp_code_accepted_once(self):
        code = self.totp.now()
        self.assertEqual(self._login_totp(code).status_code, 200)
        self.assertTrue(self._authed())
        # The same code from a second session is refused.
        other = Client()
        r = self._login_totp(code, c=other)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertFalse(self._authed(other))
        # The next time step is a new code and is accepted.
        from datetime import UTC, datetime

        nxt = self.totp.at(datetime.now(UTC), 1)
        r = self._login_totp(nxt, c=other)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(self._authed(other))

    def test_confirm_code_cannot_be_replayed_at_login(self):
        self.profile.require_mfa = False
        self.profile.mfa_totp_confirmed = False
        self.profile.secrets = {}
        self.profile.save()
        c = self._signed_in()
        secret = _post(c, "/api/auth/mfa/totp/setup/").json()["secret"]
        code = pyotp.TOTP(secret).now()
        self.assertEqual(_post(c, "/api/auth/mfa/totp/confirm/", code=code).status_code, 200)
        self.profile.refresh_from_db()
        self.profile.require_mfa = True
        self.profile.save()
        r = self._login_totp(code)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertFalse(self._authed())

    def test_disable_code_cannot_be_replayed(self):
        code = self.totp.now()
        self.assertEqual(self._login_totp(code).status_code, 200)
        r = _post(self.c, "/api/auth/mfa/totp/disable/", code=code)
        self.assertEqual(r.status_code, 400, r.content)
        self.profile.refresh_from_db()
        self.assertTrue(self.profile.mfa_totp_confirmed)


@override_settings(
    CACHES={
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
            "LOCATION": "bruteforce-test",
        }
    }
)
class BruteForceGuardTests(TestCase):
    """#55 - login lockout + MFA attempt cap + resend cooldown."""

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
        # Locked now - even the correct password is refused.
        r = _post(self.c, "/api/auth/login/", username="bob", password="pw12345!")
        self.assertEqual(r.status_code, 429)

    def test_one_clients_failures_do_not_lock_out_another_user(self):
        """Behind a second proxy every user shares the proxy's address; ten
        wrong passwords from anyone used to lock out everyone (#226)."""
        self.profile.require_mfa = False
        self.profile.save()
        User.objects.create_user("mallory", password="m-pass-1!")
        proxy = {"HTTP_X_FORWARDED_FOR": "10.9.9.9"}  # the shared proxy hop
        for _ in range(LOGIN_MAX_FAILURES + 2):
            self.c.post("/api/auth/login/", data=json.dumps(
                {"username": "mallory", "password": "wrong"}),
                content_type="application/json", **proxy)
        bob = Client()
        r = bob.post("/api/auth/login/", data=json.dumps(
            {"username": "bob", "password": "pw12345!"}),
            content_type="application/json", **proxy)
        self.assertEqual(r.status_code, 200, r.content)

    def test_rotating_addresses_cannot_brute_force_one_account(self):
        from .login_api import LOGIN_MAX_ACCOUNT_FAILURES

        for i in range(LOGIN_MAX_ACCOUNT_FAILURES):
            self.c.post("/api/auth/login/", data=json.dumps(
                {"username": "bob", "password": "wrong"}),
                content_type="application/json",
                HTTP_X_FORWARDED_FOR=f"198.51.100.{i % 250}")
        r = Client().post("/api/auth/login/", data=json.dumps(
            {"username": "bob", "password": "pw12345!"}),
            content_type="application/json", HTTP_X_FORWARDED_FOR="203.0.113.7")
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

    def test_totp_disable_shares_the_account_lockout(self):
        """Guesses at the disable endpoint count against the same per-account
        cap as the login step, so it can't be used to brute-force the code or
        the password from a stolen session (#320)."""
        from auth_api.login_api import MFA_MAX_ACCOUNT_FAILURES

        self.profile.mfa_totp_confirmed = True
        self.profile.secrets = {"totp": pyotp.random_base32()}
        self.profile.save()
        c = Client()
        c.force_login(self.user)
        for _ in range(MFA_MAX_ACCOUNT_FAILURES):
            r = _post(c, "/api/auth/mfa/totp/disable/", code="000000")
            self.assertEqual(r.status_code, 400)
        r = _post(c, "/api/auth/mfa/totp/disable/", password="pw12345!")
        self.assertEqual(r.status_code, 429)
        self.profile.refresh_from_db()
        self.assertTrue(self.profile.mfa_totp_confirmed)
