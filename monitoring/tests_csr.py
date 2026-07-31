"""Certificate signing requests (M3).

The load-bearing guarantees: generation is fail-closed without a secret store;
the private key is stored in the store (never on the row) and returned exactly
once; the issued cert only imports when its public key matches the CSR.
"""
from __future__ import annotations

import datetime as dt

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import NameOID
from django.contrib.auth import get_user_model
from django.test import TestCase

from core.models import DeploymentSettings, Organization, Tenant

from .csr import CsrError, generate, get_private_key, import_issued
from .models import CertificateRequest, StoredSecret
from .secret_store import SecretStoreDisabled

User = get_user_model()


def _sign_csr(csr_pem: str, *, days: int = 365) -> str:
    """Act as a CA: sign the request's public key into a certificate PEM."""
    csr = x509.load_pem_x509_csr(csr_pem.encode())
    issuer_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = dt.datetime.now(dt.UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(csr.subject)
        .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test CA")]))
        .public_key(csr.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=days))
        .sign(issuer_key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.PEM).decode()


class CsrGenerationTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.user = User.objects.create_user("u", password="x")

    def _enable_store(self):
        dep = DeploymentSettings.load()
        dep.secrets_provider = "local"
        dep.save(update_fields=["secrets_provider"])

    def test_generation_fails_closed_without_a_secret_store(self):
        with self.assertRaises(SecretStoreDisabled):
            generate(tenant=self.tenant, user=self.user, common_name="svc.example.com")
        self.assertEqual(CertificateRequest.objects.count(), 0)

    def test_generate_produces_csr_and_stores_key_off_row(self):
        self._enable_store()
        req, private_key = generate(
            tenant=self.tenant,
            user=self.user,
            common_name="svc.example.com",
            organization="Acme",
            san_dns=["svc.example.com", "www.example.com"],
            key_spec="ec-p256",
        )
        self.assertEqual(req.status, "generated")
        self.assertIn("BEGIN CERTIFICATE REQUEST", req.csr_pem)
        self.assertIn("BEGIN PRIVATE KEY", private_key)
        # The key is in the store, never on the row.
        self.assertEqual(req.key_ref, f"csr/{req.id}")
        self.assertEqual(get_private_key(req), private_key)
        self.assertNotIn("PRIVATE KEY", req.csr_pem)
        # The CSR carries the subject + SANs we asked for.
        csr = x509.load_pem_x509_csr(req.csr_pem.encode())
        self.assertEqual(
            csr.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value,
            "svc.example.com",
        )
        san = csr.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        self.assertEqual(
            set(san.get_values_for_type(x509.DNSName)),
            {"svc.example.com", "www.example.com"},
        )

    def test_common_name_is_required(self):
        self._enable_store()
        with self.assertRaises(CsrError):
            generate(tenant=self.tenant, user=self.user, common_name="  ")

    def test_import_matching_issued_cert_links_and_marks_issued(self):
        self._enable_store()
        req, _ = generate(
            tenant=self.tenant, user=self.user, common_name="svc.example.com"
        )
        issued_pem = _sign_csr(req.csr_pem)
        cert = import_issued(req, issued_pem)
        req.refresh_from_db()
        self.assertEqual(req.status, "issued")
        self.assertEqual(req.issued_certificate_id, cert.id)
        self.assertEqual(cert.subject_cn, "svc.example.com")

    def test_import_rejects_a_cert_for_a_different_key(self):
        self._enable_store()
        req, _ = generate(
            tenant=self.tenant, user=self.user, common_name="svc.example.com"
        )
        # A cert built around an unrelated key must not attach.
        other_key = ec.generate_private_key(ec.SECP256R1())
        now = dt.datetime.now(dt.UTC)
        wrong = (
            x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "svc.example.com")]))
            .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "CA")]))
            .public_key(other_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(days=1))
            .not_valid_after(now + dt.timedelta(days=365))
            .sign(other_key, hashes.SHA256())
            .public_bytes(serialization.Encoding.PEM)
            .decode()
        )
        with self.assertRaises(CsrError):
            import_issued(req, wrong)
        req.refresh_from_db()
        self.assertEqual(req.status, "generated")  # unchanged


class CsrApiTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        dep = DeploymentSettings.load()
        dep.secrets_provider = "local"
        dep.save(update_fields=["secrets_provider"])
        admin = User.objects.create_superuser("admin", "a@x.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def test_create_returns_csr_and_key_once(self):
        r = self.client.post(
            "/api/monitoring/certificate-requests/",
            {"common_name": "svc.acme.com", "key_spec": "rsa-2048"},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertIn("BEGIN CERTIFICATE REQUEST", body["csr_pem"])
        self.assertIn("BEGIN PRIVATE KEY", body["private_key"])
        # The list serializer never carries the key.
        rid = body["id"]
        detail = self.client.get(f"/api/monitoring/certificate-requests/{rid}/").json()
        self.assertNotIn("private_key", detail)

    def test_delete_removes_the_stored_key(self):
        r = self.client.post(
            "/api/monitoring/certificate-requests/",
            {"common_name": "svc.acme.com"},
            content_type="application/json",
        )
        rid = r.json()["id"]
        self.assertEqual(StoredSecret.objects.filter(ref=f"csr/{rid}").count(), 1)
        self.client.delete(f"/api/monitoring/certificate-requests/{rid}/")
        self.assertEqual(StoredSecret.objects.filter(ref=f"csr/{rid}").count(), 0)
