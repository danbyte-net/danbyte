"""Certificate inventory: collector, reconciliation, bindings, expiry alerting,
and the rule that no private key may ever be stored.

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

from api.models import IPAddress, Prefix
from api.test_utils import status_for
from core.models import Organization, Tenant
from danbyte_checks import get_checker, tls_cert

from .cert_drift import accept_cert_mismatch, evaluate_mismatch
from .cert_drift import dedup_key as mismatch_key
from .cert_expiry import (
    DEDUP_PREFIX,
    EXPIRED,
    EXPIRING_CRITICAL,
    EXPIRING_WARNING,
    OK,
    classify,
    sweep,
    thresholds,
)
from .certificates import (
    CertificateUploadError,
    Endpoint,
    observe_endpoint,
    record_chain,
    upload_certificate,
)
from .models import (
    Alert,
    AlertSeverity,
    AlertStatus,
    Certificate,
    CertificateAssignment,
    CertificateBinding,
    MonitoringSettings,
)

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
        """An anonymous read — no monitored IP, so no binding."""
        with allow_target(), fake_handshake(list(chain_der)):
            obs, rows = observe_endpoint(tenant or self.tenant, host, 443)
        return obs, rows

    def make_ip(self, address="10.0.0.5", tenant=None):
        tenant = tenant or self.tenant
        prefix, _ = Prefix.objects.get_or_create(
            tenant=tenant, cidr="10.0.0.0/8",
            defaults={"status": status_for(tenant, "container")},
        )
        return IPAddress.objects.create(
            tenant=tenant, ip_address=address, prefix=prefix
        )

    def observe_at(self, chain_der, ip, *, tenant=None, host=None, port=443,
                   server_name=None):
        """A read tied to a monitored IP — this is what produces bindings."""
        with allow_target(), fake_handshake(list(chain_der)):
            return observe_endpoint(
                tenant or self.tenant,
                host or ip.ip_address,
                port,
                server_name=server_name,
                target_ip=ip,
            )


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

    def test_whole_chain_is_recorded_with_depth_on_the_binding(self):
        root, root_key = make_cert("Test Root CA")
        leaf, _ = make_cert("svc.example.internal", issuer_cn="Test Root CA",
                            issuer_key=root_key)
        ip = self.make_ip()
        self.observe_at([leaf, root], ip)
        rows = {c.subject_cn: c for c in Certificate.objects.filter(tenant=self.tenant)}
        # Depth is a property of *this* handshake, so it lives on the binding.
        depths = {
            b.certificate.subject_cn: b.chain_depth
            for b in CertificateBinding.objects.select_related("certificate")
        }
        self.assertEqual(depths["svc.example.internal"], 0)
        self.assertEqual(depths["Test Root CA"], 1)
        # Self-signed is intrinsic to the bytes, so it stays on the certificate.
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
        ip = self.make_ip()
        error = ssl.SSLCertVerificationError("self-signed certificate")
        error.verify_message = "self-signed certificate"
        with allow_target(), mock.patch.object(
            tls_cert, "_handshake",
            side_effect=[error, ([der], "TLSv1.3", "TLS_AES_256_GCM_SHA384")],
        ):
            observe_endpoint(
                self.tenant, "selfsigned.example.internal", 443, target_ip=ip
            )
        row = Certificate.objects.get(tenant=self.tenant)
        self.assertTrue(row.self_signed)
        # "Did the chain verify" is per-endpoint, so it is on the binding.
        self.assertIs(CertificateBinding.objects.get().chain_verified, False)

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
    def test_the_model_has_no_key_bearing_field(self):
        """S0 adds a ``pem`` column for the **public** certificate (broadcast to
        every client — not a secret) and free-text ``name``/``notes``, but still
        has no field named for a key or an opaque blob, and the ``save`` guard
        below rejects key material in any field regardless."""
        names = {f.name for f in Certificate._meta.get_fields()}
        for forbidden in (
            "private_key", "key", "key_pem", "raw", "blob", "body",
            "secret_params", "secrets", "custom_fields", "data",
        ):
            self.assertNotIn(forbidden, names)
        # The public PEM column exists deliberately; the private key never does.
        self.assertIn("pem", names)

    def test_save_refuses_key_material_in_pem_and_notes(self):
        der, _ = make_cert("svc.example.internal")
        _, rows = self.observe([der])
        for field in ("pem", "notes", "name"):
            with self.subTest(field=field):
                fresh = Certificate.objects.get(pk=rows[0].pk)
                setattr(fresh, field, PRIVATE_KEY_PEM)
                with self.assertRaises(ValidationError):
                    fresh.save()

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

    def test_observed_facts_are_read_only_on_patch(self):
        """PATCH may touch authored metadata only — never an intrinsic fact.

        A payload trying to overwrite subject/fingerprint (or smuggle a key into
        one) is silently ignored for the facts and accepted for name/notes."""
        mine = Certificate.objects.get(tenant=self.tenant)
        payload = {
            "subject_cn": "hacked", "subject": PRIVATE_KEY_PEM,
            "fingerprint_sha256": "0" * 64,
            "name": "Edge cert", "notes": "renewed by ACME",
        }
        resp = self.client.patch(
            f"/api/monitoring/certificates/{mine.id}/", payload, format="json"
        )
        self.assertEqual(resp.status_code, 200)
        mine.refresh_from_db()
        # Facts unchanged; only authored metadata took.
        self.assertEqual(mine.subject_cn, "mine.example.com")
        self.assertNotIn("PRIVATE KEY", mine.subject)
        self.assertEqual(mine.name, "Edge cert")
        self.assertEqual(mine.notes, "renewed by ACME")

    def test_create_without_pem_is_a_400_not_a_405(self):
        """The create path is upload-only: a body with fact fields but no PEM is
        a clean validation error, and nothing is written."""
        before = Certificate.objects.filter(tenant=self.tenant).count()
        resp = self.client.post(
            "/api/monitoring/certificates/",
            {"subject_cn": "hacked", "subject": PRIVATE_KEY_PEM},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(
            Certificate.objects.filter(tenant=self.tenant).count(), before
        )

    def test_delete_is_allowed(self):
        mine = Certificate.objects.get(tenant=self.tenant)
        self.assertEqual(
            self.client.delete(
                f"/api/monitoring/certificates/{mine.id}/"
            ).status_code,
            204,
        )
        self.assertFalse(
            Certificate.objects.filter(pk=mine.id).exists()
        )

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


# ─── X1: bindings ─────────────────────────────────────────────────────────


class BindingTests(_TenantBase):
    def test_one_certificate_on_many_endpoints_is_one_row_and_many_bindings(self):
        """The reason the fingerprint is the identity: a wildcard cert on three
        hosts must not become three certificate rows."""
        der, _ = make_cert("*.example.com", dns=("*.example.com",))
        for address in ("10.0.0.5", "10.0.0.6", "10.0.0.7"):
            self.observe_at([der], self.make_ip(address))

        self.assertEqual(Certificate.objects.filter(tenant=self.tenant).count(), 1)
        cert = Certificate.objects.get(tenant=self.tenant)
        self.assertEqual(cert.bindings.count(), 3)
        self.assertEqual(
            {b.target_ip.ip_address for b in cert.bindings.all()},
            {"10.0.0.5", "10.0.0.6", "10.0.0.7"},
        )

    def test_re_observation_moves_last_seen_and_keeps_first_seen(self):
        der, _ = make_cert("svc.example.com")
        ip = self.make_ip()
        self.observe_at([der], ip)
        binding = CertificateBinding.objects.get()
        first, seen = binding.first_seen, binding.last_seen

        self.observe_at([der], ip)
        self.assertEqual(CertificateBinding.objects.count(), 1)
        binding.refresh_from_db()
        self.assertEqual(binding.first_seen, first)
        self.assertGreater(binding.last_seen, seen)

    def test_a_failed_read_creates_no_binding_and_refreshes_none(self):
        der, _ = make_cert("svc.example.com")
        ip = self.make_ip()
        self.observe_at([der], ip)
        binding = CertificateBinding.objects.get()
        seen = binding.last_seen

        with allow_target(), mock.patch.object(
            tls_cert, "_handshake", side_effect=ConnectionRefusedError("refused")
        ):
            observe_endpoint(self.tenant, ip.ip_address, 443, target_ip=ip)

        self.assertEqual(CertificateBinding.objects.count(), 1)
        binding.refresh_from_db()
        self.assertEqual(binding.last_seen, seen)

    def test_a_renewal_leaves_the_old_binding_as_history(self):
        """Bindings are never deleted — that is the record of what an endpoint
        *used* to serve, and the reason a stale last_seen is the signal."""
        old, _ = make_cert("svc.example.com", days_after=20)
        ip = self.make_ip()
        self.observe_at([old], ip)
        new, _ = make_cert("svc.example.com", days_after=400)
        self.observe_at([new], ip)

        bindings = list(CertificateBinding.objects.order_by("first_seen"))
        self.assertEqual(len(bindings), 2)
        # Same endpoint, two certificates, one key that outlives the renewal.
        self.assertEqual({b.endpoint_key for b in bindings}, {bindings[0].endpoint_key})
        self.assertNotEqual(bindings[0].certificate_id, bindings[1].certificate_id)

    def test_the_endpoint_key_is_ip_port_and_sni(self):
        der, _ = make_cert("svc.example.com")
        ip = self.make_ip()
        self.observe_at([der], ip, port=443, server_name="a.example.com")
        self.observe_at([der], ip, port=443, server_name="b.example.com")
        self.observe_at([der], ip, port=8443, server_name="a.example.com")

        keys = set(CertificateBinding.objects.values_list("endpoint_key", flat=True))
        self.assertEqual(len(keys), 3)  # name and port each make a new endpoint
        self.assertEqual(CertificateBinding.objects.count(), 3)

    def test_chain_facts_are_per_endpoint_not_per_certificate(self):
        """A server that stops sending its intermediate changes the observation
        but not a single byte of any certificate."""
        root, root_key = make_cert("Test Root CA")
        leaf, _ = make_cert("svc.example.com", issuer_cn="Test Root CA",
                            issuer_key=root_key)
        full = self.make_ip("10.0.0.5")
        partial = self.make_ip("10.0.0.6")
        self.observe_at([leaf, root], full)
        self.observe_at([leaf], partial)

        cert = Certificate.objects.get(subject_cn="svc.example.com")
        self.assertEqual(cert.bindings.count(), 2)
        self.assertEqual(
            CertificateBinding.objects.filter(
                certificate__subject_cn="Test Root CA"
            ).count(),
            1,  # only the endpoint that actually sent it
        )
        for field in ("chain_depth", "chain_verified"):
            self.assertNotIn(field, {f.name for f in Certificate._meta.get_fields()})

    def test_an_anonymous_read_records_a_certificate_but_no_binding(self):
        der, _ = make_cert("svc.example.com")
        self.observe([der])  # no target IP
        self.assertEqual(Certificate.objects.count(), 1)
        self.assertEqual(CertificateBinding.objects.count(), 0)


class BindingTenantIsolationTests(_TenantBase):
    def test_a_binding_may_never_cross_tenants(self):
        der, _ = make_cert("shared.example.com")
        theirs = self.make_ip("10.0.0.9", tenant=self.other)
        parsed = tls_cert.parse_certificate(der, 0)

        with self.assertRaises(ValueError):
            record_chain(
                self.tenant,
                {"validity": "verified", "chain": [parsed]},
                endpoint=Endpoint(target_ip=theirs, port=443),
            )
        self.assertEqual(CertificateBinding.objects.count(), 0)

    def test_the_model_itself_refuses_a_cross_tenant_certificate(self):
        """Defence in depth: the reconciler's guard is not the only one."""
        der, _ = make_cert("shared.example.com")
        self.observe_at([der], self.make_ip("10.0.0.5"))
        theirs_ip = self.make_ip("10.0.0.9", tenant=self.other)
        mine_cert = Certificate.objects.get(tenant=self.tenant)

        with self.assertRaises(ValidationError):
            CertificateBinding(
                tenant=self.tenant, certificate=mine_cert, target_ip=theirs_ip,
                port=443, first_seen=timezone.now(), last_seen=timezone.now(),
            ).save()

    def test_two_tenants_observing_the_same_certificate_get_separate_bindings(self):
        der, _ = make_cert("shared.example.com")
        self.observe_at([der], self.make_ip("10.0.0.5"))
        self.observe_at(
            [der], self.make_ip("10.0.0.5", tenant=self.other), tenant=self.other
        )
        self.assertEqual(CertificateBinding.objects.filter(tenant=self.tenant).count(), 1)
        self.assertEqual(CertificateBinding.objects.filter(tenant=self.other).count(), 1)
        mine = CertificateBinding.objects.get(tenant=self.tenant)
        self.assertEqual(mine.certificate.tenant_id, self.tenant.id)
        self.assertEqual(mine.target_ip.tenant_id, self.tenant.id)


# ─── X2: expiry alerting ──────────────────────────────────────────────────


class ExpiryAlertTests(_TenantBase):
    """The alert is about the *endpoint*, not the certificate row — which is
    what makes a renewal resolve it instead of orphaning it."""

    def setUp(self):
        super().setUp()
        self.ip = self.make_ip()
        self.notify = mock.patch("monitoring.notify.notify_alert").start()
        self.addCleanup(mock.patch.stopall)

    def alerts(self, status=AlertStatus.FIRING):
        return list(Alert.objects.filter(tenant=self.tenant, status=status))

    def serve(self, days_after, *, ip=None, host=None):
        der, _ = make_cert(
            "svc.example.com", days_before=400, days_after=days_after
        )
        return self.observe_at([der], ip or self.ip, host=host)

    def test_healthy_certificate_raises_nothing(self):
        self.serve(365)
        self.assertEqual(self.alerts(), [])

    def test_warning_window_opens_a_warning(self):
        self.serve(20)  # inside 30, outside 7
        alert = Alert.objects.get()
        self.assertEqual(alert.severity, AlertSeverity.WARNING)
        self.assertEqual(alert.check_status, "degraded")
        self.assertEqual(alert.detail["cert_state"], EXPIRING_WARNING)
        self.assertEqual(alert.kind, "tls_cert")
        self.assertTrue(alert.dedup_key.startswith(DEDUP_PREFIX))

    def test_critical_window_opens_a_critical(self):
        self.serve(3)
        alert = Alert.objects.get()
        self.assertEqual(alert.severity, AlertSeverity.CRITICAL)
        self.assertEqual(alert.detail["cert_state"], EXPIRING_CRITICAL)

    def test_expired_is_its_own_state_not_just_urgent(self):
        self.serve(-5)
        alert = Alert.objects.get()
        self.assertEqual(alert.severity, AlertSeverity.CRITICAL)
        self.assertEqual(alert.detail["cert_state"], EXPIRED)
        # Distinct from "expiring critically": an expired cert is a failure.
        self.assertEqual(alert.check_status, "down")

    def test_crossing_from_warning_to_critical_updates_one_alert(self):
        self.serve(20)
        opened = Alert.objects.get()
        self.serve(3)  # a new (shorter) cert on the same endpoint
        self.assertEqual(Alert.objects.count(), 1)
        opened.refresh_from_db()
        self.assertEqual(opened.severity, AlertSeverity.CRITICAL)
        self.assertEqual(opened.detail["cert_state"], EXPIRING_CRITICAL)
        self.assertEqual(opened.notify_count, 2)

    def test_renewal_resolves_the_alert_rather_than_orphaning_it(self):
        """The subtle failure this whole design exists to avoid: a renewal is a
        NEW certificate row, so an alert keyed on the certificate could never be
        resolved by it."""
        self.serve(3)
        firing = Alert.objects.get()
        self.assertEqual(firing.status, AlertStatus.FIRING)
        old_fingerprint = firing.detail["fingerprint_sha256"]

        self.serve(365)  # renewed on the same endpoint

        self.assertEqual(Alert.objects.count(), 1)  # no second, orphaned alert
        firing.refresh_from_db()
        self.assertEqual(firing.status, AlertStatus.RESOLVED)
        self.assertIsNotNone(firing.resolved_at)
        # And it is the *same row* that was firing for the retired certificate.
        self.assertEqual(firing.detail["fingerprint_sha256"], old_fingerprint)
        self.assertEqual(Certificate.objects.count(), 2)  # history intact

    def test_renewal_into_the_window_keeps_one_alert_pointing_at_the_new_cert(self):
        self.serve(3)
        alert = Alert.objects.get()
        self.serve(20)  # renewed, but still inside the warning window
        self.assertEqual(Alert.objects.count(), 1)
        alert.refresh_from_db()
        self.assertEqual(alert.status, AlertStatus.FIRING)
        self.assertEqual(alert.detail["cert_state"], EXPIRING_WARNING)
        newest = Certificate.objects.order_by("-not_after").first()
        self.assertEqual(alert.detail["fingerprint_sha256"], newest.fingerprint_sha256)

    def test_a_stale_binding_stops_alerting(self):
        self.serve(3)
        self.assertEqual(len(self.alerts()), 1)

        CertificateBinding.objects.update(
            last_seen=timezone.now() - dt.timedelta(days=30)
        )
        sweep()

        self.assertEqual(self.alerts(), [])
        resolved = Alert.objects.get()
        self.assertEqual(resolved.status, AlertStatus.RESOLVED)
        self.assertIn("no longer observed", resolved.detail["resolution"])
        # History survives — the binding is not deleted, only stale.
        self.assertEqual(CertificateBinding.objects.count(), 1)

    def test_a_stale_binding_never_opens_an_alert_in_the_first_place(self):
        self.serve(3)
        Alert.objects.all().delete()
        CertificateBinding.objects.update(
            last_seen=timezone.now() - dt.timedelta(days=30)
        )
        self.assertEqual(sweep()["opened"], 0)
        self.assertEqual(Alert.objects.count(), 0)

    def test_thresholds_are_configurable_per_tenant(self):
        MonitoringSettings.objects.create(
            tenant=self.tenant,
            cert_expiry_warning_days=90,
            cert_expiry_critical_days=45,
        )
        self.serve(60)  # healthy on the defaults, a warning at 90/45
        alert = Alert.objects.get()
        self.assertEqual(alert.detail["cert_state"], EXPIRING_WARNING)
        self.assertEqual(alert.detail["warning_days"], 90)

    def test_alerting_can_be_switched_off_without_leaving_strays(self):
        self.serve(3)
        self.assertEqual(len(self.alerts()), 1)
        MonitoringSettings.objects.create(
            tenant=self.tenant, cert_expiry_alerts_enabled=False
        )
        sweep()
        self.assertEqual(self.alerts(), [])

    def test_time_passing_is_enough_to_open_an_alert(self):
        """The sweep exists because a certificate crosses the warning line
        whether or not anything scanned it that day."""
        self.serve(365)
        self.assertEqual(Alert.objects.count(), 0)
        Certificate.objects.update(
            not_after=timezone.now() + dt.timedelta(days=2)
        )
        sweep()
        self.assertEqual(Alert.objects.get().detail["cert_state"], EXPIRING_CRITICAL)

    def test_only_leaf_certificates_alert(self):
        root, root_key = make_cert("Test Root CA", days_after=4)
        leaf, _ = make_cert("svc.example.com", issuer_cn="Test Root CA",
                            issuer_key=root_key, days_after=400)
        self.observe_at([leaf, root], self.ip)
        # The root expires in 4 days but is the CA's problem, not an endpoint's.
        self.assertEqual(Alert.objects.count(), 0)

    def test_each_endpoint_gets_its_own_alert(self):
        der, _ = make_cert("*.example.com", days_after=3)
        second = self.make_ip("10.0.0.6")
        self.observe_at([der], self.ip)
        self.observe_at([der], second)
        self.assertEqual(Alert.objects.count(), 2)
        self.assertEqual(
            {a.target_ip_id for a in Alert.objects.all()}, {self.ip.id, second.id}
        )
        # ...over one certificate row: N endpoints, N alerts, 1 cert.
        self.assertEqual(Certificate.objects.count(), 1)

    def test_dedup_key_cannot_collide_with_a_check_alert(self):
        self.serve(3)
        key = Alert.objects.get().dedup_key
        self.assertTrue(key.startswith(DEDUP_PREFIX))
        self.assertLessEqual(len(key), 120)  # fits Alert.dedup_key

    def test_alerts_do_not_cross_tenants(self):
        theirs_ip = self.make_ip("10.0.0.5", tenant=self.other)
        self.serve(3)
        der, _ = make_cert("theirs.example.com", days_after=3)
        self.observe_at([der], theirs_ip, tenant=self.other)
        self.assertEqual(Alert.objects.filter(tenant=self.tenant).count(), 1)
        self.assertEqual(Alert.objects.filter(tenant=self.other).count(), 1)
        mine = Alert.objects.get(tenant=self.tenant)
        self.assertEqual(mine.target_ip_id, self.ip.id)


class ExpiryClassificationTests(TestCase):
    """The derived-at-read-time property X0 established, kept intact."""

    def test_state_is_derived_from_not_after_never_from_a_stored_flag(self):
        limits = {"warning_days": 30, "critical_days": 7, "stale_days": 7}
        now = timezone.now()

        class _Cert:
            def __init__(self, days):
                self.not_after = now + dt.timedelta(days=days)

        self.assertEqual(classify(_Cert(365), limits, now), OK)
        self.assertEqual(classify(_Cert(29), limits, now), EXPIRING_WARNING)
        self.assertEqual(classify(_Cert(6), limits, now), EXPIRING_CRITICAL)
        self.assertEqual(classify(_Cert(-1), limits, now), EXPIRED)
        self.assertEqual(classify(_Cert(0), limits, now), EXPIRED)

    def test_critical_above_warning_degrades_to_all_critical(self):
        row = MonitoringSettings(
            cert_expiry_warning_days=7, cert_expiry_critical_days=30
        )
        self.assertEqual(thresholds(row)["critical_days"], 7)


# ─── X1/X2 API ────────────────────────────────────────────────────────────


class CertificateBindingApiTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.other_org = Organization.objects.create(name="Globex", slug="globex")
        self.other = Tenant.objects.create(
            org=self.other_org, name="Globex", slug="globex"
        )

        def ip_for(tenant, address):
            prefix, _ = Prefix.objects.get_or_create(
                tenant=tenant, cidr="10.0.0.0/8",
                defaults={"status": status_for(tenant, "container")},
            )
            return IPAddress.objects.create(
                tenant=tenant, ip_address=address, prefix=prefix
            )

        der, _ = make_cert("mine.example.com", days_after=10)
        with allow_target(), fake_handshake([der]):
            observe_endpoint(
                self.tenant, "10.0.0.5", 443, target_ip=ip_for(self.tenant, "10.0.0.5")
            )
        other_der, _ = make_cert("theirs.example.com")
        with allow_target(), fake_handshake([other_der]):
            observe_endpoint(
                self.other, "10.0.0.5", 443, target_ip=ip_for(self.other, "10.0.0.5")
            )

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
        resp = self.client.get("/api/monitoring/certificate-bindings/")
        self.assertIn(resp.status_code, (401, 403))

    def test_list_is_scoped_to_the_active_tenant(self):
        rows = self._results(
            self.client.get("/api/monitoring/certificate-bindings/")
        )
        self.assertEqual([r["certificate_subject_cn"] for r in rows],
                         ["mine.example.com"])

    def test_cross_tenant_detail_is_not_readable(self):
        theirs = CertificateBinding.objects.get(tenant=self.other)
        resp = self.client.get(f"/api/monitoring/certificate-bindings/{theirs.id}/")
        self.assertEqual(resp.status_code, 404)

    def test_write_methods_are_refused(self):
        mine = CertificateBinding.objects.get(tenant=self.tenant)
        self.assertEqual(
            self.client.post("/api/monitoring/certificate-bindings/", {},
                             format="json").status_code, 405
        )
        self.assertEqual(
            self.client.delete(
                f"/api/monitoring/certificate-bindings/{mine.id}/"
            ).status_code, 405
        )

    def test_filter_by_certificate_answers_what_breaks(self):
        cert = Certificate.objects.get(tenant=self.tenant)
        rows = self._results(
            self.client.get(
                f"/api/monitoring/certificate-bindings/?certificate={cert.id}"
            )
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["endpoint"], "10.0.0.5:443")

    def test_stale_filter_separates_history_from_what_is_served_now(self):
        fresh = self._results(
            self.client.get("/api/monitoring/certificate-bindings/?stale=0")
        )
        self.assertEqual(len(fresh), 1)
        CertificateBinding.objects.filter(tenant=self.tenant).update(
            last_seen=timezone.now() - dt.timedelta(days=90)
        )
        self.assertEqual(
            len(self._results(
                self.client.get("/api/monitoring/certificate-bindings/?stale=0")
            )), 0,
        )
        self.assertEqual(
            len(self._results(
                self.client.get("/api/monitoring/certificate-bindings/?stale=1")
            )), 1,
        )

    def test_certificate_exposes_its_blast_radius(self):
        rows = self._results(self.client.get("/api/monitoring/certificates/"))
        self.assertEqual(rows[0]["binding_count"], 1)


class CheckResultSeamTests(_TenantBase):
    """The production path: a ``tls_cert`` CheckResult lands, and the inventory
    plus its alert follow — for both persistence seams (check-now and the
    scheduled worker), which share ``record_check_results``."""

    def test_a_check_result_produces_a_binding_and_an_alert(self):
        from .certificates import record_check_results
        from .models import CheckKind, CheckResult, CheckTemplate

        ip = self.make_ip()
        template = CheckTemplate.objects.create(
            tenant=self.tenant, name="tls", slug="tls", kind=CheckKind.TLS_CERT
        )
        der, _ = make_cert("svc.example.com", days_before=400, days_after=3)
        with allow_target(), fake_handshake([der]):
            observation = tls_cert.collect_chain("svc.example.com", 8443)

        result = CheckResult.objects.create(
            tenant=self.tenant, target_ip=ip, template=template,
            kind="tls_cert", status="degraded", detail=observation,
        )
        self.assertEqual(record_check_results([result]), 1)

        binding = CertificateBinding.objects.get()
        self.assertEqual(binding.target_ip_id, ip.id)
        self.assertEqual(binding.port, 8443)  # taken from the observation
        self.assertEqual(binding.server_name, "svc.example.com")
        alert = Alert.objects.get()
        self.assertEqual(alert.detail["cert_state"], EXPIRING_CRITICAL)
        self.assertEqual(alert.target_ip_id, ip.id)

    def test_the_binding_ip_comes_from_the_check_not_the_payload(self):
        """A detail blob must not be able to point a binding at another IP."""
        from .certificates import endpoint_from_result
        from .models import CheckResult

        ip = self.make_ip()
        elsewhere = self.make_ip("10.0.0.99")
        result = CheckResult(
            tenant=self.tenant, target_ip=ip, kind="tls_cert", status="up",
            detail={"host": elsewhere.ip_address, "port": 443,
                    "server_name": "spoof.example.com"},
        )
        endpoint = endpoint_from_result(result)
        self.assertEqual(endpoint.target_ip.id, ip.id)

    def test_a_non_certificate_result_is_ignored(self):
        from .certificates import record_check_results
        from .models import CheckResult

        result = CheckResult(
            tenant=self.tenant, target_ip=self.make_ip(), kind="icmp",
            status="up", detail={"rtt": 1.0},
        )
        self.assertEqual(record_check_results([result]), 0)
        self.assertEqual(Certificate.objects.count(), 0)


# ─── S0: authoring (upload) ─────────────────────────────────────────────────


def pem_of(der: bytes) -> str:
    """DER → public-certificate PEM, as an operator would paste it."""
    cert = x509.load_der_x509_certificate(der)
    return cert.public_bytes(serialization.Encoding.PEM).decode("ascii")


class UploadTests(_TenantBase):
    def test_upload_happy_path_parses_fields_and_stores_pem(self):
        der, _ = make_cert("edge.example.com", dns=("edge.example.com",))
        pem = pem_of(der)
        row, created = upload_certificate(self.tenant, pem, name="Edge")
        self.assertTrue(created)
        parsed = tls_cert.parse_certificate(der, 0)
        self.assertEqual(row.fingerprint_sha256, parsed["fingerprint_sha256"])
        self.assertEqual(row.subject_cn, "edge.example.com")
        self.assertEqual(row.san_dns, ["edge.example.com"])
        self.assertTrue(row.uploaded)
        self.assertFalse(row.observed)
        self.assertEqual(row.origin, "uploaded")
        self.assertEqual(row.name, "Edge")
        self.assertIn("BEGIN CERTIFICATE", row.pem)
        self.assertNotIn("PRIVATE KEY", row.pem)

    def test_upload_rejects_a_pem_carrying_a_private_key(self):
        der, _ = make_cert("edge.example.com")
        bundle = pem_of(der) + "\n" + PRIVATE_KEY_PEM
        with self.assertRaises(CertificateUploadError) as cm:
            upload_certificate(self.tenant, bundle)
        self.assertIn("private key", str(cm.exception).lower())
        self.assertEqual(Certificate.objects.count(), 0)

    def test_upload_rejects_unparseable_pem(self):
        with self.assertRaises(CertificateUploadError):
            upload_certificate(self.tenant, "-----BEGIN CERTIFICATE-----\nnope\n")
        self.assertEqual(Certificate.objects.count(), 0)

    def test_upload_of_an_already_observed_fingerprint_dedups_to_one_row(self):
        der, _ = make_cert("edge.example.com")
        self.observe([der])  # observed row first
        self.assertEqual(Certificate.objects.count(), 1)
        row, created = upload_certificate(self.tenant, pem_of(der))
        self.assertFalse(created)  # converged, not duplicated
        self.assertEqual(Certificate.objects.count(), 1)
        self.assertTrue(row.uploaded)
        self.assertTrue(row.observed)
        self.assertEqual(row.origin, "both")

    def test_observing_an_uploaded_cert_flips_observed_on(self):
        der, _ = make_cert("edge.example.com")
        row, _ = upload_certificate(self.tenant, pem_of(der))
        self.assertFalse(row.observed)
        self.observe([der])
        row.refresh_from_db()
        self.assertTrue(row.observed)
        self.assertTrue(row.uploaded)

    def test_a_bundle_uses_the_first_block_as_the_leaf(self):
        root, root_key = make_cert("Test Root CA")
        leaf, _ = make_cert("edge.example.com", issuer_cn="Test Root CA",
                            issuer_key=root_key)
        bundle = pem_of(leaf) + pem_of(root)
        row, _ = upload_certificate(self.tenant, bundle)
        self.assertEqual(row.subject_cn, "edge.example.com")
        self.assertEqual(Certificate.objects.count(), 1)


class UploadApiTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_upload_via_api_returns_the_created_certificate(self):
        der, _ = make_cert("api.example.com")
        resp = self.client.post(
            "/api/monitoring/certificates/",
            {"pem": pem_of(der), "name": "API cert"}, format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        self.assertEqual(body["subject_cn"], "api.example.com")
        self.assertEqual(body["origin"], "uploaded")
        self.assertTrue(body["uploaded"])
        self.assertEqual(body["name"], "API cert")
        self.assertIn("BEGIN CERTIFICATE", body["pem"])

    def test_upload_of_a_private_key_is_a_clean_400(self):
        der, _ = make_cert("api.example.com")
        resp = self.client.post(
            "/api/monitoring/certificates/",
            {"pem": pem_of(der) + "\n" + PRIVATE_KEY_PEM}, format="json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertNotIn("PRIVATE KEY", str(resp.json()).upper()
                         .replace("REMOVE THE PRIVATE KEY", ""))
        self.assertEqual(Certificate.objects.count(), 0)


# ─── S0: assignment ─────────────────────────────────────────────────────────


class AssignmentApiTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.other_org = Organization.objects.create(name="Globex", slug="globex")
        self.other = Tenant.objects.create(
            org=self.other_org, name="Globex", slug="globex"
        )
        der, _ = make_cert("edge.example.com")
        self.cert, _ = upload_certificate(self.tenant, pem_of(der))
        self.prefix, _ = Prefix.objects.get_or_create(
            tenant=self.tenant, cidr="10.0.0.0/8",
            defaults={"status": status_for(self.tenant, "container")},
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=self.prefix
        )
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_assign_a_cert_to_an_ip(self):
        resp = self.client.post(
            "/api/monitoring/certificate-assignments/",
            {"certificate": str(self.cert.id), "object_type": "api.ipaddress",
             "object_id": str(self.ip.id)}, format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.json()["object_type"], "api.ipaddress")
        self.assertEqual(CertificateAssignment.objects.count(), 1)

    def test_assignment_to_another_tenants_object_is_rejected(self):
        their_prefix = Prefix.objects.create(
            tenant=self.other, cidr="10.9.0.0/16",
            status=status_for(self.other, "container"),
        )
        their_ip = IPAddress.objects.create(
            tenant=self.other, ip_address="10.9.0.5", prefix=their_prefix
        )
        resp = self.client.post(
            "/api/monitoring/certificate-assignments/",
            {"certificate": str(self.cert.id), "object_type": "api.ipaddress",
             "object_id": str(their_ip.id)}, format="json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(CertificateAssignment.objects.count(), 0)

    def test_unknown_object_type_is_rejected(self):
        resp = self.client.post(
            "/api/monitoring/certificate-assignments/",
            {"certificate": str(self.cert.id), "object_type": "api.nope",
             "object_id": str(self.ip.id)}, format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_list_is_scoped_to_the_active_tenant(self):
        CertificateAssignment.objects.create(
            tenant=self.tenant, certificate=self.cert,
            object_type="api.ipaddress", object_id=str(self.ip.id),
        )
        their_der, _ = make_cert("theirs.example.com")
        their_cert, _ = upload_certificate(self.other, pem_of(their_der))
        CertificateAssignment.objects.create(
            tenant=self.other, certificate=their_cert,
            object_type="api.ipaddress", object_id="00000000-0000-0000-0000-000000000000",
        )
        resp = self.client.get("/api/monitoring/certificate-assignments/")
        rows = resp.json()["results"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["certificate"], str(self.cert.id))


# ─── S1: assignment drift (cert_mismatch) ───────────────────────────────────


class CertMismatchDriftTests(_TenantBase):
    def _upload(self, cn, tenant=None):
        der, _ = make_cert(cn)
        row, _ = upload_certificate(tenant or self.tenant, pem_of(der))
        return der, row

    def _assign(self, cert, object_type, object_id, tenant=None):
        return CertificateAssignment.objects.create(
            tenant=tenant or self.tenant, certificate=cert,
            object_type=object_type, object_id=str(object_id),
        )

    def _mismatch_alert(self, endpoint_key, tenant=None):
        return Alert.objects.filter(
            tenant=tenant or self.tenant, dedup_key=mismatch_key(endpoint_key),
            status=AlertStatus.FIRING,
        ).first()

    def test_serving_a_different_cert_than_assigned_fires_cert_mismatch(self):
        ip = self.make_ip()
        _, declared = self._upload("declared.example.com")
        self._assign(declared, "api.ipaddress", ip.id)
        served_der, _ = make_cert("served.example.com")
        # Observing (with the assignment already in place) runs the reactive pass.
        self.observe_at([served_der], ip)
        binding = CertificateBinding.objects.get(target_ip=ip, chain_depth=0)
        alert = self._mismatch_alert(binding.endpoint_key)
        self.assertIsNotNone(alert)
        self.assertEqual(alert.detail["drift"], "cert_mismatch")
        self.assertEqual(
            alert.detail["served_fingerprint_sha256"],
            binding.certificate.fingerprint_sha256,
        )
        self.assertEqual(alert.severity, AlertSeverity.WARNING)

    def test_serving_the_assigned_cert_is_silent(self):
        ip = self.make_ip()
        served_der, served = self._upload("match.example.com")
        self._assign(served, "api.ipaddress", ip.id)
        self.observe_at([served_der], ip)
        binding = CertificateBinding.objects.get(target_ip=ip, chain_depth=0)
        self.assertIsNone(self._mismatch_alert(binding.endpoint_key))

    def test_no_assignment_means_no_drift(self):
        ip = self.make_ip()
        served_der, _ = make_cert("undeclared.example.com")
        self.observe_at([served_der], ip)
        binding = CertificateBinding.objects.get(target_ip=ip, chain_depth=0)
        self.assertIsNone(self._mismatch_alert(binding.endpoint_key))

    def test_a_device_level_assignment_is_inherited_by_its_endpoints(self):
        from api.models import Device

        device = Device.objects.create(tenant=self.tenant, name="edge-sw")
        ip = self.make_ip()
        ip.assigned_device = device
        ip.save(update_fields=["assigned_device"])
        _, declared = self._upload("declared.example.com")
        self._assign(declared, "api.device", device.id)
        served_der, _ = make_cert("served.example.com")
        self.observe_at([served_der], ip)
        binding = CertificateBinding.objects.get(target_ip=ip, chain_depth=0)
        self.assertIsNotNone(self._mismatch_alert(binding.endpoint_key))

    def test_renewal_that_updates_the_assignment_resolves_the_mismatch(self):
        ip = self.make_ip()
        _, declared = self._upload("declared.example.com")
        self._assign(declared, "api.ipaddress", ip.id)
        served_der, _ = make_cert("served.example.com")
        self.observe_at([served_der], ip)
        binding = CertificateBinding.objects.get(target_ip=ip, chain_depth=0)
        self.assertIsNotNone(self._mismatch_alert(binding.endpoint_key))
        # Point the assignment at what's actually served → resolves.
        served_cert = binding.certificate
        CertificateAssignment.objects.filter(certificate=declared).delete()
        self._assign(served_cert, "api.ipaddress", ip.id)
        evaluate_mismatch(tenant_ids={self.tenant.id},
                          endpoint_keys={binding.endpoint_key})
        self.assertIsNone(self._mismatch_alert(binding.endpoint_key))

    def test_accepting_a_mismatch_creates_the_assignment_and_clears_it(self):
        ip = self.make_ip()
        _, declared = self._upload("declared.example.com")
        self._assign(declared, "api.ipaddress", ip.id)
        served_der, _ = make_cert("served.example.com")
        self.observe_at([served_der], ip)
        binding = CertificateBinding.objects.get(target_ip=ip, chain_depth=0)
        self.assertIsNotNone(self._mismatch_alert(binding.endpoint_key))
        assignment = accept_cert_mismatch(self.tenant, binding)
        self.assertEqual(assignment.certificate_id, binding.certificate_id)
        # The stale IP-level assignment was replaced, and the alert cleared.
        self.assertFalse(
            CertificateAssignment.objects.filter(certificate=declared).exists()
        )
        self.assertIsNone(self._mismatch_alert(binding.endpoint_key))

    def test_mismatch_is_tenant_isolated(self):
        ip = self.make_ip()
        _, declared = self._upload("declared.example.com")
        self._assign(declared, "api.ipaddress", ip.id)
        served_der, _ = make_cert("served.example.com")
        self.observe_at([served_der], ip)
        binding = CertificateBinding.objects.get(target_ip=ip, chain_depth=0)
        # The other tenant sees no alert for this endpoint key.
        self.assertIsNone(self._mismatch_alert(binding.endpoint_key, tenant=self.other))
        self.assertIsNotNone(self._mismatch_alert(binding.endpoint_key))
