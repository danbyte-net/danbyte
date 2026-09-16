"""A second opinion in the drift inbox.

The SNMP poller is not the only thing that can observe a device. A registered
source gets its differences into the same inbox, ranked below the direct poll -
and, crucially, still gets them there for a device the poller has never
reached, which is the whole reason the seam exists.
"""
from __future__ import annotations

from types import SimpleNamespace

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device
from core.models import Organization, Tenant

from .models import DeviceSnmp
from .observations import (
    _SOURCES,
    observation_sources,
    observations_for,
    register_observation_source,
)
from .snmp_drift import apply_drift_action, compute_device_drift


def _state(**over):
    row = {
        "data": {}, "interfaces": [], "polled_at": timezone.now(), "reachable": True,
    }
    row.update(over)
    return SimpleNamespace(**row)


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.device = Device.objects.create(tenant=self.tenant, name="sw1")
        # The registry is process-wide and the real apps register into it at
        # startup. Isolate it here so these tests see only what they register,
        # and put it back afterwards - clearing without restoring would quietly
        # unregister Zabbix for every test module that runs after this one.
        before = dict(_SOURCES)

        def restore():
            _SOURCES.clear()
            _SOURCES.update(before)

        self.addCleanup(restore)
        _SOURCES.clear()

    def source(self, state, name="other"):
        register_observation_source(name, name.title(), lambda d, t: state)

    def poll(self, **over):
        row = {
            "tenant": self.tenant, "device": self.device, "reachable": True,
            "polled_at": timezone.now(), "data": {"sys_name": "sw1"}, "interfaces": [],
        }
        row.update(over)
        return DeviceSnmp.objects.create(**row)

    def items(self, kind="device_field"):
        return [
            i for i in compute_device_drift(self.device, self.tenant)
            if i["kind"] == kind
        ]


class RegistryTests(_Base):
    def test_a_source_is_listed_once_registered(self):
        self.source(_state())
        self.assertEqual(observation_sources(), [("other", "Other")])

    def test_the_direct_poll_is_not_a_registered_source(self):
        with self.assertRaises(ValueError):
            register_observation_source("snmp", "SNMP", lambda d, t: None)

    def test_a_source_that_has_never_looked_is_not_an_observation(self):
        """Absent is not the same as empty: a source with no poll behind it
        must not make every field read as drift."""
        self.source(_state(polled_at=None, data={"sys_name": "other"}))
        self.assertEqual(observations_for(self.device, self.tenant), [])
        self.assertEqual(self.items(), [])

    def test_a_source_that_could_not_see_the_device_says_nothing(self):
        """Last week's reading is not an observation of now - the same rule the
        direct poll gets, so no source has to remember it."""
        self.source(_state(reachable=False, data={"sys_name": "other"}))
        self.assertEqual(observations_for(self.device, self.tenant), [])
        self.assertEqual(self.items(), [])

    def test_a_source_that_raises_is_skipped_not_fatal(self):
        def boom(device, tenant):
            raise RuntimeError("integration is mid-migration")

        register_observation_source("broken", "Broken", boom)
        self.poll()
        with self.assertLogs("monitoring.observations", level="ERROR"):
            self.assertEqual(observations_for(self.device, self.tenant), [])
        self.assertEqual(self.items(), [])


class IndirectDriftTests(_Base):
    def test_a_source_raises_its_difference_stamped_with_its_name(self):
        self.poll()
        self.source(_state(data={"sys_name": "sw1", "serial": "FOC123"}))
        [item] = self.items()
        self.assertEqual(item["field"], "serial_number")
        self.assertEqual(item["observed"], "FOC123")
        self.assertEqual(item["intended"], "")
        self.assertEqual(item["source"], "other")

    def test_the_direct_poll_wins_where_both_speak(self):
        self.poll(data={"sys_name": "polled-name"})
        self.source(_state(data={"sys_name": "zabbix-name"}))
        items = self.items()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["observed"], "polled-name")
        self.assertNotIn("source", items[0])

    def test_a_device_the_poller_never_reached_still_gets_the_second_opinion(self):
        """The case the seam exists for - no route, no credentials, no poll."""
        self.assertIsNone(
            DeviceSnmp.objects.filter(device=self.device).first()
        )
        self.source(_state(data={"sys_name": "sw1", "serial": "FOC9"}))
        [item] = self.items()
        self.assertEqual(item["observed"], "FOC9")
        self.assertEqual(item["source"], "other")

    def test_a_failed_poll_does_not_hide_the_second_opinion(self):
        self.poll(reachable=False, data={})
        self.source(_state(data={"sys_name": "sw1", "serial": "FOC9"}))
        self.assertEqual([i["source"] for i in self.items()], ["other"])

    def test_agreement_is_not_drift(self):
        self.poll()
        self.device.serial_number = "FOC123"
        self.device.save(update_fields=["serial_number"])
        self.source(_state(data={"sys_name": "sw1", "serial": "FOC123"}))
        self.assertEqual(self.items(), [])

    def test_a_field_the_source_is_silent_about_is_not_drift(self):
        """Saying nothing is not saying blank - a source with no serial must
        never propose emptying one Danbyte has."""
        self.device.serial_number = "FOC123"
        self.device.save(update_fields=["serial_number"])
        self.poll()
        self.source(_state(data={"sys_name": "sw1"}))
        self.assertEqual(self.items(), [])

    def test_two_sources_do_not_both_raise_the_same_field(self):
        self.poll()
        self.source(_state(data={"serial": "A"}), name="alpha")
        self.source(_state(data={"serial": "B"}), name="beta")
        self.assertEqual([i["observed"] for i in self.items()], ["A"])


class AcceptTests(_Base):
    def test_accepting_a_serial_writes_it(self):
        self.source(_state(data={"serial": "FOC123"}))
        [item] = self.items()
        self.assertTrue(apply_drift_action(self.device, self.tenant, item))
        self.device.refresh_from_db()
        self.assertEqual(self.device.serial_number, "FOC123")
        self.assertEqual(self.items(), [])

    def test_accepting_a_name_still_works(self):
        self.poll(data={"sys_name": "renamed"})
        [item] = self.items()
        self.assertTrue(apply_drift_action(self.device, self.tenant, item))
        self.device.refresh_from_db()
        self.assertEqual(self.device.name, "renamed")

    def test_a_field_danbyte_does_not_offer_is_refused(self):
        """The body names the field, so the allow-list is what stops an
        accepted item writing something nobody offered."""
        action = {"kind": "device_field", "field": "description", "observed": "x"}
        self.assertFalse(apply_drift_action(self.device, self.tenant, action))
        self.device.refresh_from_db()
        self.assertEqual(self.device.description, "")

    def test_an_over_long_value_is_truncated_not_refused(self):
        self.source(_state(data={"serial": "S" * 400}))
        [item] = self.items()
        self.assertTrue(apply_drift_action(self.device, self.tenant, item))
        self.device.refresh_from_db()
        self.assertEqual(len(self.device.serial_number), 255)


class ApiTests(_Base):
    def setUp(self):
        super().setUp()
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_the_inbox_serves_the_second_opinion(self):
        self.source(_state(data={"serial": "FOC123"}))
        r = self.client.get(f"/api/monitoring/devices/{self.device.id}/snmp/drift/")
        self.assertEqual(r.status_code, 200, r.content)
        [item] = r.json()["drift"]
        self.assertEqual(item["source"], "other")
        self.assertEqual(item["observed"], "FOC123")
