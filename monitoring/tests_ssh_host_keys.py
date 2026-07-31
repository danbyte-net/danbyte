"""SSH host-key inventory + drift (K0)."""
from __future__ import annotations

import asyncssh
from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device, DeviceRole, IPAddress, Prefix, Site
from api.test_utils import status_for
from auth_api.models import UserProfile
from core.models import Organization, Tenant
from danbyte_checks.ssh_hostkey import (
    SSHKeyParseError,
    fingerprint_from_blob,
    parse_public_key_line,
)
from monitoring.models import Alert, AlertStatus, SSHHostKey
from monitoring.ssh_host_keys import (
    accept_observed,
    evaluate_mismatch,
    record_host_key,
)


def _key_line(kind="ssh-ed25519", comment="admin@host"):
    """A fresh OpenSSH public-key line + its asyncssh fingerprint."""
    k = asyncssh.generate_private_key(kind)
    line = k.export_public_key("openssh").decode().strip()
    if comment:
        line = f"{line.split()[0]} {line.split()[1]} {comment}"
    return line, k.get_fingerprint()


class ParserTests(APITestCase):
    def test_fingerprint_matches_asyncssh(self):
        line, fp = _key_line()
        parsed = parse_public_key_line(line)
        self.assertEqual(parsed["fingerprint"], fp)
        self.assertEqual(parsed["key_type"], "ssh-ed25519")
        self.assertEqual(parsed["comment"], "admin@host")
        self.assertEqual(parsed["bits"], 256)
        # blob → fingerprint helper agrees too
        self.assertEqual(fingerprint_from_blob(parsed["public_key"]), fp)

    def test_private_key_rejected(self):
        k = asyncssh.generate_private_key("ssh-ed25519")
        with self.assertRaises(SSHKeyParseError) as e:
            parse_public_key_line(k.export_private_key().decode())
        self.assertIn("private key", str(e.exception).lower())

    def test_pem_cert_rejected(self):
        with self.assertRaises(SSHKeyParseError) as e:
            parse_public_key_line("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----")
        self.assertIn("certificate", str(e.exception).lower())

    def test_garbage_rejected(self):
        with self.assertRaises(SSHKeyParseError):
            parse_public_key_line("not a key at all")


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.su = User.objects.create_user("su", password="x", is_superuser=True)
        prof = UserProfile.objects.create(user=self.su)
        prof.tenants.add(self.tenant)
        prof.current_tenant = self.tenant
        prof.save()
        site = Site.objects.create(tenant=self.tenant, name="AMS")
        role = DeviceRole.objects.create(tenant=self.tenant, name="Server", slug="server")
        self.device = Device.objects.create(
            tenant=self.tenant, name="sw1", site=site, role=role,
            status=status_for(self.tenant),
        )
        pfx = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant)
        )
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.9", prefix=pfx,
            assigned_device=self.device,
        )
        self.device.primary_ip = ip
        self.device.save(update_fields=["primary_ip"])
        self.client.force_login(self.su)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")


class UploadApiTests(_Base):
    def test_upload_creates_then_dedupes(self):
        line, fp = _key_line()
        r = self.client.post(
            "/api/monitoring/ssh-host-keys/",
            {"device": str(self.device.id), "public_key_line": line},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["fingerprint_sha256"], fp)
        self.assertTrue(r.json()["uploaded"])
        self.assertEqual(r.json()["origin"], "uploaded")
        # same key again → 200, one row
        r2 = self.client.post(
            "/api/monitoring/ssh-host-keys/",
            {"device": str(self.device.id), "public_key_line": line},
            format="json",
        )
        self.assertEqual(r2.status_code, 200, r2.content)
        self.assertEqual(SSHHostKey.objects.filter(tenant=self.tenant).count(), 1)

    def test_private_key_upload_is_400(self):
        k = asyncssh.generate_private_key("ssh-ed25519")
        r = self.client.post(
            "/api/monitoring/ssh-host-keys/",
            {"device": str(self.device.id),
             "public_key_line": k.export_private_key().decode()},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("private key", str(r.json()).lower())

    def test_upload_converges_with_observed(self):
        # observe first, then upload the same key → one row, both flags
        line, fp = _key_line()
        blob = line.split()[1]
        record_host_key(self.tenant, self.device,
                        {"key_type": "ssh-ed25519", "public_key": blob, "fingerprint": fp})
        self.assertEqual(SSHHostKey.objects.get(fingerprint_sha256=fp).origin, "observed")
        self.client.post(
            "/api/monitoring/ssh-host-keys/",
            {"device": str(self.device.id), "public_key_line": line},
            format="json",
        )
        row = SSHHostKey.objects.get(fingerprint_sha256=fp)
        self.assertTrue(row.observed and row.uploaded)
        self.assertEqual(row.origin, "both")


class DriftTests(_Base):
    def _observe(self, fp, blob="AAAA"):
        return record_host_key(
            self.tenant, self.device,
            {"key_type": "ssh-ed25519", "public_key": blob, "fingerprint": fp},
        )

    def test_no_expected_no_drift(self):
        self._observe("SHA256:observed")
        evaluate_mismatch(tenant_id=self.tenant.id, device_id=self.device.id,
                          key_type="ssh-ed25519")
        self.assertFalse(Alert.objects.filter(status=AlertStatus.FIRING).exists())

    def test_mismatch_fires_and_accept_clears(self):
        line, fp = _key_line()
        # declare the expected key
        self.client.post(
            "/api/monitoring/ssh-host-keys/",
            {"device": str(self.device.id), "public_key_line": line},
            format="json",
        )
        # device presents a DIFFERENT key
        other_fp = "SHA256:" + "z" * 43
        self._observe(other_fp, blob="BBBB")
        evaluate_mismatch(tenant_id=self.tenant.id, device_id=self.device.id,
                          key_type="ssh-ed25519")
        firing = Alert.objects.filter(status=AlertStatus.FIRING)
        self.assertEqual(firing.count(), 1)
        self.assertEqual(firing.first().detail["drift"], "ssh_host_key_mismatch")
        # accept the served key → clears
        served = SSHHostKey.objects.get(fingerprint_sha256=other_fp)
        accept_observed(served)
        self.assertFalse(
            Alert.objects.filter(status=AlertStatus.FIRING).exists()
        )

    def test_matching_key_no_drift(self):
        line, fp = _key_line()
        blob = line.split()[1]
        self.client.post(
            "/api/monitoring/ssh-host-keys/",
            {"device": str(self.device.id), "public_key_line": line},
            format="json",
        )
        self._observe(fp, blob=blob)  # observes the SAME key
        evaluate_mismatch(tenant_id=self.tenant.id, device_id=self.device.id,
                          key_type="ssh-ed25519")
        self.assertFalse(Alert.objects.filter(status=AlertStatus.FIRING).exists())


class IsolationTests(_Base):
    def test_upload_rejects_foreign_device(self):
        other_org = Organization.objects.create(name="O2", slug="o2")
        other = Tenant.objects.create(org=other_org, name="T2", slug="t2")
        foreign = Device.objects.create(
            tenant=other, name="x",
            site=Site.objects.create(tenant=other, name="S2"),
            role=DeviceRole.objects.create(tenant=other, name="R2", slug="r2"),
            status=status_for(other),
        )
        line, _ = _key_line()
        r = self.client.post(
            "/api/monitoring/ssh-host-keys/",
            {"device": str(foreign.id), "public_key_line": line},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("device", r.json())

    def test_list_is_tenant_scoped(self):
        line, fp = _key_line()
        self.client.post(
            "/api/monitoring/ssh-host-keys/",
            {"device": str(self.device.id), "public_key_line": line},
            format="json",
        )
        # a second tenant sees none
        other_org = Organization.objects.create(name="O3", slug="o3")
        other = Tenant.objects.create(org=other_org, name="T3", slug="t3")
        u2 = User.objects.create_user("u2", password="x", is_superuser=True)
        p2 = UserProfile.objects.create(user=u2)
        p2.tenants.add(other)
        p2.current_tenant = other
        p2.save()
        self.client.force_login(u2)
        self.client.post(f"/api/tenants/{other.id}/switch/")
        r = self.client.get("/api/monitoring/ssh-host-keys/")
        self.assertEqual(r.json()["count"], 0)


def _now():
    return timezone.now()
