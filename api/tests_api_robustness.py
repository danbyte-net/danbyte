"""API robustness regressions.

Two reported bugs, both reproducible against a real install:

1. The DRF ``IntegrityError`` safety net called *every* database constraint a
   "duplicate" - so a not-null violation (e.g. an IP create that reached the DB
   with a null tenant) was reported as a 409 duplicate, actively misleading
   debugging. The handler now keys on the Postgres SQLSTATE and words each
   class honestly (unique → 409 "duplicate"; not-null / FK / check → 400).

2. ``POST /api/devices/`` (and IP / Interface) returned 201 for a payload that
   sent the nested *label* keys (``device_type``, ``role``, ``site``,
   ``status``) instead of the write keys (``device_type_id`` …): DRF silently
   dropped the unknown input and created a structurally-empty object. The
   serializers now raise a 400 naming the right key.

Plus: a create with no active tenant must fail closed (4xx) *before* the
insert, never as a DB IntegrityError.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from django.db import IntegrityError
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from api.exception_handler import exception_handler
from api.models import Device, DeviceType, IPAddress, Manufacturer
from core.models import Organization, Tenant


class _FakeDiag:
    def __init__(self, column_name=None):
        self.column_name = column_name


class _FakePgError(Exception):
    """Stands in for a psycopg driver error: carries ``pgcode`` + ``diag``."""

    def __init__(self, pgcode, column_name=None):
        super().__init__("db error")
        self.pgcode = pgcode
        self.diag = _FakeDiag(column_name)


def _integrity_error(pgcode, column_name=None):
    """An IntegrityError chained to a driver error with the given SQLSTATE,
    the way Django/psycopg surface it (``exc.__cause__``)."""
    try:
        raise _FakePgError(pgcode, column_name)
    except _FakePgError as cause:
        exc = IntegrityError("integrity error")
        exc.__cause__ = cause
        return exc


class ExceptionHandlerTests(TestCase):
    """Unit tests for the SQLSTATE-aware IntegrityError mapping."""

    def _handle(self, exc):
        return exception_handler(exc, {"view": None})

    def test_not_null_violation_is_400_and_not_a_duplicate(self):
        resp = self._handle(_integrity_error("23502", column_name="tenant_id"))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        detail = resp.data["detail"].lower()
        self.assertNotIn("duplicate", detail)
        self.assertIn("required field", detail)
        self.assertIn("tenant_id", resp.data["detail"])

    def test_not_null_violation_without_column_still_400(self):
        resp = self._handle(_integrity_error("23502"))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertNotIn("duplicate", resp.data["detail"].lower())

    def test_unique_violation_stays_409_duplicate(self):
        resp = self._handle(_integrity_error("23505"))
        self.assertEqual(resp.status_code, status.HTTP_409_CONFLICT)
        self.assertIn("duplicate", resp.data["detail"].lower())

    def test_foreign_key_violation_is_400(self):
        resp = self._handle(_integrity_error("23503", column_name="prefix_id"))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertNotIn("duplicate", resp.data["detail"].lower())

    def test_check_violation_is_400(self):
        resp = self._handle(_integrity_error("23514"))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertNotIn("duplicate", resp.data["detail"].lower())

    def test_unknown_sqlstate_falls_back_to_409_without_duplicate(self):
        # A Django-level ProtectedError (delete of an in-use row) has no DB
        # cause, so no SQLSTATE - must stay 409 but never say "duplicate".
        resp = self._handle(IntegrityError("no cause"))
        self.assertEqual(resp.status_code, status.HTTP_409_CONFLICT)
        self.assertNotIn("duplicate", resp.data["detail"].lower())

    def test_non_integrity_error_falls_through(self):
        self.assertIsNone(self._handle(ValueError("nope")))


class _TenantCase(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="T", slug="t")
        self.admin = User.objects.create_superuser("robust-admin", password="x")
        self.client_api = APIClient()
        self.client_api.force_authenticate(self.admin)


class DeviceNestedKeyTests(_TenantCase):
    """Sending nested/label keys instead of ``*_id`` must 400, not 201."""

    def _mk_refs(self):
        mfr = Manufacturer.objects.create(
            tenant=self.tenant, name="Acme", slug="acme"
        )
        dt = DeviceType.objects.create(
            tenant=self.tenant, name="Model-X", manufacturer=mfr
        )
        return dt

    def test_nested_names_rejected_with_actionable_400(self):
        dt = self._mk_refs()
        resp = self.client_api.post(
            "/api/devices/",
            {
                "name": "broken-dev",
                "device_type": str(dt.id),  # should be device_type_id
                "role": "some-role",
                "site": "some-site",
                "status": "some-status",
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 400, resp.content)
        body = resp.json()
        for label, write_key in [
            ("device_type", "device_type_id"),
            ("role", "role_id"),
            ("site", "site_id"),
            ("status", "status_id"),
        ]:
            self.assertIn(label, body, body)
            self.assertIn(write_key, body[label][0])
        # Nothing was created.
        self.assertFalse(Device.objects.filter(name="broken-dev").exists())

    def test_correct_id_keys_still_create(self):
        dt = self._mk_refs()
        resp = self.client_api.post(
            "/api/devices/",
            {"name": "good-dev", "device_type_id": str(dt.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        dev = Device.objects.get(name="good-dev")
        self.assertEqual(dev.device_type_id, dt.id)


class NoActiveTenantCreateTests(TestCase):
    """A superuser with no active tenant must not reach the DB with a null
    tenant - the create fails closed with a clean 4xx, not a 500/409."""

    def setUp(self):
        # Deliberately create NO Tenant, so _get_active_tenant() returns None.
        self.admin = User.objects.create_superuser("no-tenant", password="x")
        self.client_api = APIClient()
        self.client_api.force_authenticate(self.admin)

    def test_ip_create_without_tenant_is_clean_4xx(self):
        self.assertEqual(Tenant.objects.count(), 0)
        resp = self.client_api.post(
            "/api/ips/", {"ip_address": "10.20.30.40"}, format="json"
        )
        # 403 (no active tenant) - the point is it's a clean client error,
        # never a 500 or a misleading 409 "duplicate".
        self.assertIn(resp.status_code, (400, 403), resp.content)
        self.assertNotEqual(resp.status_code, 409)
        self.assertNotEqual(resp.status_code, 500)
        self.assertEqual(IPAddress.objects.count(), 0)
