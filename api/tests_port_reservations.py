from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    Cable,
    CableTermination,
    ConsolePort,
    Device,
    Interface,
    PortReservation,
    Status,
)

User = get_user_model()


class PortReservationTests(APITestCase):
    """/api/port-reservations/ - a hold on one uncabled port, complementing
    planned cables. Released automatically when a cable lands."""

    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(self.admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

        self.dev = Device.objects.create(tenant=self.tenant, name="sw-01")
        self.iface = Interface.objects.create(device=self.dev, name="Gi1")

    def _reserve(self, **kw):
        body = {"kind": "interface", "port_id": str(self.iface.id), **kw}
        return self.client.post("/api/port-reservations/", body, format="json")

    # ── model constraints ────────────────────────────────────────────────
    def test_exactly_one_point_enforced(self):
        cp = ConsolePort.objects.create(device=self.dev, name="con0")
        with transaction.atomic():
            with self.assertRaises(IntegrityError):
                PortReservation.objects.create(
                    tenant=self.tenant, interface=self.iface, console_port=cp
                )
        with transaction.atomic():
            with self.assertRaises(IntegrityError):
                PortReservation.objects.create(tenant=self.tenant)

    def test_one_reservation_per_port(self):
        PortReservation.objects.create(tenant=self.tenant, interface=self.iface)
        with transaction.atomic():
            with self.assertRaises(IntegrityError):
                PortReservation.objects.create(
                    tenant=self.tenant, interface=self.iface
                )

    # ── API ──────────────────────────────────────────────────────────────
    def test_create_list_update_delete(self):
        r = self._reserve(note="uplink for user B")
        self.assertEqual(r.status_code, 201, r.content)
        rid = r.json()["id"]
        self.assertEqual(r.json()["claimed_by"], "admin")
        self.assertEqual(r.json()["port"]["kind"], "interface")
        self.assertEqual(r.json()["port"]["name"], "Gi1")
        self.assertEqual(r.json()["port"]["device"]["name"], "sw-01")

        r = self.client.get("/api/port-reservations/")
        self.assertEqual(r.json()["count"], 1)

        r = self.client.patch(
            f"/api/port-reservations/{rid}/", {"note": "moved"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["note"], "moved")

        r = self.client.delete(f"/api/port-reservations/{rid}/")
        self.assertEqual(r.status_code, 204)
        self.assertEqual(PortReservation.objects.count(), 0)

    def test_cannot_reserve_cabled_or_reserved_port(self):
        c = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=c, end="A", interface=self.iface)
        self.assertEqual(self._reserve().status_code, 400)

        free = Interface.objects.create(device=self.dev, name="Gi2")
        PortReservation.objects.create(tenant=self.tenant, interface=free)
        r = self.client.post(
            "/api/port-reservations/",
            {"kind": "interface", "port_id": str(free.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("already reserved", str(r.content))

    def test_cross_tenant_port_rejected_and_hidden(self):
        other_t = Tenant.objects.create(org=self.org, name="B", slug="b")
        other_dev = Device.objects.create(tenant=other_t, name="sw-b")
        other_if = Interface.objects.create(device=other_dev, name="Gi1")
        r = self.client.post(
            "/api/port-reservations/",
            {"kind": "interface", "port_id": str(other_if.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 400)

        PortReservation.objects.create(tenant=other_t, interface=other_if)
        r = self.client.get("/api/port-reservations/")
        self.assertEqual(r.json()["count"], 0)

    def test_device_and_kind_filters(self):
        self._reserve()
        cp = ConsolePort.objects.create(device=self.dev, name="con0")
        self.client.post(
            "/api/port-reservations/",
            {"kind": "console_port", "port_id": str(cp.id)},
            format="json",
        )
        r = self.client.get(f"/api/port-reservations/?device={self.dev.id}")
        self.assertEqual(r.json()["count"], 2)
        r = self.client.get("/api/port-reservations/?kind=console_port")
        self.assertEqual(r.json()["count"], 1)

    # ── semantics ────────────────────────────────────────────────────────
    def test_cable_termination_releases_reservation(self):
        self._reserve()
        cp = ConsolePort.objects.create(device=self.dev, name="con0")
        PortReservation.objects.create(tenant=self.tenant, console_port=cp)
        self.assertEqual(PortReservation.objects.count(), 2)

        c = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=c, end="A", interface=self.iface)
        self.assertEqual(PortReservation.objects.count(), 1)

        c2 = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=c2, end="A", console_port=cp)
        self.assertEqual(PortReservation.objects.count(), 0)

    def test_cable_created_through_the_api_releases_the_hold(self):
        """The regression behind "the reservation comes back": the API
        writes terminations with bulk_create, which skips save(), so the
        hold survived behind the cable and reappeared when it was deleted.
        Mark_connected was left set the same way."""
        self._reserve(note="hold")
        other = Interface.objects.create(
            device=self.dev, name="Gi9", mark_connected=True
        )
        r = self.client.post(
            "/api/cables/",
            {
                "a": [{"kind": "interface", "id": str(self.iface.id)}],
                "b": [{"kind": "interface", "id": str(other.id)}],
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(PortReservation.objects.count(), 0)
        other.refresh_from_db()
        self.assertFalse(other.mark_connected)

        # Deleting the cable must not resurrect anything.
        self.client.delete(f"/api/cables/{r.json()['id']}/")
        self.assertEqual(PortReservation.objects.count(), 0)
        row = next(
            x
            for x in self.client.get(
                f"/api/interfaces/?device={self.dev.id}"
            ).json()["results"]
            if x["name"] == "Gi1"
        )
        self.assertIsNone(row["reservation"])
        self.assertIsNone(row["cable"])

    def test_planned_cable_keeps_mark_connected(self):
        """A planned cable is not patched: it fulfils the hold, but must not
        erase a fact the operator typed (mark_connected has no undo, and the
        flag is never restored when the planned cable is deleted)."""
        planned = Status.objects.create(
            tenant=self.tenant, name="Planned", slug="planned",
            available_to=["cable"],
        )
        self.iface.mark_connected = True
        self.iface.save(update_fields=["mark_connected"])
        PortReservation.objects.create(tenant=self.tenant, interface=self.iface)
        other = Interface.objects.create(device=self.dev, name="Gi8")

        r = self.client.post(
            "/api/cables/",
            {
                "status_id": str(planned.id),
                "a": [{"kind": "interface", "id": str(self.iface.id)}],
                "b": [{"kind": "interface", "id": str(other.id)}],
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.iface.refresh_from_db()
        self.assertTrue(self.iface.mark_connected)  # kept
        self.assertEqual(PortReservation.objects.count(), 0)  # hold fulfilled

    def test_reservation_records_the_ports_site(self):
        """Site-scoped grants filter on this column - a hold with no site
        would sit outside every site scope."""
        from api.models import Site

        site = Site.objects.create(tenant=self.tenant, name="S1")
        self.dev.site = site
        self.dev.save(update_fields=["site"])
        r = self._reserve()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(
            PortReservation.objects.get().site_id, site.id
        )

    def test_interface_serializer_exposes_reservation(self):
        self._reserve(note="hold")
        r = self.client.get(f"/api/interfaces/?device={self.dev.id}")
        row = r.json()["results"][0]
        self.assertEqual(row["reservation"]["claimed_by"], "admin")
        self.assertEqual(row["reservation"]["note"], "hold")

    def test_utilization_counts_reservation_as_reserved(self):
        planned = Status.objects.create(
            tenant=self.tenant, name="Planned", slug="planned",
            available_to=["cable"],
        )
        # Gi1 reserved directly; Gi2 planned cable; Gi3 marked (wins over a
        # stray reservation); Gi4 free.
        self._reserve()
        i2 = Interface.objects.create(device=self.dev, name="Gi2")
        c = Cable.objects.create(tenant=self.tenant, status=planned)
        CableTermination.objects.create(cable=c, end="A", interface=i2)
        i3 = Interface.objects.create(
            device=self.dev, name="Gi3", mark_connected=True
        )
        PortReservation.objects.create(tenant=self.tenant, interface=i3)
        Interface.objects.create(device=self.dev, name="Gi4")

        r = self.client.get(f"/api/devices/{self.dev.id}/port-utilization/")
        self.assertEqual(
            r.json()["interfaces"],
            {"total": 4, "connected": 1, "reserved": 2, "free": 1, "marked": 1},
        )

        r = self.client.get("/api/devices/port-utilization/")
        row = next(
            x for x in r.json()["results"] if x["id"] == str(self.dev.id)
        )
        self.assertEqual(row["reserved"], 2)
