"""Source-of-truth certificate expiry alerting.

The endpoint sweep only sees certificates *observed* on the wire. A cert an
operator uploaded and assigned to a device/VM/IP is intent — it must warn on
expiry too, even if it was never scanned. These tests pin that behaviour and
the not-null ``Alert.target_ip`` resolution rule (assigned object → its IP).
"""
from __future__ import annotations

import datetime as dt
from unittest import mock

from django.test import TestCase
from django.utils import timezone

from api.models import (
    Device, DeviceRole, DeviceType, IPAddress, Manufacturer, Prefix, Site,
)
from api.test_utils import status_for
from core.models import Organization, Tenant

from .cert_expiry import SOT_DEDUP_PREFIX, evaluate_sot_expiry, sot_dedup_key
from .models import (
    Alert, AlertSeverity, AlertStatus, Certificate, CertificateAssignment,
)


def _fingerprint(seed: str) -> str:
    return (seed * 64)[:64].lower().replace(" ", "0")


class SotExpiryTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="S")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        self.dtype = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="X"
        )
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="R", slug="r")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant)
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=self.prefix
        )
        self.device = Device.objects.create(
            tenant=self.tenant, name="dev1", device_type=self.dtype, site=self.site,
            role=self.role, primary_ip=self.ip, status=status_for(self.tenant),
        )
        self.notify = mock.patch("monitoring.notify.notify_alert").start()
        self.addCleanup(mock.patch.stopall)

    def _cert(self, days_after, *, seed="a", observed=False, uploaded=True):
        now = timezone.now()
        return Certificate.objects.create(
            tenant=self.tenant,
            fingerprint_sha256=_fingerprint(seed),
            subject_cn="svc.declared",
            not_before=now - dt.timedelta(days=1),
            not_after=now + dt.timedelta(days=days_after),
            uploaded=uploaded,
            observed=observed,
            pem="-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----\n",
        )

    def _assign(self, cert, *, object_type="device", object_id=None):
        return CertificateAssignment.objects.create(
            tenant=self.tenant, certificate=cert,
            object_type=object_type, object_id=str(object_id or self.device.id),
        )

    def alerts(self, status=AlertStatus.FIRING):
        return list(
            Alert.objects.filter(
                tenant=self.tenant, status=status,
                dedup_key__startswith=SOT_DEDUP_PREFIX,
            )
        )

    # ─── The core gap: a declared, expiring cert alerts ──────────────────

    def test_assigned_expiring_cert_opens_an_alert_on_the_objects_ip(self):
        cert = self._cert(3)  # inside critical
        a = self._assign(cert)
        counts = evaluate_sot_expiry()
        self.assertEqual(counts["opened"], 1)
        alert = Alert.objects.get(dedup_key=sot_dedup_key(a.id))
        self.assertEqual(alert.status, AlertStatus.FIRING)
        self.assertEqual(alert.severity, AlertSeverity.CRITICAL)
        self.assertEqual(alert.kind, "tls_cert")
        self.assertEqual(alert.target_ip_id, self.ip.id)
        self.assertEqual(alert.detail["drift"], "cert_expiry_sot")
        self.assertEqual(alert.detail["certificate_id"], str(cert.id))

    def test_warning_window_is_a_warning(self):
        a = self._assign(self._cert(20))  # inside 30, outside 7
        evaluate_sot_expiry()
        alert = Alert.objects.get(dedup_key=sot_dedup_key(a.id))
        self.assertEqual(alert.severity, AlertSeverity.WARNING)

    def test_expired_declared_cert_alerts(self):
        a = self._assign(self._cert(-5))
        evaluate_sot_expiry()
        alert = Alert.objects.get(dedup_key=sot_dedup_key(a.id))
        self.assertEqual(alert.severity, AlertSeverity.CRITICAL)
        self.assertEqual(alert.check_status, "down")

    def test_healthy_declared_cert_raises_nothing(self):
        self._assign(self._cert(200))
        self.assertEqual(evaluate_sot_expiry()["opened"], 0)
        self.assertEqual(self.alerts(), [])

    # ─── target_ip resolution rules (Alert.target_ip is not-null) ────────

    def test_ip_assignment_hangs_the_alert_on_itself(self):
        cert = self._cert(3, seed="b")
        a = self._assign(cert, object_type="ipaddress", object_id=self.ip.id)
        evaluate_sot_expiry()
        alert = Alert.objects.get(dedup_key=sot_dedup_key(a.id))
        self.assertEqual(alert.target_ip_id, self.ip.id)

    def test_object_without_an_ip_raises_nothing_rather_than_crashing(self):
        noip = Device.objects.create(
            tenant=self.tenant, name="noip", device_type=self.dtype,
            site=self.site, role=self.role, status=status_for(self.tenant),
        )
        self._assign(self._cert(3, seed="c"), object_id=noip.id)
        # No IP to attach to → skipped, never a not-null violation.
        self.assertEqual(evaluate_sot_expiry()["opened"], 0)
        self.assertEqual(self.alerts(), [])

    # ─── The observed path owns observed certs; no double-alert ──────────

    def test_observed_cert_is_left_to_the_endpoint_sweep(self):
        # uploaded AND observed → the binding sweep covers it; SoT skips it.
        self._assign(self._cert(3, seed="d", observed=True))
        self.assertEqual(evaluate_sot_expiry()["checked"], 0)
        self.assertEqual(self.alerts(), [])

    # ─── Resolution: renewal / unassign clears the alert ─────────────────

    def test_renewal_out_of_the_window_resolves_the_alert(self):
        cert = self._cert(3)
        a = self._assign(cert)
        evaluate_sot_expiry()
        self.assertEqual(len(self.alerts()), 1)
        # Renew: the assignment now points at a healthy cert.
        healthy = self._cert(300, seed="e")
        a.certificate = healthy
        a.save(update_fields=["certificate"])
        evaluate_sot_expiry()
        self.assertEqual(self.alerts(), [])
        resolved = Alert.objects.get(dedup_key=sot_dedup_key(a.id))
        self.assertEqual(resolved.status, AlertStatus.RESOLVED)

    def test_unassigning_resolves_the_alert(self):
        cert = self._cert(3)
        a = self._assign(cert)
        evaluate_sot_expiry()
        aid = a.id
        a.delete()
        evaluate_sot_expiry()
        resolved = Alert.objects.get(dedup_key=sot_dedup_key(aid))
        self.assertEqual(resolved.status, AlertStatus.RESOLVED)

    # ─── B1: notifications render cert specifics, not "tls_cert is down" ──

    def test_notification_summary_names_the_cert_and_its_expiry(self):
        from .notify import _alert_payload, _alert_summary

        a = self._assign(self._cert(3))
        evaluate_sot_expiry()
        alert = Alert.objects.get(dedup_key=sot_dedup_key(a.id))
        summary = _alert_summary(alert, "firing", "10.0.0.5")
        self.assertIn("svc.declared", summary)
        self.assertIn("expires in", summary)
        self.assertNotIn("tls_cert is", summary)  # not the generic line
        payload = _alert_payload(alert, "firing", "10.0.0.5")
        self.assertEqual(payload["subject_cn"], "svc.declared")
        self.assertEqual(payload["cert_state"], "expiring_critical")
        self.assertIn("fingerprint_sha256", payload)
        self.assertIn("not_after", payload)

    def test_expired_cert_summary_says_expired(self):
        from .notify import _alert_summary

        a = self._assign(self._cert(-5))
        evaluate_sot_expiry()
        alert = Alert.objects.get(dedup_key=sot_dedup_key(a.id))
        self.assertIn("expired", _alert_summary(alert, "firing", "10.0.0.5"))

    def test_warning_to_critical_escalates_one_alert_and_re_notifies(self):
        cert = self._cert(20)
        a = self._assign(cert)
        evaluate_sot_expiry()
        alert = Alert.objects.get(dedup_key=sot_dedup_key(a.id))
        self.assertEqual(alert.severity, AlertSeverity.WARNING)
        # The same assignment now carries a cert deep in the critical window.
        cert.not_after = timezone.now() + dt.timedelta(days=2)
        cert.save(update_fields=["not_after"])
        evaluate_sot_expiry()
        self.assertEqual(Alert.objects.filter(dedup_key=sot_dedup_key(a.id)).count(), 1)
        alert.refresh_from_db()
        self.assertEqual(alert.severity, AlertSeverity.CRITICAL)
        self.assertEqual(alert.notify_count, 2)
