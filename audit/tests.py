"""Change-log signal behaviour."""
from __future__ import annotations

from django.test import TestCase

from api.models import Prefix
from api.test_utils import status_for
from core.models import Organization, Tenant

from .models import ChangeLogEntry


class ChangeLogTests(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")

    def test_create_logged(self):
        p = Prefix.objects.create(
            tenant=self.tenant, cidr="10.1.0.0/24", status=status_for(self.tenant)
        )
        e = ChangeLogEntry.objects.get(object_id=str(p.id))
        self.assertEqual(e.action, "create")
        self.assertEqual(e.object_type, "api.prefix")
        self.assertEqual(e.tenant_id, self.tenant.id)

    def test_update_logs_field_diff(self):
        reserved = status_for(self.tenant, "reserved")
        active = status_for(self.tenant)
        p = Prefix.objects.create(
            tenant=self.tenant, cidr="10.2.0.0/24", status=reserved
        )
        p.status = active
        p.save()
        upd = ChangeLogEntry.objects.filter(object_id=str(p.id), action="update").get()
        # status is a FK now → the diff records the Status UUIDs (status_id).
        self.assertEqual(
            upd.changes["status"], {"old": str(reserved.id), "new": str(active.id)}
        )

    def test_noop_save_not_logged(self):
        p = Prefix.objects.create(
            tenant=self.tenant, cidr="10.3.0.0/24", status=status_for(self.tenant)
        )
        before = ChangeLogEntry.objects.filter(object_id=str(p.id)).count()
        p.save()  # nothing changed
        after = ChangeLogEntry.objects.filter(object_id=str(p.id)).count()
        self.assertEqual(before, after)

    def test_delete_logged(self):
        p = Prefix.objects.create(
            tenant=self.tenant, cidr="10.4.0.0/24", status=status_for(self.tenant)
        )
        pid = str(p.id)
        p.delete()
        self.assertTrue(
            ChangeLogEntry.objects.filter(object_id=pid, action="delete").exists()
        )


class ViaCaptureTests(TestCase):
    """The `via` column: how a change arrived (session UI, API token header,
    or a non-request write), plus the changelog `?via=` filter."""

    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")

    def test_non_request_write_is_system(self):
        p = Prefix.objects.create(
            tenant=self.tenant, cidr="10.9.0.0/24", status=status_for(self.tenant)
        )
        e = ChangeLogEntry.objects.get(object_id=str(p.id))
        self.assertEqual(e.via, "system")

    def test_middleware_marks_ui_and_api(self):
        from audit.context import current_via
        from audit.middleware import AuditContextMiddleware

        seen: list[str] = []
        mw = AuditContextMiddleware(lambda request: seen.append(current_via()))

        class Req:
            META: dict = {}
            user = None

        mw(Req())
        Req.META = {"HTTP_AUTHORIZATION": "Token abc"}
        mw(Req())
        self.assertEqual(seen, ["ui", "api"])

    def test_changelog_via_filter(self):
        from django.contrib.auth import get_user_model
        from rest_framework.test import APIClient

        Prefix.objects.create(
            tenant=self.tenant, cidr="10.8.0.0/24", status=status_for(self.tenant)
        )
        admin = get_user_model().objects.create_superuser("a", "a@x.com", "x")
        c = APIClient()
        c.force_login(admin)
        s = c.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        body = c.get("/api/changelog/?via=system").json()
        self.assertTrue(
            all(r["via"] == "system" for r in body["results"]) and body["count"] >= 1
        )
        self.assertEqual(c.get("/api/changelog/?via=api").json()["count"], 0)


class ObjectExistsTests(TestCase):
    """`object_exists` on the changelog API: links only to living objects."""

    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")

    def test_flag_tracks_target_liveness(self):
        from django.contrib.auth import get_user_model
        from rest_framework.test import APIClient

        admin = get_user_model().objects.create_superuser("root", "r@a.c", "pw")
        client = APIClient()
        client.force_login(admin)
        session = client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

        keep = Prefix.objects.create(
            tenant=self.tenant, cidr="10.5.0.0/24", status=status_for(self.tenant)
        )
        gone = Prefix.objects.create(
            tenant=self.tenant, cidr="10.6.0.0/24", status=status_for(self.tenant)
        )
        gone_id = str(gone.id)
        gone.delete()

        rows = client.get("/api/changelog/").json()["results"]
        by_obj = {}
        for r in rows:
            by_obj.setdefault(r["object_id"], r)
        self.assertTrue(by_obj[str(keep.id)]["object_exists"])
        # Both the create entry and the delete entry of the gone prefix agree.
        self.assertFalse(by_obj[gone_id]["object_exists"])
