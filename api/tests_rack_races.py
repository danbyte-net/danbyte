"""Rack placements and rack changes at the same moment (#375, #376): both
lock the rack row, so the second request reads what the first committed and
no device ends up over another or outside its rack.

The first request runs in a transaction held open in one thread while the
second is sent from another, as in tests_din_races."""
from __future__ import annotations

import threading

from django.contrib.auth import get_user_model
from django.db import connection, transaction
from rest_framework.test import APIClient, APITransactionTestCase

from core.models import Organization, Tenant

from .models import Device, DeviceType, Rack, Site
from .test_utils import status_for


class RackRaceTests(APITransactionTestCase):
    @classmethod
    def tearDownClass(cls):
        # The final flush wipes the migration-seeded RBAC groups from a
        # --keepdb database; put them back for the next run.
        super().tearDownClass()
        from auth_api.builtin_groups import ensure_builtin_groups

        ensure_builtin_groups()

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="dc1")
        status_for(self.tenant)
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.rack = Rack.objects.create(tenant=self.tenant, site=self.site, name="R1")
        self.type = DeviceType.objects.create(tenant=self.tenant, name="srv", u_height=1)
        self.sessions = []
        for _ in range(2):
            login = APIClient()
            login.force_login(self.user)
            session = login.session
            session["current_tenant_id"] = str(self.tenant.id)
            session.save()
            self.sessions.append({k: m.value for k, m in login.cookies.items()})
        self.side = threading.local()

    def _client(self):
        client = APIClient()
        client.cookies.load(self.sessions[getattr(self.side, "n", 0)])
        return client

    def place(self, name, position, face):
        return self._client().post("/api/devices/", {
            "name": name, "device_type_id": str(self.type.id),
            "site_id": str(self.site.id), "rack_id": str(self.rack.id),
            "position": position, "face": face,
        }, format="json")

    def shrink(self, u_height):
        return self._client().patch(f"/api/racks/{self.rack.id}/",
                                    {"u_height": u_height}, format="json")

    def race(self, first, second):
        held, release, out = threading.Event(), threading.Event(), {}

        def hold():
            self.side.n = 0
            try:
                with transaction.atomic():
                    out["first"] = first()
                    held.set()
                    release.wait(10)
            finally:
                held.set()
                connection.close()

        def run():
            self.side.n = 1
            try:
                out["second"] = second()
            finally:
                connection.close()

        a = threading.Thread(target=hold)
        a.start()
        held.wait(10)
        b = threading.Thread(target=run)
        b.start()
        b.join(1.0)
        out["waited"] = b.is_alive()
        release.set()
        a.join(10)
        b.join(10)
        return out

    def test_two_placements_on_opposite_faces_of_one_unit(self):
        out = self.race(lambda: self.place("a", 10, "front"),
                        lambda: self.place("b", 10, "rear"))
        self.assertEqual(out["first"].status_code, 201, out["first"].content)
        self.assertTrue(out["waited"])
        self.assertEqual(out["second"].status_code, 400, out["second"].content)
        self.assertEqual(Device.objects.filter(rack=self.rack, position=10).count(), 1)

    def test_a_placement_in_progress_blocks_the_shrink(self):
        out = self.race(lambda: self.place("hi", 40, "front"), lambda: self.shrink(10))
        self.assertEqual(out["first"].status_code, 201, out["first"].content)
        self.assertTrue(out["waited"])
        self.assertEqual(out["second"].status_code, 400, out["second"].content)
        self.rack.refresh_from_db()
        self.assertEqual(self.rack.u_height, 42)

    def test_a_shrink_in_progress_refuses_the_placement_above_it(self):
        out = self.race(lambda: self.shrink(10), lambda: self.place("hi", 40, "front"))
        self.assertEqual(out["first"].status_code, 200, out["first"].content)
        self.assertTrue(out["waited"])
        self.assertEqual(out["second"].status_code, 400, out["second"].content)
        self.assertIn("position", out["second"].json())
        self.assertFalse(Device.objects.filter(name="hi").exists())
