"""The site's own certificate: validation, the drop, the apply state, the
self-signed renewal, the ACME hooks and the card's API."""
from __future__ import annotations

import json
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest import mock

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework.test import APITestCase

from core import site_tls
from core.models import DeploymentSettings, Organization, SiteCertificate, Tenant
from monitoring.models import AcmeOrder, CertificateRequest, Issuer

User = get_user_model()


def _pair(cn="site.example", *, days=90, key=None):
    key = key or rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, cn)])
    now = datetime.now(UTC)
    cert = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name)
        .public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=days))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(cn)]), critical=False)
        .sign(key, hashes.SHA256())
    )
    return (
        cert.public_bytes(serialization.Encoding.PEM).decode(),
        key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                          serialization.NoEncryption()).decode(),
    )


class DropTests(APITestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.override = override_settings(SITE_TLS_DROP_DIR=self.tmp)
        self.override.enable()
        self.addCleanup(self.override.disable)

    def test_pair_is_validated_before_anything_is_written(self):
        cert, key = _pair()
        _, other = _pair()
        with self.assertRaises(site_tls.SiteTlsError):
            site_tls.validate_pair(cert, other)
        with self.assertRaises(site_tls.SiteTlsError):
            site_tls.validate_pair(cert, "not a key")
        expired, ekey = _pair(days=-1)
        with self.assertRaises(site_tls.SiteTlsError):
            site_tls.validate_pair(expired, ekey)
        self.assertFalse((Path(self.tmp) / site_tls.CERT_NAME).exists())

    def test_drop_writes_the_pair_and_the_stamp_last(self):
        cert, key = _pair("db.example")
        facts = site_tls.drop_pair(cert, key, source="upload", reason="test")
        d = Path(self.tmp)
        self.assertEqual(facts["cn"], "db.example")
        self.assertEqual(oct((d / site_tls.KEY_NAME).stat().st_mode)[-3:], "600")
        self.assertIn("BEGIN CERTIFICATE", (d / site_tls.CERT_NAME).read_text())
        stamp = json.loads((d / site_tls.STAMP).read_text())
        row = SiteCertificate.load()
        self.assertEqual(stamp["sha256"], row.dropped_sha256)
        self.assertEqual(row.source, "upload")
        self.assertEqual(row.names, ["DNS:db.example"])
        state = site_tls.apply_state()
        self.assertTrue(state["pending"])
        self.assertIsNone(state["applied"])
        # The root unit answers through danbyte.applied and consumes the stamp.
        (d / site_tls.APPLIED).write_text(json.dumps({"outcome": "applied", "sha256": stamp["sha256"]}))
        (d / site_tls.STAMP).unlink()
        state = site_tls.apply_state()
        self.assertFalse(state["pending"])
        self.assertEqual(state["applied"]["outcome"], "applied")

    def test_chain_is_appended_leaf_first(self):
        cert, key = _pair("leaf.example")
        ca, _ = _pair("Some CA")
        full, _, _ = site_tls.validate_pair(cert, key, chain_pem=ca)
        self.assertEqual(full.count("BEGIN CERTIFICATE"), 2)
        self.assertTrue(full.startswith(cert.strip()[:40]))

    def test_self_signed_keeps_every_name(self):
        cert, key = site_tls.make_self_signed(["db.example", "10.0.0.41"])
        facts = site_tls.validate_pair(cert, key)[2]
        self.assertEqual(facts["cn"], "db.example")
        self.assertEqual(set(facts["names"]), {"DNS:db.example", "IP:10.0.0.41", "DNS:localhost"})
        self.assertTrue(facts["self_signed"])
        with self.assertRaises(site_tls.SiteTlsError):
            site_tls.make_self_signed([])

    def test_self_signed_renews_only_when_short_and_wanted(self):
        row = SiteCertificate.load()
        row.source = "self-signed"
        row.save()
        short = {"self_signed": True, "days_left": 10, "names": ["DNS:db.example"]}
        with mock.patch.object(site_tls, "served", return_value=short):
            self.assertTrue(site_tls.renew_self_signed_if_due())
        self.assertTrue((Path(self.tmp) / site_tls.STAMP).exists())
        (Path(self.tmp) / site_tls.STAMP).unlink()
        with mock.patch.object(site_tls, "served", return_value={**short, "days_left": 200}):
            self.assertFalse(site_tls.renew_self_signed_if_due())
        row.auto_renew = False
        row.save()
        with mock.patch.object(site_tls, "served", return_value=short):
            self.assertFalse(site_tls.renew_self_signed_if_due())
        row.auto_renew, row.source = True, "upload"
        row.save()
        with mock.patch.object(site_tls, "served", return_value=short):
            self.assertFalse(site_tls.renew_self_signed_if_due())
        self.assertFalse((Path(self.tmp) / site_tls.STAMP).exists())

    def test_public_host_prefers_the_public_base_url(self):
        dep = DeploymentSettings.load()
        dep.public_base_url = "https://ipam.example.net/"
        dep.save(update_fields=["public_base_url"])
        self.assertEqual(site_tls.public_host(), "ipam.example.net")


class AcmeHookTests(APITestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.override = override_settings(SITE_TLS_DROP_DIR=self.tmp)
        self.override.enable()
        self.addCleanup(self.override.disable)
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.issuer = Issuer.objects.create(
            tenant=self.tenant, name="LE", directory_url=site_tls.LETSENCRYPT_DIRECTORY,
            contact_email="ops@example.net",
        )
        self.req = CertificateRequest.objects.create(
            tenant=self.tenant, common_name="db.example", key_ref="csr/x",
        )

    def test_challenge_content_answers_only_pending_tokens(self):
        order = AcmeOrder.objects.create(
            tenant=self.tenant, issuer=self.issuer, request=self.req,
            challenge_type=AcmeOrder.Challenge.HTTP01, status=AcmeOrder.Status.PENDING,
            challenges=[{"identifier": "db.example", "type": "http-01", "status": "pending",
                         "token": "abc-DEF_123", "path": "/.well-known/acme-challenge/abc-DEF_123",
                         "content": "abc-DEF_123.thumb"}],
        )
        self.assertEqual(site_tls.challenge_content("abc-DEF_123"), "abc-DEF_123.thumb")
        self.assertIsNone(site_tls.challenge_content("nope"))
        self.assertIsNone(site_tls.challenge_content("../etc"))
        r = self.client.get("/.well-known/acme-challenge/abc-DEF_123")
        self.assertEqual((r.status_code, r.content), (200, b"abc-DEF_123.thumb"))
        self.assertEqual(self.client.get("/.well-known/acme-challenge/nope").status_code, 404)
        order.status = AcmeOrder.Status.VALID
        order.save()
        self.assertEqual(self.client.get("/.well-known/acme-challenge/abc-DEF_123").status_code, 404)

    def test_issued_order_for_the_site_is_dropped(self):
        row = SiteCertificate.load()
        row.source, row.request = "acme", self.req
        row.save()
        cert, key = _pair("db.example")
        order = AcmeOrder.objects.create(
            tenant=self.tenant, issuer=self.issuer, request=self.req,
            challenge_type=AcmeOrder.Challenge.HTTP01,
        )
        with mock.patch("monitoring.csr.get_private_key", return_value=key):
            site_tls.on_issued(order, cert)
        self.assertTrue((Path(self.tmp) / site_tls.STAMP).exists())
        self.assertEqual(SiteCertificate.load().dropped_reason, "issued by LE")
        # Another request's order is somebody else's certificate.
        other = CertificateRequest.objects.create(tenant=self.tenant, common_name="x", key_ref="csr/y")
        (Path(self.tmp) / site_tls.STAMP).unlink()
        with mock.patch("monitoring.csr.get_private_key", return_value=key):
            site_tls.on_issued(AcmeOrder.objects.create(
                tenant=self.tenant, issuer=self.issuer, request=other,
                challenge_type=AcmeOrder.Challenge.HTTP01), cert)
        self.assertFalse((Path(self.tmp) / site_tls.STAMP).exists())

    def test_command_orders_from_letsencrypt(self):
        from io import StringIO

        from django.core.management import call_command
        from django.core.management.base import CommandError

        Issuer.objects.all().delete()
        with mock.patch.object(site_tls, "start_acme") as start:
            start.return_value = mock.Mock(id="o1", status="pending")
            out = StringIO()
            call_command("site_certificate", "acme", "--letsencrypt", "--email", "ops@example.net",
                         "--name", "db.example", stdout=out)
            self.assertEqual(json.loads(out.getvalue())["issuer"], "Let's Encrypt")
            self.assertEqual(start.call_args.args[3], "http-01")
            self.assertEqual(start.call_args.args[4], ["db.example"])
        self.assertEqual(Issuer.objects.filter(name="Let's Encrypt").count(), 1)
        Organization.objects.create(name="B", slug="b")
        Tenant.objects.create(org=Organization.objects.get(slug="b"), name="B", slug="b")
        with self.assertRaises(CommandError):
            call_command("site_certificate", "acme", "--letsencrypt", "--email", "x@y.z", stdout=StringIO())

    def test_letsencrypt_issuer_is_made_once(self):
        Issuer.objects.all().delete()
        with self.assertRaises(site_tls.SiteTlsError):
            site_tls.letsencrypt_issuer(self.tenant, None, "")
        a = site_tls.letsencrypt_issuer(self.tenant, None, "ops@example.net")
        b = site_tls.letsencrypt_issuer(self.tenant, None, "")
        self.assertEqual(a.id, b.id)
        self.assertEqual(a.name, "Let's Encrypt")


class ApiTests(APITestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.override = override_settings(SITE_TLS_DROP_DIR=self.tmp)
        self.override.enable()
        self.addCleanup(self.override.disable)
        self.root = User.objects.create_superuser("root", "r@acme.com", "pw")
        self.plain = User.objects.create_user("plain", "p@acme.com", "pw")

    def test_superuser_only(self):
        self.client.force_login(self.plain)
        self.assertEqual(self.client.get("/api/system/site-certificate/").status_code, 403)
        self.assertEqual(self.client.post("/api/system/site-certificate/self-signed/").status_code, 403)

    def test_status_upload_and_self_signed(self):
        self.client.force_login(self.root)
        with mock.patch.object(site_tls, "served", return_value=None):
            r = self.client.get("/api/system/site-certificate/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["source"], "none")
        r = self.client.post("/api/system/site-certificate/upload/",
                             {"cert": "junk", "key": "junk"}, format="json")
        self.assertEqual(r.status_code, 400)
        cert, key = _pair("up.example")
        r = self.client.post("/api/system/site-certificate/upload/",
                             {"cert": cert, "key": key}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertNotIn("PRIVATE", r.content.decode())
        with mock.patch.object(site_tls, "served", return_value=None):
            r = self.client.post("/api/system/site-certificate/self-signed/",
                                 {"names": ["one.example", "10.0.0.9"]}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(SiteCertificate.load().source, "self-signed")
        r = self.client.patch("/api/system/site-certificate/", {"auto_renew": False}, format="json")
        self.assertFalse(r.json()["auto_renew"])
