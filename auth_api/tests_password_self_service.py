"""Self-service password change and reset by email (#492)."""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from unittest import mock

from django.contrib.auth.models import User
from django.contrib.sessions.models import Session
from django.core import mail
from django.core.cache import cache
from django.db import connection
from django.test import Client, TestCase, override_settings
from django.test.utils import CaptureQueriesContext

from audit.models import ChangeLogEntry
from auth_api import login_api, password_api
from auth_api.models import ApiToken, UserProfile
from core.models import DeploymentSettings

OLD = "Old-Passw0rd-1"
NEW = "Brand-New-Pass-42"

LOCMEM = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "password-self-service-test",
    }
}


def _post(client, url, **body):
    return client.post(url, data=json.dumps(body), content_type="application/json")


def _signed_in(client) -> bool:
    return "_auth_user_id" in client.session


def _active_sessions_of(user) -> int:
    return sum(
        1
        for s in Session.objects.all()
        if s.get_decoded().get("_auth_user_id") == str(user.pk)
    )


@override_settings(CACHES=LOCMEM)
class PasswordChangeTests(TestCase):
    URL = "/api/auth/password/change/"

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user("alice", email="alice@example.com", password=OLD)
        self.profile = UserProfile.objects.create(user=self.user)
        self.c = Client()
        self.c.force_login(self.user)

    def _change(self, client=None, current=OLD, new=NEW, **extra):
        return (client or self.c).post(
            self.URL,
            data=json.dumps({"current_password": current, "new_password": new}),
            content_type="application/json",
            **extra,
        )

    def test_change_ok_keeps_this_session(self):
        r = self._change()
        self.assertEqual(r.status_code, 200, r.content)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(NEW))
        # update_session_auth_hash: the caller is still signed in.
        me = self.c.get("/api/me/").json()
        self.assertTrue(me["is_authenticated"])
        self.assertEqual(me["password_source"], "local")

    def test_other_sessions_end(self):
        other = Client()
        other.force_login(self.user)
        # A half-finished sign-in elsewhere, waiting for its second factor.
        pending = Client()
        session = pending.session
        session[login_api.SESSION_KEY] = {"user_id": self.user.pk, "exp": 9e12}
        session.save()
        bystander = User.objects.create_user("bob", password=OLD)
        third = Client()
        third.force_login(bystander)

        r = self._change()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["sessions_ended"], 2)
        self.assertEqual(_active_sessions_of(self.user), 1)
        self.assertFalse(other.get("/api/me/").json()["is_authenticated"])
        self.assertFalse(Session.objects.filter(session_key=session.session_key).exists())
        self.assertTrue(self.c.get("/api/me/").json()["is_authenticated"])
        self.assertTrue(third.get("/api/me/").json()["is_authenticated"])

    def _token(self):
        from auth_api.models import generate_api_key, hash_api_key
        from core.models import Organization, Tenant

        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.profile.tenants.add(tenant)
        key = generate_api_key()
        ApiToken.objects.create(
            user=self.user, tenant=tenant, name="t", kind="user",
            key_hash=hash_api_key(key), prefix=key[:11],
        )
        return key

    def test_api_tokens_untouched(self):
        self.user.is_superuser = True
        self.user.save(update_fields=["is_superuser"])
        key = self._token()
        self.assertEqual(self._change().status_code, 200)
        self.assertEqual(ApiToken.objects.filter(user=self.user).count(), 1)
        r = Client().get("/api/sites/", HTTP_AUTHORIZATION=f"Token {key}")
        self.assertEqual(r.status_code, 200, r.content)

    def test_wrong_current_password(self):
        r = self._change(current="not-it")
        self.assertEqual(r.status_code, 400)
        self.assertIn("current_password", r.json())
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(OLD))

    def test_weak_new_password_gets_validator_messages(self):
        for weak in ("1", "password", "12345678901", "alice123"):
            r = self._change(new=weak)
            self.assertEqual(r.status_code, 400, weak)
            self.assertTrue(r.json()["new_password"], weak)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(OLD))

    def test_same_password_refused(self):
        self.assertEqual(self._change(new=OLD).status_code, 400)

    def test_ldap_and_sso_accounts_refused(self):
        for source, word in (("ldap", "directory"), ("sso", "identity provider")):
            self.profile.auth_source = source
            self.profile.save(update_fields=["auth_source"])
            r = self._change()
            self.assertEqual(r.status_code, 400, source)
            self.assertIn(word, r.json()["detail"])
            self.assertEqual(self.c.get("/api/me/").json()["password_source"], source)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(OLD))

    def test_anonymous_refused(self):
        self.assertEqual(self._change(client=Client()).status_code, 401)

    def test_token_auth_refused(self):
        key = self._token()
        anon = Client()
        r = self._change(client=anon, HTTP_AUTHORIZATION=f"Token {key}")
        self.assertEqual(r.status_code, 403)
        # Even alongside a valid session.
        r = self._change(HTTP_AUTHORIZATION=f"Token {key}")
        self.assertEqual(r.status_code, 403)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(OLD))

    def test_csrf_enforced(self):
        c = Client(enforce_csrf_checks=True)
        c.force_login(self.user)
        self.assertEqual(self._change(client=c).status_code, 403)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(OLD))

    def test_wrong_current_counts_toward_login_lockout(self):
        for _ in range(login_api.LOGIN_MAX_FAILURES):
            self.assertEqual(self._change(current="nope").status_code, 400)
        # Locked: even the right password is not checked now ...
        self.assertEqual(self._change().status_code, 429)
        # ... and the sign-in form shares the lockout.
        r = _post(Client(), "/api/auth/login/", username="alice", password=OLD)
        self.assertEqual(r.status_code, 429)

    def test_login_failures_count_toward_change(self):
        for _ in range(login_api.LOGIN_MAX_FAILURES):
            _post(Client(), "/api/auth/login/", username="alice", password="nope")
        self.assertEqual(self._change().status_code, 429)

    def test_audit_entry_without_secrets(self):
        self.assertEqual(self._change().status_code, 200)
        entry = ChangeLogEntry.objects.get(object_type="auth.user", object_id=str(self.user.pk))
        self.assertEqual(entry.user, self.user)
        blob = json.dumps([entry.changes, entry.pre_change, entry.post_change, entry.cause])
        self.assertNotIn(OLD, blob)
        self.assertNotIn(NEW, blob)
        self.assertNotIn(self.user.password, blob)


@override_settings(CACHES=LOCMEM, PASSWORD_RESET_ENABLED=True, PASSWORD_RESET_LINK_TIMEOUT=3600)
class PasswordResetTests(TestCase):
    URL = "/api/auth/password-reset/"
    CONFIRM = "/api/auth/password-reset/confirm/"

    def setUp(self):
        cache.clear()
        dep = DeploymentSettings.load()
        dep.email_enabled = True
        dep.public_base_url = "https://danbyte.example.com/"
        dep.save(update_fields=["email_enabled", "public_base_url"])
        relay = mock.patch.object(login_api, "deployment_relay_configured", return_value=True)
        relay.start()
        self.addCleanup(relay.stop)
        # The request only enqueues; run the job inline where a test needs it.
        self.jobs: list[str] = []
        queue = mock.MagicMock()
        queue.enqueue.side_effect = lambda path, ident: self.jobs.append(ident)
        q = mock.patch("django_rq.get_queue", return_value=queue)
        q.start()
        self.addCleanup(q.stop)

        self.user = User.objects.create_user("alice", email="alice@example.com", password=OLD)
        self.profile = UserProfile.objects.create(user=self.user)

    def _request(self, identifier, client=None, **extra):
        return (client or Client()).post(
            self.URL,
            data=json.dumps({"identifier": identifier}),
            content_type="application/json",
            **extra,
        )

    def _run_jobs(self) -> int:
        sent = sum(password_api.send_reset_job(i) for i in self.jobs)
        self.jobs.clear()
        return sent

    def _link(self) -> dict[str, str]:
        body = mail.outbox[-1].body
        m = re.search(r"(\S+)/reset-password\?uid=([^&\s]+)&token=(\S+)", body)
        self.assertIsNotNone(m, body)
        return {"origin": m.group(1), "uid": m.group(2), "token": m.group(3)}

    def _confirm(self, link, password=NEW, client=None):
        return _post(
            client or Client(), self.CONFIRM,
            uid=link["uid"], token=link["token"], password=password,
        )

    # ── off / hidden ──
    @override_settings(PASSWORD_RESET_ENABLED=False)
    def test_disabled_is_404_and_hidden(self):
        self.assertEqual(self._request("alice").status_code, 404)
        r = _post(Client(), self.CONFIRM, uid="x", token="y", password=NEW)
        self.assertEqual(r.status_code, 404)
        self.assertFalse(Client().get("/api/me/").json()["password_reset_available"])
        self.assertEqual(self.jobs, [])

    def test_hidden_without_mail_or_public_url(self):
        self.assertTrue(Client().get("/api/me/").json()["password_reset_available"])
        dep = DeploymentSettings.load()
        dep.public_base_url = ""
        dep.save(update_fields=["public_base_url"])
        self.assertEqual(self._request("alice").status_code, 404)
        dep.public_base_url = "https://danbyte.example.com"
        dep.email_enabled = False
        dep.save(update_fields=["public_base_url", "email_enabled"])
        self.assertEqual(self._request("alice").status_code, 404)

    # ── no enumeration ──
    def test_same_answer_and_same_work_for_any_identifier(self):
        ldap = User.objects.create_user("dirk", email="dirk@example.com", password=OLD)
        UserProfile.objects.create(user=ldap, auth_source="ldap")
        User.objects.create_user("off", email="off@example.com", password=OLD, is_active=False)
        answers = []
        for ident in ("alice", "alice@example.com", "nobody", "dirk", "off"):
            with CaptureQueriesContext(connection) as ctx:
                r = self._request(ident)
            # The request never reads a user row: the same queries for all.
            sql = [q["sql"] for q in ctx.captured_queries]
            self.assertFalse([q for q in sql if '"auth_user"' in q], sql)
            answers.append((r.status_code, r.content, tuple(sql)))
        self.assertEqual(len(set(answers)), 1, answers)
        self.assertEqual(answers[0][0], 200)
        self.assertEqual(len(self.jobs), 5)
        # Mail only for the real, local, active account (twice: by name, by email).
        cache.delete(f"pwreset-mail:{self.user.pk}")
        sent = password_api.send_reset_job("alice")
        self.assertEqual(sent, 1)
        cache.delete(f"pwreset-mail:{self.user.pk}")
        self.assertEqual(password_api.send_reset_job("ALICE@example.com"), 1)
        for ident in ("nobody", "dirk", "off", "dirk@example.com"):
            self.assertEqual(password_api.send_reset_job(ident), 0, ident)
        self.assertEqual(len(mail.outbox), 2)
        self.assertEqual(mail.outbox[0].to, ["alice@example.com"])
        self.assertFalse(getattr(mail.outbox[0], "alternatives", []))

    def test_sso_and_passwordless_accounts_get_no_mail(self):
        sso = User.objects.create_user("sam", email="sam@example.com")
        UserProfile.objects.create(user=sso, auth_source="sso")
        invited = User.objects.create_user("ivy", email="ivy@example.com")
        invited.set_unusable_password()
        invited.save()
        for ident in ("sam", "ivy"):
            self.assertEqual(self._request(ident).status_code, 200)
        self.assertEqual(self._run_jobs(), 0)
        self.assertEqual(mail.outbox, [])

    def test_mail_cooldown_per_account(self):
        self._request("alice")
        self._request("alice")
        self.assertEqual(self._run_jobs(), 1)

    # ── rate limits ──
    def test_rate_limited_per_client_and_account(self):
        for _ in range(login_api.LOGIN_MAX_FAILURES):
            self.assertEqual(self._request("alice").status_code, 200)
        self.assertEqual(self._request("alice").status_code, 429)
        # Unknown accounts are limited the same way.
        for _ in range(login_api.LOGIN_MAX_FAILURES):
            self._request("ghost")
        self.assertEqual(self._request("ghost").status_code, 429)
        # Another address still may, until the account-wide limit.
        self.assertEqual(self._request("alice", REMOTE_ADDR="198.51.100.9").status_code, 200)

    def test_rate_limited_per_account_across_addresses(self):
        n = 0
        while n < login_api.LOGIN_MAX_ACCOUNT_FAILURES:
            ip = f"198.51.100.{n % 200}"
            self.assertEqual(self._request("alice", REMOTE_ADDR=ip).status_code, 200)
            n += 1
        self.assertEqual(self._request("alice", REMOTE_ADDR="203.0.113.1").status_code, 429)

    # ── the link ──
    def test_link_uses_public_url_not_host_header(self):
        # The request's host (the test client's "testserver") never reaches
        # the link: the job builds it from the configured public URL.
        self._request("alice", HTTP_X_FORWARDED_HOST="evil.example.net")
        self._run_jobs()
        link = self._link()
        self.assertEqual(link["origin"], "https://danbyte.example.com")
        self.assertNotIn("testserver", mail.outbox[-1].body)
        self.assertNotIn("evil", mail.outbox[-1].body)

    def test_reset_sets_password_ends_sessions_no_login(self):
        signed_in = Client()
        signed_in.force_login(self.user)
        self._request("alice")
        self._run_jobs()
        c = Client()
        r = self._confirm(self._link(), client=c)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(_signed_in(c))
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(NEW))
        self.assertEqual(_active_sessions_of(self.user), 0)
        self.assertFalse(signed_in.get("/api/me/").json()["is_authenticated"])
        self.assertTrue(
            ChangeLogEntry.objects.filter(
                object_type="auth.user", object_id=str(self.user.pk)
            ).exists()
        )

    def test_link_single_use(self):
        self._request("alice")
        self._run_jobs()
        link = self._link()
        self.assertEqual(self._confirm(link).status_code, 200)
        r = self._confirm(link, password="Yet-Another-Pass-7")
        self.assertEqual(r.status_code, 400)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(NEW))

    def test_link_dies_when_the_account_signs_in(self):
        self._request("alice")
        self._run_jobs()
        link = self._link()
        self.assertEqual(
            _post(Client(), "/api/auth/login/", username="alice", password=OLD).status_code, 200
        )
        self.assertEqual(self._confirm(link).status_code, 400)

    def test_link_expires(self):
        self._request("alice")
        self._run_jobs()
        link = self._link()
        later = datetime.now() + timedelta(seconds=3601)
        with mock.patch.object(password_api.reset_token_generator, "_now", return_value=later):
            self.assertEqual(self._confirm(link).status_code, 400)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(OLD))

    @override_settings(PASSWORD_RESET_LINK_TIMEOUT=60)
    def test_link_timeout_setting(self):
        self._request("alice")
        self._run_jobs()
        later = datetime.now() + timedelta(seconds=61)
        with mock.patch.object(password_api.reset_token_generator, "_now", return_value=later):
            self.assertEqual(self._confirm(self._link()).status_code, 400)

    def test_invite_token_is_not_a_reset_token(self):
        from django.test import RequestFactory

        from auth_api.login_api import build_set_password_url

        url = build_set_password_url(RequestFactory().get("/"), self.user)
        uid = re.search(r"uid=([^&]+)", url).group(1)
        token = re.search(r"token=(\S+)", url).group(1)
        self.assertEqual(self._confirm({"uid": uid, "token": token}).status_code, 400)

    def test_weak_password_refused_with_messages(self):
        self._request("alice")
        self._run_jobs()
        r = self._confirm(self._link(), password="12345678901")
        self.assertEqual(r.status_code, 400)
        self.assertTrue(r.json()["password"])
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(OLD))

    def test_disabled_or_directory_account_link_refused(self):
        self._request("alice")
        self._run_jobs()
        link = self._link()
        self.profile.auth_source = "ldap"
        self.profile.save(update_fields=["auth_source"])
        self.assertEqual(self._confirm(link).status_code, 400)
        self.profile.auth_source = "local"
        self.profile.save(update_fields=["auth_source"])
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])
        self.assertEqual(self._confirm(link).status_code, 400)

    def test_mfa_still_required_after_reset(self):
        self.profile.require_mfa = True
        self.profile.mfa_email = True
        self.profile.save()
        self._request("alice")
        self._run_jobs()
        self.assertEqual(self._confirm(self._link()).status_code, 200)
        c = Client()
        r = _post(c, "/api/auth/login/", username="alice", password=NEW)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["mfa_required"])
        self.assertFalse(_signed_in(c))

    def test_garbage_links(self):
        for uid, token in (("", ""), ("!!", "x"), ("MQ", "1-2"), ("MTIzNDU2Nzg5", "a-b")):
            r = _post(Client(), self.CONFIRM, uid=uid, token=token, password=NEW)
            self.assertEqual(r.status_code, 400, (uid, token))
        r = _post(Client(), self.CONFIRM, uid=["x"], token=1, password=None)
        self.assertEqual(r.status_code, 400)

    def test_csrf_enforced_on_public_endpoints(self):
        c = Client(enforce_csrf_checks=True)
        self.assertEqual(self._request("alice", client=c).status_code, 403)
        r = _post(c, self.CONFIRM, uid="x", token="y", password=NEW)
        self.assertEqual(r.status_code, 403)
