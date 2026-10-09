"""Rails, devices and types changed at the same moment (#310): a cabinet save,
a cabinet sync and a device type change each lock what a device placement
locks, so one of the two is refused and no device ends up past its rail's end
or over another device.

Each test holds the first request's transaction open in one thread, sends the
second from another, and lets the first commit only once the second has
finished or been waiting for a second. Without the locks the second request
does not wait and passes its check against what it could see."""
from __future__ import annotations

import threading

from django.contrib.auth import get_user_model
from django.db import connection, transaction
from rest_framework.test import APIClient, APITransactionTestCase

from core.models import Organization, Tenant

from .models import Cabinet, CabinetType, Device, DeviceType, DinRail, DinRailTemplate, Site
from .test_utils import status_for


class DinRaceTests(APITransactionTestCase):
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
        self.site = Site.objects.create(tenant=self.tenant, name="plant-1")
        status_for(self.tenant)
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.cab = Cabinet.objects.create(
            tenant=self.tenant, site=self.site, name="K1",
            inner_width_mm=500, inner_height_mm=600,
        )
        self.rail = DinRail.objects.create(
            cabinet=self.cab, label="R1", profile="ts35", x_mm=0, y_mm=100, length_mm=400,
        )
        self.relay = DeviceType.objects.create(
            tenant=self.tenant, name="Relay", width_mm=18, height_mm=80, din_profiles=["ts35"],
        )

        # A session per side of a race, made up front: a request writes its
        # session and a login writes the user row, and either would make the
        # other side queue on that instead of on what is under test.
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

    def mount(self, name, offset):
        return self._client().post("/api/devices/", {
            "name": name, "device_type_id": str(self.relay.id),
            "din_rail_id": str(self.rail.id), "din_offset_mm": offset,
        }, format="json")

    def shorten(self, length):
        rails = self._client().get(f"/api/cabinets/{self.cab.id}/").json()["rails"]
        return self._client().patch(f"/api/cabinets/{self.cab.id}/", {
            "rails": [{**rails[0], "length_mm": length}],
        }, format="json")

    def race(self, first, second):
        """``first()`` in a transaction held open while ``second()`` runs.
        Returns both responses and whether ``second`` was still waiting when
        ``first`` was let go."""
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

    def assert_on_rail(self):
        """Every device on the rail fits on it and none overlap."""
        self.rail.refresh_from_db()
        spans = sorted(
            (d.din_offset_mm, d.din_offset_mm + d.device_type.width_mm, d.name)
            for d in Device.objects.filter(din_rail=self.rail).select_related("device_type")
        )
        for _start, end, name in spans:
            self.assertLessEqual(end, self.rail.length_mm, f"{name} runs past the rail's end")
        for (_, end, a), (start, _, b) in zip(spans, spans[1:], strict=False):
            self.assertLessEqual(end, start, f"{a} overlaps {b}")

    def test_a_mount_in_progress_blocks_shortening_the_rail(self):
        out = self.race(lambda: self.mount("plc", 300), lambda: self.shorten(200))
        self.assertEqual(out["first"].status_code, 201, out["first"].content)
        self.assertTrue(out["waited"])
        self.assertEqual(out["second"].status_code, 400, out["second"].content)
        self.assertEqual(out["second"].json(), {"rails": [
            {"length_mm": ["Too short for its devices (needs 318 mm)."]},
        ]})
        self.assert_on_rail()

    def test_a_shortened_rail_in_progress_refuses_the_mount_past_its_end(self):
        out = self.race(lambda: self.shorten(200), lambda: self.mount("plc", 300))
        self.assertEqual(out["first"].status_code, 200, out["first"].content)
        self.assertTrue(out["waited"])
        self.assertEqual(out["second"].status_code, 400, out["second"].content)
        self.assertIn("din_offset_mm", out["second"].json())
        self.assertFalse(Device.objects.filter(name="plc").exists())
        self.assert_on_rail()

    def test_a_mount_in_progress_blocks_a_sync_that_shortens_the_rail(self):
        ct = CabinetType.objects.create(
            tenant=self.tenant, name="T", inner_width_mm=500, inner_height_mm=600,
        )
        DinRailTemplate.objects.create(
            cabinet_type=ct, label="R1", profile="ts35", x_mm=0, y_mm=100, length_mm=200,
        )
        Cabinet.objects.filter(pk=self.cab.pk).update(cabinet_type=ct)

        def sync():
            return self._client().post(f"/api/cabinets/{self.cab.id}/sync-from-type/",
                                       {"apply": True, "sizes": False}, format="json")

        out = self.race(lambda: self.mount("plc", 300), sync)
        self.assertEqual(out["first"].status_code, 201, out["first"].content)
        self.assertTrue(out["waited"])
        # The sync skips the blocked rail rather than shortening it.
        self.assertEqual(out["second"].status_code, 200, out["second"].content)
        self.assertEqual(out["second"].json()["diff"]["rails"]["blocked"][0]["label"], "R1")
        self.assert_on_rail()

    def test_a_mount_in_progress_blocks_widening_its_type(self):
        self.assertEqual(self.mount("a", 0).status_code, 201)

        def widen():
            return self._client().patch(f"/api/device-types/{self.relay.id}/",
                                        {"width_mm": 20}, format="json")

        out = self.race(lambda: self.mount("b", 18), widen)
        self.assertEqual(out["first"].status_code, 201, out["first"].content)
        self.assertTrue(out["waited"])
        self.assertEqual(out["second"].json(), {"width_mm": ["a would overlap b on K1 R1."]})
        self.assert_on_rail()

    def test_a_widened_type_in_progress_refuses_the_mount_it_overlaps(self):
        self.assertEqual(self.mount("a", 0).status_code, 201)

        def widen():
            return self._client().patch(f"/api/device-types/{self.relay.id}/",
                                        {"width_mm": 20}, format="json")

        out = self.race(widen, lambda: self.mount("b", 18))
        self.assertEqual(out["first"].status_code, 200, out["first"].content)
        self.assertTrue(out["waited"])
        self.assertEqual(out["second"].status_code, 400, out["second"].content)
        self.assertIn("din_offset_mm", out["second"].json())
        self.assert_on_rail()

    def test_placements_of_one_type_on_two_rails_do_not_wait(self):
        # The type's lock is shared between placements; only the rail queues.
        other = DinRail.objects.create(
            cabinet=self.cab, label="R2", profile="ts35", x_mm=0, y_mm=300, length_mm=400,
        )

        # Devices already in the cabinet, moved onto the rails: creating one
        # queues on its per-tenant number, which is not under test here.
        a, b = (
            Device.objects.create(tenant=self.tenant, site=self.site, name=n,
                                  device_type=self.relay, cabinet=self.cab)
            for n in ("a", "b")
        )

        def move(device, rail):
            return lambda: self._client().patch(f"/api/devices/{device.id}/", {
                "din_rail_id": str(rail.id), "din_offset_mm": 0,
            }, format="json")

        out = self.race(move(a, self.rail), move(b, other))
        self.assertEqual(out["first"].status_code, 200, out["first"].content)
        self.assertFalse(out["waited"])
        self.assertEqual(out["second"].status_code, 200, out["second"].content)

    def test_two_mounts_on_one_rail_queue_for_the_same_gap(self):
        out = self.race(lambda: self.mount("a", 0), lambda: self.mount("b", 10))
        self.assertEqual(out["first"].status_code, 201, out["first"].content)
        self.assertTrue(out["waited"])
        self.assertEqual(out["second"].status_code, 400, out["second"].content)
        self.assert_on_rail()
