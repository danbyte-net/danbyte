"""Where a device's SNMP poll runs (#325).

Poll now, Refresh MACs and the Outpost's own work list resolve the device's
engine the same way checks do - device → location (and parents) → site →
tenant default - and an Outpost polls exactly the devices that resolve to it.
A driver engine (Zabbix) never polls SNMP; such a device, like an unbound one,
polls from the core. The scheduled ``poll_snmp`` command leaves an Outpost's
devices to it.
"""
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from api.models import Device, IPAddress, Location, Prefix, Site
from core.models import Organization, Tenant
from monitoring.engines import (
    devices_for_engine,
    engine_for_device,
    engines_for_devices,
    set_binding,
)
from monitoring.models import MonitoringEngine, MonitoringSettings, SnmpProfile

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(admin)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()
        self.site = Site.objects.create(tenant=self.tenant, name="branch")
        self.outpost = MonitoringEngine.objects.create(
            tenant=self.tenant, name="branch-op", slug="branch-op",
            kind="remote", transport="pull", token={"secret": "route-tok"},
        )
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.8.2.0/24")
        SnmpProfile.objects.create(
            tenant=self.tenant, name="v2", slug="v2", version="v2c", is_default=True,
        )

    def _device(self, name, **kw):
        self._n = getattr(self, "_n", 0) + 1
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address=f"10.8.2.{self._n}", prefix=self.prefix,
        )
        return Device.objects.create(tenant=self.tenant, name=name, primary_ip=ip, **kw)

    def _poll(self, device):
        return self.client.post(
            f"/api/monitoring/devices/{device.id}/snmp-poll/", {}, format="json"
        )

    def _work_ids(self):
        r = self.client.get(
            "/api/outpost/snmp-work/", HTTP_AUTHORIZATION="Bearer route-tok"
        )
        self.assertEqual(r.status_code, 200, r.content)
        return {d["device_id"] for d in r.json()["devices"]}

    def _assert_queued(self, device):
        r = self._poll(device)
        self.assertEqual(r.status_code, 202, r.content)
        self.assertTrue(r.json()["queued_on_outpost"])
        self.assertEqual(r.json()["engine"], "branch-op")
        self.assertIn(str(device.id), self._work_ids())


class PollNowRoutingTests(_Base):
    def test_a_site_binding_routes_poll_now_and_lists_the_device(self):
        set_binding(self.tenant, "site", self.site.id, self.outpost)
        self._assert_queued(self._device("sw-site", site=self.site))

    def test_a_location_binding_routes_poll_now(self):
        room = Location.objects.create(tenant=self.tenant, site=self.site, name="room", slug="room")
        set_binding(self.tenant, "location", room.id, self.outpost)
        self._assert_queued(self._device("sw-room", site=self.site, location=room))

    def test_a_parent_location_binding_is_inherited(self):
        floor = Location.objects.create(tenant=self.tenant, site=self.site, name="floor", slug="floor")
        room = Location.objects.create(
            tenant=self.tenant, site=self.site, name="room", slug="room", parent=floor
        )
        set_binding(self.tenant, "location", floor.id, self.outpost)
        self._assert_queued(self._device("sw-child", site=self.site, location=room))

    def test_a_device_binding_routes_and_the_work_list_carries_it(self):
        dev = self._device("sw-pinned", site=self.site)
        set_binding(self.tenant, "device", dev.id, self.outpost)
        self._assert_queued(dev)

    def test_the_tenant_default_outpost_polls_unbound_devices(self):
        s = MonitoringSettings.for_tenant(self.tenant)
        s.default_engine = self.outpost
        s.save()
        self._assert_queued(self._device("sw-default", site=self.site))

    def test_a_device_in_a_bound_sites_room_without_a_site_still_routes(self):
        room = Location.objects.create(tenant=self.tenant, site=self.site, name="room", slug="room")
        set_binding(self.tenant, "site", self.site.id, self.outpost)
        self._assert_queued(self._device("sw-nosite", location=room))

    def test_a_more_specific_binding_steals_a_device_from_the_sites_outpost(self):
        other = MonitoringEngine.objects.create(
            tenant=self.tenant, name="other-op", slug="other-op",
            kind="remote", transport="pull", token={"secret": "other-tok"},
        )
        set_binding(self.tenant, "site", self.site.id, self.outpost)
        dev = self._device("sw-stolen", site=self.site)
        set_binding(self.tenant, "device", dev.id, other)
        self.assertEqual(engine_for_device(dev).id, other.id)
        self.assertNotIn(str(dev.id), self._work_ids())
        self.assertEqual([d.id for d in devices_for_engine(other)], [dev.id])

    def test_an_unbound_device_polls_from_the_core(self):
        dev = self._device("sw-core", site=self.site)
        with patch("monitoring.views.poll_device") as poll:
            poll.return_value = (None, "no_target")
            r = self._poll(dev)
        self.assertEqual(r.status_code, 400, r.content)
        poll.assert_called_once()
        self.assertEqual(self._work_ids(), set())

    def test_a_zabbix_bound_device_polls_from_the_core(self):
        zbx = MonitoringEngine.objects.create(
            tenant=self.tenant, name="zbx", slug="zbx", kind="zabbix",
        )
        dev = self._device("sw-zbx", site=self.site)
        with patch("monitoring.engines.engine_for_device", return_value=zbx), \
                patch("monitoring.views.poll_device") as poll:
            poll.return_value = (None, "no_target")
            r = self._poll(dev)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertNotIn("queued_on_outpost", r.json())
        poll.assert_called_once()


class PollWhereTests(_Base):
    """The SNMP card says where Poll now runs before it is clicked."""

    def _where(self, device):
        r = self.client.get(f"/api/monitoring/devices/{device.id}/snmp/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["poll_outpost"]

    def test_an_outpost_device_names_its_outpost(self):
        set_binding(self.tenant, "site", self.site.id, self.outpost)
        self.assertEqual(self._where(self._device("sw-op", site=self.site)), "branch-op")

    def test_a_core_device_reads_null(self):
        self.assertIsNone(self._where(self._device("sw-core", site=self.site)))

    def test_a_disabled_outpost_falls_back_to_the_core(self):
        set_binding(self.tenant, "site", self.site.id, self.outpost)
        self.outpost.enabled = False
        self.outpost.save(update_fields=["enabled"])
        self.assertIsNone(self._where(self._device("sw-off", site=self.site)))


class BatchResolveTests(_Base):
    def test_matches_the_per_device_walk_in_fixed_queries(self):
        other = MonitoringEngine.objects.create(
            tenant=self.tenant, name="other-op", slug="other-op",
            kind="remote", transport="pull", token={"secret": "other-tok"},
        )
        hq = Site.objects.create(tenant=self.tenant, name="hq")
        floor = Location.objects.create(tenant=self.tenant, site=hq, name="floor", slug="floor")
        room = Location.objects.create(
            tenant=self.tenant, site=hq, name="room", slug="room", parent=floor
        )
        set_binding(self.tenant, "site", self.site.id, self.outpost)
        set_binding(self.tenant, "location", floor.id, other)
        devices = [
            self._device("a", site=self.site),
            self._device("b", site=hq),
            self._device("c", site=hq, location=room),
            self._device("d", site=self.site),
            self._device("e"),
        ]
        set_binding(self.tenant, "device", devices[3].id, other)
        devices = list(Device.objects.filter(tenant=self.tenant).select_related("tenant"))
        engines_for_devices(self.tenant, devices[:1])  # creates settings + local
        # A fixed few - bindings, locations, the default and local engines -
        # however many devices there are.
        with CaptureQueriesContext(connection) as ctx:
            batch = engines_for_devices(self.tenant, devices)
        self.assertLessEqual(len(ctx.captured_queries), 4)
        for d in devices:
            self.assertEqual(batch[d.id].id, engine_for_device(d).id, d.name)


class ScheduledPollTests(_Base):
    def test_poll_snmp_leaves_outpost_devices_to_their_outpost(self):
        set_binding(self.tenant, "site", self.site.id, self.outpost)
        remote = self._device("sw-remote", site=self.site)
        hq = Site.objects.create(tenant=self.tenant, name="hq")
        local = self._device("sw-local", site=hq)
        with patch("monitoring.management.commands.poll_snmp.poll_device") as poll:
            poll.return_value = (None, "no_target")
            call_command("poll_snmp")
        polled = {c.args[0].id for c in poll.call_args_list}
        self.assertEqual(polled, {local.id})
        self.assertNotIn(remote.id, polled)
