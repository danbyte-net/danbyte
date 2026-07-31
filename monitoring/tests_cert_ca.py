"""CA modelling + issuer-chain graph (M1a).

A leaf's Authority Key Identifier equals its issuer's Subject Key Identifier;
that is how leaf → intermediate → root edges are built, and they must resolve
no matter what order the certs arrive in.
"""
from __future__ import annotations

import datetime as dt

from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import Encoding
from cryptography.x509.oid import NameOID
from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .certificates import CertificateUploadError, import_bundle, upload_certificate
from .models import Certificate

User = get_user_model()


def _key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _mkcert(cn, key, issuer_cn, issuer_key, *, ca, days=365):
    now = dt.datetime.now(dt.UTC)
    ski = x509.SubjectKeyIdentifier.from_public_key(key.public_key())
    builder = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)]))
        .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, issuer_cn)]))
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=days))
        .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
        .add_extension(ski, critical=False)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer_key.public_key()),
            critical=False,
        )
    )
    return builder.sign(issuer_key, hashes.SHA256()).public_bytes(Encoding.PEM).decode()


def _three_tier():
    """Return PEMs for (root, intermediate, leaf)."""
    rk, ik, lk = _key(), _key(), _key()
    root = _mkcert("Danbyte Root CA", rk, "Danbyte Root CA", rk, ca=True)
    inter = _mkcert("Danbyte Issuing CA", ik, "Danbyte Root CA", rk, ca=True)
    leaf = _mkcert("svc.danbyte.lan", lk, "Danbyte Issuing CA", ik, ca=False)
    return root, inter, leaf


class ChainLinkingTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def _upload(self, *pems):
        for p in pems:
            upload_certificate(self.tenant, p)

    def _by_cn(self, cn):
        return Certificate.objects.get(tenant=self.tenant, subject_cn=cn)

    def _assert_linked(self):
        root = self._by_cn("Danbyte Root CA")
        inter = self._by_cn("Danbyte Issuing CA")
        leaf = self._by_cn("svc.danbyte.lan")
        self.assertTrue(root.is_ca)
        self.assertTrue(inter.is_ca)
        self.assertFalse(leaf.is_ca)
        self.assertTrue(root.self_signed)
        self.assertIsNone(root.issuer_certificate_id)  # top of the chain
        self.assertEqual(inter.issuer_certificate_id, root.id)
        self.assertEqual(leaf.issuer_certificate_id, inter.id)
        # SKI/AKI captured, and the edge matches them.
        self.assertTrue(leaf.authority_key_id)
        self.assertEqual(leaf.authority_key_id, inter.subject_key_id)

    def test_links_when_uploaded_root_first(self):
        root, inter, leaf = _three_tier()
        self._upload(root, inter, leaf)
        self._assert_linked()

    def test_links_when_uploaded_leaf_first(self):
        # The hard case: a leaf arrives before any CA, then the CAs adopt it.
        root, inter, leaf = _three_tier()
        self._upload(leaf, inter, root)
        self._assert_linked()

    def test_links_when_uploaded_middle_out(self):
        root, inter, leaf = _three_tier()
        self._upload(inter, leaf, root)
        self._assert_linked()


class BundleImportTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def test_bundle_imports_every_block_and_links_the_chain(self):
        root, inter, leaf = _three_tier()
        result = import_bundle(self.tenant, "\n".join([leaf, inter, root]))
        self.assertEqual(result.total, 3)
        self.assertEqual(result.created, 3)
        self.assertEqual(result.existing, 0)
        self.assertEqual(result.errors, [])
        # All three rows exist and the chain is wired up (unlike single upload,
        # which would keep only the leaf).
        self.assertEqual(Certificate.objects.filter(tenant=self.tenant).count(), 3)
        leaf_row = Certificate.objects.get(tenant=self.tenant, subject_cn="svc.danbyte.lan")
        inter_row = Certificate.objects.get(tenant=self.tenant, subject_cn="Danbyte Issuing CA")
        self.assertEqual(leaf_row.issuer_certificate_id, inter_row.id)

    def test_reimport_dedups_by_fingerprint(self):
        root, inter, leaf = _three_tier()
        bundle = "\n".join([leaf, inter, root])
        import_bundle(self.tenant, bundle)
        again = import_bundle(self.tenant, bundle)
        self.assertEqual(again.created, 0)
        self.assertEqual(again.existing, 3)
        self.assertEqual(Certificate.objects.filter(tenant=self.tenant).count(), 3)

    def test_a_private_key_block_refuses_the_whole_bundle(self):
        root, inter, leaf = _three_tier()
        poisoned = leaf + "\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"
        with self.assertRaises(CertificateUploadError):
            import_bundle(self.tenant, poisoned)
        self.assertEqual(Certificate.objects.filter(tenant=self.tenant).count(), 0)


class ChainApiTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        root, inter, leaf = _three_tier()
        for p in (root, inter, leaf):
            upload_certificate(self.tenant, p)
        admin = User.objects.create_superuser("admin", "a@x.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def test_chain_action_returns_leaf_to_root(self):
        leaf = Certificate.objects.get(tenant=self.tenant, subject_cn="svc.danbyte.lan")
        r = self.client.get(f"/api/monitoring/certificates/{leaf.id}/chain/")
        self.assertEqual(r.status_code, 200, r.content)
        cns = [c["subject_cn"] for c in r.json()["chain"]]
        self.assertEqual(
            cns, ["svc.danbyte.lan", "Danbyte Issuing CA", "Danbyte Root CA"]
        )

    def test_authorities_lists_only_cas_with_issued_counts(self):
        r = self.client.get("/api/monitoring/certificates/authorities/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        rows = body["results"] if isinstance(body, dict) else body
        cns = {row["subject_cn"] for row in rows}
        self.assertEqual(cns, {"Danbyte Root CA", "Danbyte Issuing CA"})
        by_cn = {row["subject_cn"]: row for row in rows}
        self.assertEqual(by_cn["Danbyte Root CA"]["issued_count"], 1)  # the intermediate
        self.assertEqual(by_cn["Danbyte Issuing CA"]["issued_count"], 1)  # the leaf

    def test_is_ca_filter(self):
        r = self.client.get("/api/monitoring/certificates/?is_ca=1")
        body = r.json()
        rows = body["results"] if isinstance(body, dict) else body
        self.assertTrue(all(row["is_ca"] for row in rows))
        self.assertEqual(len(rows), 2)
