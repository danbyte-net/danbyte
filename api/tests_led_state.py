"""Status LEDs (api.led_state): bindings and their validation, what each
source shows, the reader's scope (neutral, never a leak), the locate beacon
and the ``/api/device-leds/`` payload's query count."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from django.core.exceptions import ValidationError
from django.db import connection
from django.test import SimpleTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from monitoring.models import CheckState, CheckTemplate, DeviceSnmp

from .led_state import (
    binding_for,
    color_led,
    device_status_led,
    monitoring_verdict,
    port_led,
    validate_bindings,
    validate_model_leds,
    worst,
)
from .models import (
    Device,
    DeviceType,
    Interface,
    IPAddress,
    Manufacturer,
    Module,
    ModuleBay,
    Prefix,
    ModuleType,
    Rack,
    Site,
    Status,
)

CHASSIS_LEDS = {
    "SYS": {"source": "device.status"},
    "BEACON": {"source": "device.locate"},
    "PSU": {"source": "modules.status", "bays": ["PS-*"]},
    "FAN": {"source": "modules.status", "bays": ["FAN *"]},
    "MGMT_ACT": {"source": "none"},
    "port:*": {"source": "interface.oper_status"},
}
PSU_LEDS = {
    "PS_OK": {"source": "module.status"},
    "FAIL": {"source": "module.status", "only": ["red"]},
}


def _anchors(*names):
    return {"v": 1, "box": [[0, 0, 0], [1, 1, 1]], "bays": {}, "empties": {},
            "ports": {}, "leds": {n: {"node": i, "led_material": True}
                                  for i, n in enumerate(names)}}


class BindingTests(SimpleTestCase):
    def test_clean_bindings_pass(self):
        clean, notes = validate_bindings({
            "SYS": {"source": "device.status"},
            "led:BEACON": {"source": "device.locate"},
            "PSU": {"source": "modules.status: PS-*"},
            "FAN": {"source": "modules.status", "bays": "FAN *"},
            "FAIL": {"source": "module.status", "only": "red"},
        })
        self.assertEqual(notes, [])
        self.assertEqual(clean["BEACON"], {"source": "device.locate"})
        self.assertEqual(clean["PSU"], {"source": "modules.status", "bays": ["PS-*"]})
        self.assertEqual(clean["FAN"], {"source": "modules.status", "bays": ["FAN *"]})
        self.assertEqual(clean["FAIL"], {"source": "module.status", "only": ["red"]})
        validate_model_leds(clean)

    def test_bad_entries_are_dropped_with_a_note(self):
        clean, notes = validate_bindings({
            "SYS": {"source": "device.health"},
            "PSU": {"source": "modules.status"},
            "X": {"source": "device.status", "only": ["purple"]},
            "Y": {"source": "device.status", "bays": "PS-*"},
            "Z": "device.status",
            "OK": {"source": "none"},
        })
        self.assertEqual(clean, {"OK": {"source": "none"}})
        self.assertEqual(len(notes), 5)
        self.assertIn("leds.SYS: unknown source 'device.health' - dropped.", notes)

    def test_the_field_validator_refuses_bad_bindings(self):
        with self.assertRaises(ValidationError):
            validate_model_leds({"SYS": {"source": "nope"}})
        with self.assertRaises(ValidationError):
            validate_model_leds({"led:SYS": {"source": "device.status"}})
        validate_model_leds(None)

    def test_exact_key_beats_a_glob(self):
        b = {"port:*": {"source": "interface.oper_status"},
             "port:Gi0/0": {"source": "none"}}
        self.assertEqual(binding_for(b, "port:Gi0/0"), {"source": "none"})
        self.assertEqual(binding_for(b, "port:Te1/0/1")["source"], "interface.oper_status")
        self.assertIsNone(binding_for(b, "SYS"))


class SourceTests(SimpleTestCase):
    def test_swatches_read_as_lights(self):
        self.assertEqual(color_led("#10b981"), "green")    # active
        self.assertEqual(color_led("#f59e0b"), "amber")    # planned / staged
        self.assertEqual(color_led("#ef4444"), "red")      # offline / failed
        self.assertEqual(color_led("#a1a1aa"), "off")      # inventory
        self.assertEqual(color_led("#3b82f6"), "off")      # blue: not a status light
        self.assertEqual(color_led(""), "off")

    def test_worst_of(self):
        self.assertEqual(worst(["green", "red", "amber"]), "red")
        self.assertEqual(worst(["green", "off"]), "green")
        self.assertEqual(worst([]), "off")

    def test_monitoring_verdicts(self):
        self.assertEqual(monitoring_verdict([]), "unmonitored")
        self.assertEqual(monitoring_verdict([("unknown", 0)]), "unmonitored")
        self.assertEqual(monitoring_verdict([("stale", 3)]), "stale")
        self.assertEqual(monitoring_verdict([("up", 0)]), "up")
        self.assertEqual(monitoring_verdict([("down", 3)]), "down")
        self.assertEqual(monitoring_verdict([("up", 1)]), "warn")
        self.assertEqual(monitoring_verdict([("degraded", 0)]), "warn")
        self.assertEqual(monitoring_verdict([("down", 3), ("up", 0)]), "warn")

    def test_device_status(self):
        self.assertEqual(device_status_led("green", "up"), "green")
        self.assertEqual(device_status_led("green", "down"), "red")
        self.assertEqual(device_status_led("green", "warn"), "amber_blink")
        self.assertEqual(device_status_led("green", "stale"), "off")
        # Green needs monitoring to have seen it up.
        self.assertEqual(device_status_led("green", "unmonitored"), "off")
        self.assertEqual(device_status_led("red", "unmonitored"), "red")
        self.assertEqual(device_status_led(None, "up"), "green")
        # Not in service: off whatever the checks say.
        self.assertEqual(device_status_led("off", "down"), "off")
        self.assertEqual(device_status_led("green", "hidden"), "neutral")

    def test_ports(self):
        self.assertEqual(port_led({"oper_status": "up", "admin_status": "up"}), "green")
        self.assertEqual(port_led({"oper_status": "down", "admin_status": "up"}), "off")
        self.assertEqual(port_led({"oper_status": "up", "admin_status": "down"}), "off")
        self.assertEqual(port_led({"oper_status": "testing"}), "amber")
        self.assertEqual(port_led({"oper_status": "up"}, enabled=False), "off")
        # A device SNMP doesn't poll: what Danbyte records decides.
        self.assertEqual(port_led(None, True, documented=True), "green")
        self.assertEqual(port_led(None, True, documented=False), "off")
        self.assertEqual(port_led(None, False, documented=True), "off")
        # A polled device (documented None) with no row stays off.
        self.assertEqual(port_led(None, True, documented=None), "off")
        self.assertEqual(port_led(None), "off")


class _Base(APITestCase):
    def setUp(self):
        self.now = timezone.now()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site = Site.objects.create(tenant=self.tenant, name="A")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.9.0.0/16")
        self.active = self._status("active", "#10b981")
        self.failed = self._status("failed", "#ef4444")
        self.planned = self._status("planned", "#f59e0b", is_planned=True)
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="Cisco", slug="cisco")
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, name="C9500", u_height=1, manufacturer=mfr,
            model_anchors=_anchors("SYS", "BEACON", "PSU", "FAN", "MGMT_ACT",
                                   "port:Te1/0/1", "port:Te1/0/2"),
            model_leds=CHASSIS_LEDS)
        self.dt.model_3d.name = "device-models/c9500.glb"
        self.dt.save()
        self.psu = ModuleType.objects.create(
            tenant=self.tenant, name="PWR", manufacturer=mfr,
            model_anchors=_anchors("PS_OK", "FAIL"), model_leds=PSU_LEDS)
        self.psu.model_3d.name = "device-models/pwr.glb"
        self.psu.save()
        self.fan = ModuleType.objects.create(
            tenant=self.tenant, name="FAN", manufacturer=mfr,
            model_anchors=_anchors("STATUS"), model_leds={"STATUS": {"source": "module.status"}})
        self.fan.model_3d.name = "device-models/fan.glb"
        self.fan.save()
        self.tpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="ping", slug="ping", kind="icmp")
        self.admin = User.objects.create_superuser("root", "r@x", "x")
        UserProfile.objects.create(user=self.admin, role="admin").tenants.add(self.tenant)
        self._login(self.admin)
        self.n = 0
        self.dev = self._device("sw1")

    def _status(self, slug, color, **kw):
        return Status.objects.create(tenant=self.tenant, name=slug.title(), slug=slug,
                                     color=color, available_to=["device", "module"], **kw)

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _device(self, name, *, modules=True):
        self.n += 1
        dev = Device.objects.create(tenant=self.tenant, name=name, device_type=self.dt,
                                    site=self.site, status=self.active)
        ip = IPAddress.objects.create(tenant=self.tenant, ip_address=f"10.9.0.{self.n}",
                                      prefix=self.prefix, assigned_device=dev)
        dev.primary_ip = ip
        dev.save(update_fields=["primary_ip"])
        for iname in ("Te1/0/1", "Te1/0/2"):
            Interface.objects.get_or_create(device=dev, name=iname)
        bays = {}
        for b, pos in (("PS-0", "0"), ("PS-1", "1"), ("FAN 0", "0")):
            bays[b] = ModuleBay.objects.get_or_create(device=dev, name=b,
                                                      defaults={"position": pos})[0]
        self.dt.model_anchors["bays"] = {b: {"node": 99, "m": []} for b in bays}
        DeviceType.objects.filter(pk=self.dt.pk).update(model_anchors=self.dt.model_anchors)
        if modules:
            Module.objects.create(device=dev, module_bay=bays["PS-0"], module_type=self.psu,
                                  status=self.active)
            Module.objects.create(device=dev, module_bay=bays["PS-1"], module_type=self.psu,
                                  status=self.failed)
            # No status of its own: reads as its device's.
            Module.objects.create(device=dev, module_bay=bays["FAN 0"], module_type=self.fan)
        return dev

    def _check(self, dev, status, fails=0):
        CheckState.objects.update_or_create(
            target_ip=dev.primary_ip, template=self.tpl,
            defaults=dict(tenant=self.tenant, kind="icmp", status=status,
                          consecutive_fail=fails, last_checked=self.now,
                          next_run=self.now + timedelta(minutes=5)))

    def _snmp(self, dev, rows, at=None):
        DeviceSnmp.objects.update_or_create(
            device=dev, defaults=dict(tenant=self.tenant, interfaces=rows,
                                      polled_at=at or self.now))

    def _leds(self, *devs, **params):
        q = {"devices": ",".join(str(d.id) for d in devs)} if devs else {}
        res = self.client.get("/api/device-leds/", {**q, **params})
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()["devices"]


class PayloadTests(_Base):
    def test_every_source(self):
        self._check(self.dev, "up")
        self._snmp(self.dev, [
            {"name": "Te1/0/1", "oper_status": "up", "admin_status": "up"},
            {"name": "Te1/0/2", "oper_status": "down", "admin_status": "up"},
        ])
        d = self._leds(self.dev)[str(self.dev.id)]
        self.assertEqual(d["leds"], {
            "SYS": "green",
            # Worst of PS-0 (active) and PS-1 (failed).
            "PSU": "red",
            # FAN 0's module has no status: its device's active.
            "FAN": "green",
            "port:Te1/0/1": "green",
        })
        self.assertEqual(d["bays"], {
            "PS-0": {"PS_OK": "green"},
            "PS-1": {"PS_OK": "red", "FAIL": "red"},
            "FAN 0": {"STATUS": "green"},
        })
        self.assertIsNone(d["locate"])

    def test_monitoring_states(self):
        self._check(self.dev, "down", 3)
        self.assertEqual(self._leds(self.dev)[str(self.dev.id)]["leds"]["SYS"], "red")
        self._check(self.dev, "up", 1)
        self.assertEqual(self._leds(self.dev)[str(self.dev.id)]["leds"]["SYS"], "amber_blink")
        self._check(self.dev, "stale", 3)
        self.assertNotIn("SYS", self._leds(self.dev)[str(self.dev.id)]["leds"])

    def test_planned_device_is_dark(self):
        self._check(self.dev, "up")
        Device.objects.filter(pk=self.dev.pk).update(status=self.planned)
        self.assertNotIn("SYS", self._leds(self.dev)[str(self.dev.id)]["leds"])

    def test_a_stale_poll_turns_ports_off(self):
        self._snmp(self.dev, [{"name": "Te1/0/1", "oper_status": "up"}],
                   at=self.now - timedelta(hours=3))
        self.assertNotIn("port:Te1/0/1", self._leds(self.dev)[str(self.dev.id)]["leds"])

    def test_module_ports_take_the_bay_position(self):
        self.psu.model_anchors = _anchors("port:Te1/{module}/9")
        self.psu.model_leds = {"port:*": {"source": "interface.oper_status"}}
        self.psu.save()
        Interface.objects.create(device=self.dev, name="Te1/1/9")
        self._snmp(self.dev, [{"name": "Te1/1/9", "oper_status": "up"}])
        bays = self._leds(self.dev)[str(self.dev.id)]["bays"]
        self.assertEqual(bays["PS-1"], {"port:Te1/1/9": "green"})
        self.assertNotIn("PS-0", bays)

    def test_rack_and_tenant_scope(self):
        rack = Rack.objects.create(tenant=self.tenant, site=self.site, name="R1")
        Device.objects.filter(pk=self.dev.pk).update(rack=rack, position=1, face="front")
        out = self._leds(rack=str(rack.id))
        self.assertEqual(list(out), [str(self.dev.id)])
        stranger = Device.objects.create(tenant=self.other, name="x", device_type=self.dt)
        self.assertEqual(self._leds(stranger), {})

    def test_unknown_parameters_are_refused(self):
        res = self.client.get("/api/device-leds/", {"device_id": str(self.dev.id)})
        self.assertEqual(res.status_code, 400)
        self.assertIn("device_id", res.json()["detail"])

    def test_post_takes_a_long_list(self):
        res = self.client.post("/api/device-leds/", {"devices": [str(self.dev.id)]},
                               format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertIn(str(self.dev.id), res.json()["devices"])

    def test_query_count_does_not_grow_with_devices(self):
        self._check(self.dev, "up")
        self._snmp(self.dev, [{"name": "Te1/0/1", "oper_status": "up"}])
        with CaptureQueriesContext(connection) as one:
            self._leds(self.dev)
        more = [self._device(f"sw{i}") for i in range(2, 7)]
        for d in more:
            self._check(d, "up")
            self._snmp(d, [{"name": "Te1/0/1", "oper_status": "up"}])
        with CaptureQueriesContext(connection) as six:
            out = self._leds(self.dev, *more)
        self.assertEqual(len(out), 6)
        self.assertEqual(len(six), len(one))
        self.assertLessEqual(len(six), 20)


class ScopeTests(_Base):
    def _reader(self, types):
        user = User.objects.create_user("u", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(name="r", object_types=types,
                                                actions=["view"])
        grant.users.add(user)
        grant.tenants.add(self.tenant)
        self._login(user)
        return user

    def test_reader_without_monitoring_or_interface_view_sees_neutral(self):
        self._check(self.dev, "down", 3)
        self._snmp(self.dev, [{"name": "Te1/0/1", "oper_status": "up"}])
        self._reader(["device", "devicetype", "module", "modulebay", "moduletype"])
        leds = self._leds(self.dev)[str(self.dev.id)]["leds"]
        self.assertEqual(leds["SYS"], "neutral")
        self.assertEqual(leds["port:Te1/0/1"], "neutral")
        self.assertEqual(leds["port:Te1/0/2"], "neutral")
        # Module statuses are theirs to see.
        self.assertEqual(leds["PSU"], "red")

    def test_reader_with_monitoring_view_sees_it(self):
        self._check(self.dev, "down", 3)
        self._reader(["device", "devicetype", "ipaddress", "interface"])
        leds = self._leds(self.dev)[str(self.dev.id)]["leds"]
        self.assertEqual(leds["SYS"], "red")
        # No module view: the front module LEDs say nothing.
        self.assertEqual(leds["PSU"], "neutral")
        self.assertEqual(self._leds(self.dev)[str(self.dev.id)]["bays"], {})

    def test_device_out_of_view_is_left_out(self):
        self._reader(["devicetype"])
        self.assertEqual(self._leds(self.dev), {})


class LocateTests(_Base):
    def test_switch_on_renew_and_off_are_logged(self):
        url = f"/api/devices/{self.dev.id}/locate/"
        before = ChangeLogEntry.objects.count()
        res = self.client.post(url, {"on": True}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        loc = res.json()["locate"]
        self.assertEqual(loc["by"], "root")
        until = Device.objects.get(pk=self.dev.pk).locate_until
        self.assertAlmostEqual((until - timezone.now()).total_seconds(), 1800, delta=30)
        d = self._leds(self.dev)[str(self.dev.id)]
        self.assertEqual(d["leds"]["BEACON"], "blue_blink")
        self.assertEqual(d["locate"]["by"], "root")
        self.assertEqual(self.client.get(f"/api/devices/{self.dev.id}/").json()["locate"]["by"],
                         "root")
        # Renewed: a later expiry, another entry.
        res = self.client.post(url, {"on": True, "minutes": 60}, format="json")
        self.assertGreater(Device.objects.get(pk=self.dev.pk).locate_until, until)
        res = self.client.post(url, {"on": False}, format="json")
        self.assertIsNone(res.json()["locate"])
        entries = list(ChangeLogEntry.objects.filter(object_id=str(self.dev.id),
                                                     changes__has_key="locate_until"))
        self.assertEqual(ChangeLogEntry.objects.count() - before, 3)
        self.assertEqual(len(entries), 3)
        self.assertTrue(all("locate_until" in e.changes for e in entries))
        self.assertEqual({e.user_name for e in entries}, {"root"})

    def test_an_expired_beacon_is_dark(self):
        Device.objects.filter(pk=self.dev.pk).update(
            locate_until=timezone.now() - timedelta(seconds=1),
            locate_at=timezone.now() - timedelta(minutes=31), locate_by="root")
        d = self._leds(self.dev)[str(self.dev.id)]
        self.assertNotIn("BEACON", d["leds"])
        self.assertIsNone(d["locate"])
        self.assertIsNone(self.client.get(f"/api/devices/{self.dev.id}/locate/").json()["locate"])

    def test_viewer_may_not_locate(self):
        user = User.objects.create_user("v", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(name="r", object_types=["device"],
                                                actions=["view"])
        grant.users.add(user)
        grant.tenants.add(self.tenant)
        self._login(user)
        res = self.client.post(f"/api/devices/{self.dev.id}/locate/", {"on": True},
                               format="json")
        self.assertEqual(res.status_code, 403)
        self.assertIsNone(Device.objects.get(pk=self.dev.pk).locate_until)

    def test_bad_payloads(self):
        url = f"/api/devices/{self.dev.id}/locate/"
        self.assertEqual(self.client.post(url, {"on": "yes"}, format="json").status_code, 400)
        self.assertEqual(self.client.post(url, {"on": True, "minutes": 0},
                                          format="json").status_code, 400)


class ModuleStatusTests(_Base):
    def test_module_status_is_written_and_read(self):
        m = Module.objects.get(device=self.dev, module_bay__name="PS-0")
        res = self.client.patch(f"/api/modules/{m.id}/", {"status_id": str(self.failed.id)},
                                format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["status"]["id"], str(self.failed.id))
        bays = self._leds(self.dev)[str(self.dev.id)]["bays"]
        self.assertEqual(bays["PS-0"], {"PS_OK": "red", "FAIL": "red"})
