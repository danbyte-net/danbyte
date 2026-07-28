"""Certificate inventory (phase X0): collector, reconciliation, and the rule
that no private key may ever be stored.

Every certificate here is generated in-process with ``cryptography`` — the tests
never touch the network. The collector's socket layer is exercised by swapping
:func:`danbyte_checks.tls_cert._handshake`, so the parse, trust and expiry logic
runs for real against real DER.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import ipaddress
import ssl
from unittest import mock

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import NameOID
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from core.models import Organization, Tenant
from danbyte_checks import get_checker, tls_cert

from .certificates import observe_endpoint, record_chain
from .models import Certificate

User = get_user_model()


# ─── Test certificate factory (in-process, no network) ────────────────────


def make_cert(
    cn: str,
    *,
    issuer_cn: str | None = None,
    issuer_key=None,
    days_before: int = 1,
    days_after: int = 365,
    dns: tuple[str, ...] = (),
    ips: tuple[str, ...] = (),
    key=None,
):
    """Build a certificate and return ``(der, private_key)``.

    ``issuer_cn``/``issuer_key`` omitted → self-signed.
    """
    key = key or rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = dt.datetime.now(dt.UTC)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    issuer = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, issuer_cn or cn)]
    )
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=days_before))
        .not_valid_after(now + dt.timedelta(days=days_after))
    )
    names = [x509.DNSName(n) for n in (dns or (cn,))]
    names += [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]
    builder = builder.add_extension(
        x509.SubjectAlternativeName(names), critical=False
    )
    cert = builder.sign(issuer_key or key, hashes.SHA256())
    return cert.public_bytes(serialization.Encoding.DER), key


PRIVATE_KEY_PEM = rsa.generate_private_key(
    public_exponent=65537, key_size=2048
).private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.TraditionalOpenSSL,
    serialization.NoEncryption(),
).decode()


def fake_handshake(chain_der, tls_version="TLSv1.3", cipher="TLS_AES_256_GCM_SHA384"):
    """Stand in for the socket layer: return this chain, no I/O."""
    return mock.patch.object(
        tls_cert, "_handshake", return_value=(list(chain_der), tls_version, cipher)
    )


def allow_target():
    """Skip address resolution — the policy itself is tested separately."""
    return mock.patch.object(tls_cert, "target_allowed", return_value=(True, ""))


# ─── Collector ────────────────────────────────────────────────────────────


class CollectorTests(TestCase):
    def test_parses_public_fields_only(self):
        der, _ = make_cert(
            "svc.example.internal", dns=("svc.example.internal", "alt.example.internal"),
            ips=("10.1.2.3",),
        )
        parsed = tls_cert.parse_certificate(der, 0)
        self.assertEqual(parsed["subject_cn"], "svc.example.internal")
        self.assertEqual(parsed["issuer_cn"], "svc.example.internal")
        self.assertEqual(
            parsed["san_dns"], ["svc.example.internal", "alt.example.internal"]
        )
        self.assertEqual(parsed["san_ip"], ["10.1.2.3"])
        self.assertEqual(len(parsed["fingerprint_sha256"]), 64)
        self.assertEqual(parsed["public_key_algorithm"], "rsa")
        self.assertEqual(parsed["public_key_bits"], 2048)
        self.assertEqual(parsed["signature_algorithm"], "sha256WithRSAEncryption")
        self.assertTrue(parsed["self_signed"])
        self.assertEqual(parsed["chain_depth"], 0)
        # Nothing key-shaped is emitted at all.
        self.assertNotIn("private_key", parsed)
        for value in parsed.values():
            self.assertNotIn("PRIVATE KEY", str(value))

    def test_ec_key_size_reported(self):
        key = ec.generate_private_key(ec.SECP384R1())
        der, _ = make_cert("ec.example.internal", key=key)
        parsed = tls_cert.parse_certificate(der, 0)
        self.assertEqual(parsed["public_key_algorithm"], "ec")
        self.assertEqual(parsed["public_key_bits"], 384)

    def test_verified_chain_records_depth_and_validity(self):
        root, root_key = make_cert("Test Root CA")
        leaf, _ = make_cert("svc.example.com", issuer_cn="Test Root CA",
                            issuer_key=root_key)
        with allow_target(), fake_handshake([leaf, root]):
            obs = tls_cert.collect_chain("svc.example.com", 443)
        self.assertEqual(obs["validity"], tls_cert.VERIFIED)
        self.assertEqual(obs["chain_length"], 2)
        self.assertEqual([c["chain_depth"] for c in obs["chain"]], [0, 1])
        self.assertFalse(obs["expired"])
        self.assertFalse(obs["chain"][0]["self_signed"])
        self.assertGreater(obs["expires_in_days"], 300)

    def test_verification_failure_still_reads_the_cert(self):
        """The whole point: an untrusted cert is what we most need to record.
        The verifying pass fails; the chain is read by an explicitly unverified
        second pass and tagged as such — never silently 'verified'."""
        der, _ = make_cert("selfsigned.example.internal")
        error = ssl.SSLCertVerificationError("self-signed certificate")
        error.verify_message = "self-signed certificate"
        with allow_target(), mock.patch.object(
            tls_cert, "_handshake",
            side_effect=[error, ([der], "TLSv1.2", "AES256-GCM-SHA384")],
        ):
            obs = tls_cert.collect_chain("selfsigned.example.internal", 443)
        self.assertEqual(obs["validity"], tls_cert.UNVERIFIED)
        self.assertEqual(obs["verify_error"], "self-signed certificate")
        self.assertTrue(obs["self_signed"])
        self.assertEqual(obs["chain_length"], 1)

    def test_expired_certificate_is_recorded_not_rejected(self):
        der, _ = make_cert("old.example.internal", days_before=400, days_after=-35)
        with allow_target(), fake_handshake([der]):
            obs = tls_cert.collect_chain("old.example.internal", 443)
        self.assertTrue(obs["expired"])
        self.assertLess(obs["expires_in_days"], 0)
        self.assertEqual(obs["chain_length"], 1)
        self.assertEqual(obs["chain"][0]["subject_cn"], "old.example.internal")

    def test_fetch_failure_is_unknown_never_valid(self):
        with allow_target(), mock.patch.object(
            tls_cert, "_handshake", side_effect=ConnectionRefusedError("refused")
        ):
            obs = tls_cert.collect_chain("dead.example.internal", 443)
        self.assertEqual(obs["validity"], tls_cert.UNKNOWN)
        self.assertEqual(obs["error_kind"], tls_cert.ERR_CONNECT)
        self.assertEqual(obs["chain"], [])
        self.assertNotIn("expired", obs)  # no expiry claim can be made

    def test_loopback_and_metadata_are_always_refused(self):
        for host in ("127.0.0.1", "169.254.169.254", "0.0.0.0"):
            with self.subTest(host=host):
                obs = tls_cert.collect_chain(host, 443, allow_private=True)
                self.assertEqual(obs["validity"], tls_cert.UNKNOWN)
                self.assertEqual(obs["error_kind"], tls_cert.ERR_POLICY)

    def test_private_address_needs_the_explicit_allowance(self):
        with mock.patch.object(
            tls_cert.netguard, "address_blocked", return_value=True
        ), fake_handshake([make_cert("pki.internal")[0]]):
            blocked = tls_cert.collect_chain("192.0.2.10", 443)
            allowed = tls_cert.collect_chain("192.0.2.10", 443, allow_private=True)
        self.assertEqual(blocked["validity"], tls_cert.UNKNOWN)
        self.assertEqual(blocked["error_kind"], tls_cert.ERR_POLICY)
        self.assertEqual(allowed["validity"], tls_cert.VERIFIED)


class CheckerTests(TestCase):
    """The registered ``tls_cert`` check kind and its status mapping."""

    def _run(self, params=None):
        checker = get_checker("tls_cert")
        return asyncio.run(checker.run("svc.example.internal", params or {}, {}, 5000))

    def test_registered_in_the_shared_registry(self):
        checker = get_checker("tls_cert")
        self.assertIsNotNone(checker)
        self.assertEqual(checker.kind, "tls_cert")

    def test_valid_cert_is_up(self):
        root, root_key = make_cert("Test Root CA")
        leaf, _ = make_cert("svc.example.internal", issuer_cn="Test Root CA",
                            issuer_key=root_key)
        with allow_target(), fake_handshake([leaf, root]):
            outcome = self._run()
        self.assertEqual(outcome.status, "up")
        self.assertEqual(outcome.detail["chain_length"], 2)

    def test_expired_cert_is_degraded_and_still_carries_the_chain(self):
        der, _ = make_cert("svc.example.internal", days_before=400, days_after=-1)
        with allow_target(), fake_handshake([der]):
            outcome = self._run()
        self.assertEqual(outcome.status, "degraded")
        self.assertTrue(outcome.detail["expired"])
        self.assertEqual(len(outcome.detail["chain"]), 1)

    def test_unreachable_is_down_with_an_unknown_reading(self):
        with allow_target(), mock.patch.object(
            tls_cert, "_handshake", side_effect=TimeoutError("timed out")
        ):
            outcome = self._run()
        self.assertEqual(outcome.status, "down")
        self.assertEqual(outcome.detail["validity"], tls_cert.UNKNOWN)
        self.assertEqual(outcome.detail["chain"], [])

    def test_blocked_target_is_unknown_not_down(self):
        checker = get_checker("tls_cert")
        outcome = asyncio.run(checker.run("127.0.0.1", {}, {}, 2000))
        self.assertEqual(outcome.status, "unknown")

    def test_secret_params_are_ignored(self):
        """A certificate read needs no credential; nothing may be smuggled in."""
        der, _ = make_cert("svc.example.internal")
        checker = get_checker("tls_cert")
        with allow_target(), fake_handshake([der]):
            outcome = asyncio.run(
                checker.run(
                    "svc.example.internal", {},
                    {"private_key": PRIVATE_KEY_PEM}, 5000,
                )
            )
        self.assertNotIn("PRIVATE KEY", str(outcome.detail))


# ─── Reconciliation ───────────────────────────────────────────────────────


class _TenantBase(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.other_org = Organization.objects.create(name="Globex", slug="globex")
        self.other = Tenant.objects.create(
            org=self.other_org, name="Globex", slug="globex"
        )

    def observe(self, chain_der, tenant=None, host="svc.example.internal"):
        with allow_target(), fake_handshake(list(chain_der)):
            obs, rows = observe_endpoint(tenant or self.tenant, host, 443)
        return obs, rows


class ReconcileTests(_TenantBase):
    def test_fingerprint_is_the_identity_same_cert_twice_is_one_row(self):
        der, _ = make_cert("svc.example.internal")
        self.observe([der])
        # Same certificate, a different endpoint, a later poll.
        self.observe([der], host="other.example.internal")
        self.assertEqual(Certificate.objects.filter(tenant=self.tenant).count(), 1)
        row = Certificate.objects.get(tenant=self.tenant)
        self.assertEqual(row.subject_cn, "svc.example.internal")
        self.assertEqual(
            row.fingerprint_sha256, tls_cert.parse_certificate(der, 0)["fingerprint_sha256"]
        )

    def test_renewal_is_a_new_row_and_the_old_one_survives(self):
        old, _ = make_cert("svc.example.internal", days_before=300, days_after=65)
        self.observe([old])
        first = Certificate.objects.get(tenant=self.tenant)

        renewed, _ = make_cert("svc.example.internal", days_after=395)
        self.observe([renewed])

        rows = Certificate.objects.filter(tenant=self.tenant).order_by("not_after")
        self.assertEqual(rows.count(), 2)
        first.refresh_from_db()  # history is intact, not overwritten
        self.assertEqual(rows[0].id, first.id)
        self.assertNotEqual(rows[0].fingerprint_sha256, rows[1].fingerprint_sha256)
        self.assertLess(rows[0].not_after, rows[1].not_after)

    def test_whole_chain_is_recorded_with_depth(self):
        root, root_key = make_cert("Test Root CA")
        leaf, _ = make_cert("svc.example.internal", issuer_cn="Test Root CA",
                            issuer_key=root_key)
        self.observe([leaf, root])
        rows = {c.subject_cn: c for c in Certificate.objects.filter(tenant=self.tenant)}
        self.assertEqual(rows["svc.example.internal"].chain_depth, 0)
        self.assertEqual(rows["Test Root CA"].chain_depth, 1)
        self.assertTrue(rows["Test Root CA"].self_signed)
        self.assertFalse(rows["svc.example.internal"].self_signed)

    def test_expired_certificate_is_recorded(self):
        der, _ = make_cert("old.example.internal", days_before=400, days_after=-35)
        _, rows = self.observe([der])
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertTrue(row.is_expired)
        self.assertLess(row.days_until_expiry, 0)
        self.assertLess(row.not_after, timezone.now())

    def test_self_signed_certificate_sets_the_flag(self):
        der, _ = make_cert("selfsigned.example.internal")
        error = ssl.SSLCertVerificationError("self-signed certificate")
        error.verify_message = "self-signed certificate"
        with allow_target(), mock.patch.object(
            tls_cert, "_handshake",
            side_effect=[error, ([der], "TLSv1.3", "TLS_AES_256_GCM_SHA384")],
        ):
            observe_endpoint(self.tenant, "selfsigned.example.internal", 443)
        row = Certificate.objects.get(tenant=self.tenant)
        self.assertTrue(row.self_signed)
        self.assertIs(row.chain_verified, False)

    def test_fetch_failure_records_nothing_and_never_refreshes(self):
        der, _ = make_cert("svc.example.internal")
        self.observe([der])
        row = Certificate.objects.get(tenant=self.tenant)
        first_seen = row.last_seen

        with allow_target(), mock.patch.object(
            tls_cert, "_handshake", side_effect=ConnectionRefusedError("refused")
        ):
            obs, rows = observe_endpoint(self.tenant, "svc.example.internal", 443)

        self.assertEqual(obs["validity"], tls_cert.UNKNOWN)
        self.assertEqual(rows, [])
        self.assertEqual(Certificate.objects.filter(tenant=self.tenant).count(), 1)
        row.refresh_from_db()
        self.assertEqual(row.last_seen, first_seen)  # not touched by a failed read

    def test_unknown_observation_is_never_recorded_directly(self):
        self.assertEqual(record_chain(self.tenant, {"validity": "unknown", "chain": []}), [])
        self.assertEqual(record_chain(self.tenant, {}), [])
        self.assertEqual(record_chain(self.tenant, None), [])
        self.assertEqual(Certificate.objects.count(), 0)


class TenantIsolationTests(_TenantBase):
    def test_same_certificate_in_two_tenants_is_two_scoped_rows(self):
        der, _ = make_cert("shared.example.com")
        self.observe([der], tenant=self.tenant)
        self.observe([der], tenant=self.other)

        self.assertEqual(Certificate.objects.count(), 2)
        self.assertEqual(Certificate.objects.filter(tenant=self.tenant).count(), 1)
        self.assertEqual(Certificate.objects.filter(tenant=self.other).count(), 1)
        mine = Certificate.objects.get(tenant=self.tenant)
        theirs = Certificate.objects.get(tenant=self.other)
        self.assertEqual(mine.fingerprint_sha256, theirs.fingerprint_sha256)
        self.assertNotEqual(mine.id, theirs.id)

    def test_a_tenants_observation_never_touches_another_tenants_row(self):
        der, _ = make_cert("shared.example.com")
        self.observe([der], tenant=self.tenant)
        mine = Certificate.objects.get(tenant=self.tenant)
        mine_seen = mine.last_seen

        self.observe([der], tenant=self.other)  # Globex sees the same cert

        mine.refresh_from_db()
        self.assertEqual(mine.last_seen, mine_seen)
        self.assertEqual(
            Certificate.objects.filter(tenant=self.other).get().tenant_id,
            self.other.id,
        )


# ─── The rule: never a private key ────────────────────────────────────────


class NoPrivateKeyTests(_TenantBase):
    def test_the_model_has_no_field_that_could_hold_key_material(self):
        """There is deliberately no PEM/blob/notes/custom-fields column — the
        strongest form of "a private key is never stored" is having nowhere to
        put one. Every text field is a named, bounded X.509 attribute."""
        names = {f.name for f in Certificate._meta.get_fields()}
        for forbidden in (
            "private_key", "key", "key_pem", "pem", "raw", "blob", "body",
            "secret_params", "secrets", "custom_fields", "notes", "data",
        ):
            self.assertNotIn(forbidden, names)

    def test_save_refuses_key_material_in_any_field(self):
        der, _ = make_cert("svc.example.internal")
        _, rows = self.observe([der])
        row = rows[0]
        for field in ("subject", "subject_cn", "issuer", "issuer_cn", "serial",
                      "signature_algorithm", "fingerprint_sha256"):
            with self.subTest(field=field):
                fresh = Certificate.objects.get(pk=row.pk)
                setattr(fresh, field, PRIVATE_KEY_PEM)
                with self.assertRaises(ValidationError):
                    fresh.save()

    def test_save_refuses_key_material_inside_the_json_san_lists(self):
        der, _ = make_cert("svc.example.internal")
        _, rows = self.observe([der])
        row = Certificate.objects.get(pk=rows[0].pk)
        row.san_dns = ["ok.example.com", PRIVATE_KEY_PEM]
        with self.assertRaises(ValidationError):
            row.save()

    def test_a_key_bearing_observation_cannot_round_trip(self):
        """Even a hostile/buggy observation payload can't land key material."""
        der, _ = make_cert("svc.example.internal")
        parsed = tls_cert.parse_certificate(der, 0)
        parsed["subject"] = PRIVATE_KEY_PEM
        parsed["private_key"] = PRIVATE_KEY_PEM
        with self.assertRaises(ValidationError):
            record_chain(self.tenant, {"validity": "verified", "chain": [parsed]})
        self.assertEqual(Certificate.objects.count(), 0)


# ─── API ──────────────────────────────────────────────────────────────────


class CertificateApiTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.other_org = Organization.objects.create(name="Globex", slug="globex")
        self.other = Tenant.objects.create(
            org=self.other_org, name="Globex", slug="globex"
        )
        der, _ = make_cert("mine.example.com", days_after=10)
        with allow_target(), fake_handshake([der]):
            observe_endpoint(self.tenant, "mine.example.com", 443)
        other_der, _ = make_cert("theirs.example.com")
        with allow_target(), fake_handshake([other_der]):
            observe_endpoint(self.other, "theirs.example.com", 443)

        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _results(self, response):
        body = response.json()
        return body["results"] if isinstance(body, dict) else body

    def test_requires_authentication(self):
        self.client.logout()
        resp = self.client.get("/api/monitoring/certificates/")
        self.assertIn(resp.status_code, (401, 403))

    def test_list_is_scoped_to_the_active_tenant(self):
        resp = self.client.get("/api/monitoring/certificates/")
        self.assertEqual(resp.status_code, 200)
        rows = self._results(resp)
        self.assertEqual([r["subject_cn"] for r in rows], ["mine.example.com"])

    def test_cross_tenant_detail_is_not_readable(self):
        theirs = Certificate.objects.get(tenant=self.other)
        resp = self.client.get(f"/api/monitoring/certificates/{theirs.id}/")
        self.assertEqual(resp.status_code, 404)

    def test_write_methods_are_refused(self):
        mine = Certificate.objects.get(tenant=self.tenant)
        payload = {"subject_cn": "hacked", "subject": PRIVATE_KEY_PEM}
        self.assertEqual(
            self.client.post("/api/monitoring/certificates/", payload,
                             format="json").status_code, 405
        )
        self.assertEqual(
            self.client.patch(f"/api/monitoring/certificates/{mine.id}/", payload,
                              format="json").status_code, 405
        )
        self.assertEqual(
            self.client.delete(f"/api/monitoring/certificates/{mine.id}/").status_code,
            405,
        )
        mine.refresh_from_db()
        self.assertEqual(mine.subject_cn, "mine.example.com")

    def test_expiry_filters(self):
        rows = self._results(
            self.client.get("/api/monitoring/certificates/?expiring_in_days=30")
        )
        self.assertEqual(len(rows), 1)
        rows = self._results(
            self.client.get("/api/monitoring/certificates/?expiring_in_days=1")
        )
        self.assertEqual(rows, [])
        rows = self._results(self.client.get("/api/monitoring/certificates/?expired=1"))
        self.assertEqual(rows, [])

    def test_serializer_never_exposes_key_material(self):
        rows = self._results(self.client.get("/api/monitoring/certificates/"))
        self.assertNotIn("PRIVATE KEY", str(rows))
        self.assertTrue(set(rows[0]) & {"fingerprint_sha256", "not_after"})
