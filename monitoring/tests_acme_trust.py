"""An issuer's CA certificate: validation on save, and the trust its ACME
calls use - the server's store plus the issuer's own root, never only one.

Real TLS against a local server (``monitoring.acme_testing``); the "system
store" is a file the test controls, so nothing depends on this machine's.
"""
from __future__ import annotations

import os
import stat
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from cryptography.hazmat.primitives.asymmetric import ec

from . import acme_trust
from .acme_testing import key_pem, make_ca, pem
from .models import Issuer
from .tests_acme_errors import NO_PROXY, AcmeErrorsBase, _Pki


def _paths(cafile=None):
    return SimpleNamespace(cafile=cafile, openssl_cafile=cafile, capath=None,
                           openssl_capath=None, openssl_cafile_env="SSL_CERT_FILE",
                           openssl_capath_env="SSL_CERT_DIR")


class TrustBase(AcmeErrorsBase):
    def setUp(self):
        super().setUp()
        self.cache = Path(tempfile.mkdtemp(prefix="trust-cache-")) / "cache"
        for p in (
            mock.patch.object(acme_trust, "_cache_root", return_value=self.cache),
            mock.patch.object(acme_trust, "SYSTEM_BUNDLES", ()),
            mock.patch.dict(os.environ, {**NO_PROXY, "REQUESTS_CA_BUNDLE": "",
                                         "CURL_CA_BUNDLE": ""}),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.use_system_store(None)

    def use_system_store(self, cafile):
        p = mock.patch.object(acme_trust.ssl, "get_default_verify_paths",
                              return_value=_paths(cafile))
        p.start()
        self.addCleanup(p.stop)


class CaCertificateFieldTests(TrustBase):
    def post(self, ca_certificate):
        return self.client.post("/api/monitoring/issuers/", {
            "name": "private", "directory_url": "https://ca.example/acme/acme/directory",
            "ca_certificate": ca_certificate,
        }, content_type="application/json")

    def assert_field_error(self, r, *words):
        self.assertEqual(r.status_code, 400, r.content)
        msg = r.json()["ca_certificate"][0]
        for w in words:
            self.assertIn(w, msg)

    def test_a_root_is_stored_normalized_and_returned_with_its_facts(self):
        text = "Our root\n" + pem(self.pki.ca) + "\ntrailing notes\n"
        r = self.post(text)
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["ca_certificate"], pem(self.pki.ca))
        info = body["ca_certificate_info"]
        self.assertEqual(len(info), 1)
        self.assertEqual(info[0]["subject_cn"], "Throwaway Test Root")
        self.assertGreater(info[0]["days_left"], 20)
        self.assertTrue(info[0]["not_after"])
        got = self.client.get(f"/api/monitoring/issuers/{body['id']}/").json()
        self.assertEqual(got["ca_certificate"], pem(self.pki.ca))

    def test_blank_is_allowed_and_clears_it(self):
        r = self.post(pem(self.pki.ca))
        iid = r.json()["id"]
        r = self.client.patch(f"/api/monitoring/issuers/{iid}/", {"ca_certificate": ""},
                              content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(Issuer.objects.get(id=iid).ca_certificate, "")
        self.assertEqual(r.json()["ca_certificate_info"], [])

    def test_garbage_is_refused(self):
        self.assert_field_error(self.post("not a certificate"), "Not a PEM certificate")
        broken = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"
        self.assert_field_error(self.post(broken), "Could not read")

    def test_a_private_key_is_refused(self):
        key = key_pem(ec.generate_private_key(ec.SECP256R1()))
        r = self.post(pem(self.pki.ca) + key)
        self.assert_field_error(r, "private key")
        self.assertNotIn("BEGIN", r.json()["ca_certificate"][0].split("(")[0])
        self.assertFalse(Issuer.objects.filter(name="private").exists())

    def test_other_pem_blocks_are_refused(self):
        csr = ("-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n"
               "-----END CERTIFICATE REQUEST-----\n")
        self.assert_field_error(self.post(csr), "certificate request")

    def test_too_many_certificates(self):
        many = "".join(pem(make_ca(f"r{i}")[0]) for i in range(acme_trust.MAX_CERTIFICATES + 1))
        self.assert_field_error(self.post(many), f"At most {acme_trust.MAX_CERTIFICATES}")

    def test_too_long(self):
        self.assertEqual(self.post("x" * (70 * 1024)).status_code, 400)

    def test_a_server_certificate_is_not_a_ca(self):
        leaf, _ = make_ca("ca.example", ca=False)
        self.assert_field_error(self.post(pem(leaf)), "“ca.example” is not a CA certificate")

    def test_an_expired_root_is_refused(self):
        old, _ = make_ca("Old Root", days=-1)
        self.assert_field_error(self.post(pem(old)), "“Old Root” expired")

    def test_a_bad_stored_value_is_a_field_error_at_use(self):
        Issuer.objects.filter(pk=self.issuer.pk).update(ca_certificate="garbage")
        r = self.register()
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("ca_certificate", r.json())


class TrustTests(TrustBase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.other = _Pki()  # a second CA: "the system store"

    def test_the_issuers_ca_is_trusted(self):
        self.issuer.ca_certificate = pem(self.pki.ca)
        self.issuer.save()
        with self.pki.server() as ca:
            self.point(ca.url())
            r = self.register()
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_system_store_is_used_without_a_ca_certificate(self):
        # The owner's case: the root went in with update-ca-certificates.
        self.use_system_store(self.other.ca_file)
        with self.other.server() as ca:
            self.point(ca.url())
            r = self.register()
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_system_store_still_counts_with_a_ca_certificate(self):
        self.use_system_store(self.other.ca_file)
        self.issuer.ca_certificate = pem(self.pki.ca)
        self.issuer.save()
        for pki in (self.pki, self.other):
            with pki.server() as ca:
                self.point(ca.url())
                r = self.register()
            self.assertEqual(r.status_code, 200, r.content)

    def test_a_ca_certificate_that_does_not_cover_it_says_so(self):
        self.issuer.ca_certificate = pem(self.other.ca)
        self.issuer.save()
        with self.pki.server() as ca:
            self.point(ca.url())
            r = self.register()
        self.assertEqual(r.status_code, 502, r.content)
        self.assertIn("does not cover it", r.json()["detail"])

    def test_without_either_the_hint_names_the_field(self):
        with self.pki.server() as ca:
            self.point(ca.url())
            r = self.register()
        self.assertEqual(r.status_code, 502, r.content)
        self.assertIn("CA certificate field", r.json()["detail"])

    def test_verify_off_is_false(self):
        self.issuer.verify_tls = False
        self.issuer.ca_certificate = pem(self.pki.ca)
        self.assertIs(acme_trust.verify_for(self.issuer), False)


class BaseBundleTests(TrustBase):
    def test_environment_wins(self):
        f = Path(tempfile.mkdtemp()) / "env.pem"
        f.write_text(pem(self.pki.ca))
        with mock.patch.dict(os.environ, {"REQUESTS_CA_BUNDLE": str(f)}):
            self.assertEqual(acme_trust.base_bundle(), (str(f), "environment"))

    def test_system_then_certifi(self):
        import certifi

        self.assertEqual(acme_trust.base_bundle(), (certifi.where(), "certifi"))
        self.use_system_store(self.pki.ca_file)
        self.assertEqual(acme_trust.base_bundle(), (self.pki.ca_file, "system"))

    def test_an_empty_system_file_is_skipped(self):
        empty = Path(tempfile.mkdtemp()) / "empty.pem"
        empty.write_text("")
        self.use_system_store(str(empty))
        self.assertEqual(acme_trust.base_bundle()[1], "certifi")


class BundleFileTests(TrustBase):
    def bundle(self, extra=None):
        return acme_trust.combined_bundle(self.pki.ca_file, extra or pem(make_ca("x")[0]))

    def test_private_file_in_a_private_directory(self):
        path = Path(self.bundle())
        self.assertEqual(path.parent, self.cache)
        self.assertEqual(stat.S_IMODE(self.cache.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(path.stat().st_uid, os.getuid())
        text = path.read_text()
        self.assertTrue(text.startswith(pem(self.pki.ca).strip()))
        self.assertEqual(text.count("BEGIN CERTIFICATE"), 2)
        self.assertFalse([p for p in self.cache.iterdir() if p.name.startswith(".tmp-")])

    def test_same_content_same_file(self):
        extra = pem(make_ca("y")[0])
        self.assertEqual(self.bundle(extra), self.bundle(extra))
        self.assertEqual(len(list(self.cache.iterdir())), 1)

    def test_idle_bundles_are_pruned(self):
        old = Path(self.bundle())
        past = time.time() - 2 * 24 * 3600
        os.utime(old, (past, past))
        new = Path(self.bundle())
        self.assertNotEqual(old, new)
        self.assertFalse(old.exists())
        self.assertTrue(new.exists())

    def test_a_directory_open_to_others_is_not_used(self):
        self.cache.mkdir(mode=0o700)
        os.chmod(self.cache, 0o777)
        path = Path(self.bundle())
        self.assertNotEqual(path.parent, self.cache)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)

    def test_a_symlink_is_not_followed(self):
        target = Path(tempfile.mkdtemp())
        self.cache.symlink_to(target)
        path = Path(self.bundle())
        self.assertNotEqual(path.parent, self.cache)
        self.assertEqual(list(target.iterdir()), [])
