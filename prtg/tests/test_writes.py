"""Writing the plan to PRTG: the API v2 client, the capability check and the
seed fallback, apply for every planned kind (and its retry), the refusals,
credentials as device properties, pruning, drift after apply, auto apply on
the beat, the queue's inbox API and its tenant boundary - against the fake
PRTG, whose v2 routes follow what PRTG 26.3.124 answered in the lab
(``fixtures/v2_*.json``).
"""
from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from django.db.models import NOT_PROVIDED
from django.test import TestCase
from django.utils import timezone

from audit.models import ChangeLogEntry, JournalEntry
from monitoring.models import SnmpProfile
from prtg import writer
from prtg.client import PrtgError
from prtg.client_v2 import (
    PrtgNotFound,
    PrtgV2Client,
    _table,
    capabilities,
    id_from_location,
    version_tuple,
)
from prtg.models import PrtgChange, PrtgConnection, PrtgDeviceLink, PrtgSensor
from prtg.provision import NO_WRITES, instance_tag

from .fake_server import load_fixture
from .test_registration import LOCAL_PROBE, _Plan, policy, profile
from .test_status import _Lab

NO_GAP = mock.patch("prtg.client_v2.WRITE_GAP", 0)


def v2(fake, **kw) -> PrtgV2Client:
    return PrtgV2Client(fake.v2_url, fake.api_key, write_gap=0, poll_seconds=0, **kw)


class RecordedShapeTests(TestCase):
    def test_recorded_create_answers_carry_the_id_in_location(self):
        rec = load_fixture("v2_responses.json")["responses"]
        self.assertEqual(rec["create_device"]["status"], 201)
        self.assertEqual(id_from_location(rec["create_device"]["location"]), "2101")
        self.assertEqual(id_from_location(rec["create_sensor"]["location"]), "2102")
        self.assertEqual(rec["patch_sensor_interval_refused"]["status"], 501)
        self.assertEqual(rec["classic_moveobjectnow_missing"]["status"], 404)
        self.assertIn("/device.htm?id=", rec["classic_duplicate_device"]["location"])

    def test_the_live_apply_as_recorded(self):
        calls = load_fixture("v2_live_apply.json")["calls"]
        writes = [(c["method"], c["path"].split("/api/v2", 1)[-1], c["status"])
                  for c in calls if c["method"] != "GET"]
        self.assertEqual(writes, [
            ("POST", "/experimental/probes/1/device", 201),
            # The new device is not a parent yet: waited out.
            ("POST", "/experimental/devices/2114/sensor", 404),
            ("POST", "/experimental/devices/2114/sensor", 201),
            ("DELETE", "/experimental/devices/2114", 204),
        ])
        self.assertIn("could not find parent", calls[9]["response"])
        self.assertEqual(id_from_location(calls[7]["location"]), "2114")

    def test_recordings_hold_no_secrets(self):
        for name in ("v2_responses.json", "v2_patch_device_schema.json"):
            text = load_fixture(name, raw=True)
            self.assertNotIn("lab-community-x", text)
            self.assertNotIn("winpass", text)

    def test_versions_and_tables(self):
        self.assertEqual(version_tuple("26.3.124.1727+"), (26, 3, 124, 1727))
        self.assertLess(version_tuple("26.1.116"), (26, 2, 120))
        rows = _table({"headers": {"values": ["interfacenumber", "name"]},
                       "rows": [{"values": ["3", "Gi0/1"]}]})
        self.assertEqual(rows, [{"interfacenumber": "3", "name": "Gi0/1"}])


class ClientV2Tests(_Lab):
    def test_device_and_sensor_lifecycle(self):
        c = v2(self.fake)
        self.assertEqual(c.version(), "26.3.124.1727")
        objid = c.create_device("1", "x", "10.9.9.9", ["danbyte"], parent_kind="probe")
        self.assertEqual(self.fake.device(int(objid))["tags_raw"], "danbyte")
        sid = c.create_sensor(objid, "ping", {"basic": {"name": "Ping", "tags": ["a"]}})
        c.update_sensor(sid, {"tags": ["a", "b"]})
        self.assertEqual(self.fake.sensor(int(sid))["tags_raw"], "a b")
        c.move(objid, "53")
        self.assertEqual(self.fake.device(int(objid))["parentid"], 53)
        self.assertTrue(c.delete_sensor(sid))
        self.assertFalse(c.delete_sensor(sid))
        self.assertTrue(c.delete_device(objid))
        self.assertFalse(c.delete_device(objid))
        calls = [r["auth"] for r in self.fake.requests if r["path"].startswith("/api/v2/")]
        self.assertEqual(set(calls), {"bearer"})

    def test_a_new_device_is_waited_for(self):
        c = v2(self.fake)
        objid = c.create_device("1", "x", "10.9.9.9", parent_kind="probe")
        self.fake.parent_misses = 2
        self.assertTrue(c.create_sensor(objid, "ping", {"basic": {"name": "Ping"}}))
        self.fake.parent_misses = 5
        with self.assertRaises(PrtgNotFound):
            v2(self.fake, parent_wait_seconds=0).create_sensor(objid, "ping", {})

    def test_errors_keep_prtgs_sentence(self):
        c = v2(self.fake)
        with self.assertRaises(PrtgNotFound) as ctx:
            c.create_device("999999", "x", "h")
        self.assertIn("could not find parent", str(ctx.exception))
        with self.assertRaises(PrtgError) as ctx:
            c._call("PATCH", "/experimental/sensors/1001", body={"intervalgroup": {}},
                    ok=(204,))
        self.assertIn("501", str(ctx.exception))

    def test_body_cap_and_rate_limit_retry(self):
        c = v2(self.fake)
        with self.assertRaises(PrtgError):
            c.create_sensor("2081", "ping", {"basic": {"name": "x" * 16_000}})
        responses = iter([mock.Mock(status_code=429, headers={"Retry-After": "0"}),
                          mock.Mock(status_code=204, headers={})])
        with mock.patch.object(c, "_raw", side_effect=lambda *a, **k: next(responses)), \
                mock.patch("prtg.client_v2.time.sleep") as sleep:
            c.move("2081", "53")
        sleep.assert_called()

    def test_metascan_waits_for_the_table(self):
        self.fake.metascans["snmptraffic"] = {
            "headers": {"values": ["interfacenumber", "name"]},
            "rows": [{"values": ["1:Gi0/1", "Gi0/1"]}],
        }
        rows = v2(self.fake).metascan("2080", "snmptraffic")
        self.assertEqual(rows[0]["interfacenumber"], "1:Gi0/1")
        with self.assertRaises(PrtgError):
            v2(self.fake).metascan("2080", "wmiservice")


class CapabilityTests(_Lab):
    def test_v2_seed_and_none(self):
        self.assertEqual(capabilities(self.conn, client=v2(self.fake))["mode"], "v2")
        self.fake.status["Version"] = "26.1.116.1000"
        result = capabilities(self.conn, client=v2(self.fake))
        self.assertEqual(result["mode"], "none")
        self.assertIn(NO_WRITES, result["detail"])
        self.conn.seed_device_objid = "2082"
        self.assertEqual(capabilities(self.conn, client=v2(self.fake))["mode"], "seed")

    def test_experimental_endpoints_missing(self):
        self.fake.v2_writes = False
        self.assertEqual(capabilities(self.conn, client=v2(self.fake))["mode"], "none")

    def test_check_is_stored(self):
        writer.check_writes(self.conn, client=v2(self.fake))
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.write_mode, "v2")
        self.assertIsNotNone(self.conn.write_checked_at)


class _Writes(_Plan):
    def setUp(self):
        super().setUp()
        self.dev = self.device("edge-01", "10.0.0.77")
        policy(self.conn, "all", self.ping, LOCAL_PROBE)
        self.conn.groups_cache = []
        self.conn.save()
        self.v2_patch = mock.patch("prtg.writer.PrtgV2Client.for_connection",
                                   side_effect=lambda conn: v2(self.fake))
        self.v2_patch.start()
        self.addCleanup(self.v2_patch.stop)
        self.gap = mock.patch("prtg.client.PAGE_GAP_SECONDS", 0)
        self.gap.start()
        self.addCleanup(self.gap.stop)

    def row(self, kind):
        return PrtgChange.objects.get(connection=self.conn, kind=kind)

    def tagged(self, tag):
        return [d for d in self.fake.tables["devices"] if tag in d["tags_raw"].split()]

    def created(self):
        self.plan()
        result = writer.apply(self.row(PrtgChange.CREATE_DEVICE))
        return PrtgDeviceLink.objects.get(connection=self.conn, device=self.dev), result


class ApplyCreateTests(_Writes):
    def test_create_device_with_its_sensor(self):
        link, result = self.created()
        [dev] = self.tagged(f"danbyte-{self.dev.id}")
        self.assertEqual(dev["host_raw"], "10.0.0.77")
        self.assertEqual(str(dev["objid"]), link.objid)
        self.assertTrue(link.created_here)
        self.assertEqual(link.matched_by, "created")
        key = next(iter(link.created_sensors))
        self.assertTrue(key.startswith("danbyte-def-"))
        sensor = self.fake.sensor(int(link.created_sensors[key]["objid"]))
        self.assertIn(key, sensor["tags_raw"].split())
        self.assertEqual(sensor["type_raw"], "ping")
        self.assertEqual(result["result"]["device"], link.objid)
        # The row stays as applied, the sensor is imported, the next plan is quiet.
        change = self.row(PrtgChange.CREATE_DEVICE)
        self.assertEqual(writer.change_status(change), "applied")
        self.assertTrue(PrtgSensor.objects.filter(link=link).exists())
        counts = self.plan()
        self.assertEqual((counts["create"], counts["add_sensor"]), (0, 0))
        self.assertTrue(JournalEntry.objects.filter(object_id=str(self.dev.id)).exists())
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_id=str(self.dev.id), changes__has_key="prtg").exists())
        with self.assertRaises(writer.Refused):
            writer.apply(change)

    def test_retry_resumes_without_a_second_device(self):
        self.plan()
        self.fake.refuse_kinds["ping"] = (500, {"code": "INTERNAL", "message": "boom"})
        change = self.row(PrtgChange.CREATE_DEVICE)
        with self.assertRaises(PrtgError):
            writer.apply(change)
        change.refresh_from_db()
        self.assertEqual(writer.change_status(change), "failed")
        self.assertIn("boom", change.detail["last_error"]["detail"])
        self.fake.refuse_kinds.clear()
        writer.apply(change)
        self.assertEqual(len(self.tagged(f"danbyte-{self.dev.id}")), 1)
        link = PrtgDeviceLink.objects.get(device=self.dev)
        self.assertTrue(link.created_here)
        self.assertEqual(len(link.created_sensors), 1)

    def test_a_device_already_tagged_is_linked_not_created(self):
        from .fake_server import device_row

        self.fake.tables["devices"].append(
            device_row(4000, "edge-01", host="10.0.0.77", tags=[f"danbyte-{self.dev.id}"])
        )
        # Not linked yet by a read: plan straight away.
        plan_counts = self.plan()
        self.assertEqual(plan_counts["create"], 1)
        writer.apply(self.row(PrtgChange.CREATE_DEVICE))
        self.assertEqual(len(self.tagged(f"danbyte-{self.dev.id}")), 1)
        link = PrtgDeviceLink.objects.get(device=self.dev)
        self.assertEqual(link.objid, "4000")
        self.assertFalse(link.created_here)

    def test_interval_goes_through_the_classic_properties(self):
        self.ping.definitions.update(interval_seconds=300)
        link, _ = self.created()
        sid = int(next(iter(link.created_sensors.values()))["objid"])
        self.assertEqual(self.fake.properties[(sid, "interval")], "300")
        self.assertEqual(self.fake.properties[(sid, "intervalgroup_")], "0")

    def test_templates_run_discovery(self):
        defn = self.ping.definitions.first()
        from prtg.models import PrtgSensorDefinition

        PrtgSensorDefinition.objects.create(
            profile=self.ping, position=2, kind="device_template",
            params={"template": "Device Generic Ping.odt"},
        )
        self.assertIsNotNone(defn)
        self.created()
        [call] = [q for name, q in self.fake.writes if name == "discovernow.htm"]
        self.assertEqual(call["template"], '"Device Generic Ping.odt"')


class CredentialTests(_Writes):
    def test_snmp_v2c_community_as_properties(self):
        prof = SnmpProfile.objects.get(tenant=self.tenant)
        prof.secret_params = {"community": "s3cret"}
        prof.is_default = True
        prof.save()
        self.conn.send_credentials = True
        self.conn.save()
        link, result = self.created()
        snmp = self.fake.device_settings[int(link.objid)]["snmpversiongroup"]
        self.assertEqual(snmp, {"_inherited": False, "snmpversion": "V2",
                                "snmpcommv2": "s3cret"})
        self.assertEqual(result["result"]["credentials"], ["SNMP lab-v2c"])
        self.assertTrue(link.credentials_hash)
        # Never in the row, the journal or the change log.
        self.assertNotIn("s3cret", str(self.row(PrtgChange.CREATE_DEVICE).detail))
        self.assertFalse(JournalEntry.objects.filter(comments__contains="s3cret").exists())

    def test_snmp_v3_fields(self):
        prof = SnmpProfile.objects.get(tenant=self.tenant)
        prof.version = "v3"
        prof.params = {"username": "u", "auth_proto": "sha256", "priv_proto": "aes256"}
        prof.secret_params = {"auth_key": "a1", "priv_key": "p1"}
        prof.save()
        sections, names = writer.credential_sections(self.dev, self.tenant)
        self.assertEqual(sections["snmpversiongroup"]["snmpauthmode"], "authpHMACSHA256")
        self.assertEqual(sections["snmpversiongroup"]["snmpencmode"], "AES256PrivProtocol")
        self.assertEqual(sections["snmpversiongroup"]["snmpuser"], "u")
        self.assertEqual(names, ["SNMP lab-v2c"])

    def test_off_by_default(self):
        link, _ = self.created()
        self.assertNotIn(int(link.objid), self.fake.device_settings)


class OtherKindsTests(_Writes):
    def test_add_remove_sensor_and_deleted_in_prtg(self):
        link, _ = self.created()
        key, entry = next(iter(link.created_sensors.items()))
        # Deleted in PRTG by hand: proposed again, with the reason.
        self.fake.tables["sensors"] = [r for r in self.fake.tables["sensors"]
                                       if str(r["objid"]) != entry["objid"]]
        self.read()
        change = self.row(PrtgChange.ADD_SENSOR)
        self.assertEqual(change.detail["reason"], "Deleted in PRTG.")
        self.assertTrue(change.detail["applicable"])
        writer.apply(change)
        link.refresh_from_db()
        new = link.created_sensors[key]["objid"]
        self.assertNotEqual(new, entry["objid"])
        # No profile wants it any more: remove_sensor deletes what Danbyte made.
        self.ping.definitions.all().delete()
        self.read()
        change = self.row(PrtgChange.REMOVE_SENSOR)
        self.assertTrue(change.detail["applicable"])
        writer.apply(change)
        self.assertIsNone(self.fake.sensor(int(new)))
        link.refresh_from_db()
        self.assertEqual(link.created_sensors, {})

    def test_remove_sensor_refused_for_one_danbyte_did_not_create(self):
        link, _ = self.created()
        stranger = self.fake.sensor(int(next(iter(link.created_sensors.values()))["objid"]))
        link.created_sensors = {}
        link.save()
        change = PrtgChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=self.dev,
            kind=PrtgChange.REMOVE_SENSOR, key=str(stranger["objid"]),
            detail={"sensor": {"objid": str(stranger["objid"])}, "applicable": True},
        )
        with self.assertRaises(writer.Refused) as ctx:
            writer.apply(change)
        self.assertIn("did not create", str(ctx.exception))
        self.assertIsNotNone(self.fake.sensor(stranger["objid"]))

    def test_move_device(self):
        link, _ = self.created()
        change = PrtgChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=self.dev,
            kind=PrtgChange.MOVE_DEVICE,
            detail={"to": {"objid": "53", "path": "Network Infrastructure"},
                    "applicable": True},
        )
        writer.apply(change)
        self.assertEqual(self.fake.device(int(link.objid))["parentid"], 53)
        link.refresh_from_db()
        self.assertEqual(link.group_path, "Network Infrastructure")


class UpdateHostTests(_Writes):
    def test_a_primary_set_later_updates_the_host(self):
        from api.models import IPAddress

        self.dev.primary_ip = None
        self.dev.save()
        link, _ = self.created()
        self.assertEqual(link.host_source, "assigned")
        self.assertEqual(self.fake.device(int(link.objid))["host_raw"], "10.0.0.77")
        ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.78/24",
                                      prefix=self.prefix, assigned_device=self.dev)
        self.dev.primary_ip = ip
        self.dev.save()
        counts = self.read()["plan"]
        self.assertEqual(counts["update_host"], 1)
        change = self.row(PrtgChange.UPDATE_HOST)
        self.assertTrue(change.detail["applicable"])
        self.assertEqual(change.detail["host_source"], "primary")
        writer.apply(change)
        self.assertEqual(self.fake.device(int(link.objid))["host_raw"], "10.0.0.78")
        link.refresh_from_db()
        self.assertEqual((link.host, link.host_source), ("10.0.0.78", "primary"))
        self.assertEqual(self.read()["plan"]["update_host"], 0)

    def test_a_device_created_on_its_primary_is_left_alone(self):
        link, _ = self.created()
        self.assertEqual(link.host_source, "primary")
        self.assertEqual(self.plan()["update_host"], 0)


class PruneTests(_Writes):
    def test_gate_and_apply(self):
        link, _ = self.created()
        self.dev.prtg_sync = "never"
        self.dev.save()
        self.read()
        self.assertFalse(PrtgChange.objects.filter(kind=PrtgChange.REMOVE_DEVICE).exists())
        self.conn.prune_devices = True
        self.conn.save()
        self.read()
        change = self.row(PrtgChange.REMOVE_DEVICE)
        # Removals are never applied unattended.
        self.assertFalse(writer.ready(change))
        writer.apply(change)
        self.assertIsNone(self.fake.device(int(link.objid)))
        self.assertFalse(PrtgDeviceLink.objects.filter(pk=link.pk).exists())

    def test_never_for_a_device_danbyte_did_not_create(self):
        self.conn.prune_devices = True
        self.conn.save()
        link = self.link(self.dev, 2081)
        self.dev.prtg_sync = "never"
        self.dev.save()
        self.read()
        self.assertFalse(PrtgChange.objects.filter(kind=PrtgChange.REMOVE_DEVICE).exists())
        change = PrtgChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=self.dev,
            kind=PrtgChange.REMOVE_DEVICE, detail={"applicable": True},
        )
        with self.assertRaises(writer.Refused):
            writer.apply(change)
        self.assertIsNotNone(self.fake.device(2081))
        self.assertTrue(PrtgDeviceLink.objects.filter(pk=link.pk).exists())


class FallbackTests(_Writes):
    def test_seed_copy(self):
        self.fake.v2_writes = False
        self.conn.seed_device_objid = "2082"
        self.conn.save()
        link, _ = self.created()
        self.assertEqual(self.conn.__class__.objects.get(pk=self.conn.pk).write_mode, "seed")
        dev = self.fake.device(int(link.objid))
        self.assertIn(f"danbyte-{self.dev.id}", dev["tags_raw"].split())
        self.assertIn(("duplicateobject.htm", "2082"),
                      [(n, q["id"]) for n, q in self.fake.writes])
        sid = next(iter(link.created_sensors.values()))["objid"]
        self.assertIn(next(iter(link.created_sensors)), self.fake.sensor(int(sid))["tags_raw"])

    def test_without_seed_the_row_says_why(self):
        self.fake.v2_writes = False
        writer.check_writes(self.conn, client=v2(self.fake))
        self.plan()
        change = self.row(PrtgChange.CREATE_DEVICE)
        self.assertFalse(change.detail["applicable"])
        self.assertIn(NO_WRITES, change.detail["reason"])
        self.assertEqual(writer.change_status(change), "attention")
        with self.assertRaises(writer.Refused):
            writer.apply(change)
        self.assertEqual(self.tagged(f"danbyte-{self.dev.id}"), [])


class AutoApplyTests(_Writes):
    def test_beat_applies_ready_rows_only_when_on(self):
        from prtg.sync_tasks import enqueue_due_reads

        queue = mock.Mock()
        self.plan()
        self.conn.last_plan_at = timezone.now()
        self.conn.save()
        with mock.patch("prtg.sync_tasks.django_rq.get_queue", return_value=queue):
            enqueue_due_reads()
        jobs = [c.args[0].__name__ for c in queue.enqueue.call_args_list]
        self.assertNotIn("run_auto_apply", jobs)
        self.assertEqual(writer.run_auto_apply(str(self.conn.id)),
                         {"skipped": "auto apply off"})
        self.conn.auto_apply_registration = True
        self.conn.save()
        queue.reset_mock()
        with mock.patch("prtg.sync_tasks.django_rq.get_queue", return_value=queue):
            enqueue_due_reads()
        jobs = [c.args[0].__name__ for c in queue.enqueue.call_args_list]
        self.assertIn("run_auto_apply", jobs)
        out = writer.run_auto_apply(str(self.conn.id))
        self.assertEqual(out["applied"], 1)
        self.assertEqual(len(self.tagged(f"danbyte-{self.dev.id}")), 1)
        self.conn.refresh_from_db()
        self.assertFalse(self.conn.auto_apply_due(timezone.now()))


class QueueInboxApiTests(_Writes):
    def setUp(self):
        super().setUp()
        from rest_framework.test import APIClient

        from core.models import Organization, Tenant
        from integrations.models import IntegrationSettings

        self.api = APIClient()
        admin = get_user_model().objects.create_superuser("root", "r@x.io", "pw")
        self.api.force_login(admin)
        sess = self.api.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()
        other = Tenant.objects.create(org=Organization.objects.create(name="P", slug="p"),
                                      name="U", slug="u")
        IntegrationSettings.objects.update_or_create(
            tenant=other, defaults={"prtg_enabled": True})
        fconn = PrtgConnection.objects.create(tenant=other, name="f", url=self.fake.url,
                                              credentials={"api_key": "k"})
        from api.models import Device

        fdev = Device.objects.create(tenant=other, name="theirs")
        self.foreign = PrtgChange.objects.create(
            tenant=other, connection=fconn, device=fdev, kind=PrtgChange.CREATE_DEVICE,
            detail={"applicable": True, "group": {"objid": "1"}},
        )

    def test_status_apply_selected_and_tenant_boundary(self):
        self.plan()
        [row] = self.api.get("/api/prtg/changes/").json()["results"]
        self.assertEqual((row["status"], row["applicable"], row["destructive"]),
                         ("ready", True, False))
        r = self.api.post("/api/prtg/changes/apply-selected/",
                          {"ids": [row["id"], str(self.foreign.id)]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["applied"], 1)
        by_id = {x["id"]: x for x in body["results"]}
        self.assertEqual(by_id[row["id"]]["status"], "applied")
        self.assertEqual(by_id[str(self.foreign.id)]["detail"], "Not found.")
        self.assertEqual(
            self.api.post(f"/api/prtg/changes/{self.foreign.id}/apply/").status_code, 404)
        [row] = self.api.get("/api/prtg/changes/").json()["results"]
        self.assertEqual(row["status"], "applied")
        self.assertFalse(row["applicable"])

    def test_single_apply_returns_result_and_dismiss_selected(self):
        self.plan()
        change = self.row(PrtgChange.CREATE_DEVICE)
        r = self.api.post(f"/api/prtg/changes/{change.id}/apply/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["status"], "applied")
        self.assertTrue(r.json()["result"]["device"])
        r = self.api.post("/api/prtg/changes/dismiss-selected/",
                          {"ids": [str(change.id), str(self.foreign.id)]}, format="json")
        self.assertEqual(r.json()["dismissed"], 1)
        self.foreign.refresh_from_db()
        self.assertFalse(self.foreign.ignored)
        self.assertEqual(
            self.api.post("/api/prtg/changes/apply-selected/", {"ids": []},
                          format="json").status_code, 400)

    def _states(self):
        """One open, one applied and one dismissed row, plus the other
        tenant's open row."""
        mk = lambda key, **kw: PrtgChange.objects.create(  # noqa: E731
            tenant=self.tenant, connection=self.conn, device=self.dev,
            kind=PrtgChange.ADD_SENSOR, key=key, **kw)
        return {
            "open": mk("o", detail={"applicable": True}),
            "applied": mk("a", detail={"applied": {"at": "x", "by": "y", "detail": "z"}}),
            "dismissed": mk("d", detail={"applicable": True}, ignored=True),
        }

    def _ids(self, query):
        r = self.api.get(f"/api/prtg/changes/?connection={self.conn.id}&{query}")
        self.assertEqual(r.status_code, 200, r.content)
        return {x["id"] for x in r.json()["results"]}

    def test_state_filter(self):
        rows = {k: str(v.id) for k, v in self._states().items()}
        self.assertEqual(self._ids("state=open"), {rows["open"]})
        self.assertEqual(self._ids("state=applied"), {rows["applied"]})
        self.assertEqual(self._ids("state=open,dismissed"),
                         {rows["open"], rows["dismissed"]})
        self.assertEqual(self._ids("state=handled"), {rows["applied"], rows["dismissed"]})
        self.assertEqual(self._ids("state=all"), set(rows.values()))
        # `state` wins over `ignored`; the old params still mean what they did.
        self.assertEqual(self._ids("state=open&ignored=1"), {rows["open"]})
        self.assertEqual(self._ids(""), {rows["open"], rows["applied"]})
        self.assertEqual(self._ids("ignored=1"), {rows["dismissed"]})
        r = self.api.get("/api/prtg/changes/?state=closed")
        self.assertEqual(r.status_code, 400)
        self.assertIn("state", r.json())
        # Never across the tenant boundary.
        self.assertNotIn(str(self.foreign.id), self._ids("state=all"))
        r = self.api.get("/api/prtg/changes/?state=all")
        self.assertNotIn(str(self.foreign.id), {x["id"] for x in r.json()["results"]})

    def test_counts(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        self._states()
        with CaptureQueriesContext(connection) as ctx:
            r = self.client_counts(f"connection={self.conn.id}")
        self.assertEqual(r, {"open": 1, "applied": 1, "dismissed": 1})
        table = PrtgChange._meta.db_table
        self.assertEqual(sum(1 for q in ctx.captured_queries if table in q["sql"]), 1)
        # The tenant's rows only; and narrowed like the list.
        self.assertEqual(self.client_counts(""), {"open": 1, "applied": 1, "dismissed": 1})
        from api.models import Device

        other = Device.objects.create(tenant=self.tenant, name="other")
        self.assertEqual(self.client_counts(f"object={other.id}"),
                         {"open": 0, "applied": 0, "dismissed": 0})
        self.assertEqual(self.client_counts(f"device={self.dev.id}")["applied"], 1)

    def client_counts(self, query):
        r = self.api.get(f"/api/prtg/changes/counts/?{query}")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_apply_selected_leaves_handled_rows(self):
        rows = self._states()
        r = self.api.post("/api/prtg/changes/apply-selected/", {
            "ids": [str(rows["applied"].id), str(rows["dismissed"].id)]}, format="json")
        body = r.json()
        self.assertEqual(body["applied"], 0)
        by_id = {x["id"]: x["detail"] for x in body["results"]}
        self.assertEqual(by_id[str(rows["applied"].id)], "Already applied.")
        self.assertEqual(by_id[str(rows["dismissed"].id)], "Not found.")

    def test_apply_all_skips_removals(self):
        link, _ = self.created()
        PrtgChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=self.dev,
            kind=PrtgChange.REMOVE_DEVICE, detail={"applicable": True},
        )
        r = self.api.post("/api/prtg/changes/apply-all/", {"connection": str(self.conn.id)},
                          format="json")
        self.assertEqual(r.json()["applied"], 0)
        self.assertIsNotNone(self.fake.device(int(link.objid)))

    def test_connection_writes_fields_and_check(self):
        r = self.api.patch(f"/api/prtg/connections/{self.conn.id}/", {
            "seed_device_objid": "2082", "send_credentials": True,
            "auto_apply_registration": True, "prune_devices": True,
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["prune_devices"])
        r = self.api.patch(f"/api/prtg/connections/{self.conn.id}/",
                           {"seed_device_objid": "abc"}, format="json")
        self.assertEqual(r.status_code, 400)
        with mock.patch("prtg.client_v2.PrtgV2Client.for_connection",
                        side_effect=lambda conn: v2(self.fake)):
            r = self.api.post(f"/api/prtg/connections/{self.conn.id}/check-writes/")
        self.assertEqual(r.json()["mode"], "v2")
        r = self.api.get(f"/api/prtg/connections/{self.conn.id}/prtg-devices/")
        self.assertIn("2082", [d["objid"] for d in r.json()])

    def test_plan_preview_carries_the_last_apply(self):
        self.created()
        [entry] = self.api.get(f"/api/prtg/plan/?device={self.dev.id}").json()
        self.assertTrue(entry["linked"]["created_here"])
        self.assertTrue(entry["last_apply"]["ok"])


class MigrationTests(TestCase):
    def test_0009_follows_object_links_with_database_defaults(self):
        from importlib import import_module

        mig = import_module("prtg.migrations.0009_writes").Migration
        self.assertIn(("prtg", "0008_object_links"), mig.dependencies)
        for model, name in ((PrtgConnection, "seed_device_objid"),
                            (PrtgConnection, "send_credentials"),
                            (PrtgConnection, "auto_apply_registration"),
                            (PrtgConnection, "prune_devices"),
                            (PrtgConnection, "write_mode"),
                            (PrtgConnection, "last_apply_summary"),
                            (PrtgDeviceLink, "created_sensors"),
                            (PrtgDeviceLink, "last_apply"),
                            (PrtgDeviceLink, "credentials_hash")):
            with self.subTest(name=name):
                self.assertIsNot(model._meta.get_field(name).db_default, NOT_PROVIDED)

    def test_tag_helper_is_stable(self):
        self.assertEqual(instance_tag("a"), instance_tag("a"))
        self.assertTrue(profile and policy)
