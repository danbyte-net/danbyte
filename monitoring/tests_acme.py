"""ACME issuance engine (M4b).

These exercise the engine against the ``acme`` library's real challenge objects
and the real certificate-import path, with only the network calls to the CA
mocked — so challenge-value computation, order persistence, and finalize→import
are covered without a live CA. The engine itself is validated end-to-end against
a real step-ca separately.
"""
from __future__ import annotations

import datetime as dt
from types import SimpleNamespace
from unittest import mock

import josepy as jose
from acme import challenges, messages
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import NameOID
from django.contrib.auth import get_user_model
from django.test import TestCase

from core.models import DeploymentSettings, Organization, Tenant

from . import acme_engine as eng
from .csr import generate
from .models import AcmeOrder, Issuer

User = get_user_model()


def _enable_store():
    dep = DeploymentSettings.load()
    dep.secrets_provider = "local"
    dep.save(update_fields=["secrets_provider"])


def _fake_authz(domain, chall):
    return SimpleNamespace(
        uri=f"https://ca/authz/{domain}",
        body=SimpleNamespace(
            identifier=SimpleNamespace(value=domain),
            challenges=[SimpleNamespace(chall=chall)],
            status=messages.STATUS_PENDING,
        ),
    )


def _fake_order(authzs):
    return SimpleNamespace(
        uri="https://ca/order/1",
        authorizations=authzs,
        body=SimpleNamespace(status=messages.STATUS_PENDING),
    )


class ChallengeExtractionTests(TestCase):
    def setUp(self):
        self.jwk = jose.JWKEC(key=ec.generate_private_key(ec.SECP256R1()))

    def test_dns01_record_name_and_value(self):
        chall = challenges.DNS01(token=b"\x01" * 32)
        orderr = _fake_order([_fake_authz("svc.example.com", chall)])
        recs = eng._records_for(orderr, self.jwk, AcmeOrder.Challenge.DNS01)
        (_, _, rec) = recs[0]
        self.assertEqual(rec.type, "dns-01")
        self.assertEqual(rec.record_name, "_acme-challenge.svc.example.com")
        # The value is the base64url SHA-256 of the key authorization.
        self.assertEqual(rec.record_value, chall.validation(self.jwk))
        self.assertTrue(rec.record_value)

    def test_http01_token_path_and_content(self):
        chall = challenges.HTTP01(token=b"\x02" * 32)
        orderr = _fake_order([_fake_authz("svc.example.com", chall)])
        recs = eng._records_for(orderr, self.jwk, AcmeOrder.Challenge.HTTP01)
        (_, _, rec) = recs[0]
        self.assertEqual(rec.type, "http-01")
        self.assertTrue(rec.path.startswith("/.well-known/acme-challenge/"))
        self.assertEqual(rec.content, chall.validation(self.jwk))

    def test_missing_challenge_type_raises(self):
        # CA only offers HTTP-01, but we asked for DNS-01.
        chall = challenges.HTTP01(token=b"\x03" * 32)
        orderr = _fake_order([_fake_authz("svc.example.com", chall)])
        with self.assertRaises(eng.AcmeError):
            eng._records_for(orderr, self.jwk, AcmeOrder.Challenge.DNS01)


class MapStatusTests(TestCase):
    def test_known_status_passes_through(self):
        self.assertEqual(eng._map_status(messages.STATUS_VALID), "valid")
        self.assertEqual(eng._map_status(messages.STATUS_PENDING), "pending")

    def test_unknown_status_falls_back_to_pending(self):
        self.assertEqual(eng._map_status(SimpleNamespace(__str__=lambda s: "weird")), "pending")


class OrderLifecycleTests(TestCase):
    def setUp(self):
        _enable_store()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.user = User.objects.create_user("u", password="x")
        self.issuer = Issuer.objects.create(
            tenant=self.tenant,
            name="step-ca",
            directory_url="https://ca/acme/directory",
            account_uri="https://ca/acct/1",
        )
        self.req, _ = generate(
            tenant=self.tenant,
            user=self.user,
            common_name="svc.example.com",
            san_dns=["svc.example.com"],
            key_spec="ec-p256",
        )
        self.order = AcmeOrder.objects.create(
            tenant=self.tenant,
            issuer=self.issuer,
            request=self.req,
            challenge_type=AcmeOrder.Challenge.DNS01,
        )
        self.jwk = jose.JWKEC(key=ec.generate_private_key(ec.SECP256R1()))

    def test_create_order_persists_challenges(self):
        chall = challenges.DNS01(token=b"\x04" * 32)
        orderr = _fake_order([_fake_authz("svc.example.com", chall)])
        fake_acme = mock.Mock()
        fake_acme.new_order.return_value = orderr
        with mock.patch.object(eng, "_client", return_value=(fake_acme, self.jwk)):
            eng.create_order(self.order)
        self.order.refresh_from_db()
        self.assertEqual(self.order.order_url, "https://ca/order/1")
        self.assertEqual(self.order.identifiers, ["svc.example.com"])
        self.assertEqual(len(self.order.challenges), 1)
        c = self.order.challenges[0]
        self.assertEqual(c["type"], "dns-01")
        self.assertEqual(c["record_name"], "_acme-challenge.svc.example.com")

    def test_finalize_imports_and_links_certificate(self):
        # Sign the request's CSR as a CA would, so import_issued accepts it.
        csr = x509.load_pem_x509_csr(self.req.csr_pem.encode())
        ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        now = dt.datetime.now(dt.UTC)
        cert = (
            x509.CertificateBuilder()
            .subject_name(csr.subject)
            .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "CA")]))
            .public_key(csr.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(days=1))
            .not_valid_after(now + dt.timedelta(days=90))
            .sign(ca_key, hashes.SHA256())
        )
        fullchain = cert.public_bytes(serialization.Encoding.PEM).decode()

        self.order.order_url = "https://ca/order/1"
        self.order.save(update_fields=["order_url"])

        chall = challenges.DNS01(token=b"\x05" * 32)
        orderr = _fake_order([_fake_authz("svc.example.com", chall)])
        fake_acme = mock.Mock()
        fake_acme.poll_and_finalize.return_value = SimpleNamespace(fullchain_pem=fullchain)

        with (
            mock.patch.object(eng, "_client", return_value=(fake_acme, self.jwk)),
            mock.patch.object(eng, "_reload_order", return_value=orderr),
        ):
            cert_row = eng.finalize_order(self.order)

        self.assertTrue(fake_acme.answer_challenge.called)
        self.order.refresh_from_db()
        self.req.refresh_from_db()
        self.assertEqual(self.order.status, AcmeOrder.Status.VALID)
        self.assertEqual(self.order.issued_certificate_id, cert_row.id)
        self.assertEqual(self.req.status, "issued")

    def test_client_without_account_raises(self):
        self.issuer.account_uri = ""
        self.issuer.save(update_fields=["account_uri"])
        with self.assertRaises(eng.AcmeError):
            eng._client(self.issuer)


class RegisterAccountTests(TestCase):
    def setUp(self):
        _enable_store()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.issuer = Issuer.objects.create(
            tenant=self.tenant,
            name="step-ca",
            directory_url="https://ca/acme/directory",
            contact_email="ops@example.com",
        )

    def test_register_stores_key_and_uri(self):
        fake_acme = mock.Mock()
        fake_acme.new_account.return_value = SimpleNamespace(uri="https://ca/acct/9")
        with mock.patch.object(eng, "client") as mock_client:
            mock_client.ClientV2.get_directory.return_value = mock.Mock()
            mock_client.ClientV2.return_value = fake_acme
            uri = eng.register_account(self.issuer)
        self.assertEqual(uri, "https://ca/acct/9")
        self.issuer.refresh_from_db()
        self.assertEqual(self.issuer.account_uri, "https://ca/acct/9")
        self.assertEqual(self.issuer.account_ref, f"issuer/{self.issuer.id}/account")
        # The account key is stored off-row in the secret store.
        from .secret_store import require_secret_store

        data = require_secret_store().get(self.tenant.id, self.issuer.account_ref)
        self.assertIn("account_key", data)
        self.assertIn("BEGIN PRIVATE KEY", data["account_key"])


class AcmeApiTests(TestCase):
    def setUp(self):
        _enable_store()
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        other_org = Organization.objects.create(name="Other", slug="other")
        self.other_tenant = Tenant.objects.create(org=other_org, name="Other", slug="other")
        admin = User.objects.create_superuser("admin", "a@x.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        self.issuer = Issuer.objects.create(
            tenant=self.tenant, name="ca", directory_url="https://ca/d",
            account_uri="https://ca/acct/1",
        )
        # An issuer that belongs to a different tenant — must not be usable.
        self.foreign = Issuer.objects.create(
            tenant=self.other_tenant, name="foreign", directory_url="https://x/d",
        )
        r = self.client.post(
            "/api/monitoring/certificate-requests/",
            {"common_name": "svc.acme.com", "san_dns": ["svc.acme.com"]},
            content_type="application/json",
        )
        self.req_id = r.json()["id"]

    def test_acme_order_rejects_cross_tenant_issuer(self):
        r = self.client.post(
            f"/api/monitoring/certificate-requests/{self.req_id}/acme-order/",
            {"issuer": str(self.foreign.id), "challenge_type": "dns-01"},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(AcmeOrder.objects.count(), 0)

    def test_acme_order_creates_and_returns_challenges(self):
        chall = challenges.DNS01(token=b"\x06" * 32)
        orderr = _fake_order([_fake_authz("svc.acme.com", chall)])
        fake_acme = mock.Mock()
        fake_acme.new_order.return_value = orderr
        jwk = jose.JWKEC(key=ec.generate_private_key(ec.SECP256R1()))
        with mock.patch.object(eng, "_client", return_value=(fake_acme, jwk)):
            r = self.client.post(
                f"/api/monitoring/certificate-requests/{self.req_id}/acme-order/",
                {"issuer": str(self.issuer.id), "challenge_type": "dns-01"},
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["challenges"][0]["record_name"], "_acme-challenge.svc.acme.com")
        self.assertEqual(AcmeOrder.objects.filter(tenant=self.tenant).count(), 1)

    def test_acme_finalize_enqueues(self):
        order = AcmeOrder.objects.create(
            tenant=self.tenant,
            issuer=self.issuer,
            request_id=self.req_id,
            order_url="https://ca/order/1",
        )
        with mock.patch("django_rq.get_queue") as gq:
            r = self.client.post(
                f"/api/monitoring/certificate-requests/{self.req_id}/acme-finalize/",
                {"order": str(order.id)},
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 202, r.content)
        gq.return_value.enqueue.assert_called_once()
        order.refresh_from_db()
        self.assertEqual(order.status, AcmeOrder.Status.PROCESSING)
