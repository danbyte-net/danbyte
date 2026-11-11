"""ACME transport failures: every API action and background job answers a
clean message, never a 500 or an empty error.

The CA is a local TLS server (``monitoring.acme_testing``) with a throwaway
CA made per test class - untrusted, wrong name, expired, refused, hanging -
so the real ``requests``/OpenSSL failure paths are what is translated.
"""
from __future__ import annotations

import os
import socket
import tempfile
from pathlib import Path
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase

from core.models import DeploymentSettings, Organization, Tenant

from . import acme_engine as eng
from .acme_testing import (
    FakeAcme,
    SilentListener,
    closed_port,
    key_pem,
    make_ca,
    make_server_cert,
    pem,
)
from .csr import generate
from .models import AcmeOrder, Issuer

User = get_user_model()
NO_PROXY = {"NO_PROXY": "*", "no_proxy": "*"}


def _enable_store():
    dep = DeploymentSettings.load()
    dep.secrets_provider = "local"
    dep.save(update_fields=["secrets_provider"])


class _Pki:
    """One throwaway CA, and server pairs signed by it."""

    def __init__(self):
        self.ca, self.ca_key = make_ca()
        self.dir = tempfile.mkdtemp(prefix="acme-test-ca-")
        self.ca_file = str(Path(self.dir) / "ca.pem")
        Path(self.ca_file).write_text(pem(self.ca))

    def server(self, names=("localhost", "127.0.0.1"), *, expired=False):
        cert, key = make_server_cert(self.ca, self.ca_key, names, expired=expired)
        return FakeAcme(pem(cert), key_pem(key))


class AcmeErrorsBase(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.pki = _Pki()

    def setUp(self):
        _enable_store()
        env = mock.patch.dict(os.environ, NO_PROXY)
        env.start()
        self.addCleanup(env.stop)
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        other = Organization.objects.create(name="O2", slug="o2")
        self.other_tenant = Tenant.objects.create(org=other, name="T2", slug="t2")
        self.admin = User.objects.create_superuser("root", "r@x.c", "pw")
        self.client.force_login(self.admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.issuer = Issuer.objects.create(
            tenant=self.tenant, name="step-ca", directory_url="https://localhost:1/directory",
        )

    def trust_test_ca(self):
        """Make the engine verify against the throwaway CA only."""
        p = mock.patch.object(eng, "_verify", return_value=self.pki.ca_file)
        p.start()
        self.addCleanup(p.stop)

    def point(self, url):
        self.issuer.directory_url = url
        self.issuer.save(update_fields=["directory_url"])

    def register(self, issuer=None):
        issuer = issuer or self.issuer
        return self.client.post(f"/api/monitoring/issuers/{issuer.id}/register-account/",
                                {}, content_type="application/json")


class RegisterAccountErrorTests(AcmeErrorsBase):
    def assert_upstream(self, r, code, *words):
        self.assertEqual(r.status_code, 502, r.content)
        self.assertEqual(r["Content-Type"], "application/json")
        body = r.json()
        self.assertEqual(body["code"], code)
        for w in words:
            self.assertIn(w, body["detail"])
        self.assertNotIn("Traceback", body["detail"])
        return body

    def test_untrusted_certificate_is_a_502_saying_so(self):
        with self.pki.server() as ca:
            self.point(ca.url())
            r = self.register()
        body = self.assert_upstream(r, "acme_tls_untrusted", "not trusted", "localhost")
        self.assertIn("root certificate", body["detail"])
        self.issuer.refresh_from_db()
        self.assertEqual(self.issuer.account_uri, "")

    def test_hostname_mismatch_is_named(self):
        self.trust_test_ca()
        with self.pki.server(names=("ca.example",)) as ca:
            self.point(ca.url())
            r = self.register()
        self.assert_upstream(r, "acme_tls_hostname", "not valid for localhost")

    def test_expired_certificate_is_named(self):
        self.trust_test_ca()
        with self.pki.server(expired=True) as ca:
            self.point(ca.url())
            r = self.register()
        self.assert_upstream(r, "acme_tls_expired", "expired")

    def test_connection_refused(self):
        self.point(f"https://127.0.0.1:{closed_port()}/directory")
        r = self.register()
        self.assert_upstream(r, "acme_refused", "refused")

    def test_timeout(self):
        with SilentListener() as hang, mock.patch.object(eng, "_NETWORK_TIMEOUT", 1):
            self.point(f"https://127.0.0.1:{hang.port}/directory")
            r = self.register()
        self.assert_upstream(r, "acme_timeout", "did not answer", "1 seconds")

    def test_name_that_does_not_resolve(self):
        self.point("https://ca.example.invalid/directory")
        with mock.patch("socket.getaddrinfo",
                        side_effect=socket.gaierror(-2, "Name or service not known")):
            r = self.register()
        self.assert_upstream(r, "acme_dns", "does not resolve", "ca.example.invalid")

    def test_not_a_directory_is_a_400_on_the_url(self):
        self.trust_test_ca()
        with self.pki.server() as ca:
            for path in ("/nope", "/not-a-directory"):
                self.point(ca.url(path))
                r = self.register()
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn("is not an ACME directory", r.json()["directory_url"][0])

    def test_trusted_ca_registers(self):
        self.trust_test_ca()
        with self.pki.server() as ca:
            self.point(ca.url())
            r = self.register()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["account_uri"].endswith("/acct/1"))

    def test_verify_off_still_reaches_an_untrusted_ca(self):
        self.issuer.verify_tls = False
        self.issuer.save(update_fields=["verify_tls"])
        with self.pki.server() as ca:
            self.point(ca.url())
            r = self.register()
        self.assertEqual(r.status_code, 200, r.content)

    def test_ca_problem_document_is_a_502_with_its_detail(self):
        from acme import messages

        problem = messages.Error(typ="urn:ietf:params:acme:error:unauthorized",
                                 detail="EAB\x1b[31m binding\nrequired")
        with mock.patch.object(eng, "client") as c:
            c.ClientV2.get_directory.return_value = {"newNonce": 1, "newAccount": 1,
                                                     "newOrder": 1}
            c.ClientV2.return_value.new_account.side_effect = problem
            r = self.register()
        body = self.assert_upstream(r, "acme_ca_refused", "unauthorized - EAB")
        self.assertNotIn("\x1b", body["detail"])
        self.assertNotIn("\n", body["detail"])

    def test_other_tenants_issuer_is_not_found(self):
        foreign = Issuer.objects.create(tenant=self.other_tenant, name="x",
                                        directory_url="https://localhost:1/d")
        self.assertEqual(self.register(foreign).status_code, 404)


class OrderErrorTests(AcmeErrorsBase):
    def setUp(self):
        super().setUp()
        from .secret_store import require_secret_store

        self.issuer.account_uri = "https://localhost/acct/1"
        self.issuer.account_ref = f"issuer/{self.issuer.id}/account"
        self.issuer.save()
        from cryptography.hazmat.primitives.asymmetric import ec

        require_secret_store().put(self.tenant.id, self.issuer.account_ref,
                                   {"account_key": key_pem(ec.generate_private_key(
                                       ec.SECP256R1()))})
        self.req, _ = generate(tenant=self.tenant, user=self.admin, common_name="svc.example",
                               san_dns=["svc.example"], key_spec="ec-p256")

    def test_acme_order_action_answers_502_and_keeps_the_reason(self):
        with self.pki.server() as ca:
            self.point(ca.url())
            r = self.client.post(
                f"/api/monitoring/certificate-requests/{self.req.id}/acme-order/",
                {"issuer": str(self.issuer.id), "challenge_type": "dns-01"},
                content_type="application/json")
        self.assertEqual(r.status_code, 502, r.content)
        self.assertEqual(r.json()["code"], "acme_tls_untrusted")
        order = AcmeOrder.objects.get(request=self.req)
        self.assertEqual(order.status, AcmeOrder.Status.ERRORED)
        self.assertIn("not trusted", order.error)

    def _order(self, **kw):
        return AcmeOrder.objects.create(tenant=self.tenant, issuer=self.issuer,
                                        request=self.req, status=AcmeOrder.Status.PROCESSING,
                                        **kw)

    def test_finalize_job_records_the_reason(self):
        order = self._order(order_url="https://localhost/order/1")
        self.point(f"https://127.0.0.1:{closed_port()}/directory")
        eng.finalize_order_job(order.id)
        order.refresh_from_db()
        self.assertEqual(order.status, AcmeOrder.Status.ERRORED)
        self.assertIn("refused", order.error)

    def test_issue_job_records_the_reason(self):
        self.issuer.dns_provider = "rfc2136"
        self.issuer.dns_settings = {"server": "127.0.0.1", "zone": "example", "key_name": "k"}
        self.issuer.secrets = {"tsig_secret": "c2VjcmV0"}
        self.issuer.save()
        order = self._order()
        with self.pki.server() as ca:
            self.point(ca.url())
            eng.issue_order_job(order.id)
        order.refresh_from_db()
        self.assertEqual(order.status, AcmeOrder.Status.ERRORED)
        self.assertIn("not trusted", order.error)

    def test_site_certificate_job_records_the_reason(self):
        from core import site_tls

        order = self._order(challenge_type=AcmeOrder.Challenge.HTTP01)
        self.issuer.account_uri = ""  # the job registers first
        self.issuer.save(update_fields=["account_uri"])
        with self.pki.server() as ca:
            self.point(ca.url())
            site_tls.issue_site_order_job(order.id)
        order.refresh_from_db()
        self.assertEqual(order.status, AcmeOrder.Status.ERRORED)
        self.assertIn("not trusted", order.error)

    def test_an_unexpected_failure_is_still_recorded(self):
        order = self._order(order_url="https://localhost/order/1")
        with mock.patch.object(eng, "finalize_order", side_effect=ZeroDivisionError):
            with self.assertLogs("monitoring.acme_engine", "ERROR"):
                eng.finalize_order_job(order.id)
        order.refresh_from_db()
        self.assertEqual(order.status, AcmeOrder.Status.ERRORED)
        self.assertIn("server log", order.error)
