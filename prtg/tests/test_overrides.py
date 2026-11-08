"""Per-object sensor overrides: a wanted sensor turned off (or on) for one
device, how the planning pass and the Coverage rows follow it, and the
``sensor-overrides`` API with its permissions and journal."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db.models import NOT_PROVIDED

from api.models import Device
from audit.models import JournalEntry
from auth_api.models import ObjectPermission, UserProfile
from prtg.models import (
    PrtgChange,
    PrtgDeviceLink,
    PrtgSensor,
    PrtgSensorDefinition,
    PrtgSensorOverride,
)
from prtg.provision import COVERAGE_TEXT, TEXT, instance_tag, preview

from .test_registration import _Api, _Plan, policy, profile

URL = "/api/prtg/sensor-overrides/"


def key_of(prof, kind) -> str:
    return instance_tag(PrtgSensorDefinition.objects.get(profile=prof, kind=kind).id)


class OverridePlanTests(_Plan):
    def setUp(self):
        super().setUp()
        self.std = profile(self.conn, "Std", ("ping", {}, True), ("snmp_uptime", {}, True),
                           ("snmp_cpu", {}, False))
        policy(self.conn, "std", self.std)
        self.user = get_user_model().objects.create_user("ops")

    def off(self, obj, kind, enabled=False, note=""):
        return PrtgSensorOverride.objects.create(
            tenant=self.tenant, connection=self.conn, device=obj,
            definition_key=key_of(self.std, kind), enabled=enabled, note=note,
            created_by=self.user,
        )

    def test_an_off_sensor_is_not_proposed_and_shows_off(self):
        d = self.device("db-zabbix", "10.0.0.53")
        self.read()
        self.off(d, "snmp_uptime", note="no SNMP here")
        self.plan()
        self.assertEqual(self.changes(PrtgChange.ADD_SENSOR), [])
        cov = preview(self.conn, d)["coverage"]
        rows = {r["kind"]: r for r in cov["wanted"]}
        self.assertEqual(rows["snmp_uptime"]["status"], "off")
        self.assertEqual(rows["snmp_uptime"]["reason"], COVERAGE_TEXT["off"])
        o = rows["snmp_uptime"]["override"]
        self.assertEqual((o["enabled"], o["by"], o["note"]), (False, "ops", "no SNMP here"))
        self.assertIsNone(rows["ping"]["override"])
        self.assertEqual(cov["present"], 1)
        self.assertNotIn("snmp_uptime",
                         [s["kind"] for s in preview(self.conn, d)["planned"]["sensors"]])

    def test_a_new_device_is_created_without_it(self):
        d = self.device("edge", "10.0.0.90")
        self.off(d, "snmp_uptime")
        self.plan()
        [c] = self.changes(PrtgChange.CREATE_DEVICE)
        self.assertEqual([s["kind"] for s in c.detail["sensors"]], ["ping", "snmp_cpu"])

    def test_on_makes_an_optional_sensor_required_here(self):
        d = self.device("db-zabbix", "10.0.0.53")
        self.read()
        self.off(d, "snmp_cpu", enabled=True)
        self.plan()
        kinds = sorted(c.detail["sensor"]["kind"] for c in self.changes(PrtgChange.ADD_SENSOR))
        self.assertEqual(kinds, ["snmp_cpu", "snmp_uptime"])

    def _made(self, d):
        """Sensor 2100 as one Danbyte made for the uptime definition."""
        key = key_of(self.std, "snmp_uptime")
        PrtgSensor.objects.filter(objid="2100").update(tags=[key])
        link = PrtgDeviceLink.objects.get(device=d)
        link.created_sensors = {key: {"objid": "2100"}}
        link.save()

    def test_a_sensor_danbyte_made_stays_unless_the_connection_prunes(self):
        d = self.device("db-zabbix", "10.0.0.53")
        self.read()
        self._made(d)
        self.off(d, "snmp_uptime")
        self.plan()
        self.assertEqual(self.changes(PrtgChange.REMOVE_SENSOR), [])
        row = next(r for r in preview(self.conn, d)["coverage"]["wanted"]
                   if r["kind"] == "snmp_uptime")
        self.assertEqual((row["status"], row["sensor_objid"]), ("off", "2100"))
        self.assertEqual(row["reason"], COVERAGE_TEXT["off_kept"])

        self.conn.prune_devices = True
        self.conn.save(update_fields=["prune_devices"])
        self.plan()
        [c] = self.changes(PrtgChange.REMOVE_SENSOR)
        self.assertEqual((c.key, c.detail["reason"]), ("2100", TEXT["sensor_off"]))
        self.assertTrue(c.detail["applicable"])
        out = preview(self.conn, d)
        row = next(r for r in out["coverage"]["wanted"] if r["kind"] == "snmp_uptime")
        self.assertEqual((row["reason"], row["change_id"]),
                         (COVERAGE_TEXT["off_remove"], str(c.id)))
        self.assertEqual([r["objid"] for r in out["planned"]["remove"]], ["2100"])

    def test_a_tagged_sensor_danbyte_did_not_make_is_left_alone(self):
        d = self.device("db-zabbix", "10.0.0.53")
        self.read()
        PrtgSensor.objects.filter(objid="2100").update(tags=[key_of(self.std, "snmp_uptime")])
        self.conn.prune_devices = True
        self.conn.save(update_fields=["prune_devices"])
        self.off(d, "snmp_uptime")
        self.plan()
        self.assertEqual(self.changes(PrtgChange.REMOVE_SENSOR), [])

    def test_columns_carry_database_defaults(self):
        for name in ("enabled", "note"):
            self.assertIsNot(PrtgSensorOverride._meta.get_field(name).db_default, NOT_PROVIDED)


class OverrideApiTests(_Api):
    def setUp(self):
        super().setUp()
        self.dev = Device.objects.create(tenant=self.tenant, name="edge", site=self.site)
        self.post_policy()
        self.key = key_of(self.prof, "ping")

    def put(self, **kw):
        body = {"device": str(self.dev.id), "definition_key": self.key, "enabled": False, **kw}
        return self.client.put(URL, body, format="json")

    def coverage(self):
        [entry] = self.client.get(f"/api/prtg/plan/?device={self.dev.id}").json()
        return entry["coverage"]

    def test_turn_off_and_back(self):
        r = self.put(note="lab box")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["enabled"], r.json()["note"], r.json()["by"]),
                         (False, "lab box", "root"))
        self.assertEqual(r.json()["connection"], str(self.conn.id))
        [row] = self.coverage()["wanted"]
        self.assertEqual(row["status"], "off")
        self.assertEqual(row["override"]["note"], "lab box")
        journal = JournalEntry.objects.filter(object_id=str(self.dev.id))
        self.assertIn("Ping turned off", journal.first().comments)
        # Turning it off drops the planned create's sensor.
        r = self.client.delete(URL, {"device": str(self.dev.id), "definition_key": self.key},
                               format="json")
        self.assertEqual(r.status_code, 204, r.content)
        self.assertFalse(PrtgSensorOverride.objects.exists())
        [row] = self.coverage()["wanted"]
        self.assertNotEqual(row["status"], "off")
        self.assertEqual(journal.count(), 2)
        r = self.client.delete(f"{URL}?device={self.dev.id}&definition_key={self.key}")
        self.assertEqual(r.status_code, 404)

    def test_put_twice_updates_the_row(self):
        self.put()
        self.put(enabled=True)
        [o] = PrtgSensorOverride.objects.all()
        self.assertTrue(o.enabled)

    def test_bad_requests(self):
        self.assertEqual(self.put(definition_key="danbyte-def-000000000000").status_code, 400)
        self.assertEqual(self.put(enabled="no").status_code, 400)
        self.assertEqual(self.put(device=None).status_code, 400)
        foreign = Device.objects.create(tenant=self.other, name="x", site=self.foreign_site)
        self.assertEqual(self.put(device=str(foreign.id)).status_code, 404)
        self.assertEqual(self.put(connection=str(self.foreign.id)).status_code, 400)

    def _user(self, grants):
        user = get_user_model().objects.create_user(f"u{ObjectPermission.objects.count()}")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        for i, (types, actions) in enumerate(grants):
            perm = ObjectPermission.objects.create(
                name=f"g{i}-{user.username}", object_types=types, actions=actions,
            )
            perm.tenants.set([self.tenant])
            perm.users.set([user])
        return user

    def login(self, user):
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def test_needs_the_override_and_the_object_change_grants(self):
        self.login(self._user([(["device"], ["view", "change"])]))
        self.assertEqual(self.put().status_code, 403)
        self.login(self._user([(["device"], ["view"]),
                               (["prtgsensoroverride"], ["change"])]))
        self.assertEqual(self.put().status_code, 403)
        self.login(self._user([(["device"], ["view", "change"]),
                               (["prtgsensoroverride"], ["change"])]))
        self.assertEqual(self.put().status_code, 200)
        self.assertTrue(PrtgSensorOverride.objects.exists())
