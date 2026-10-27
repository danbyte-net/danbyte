"""Deleting and retiring: what a Danbyte delete or a retirement rule does in
PRTG - remove, pause or keep on delete (single and bulk, created and not
created links), rule matching by status and tag, pause and resume, deletes
only where allowed, automatic apply only where the rule allows it, and the
tenant boundary - against the fake PRTG.
"""
from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from api.models import Cluster, ClusterType, Device, Status, VirtualMachine
from audit.models import JournalEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, Tenant
from integrations.models import IntegrationSettings
from prtg import retire, writer
from prtg.client import PrtgUnreachable
from prtg.models import PrtgChange, PrtgConnection, PrtgDeviceLink, PrtgRetireRule
from prtg.status import PAUSED

from .test_writes import _Writes

#: The fixture devices: neither was created by Danbyte.
THEIRS, THEIRS_2 = 2081, 2082


def _queued(items, user=None):
    return [dict(i, ok=True, queued=True, detail="Queued.") for i in items]


class _Retire(_Writes):
    def setUp(self):
        super().setUp()
        self.retired = Status.objects.create(
            tenant=self.tenant, name="Retired", slug="retired", available_to=["device"]
        )
        self.decom = Status.objects.create(
            tenant=self.tenant, name="Decommissioning", slug="decommissioning",
            available_to=["device"],
        )
        self.api = APIClient()
        self.admin = get_user_model().objects.create_superuser("root", "r@x.io", "pw")
        self.login(self.admin)
        # Paused for the deletes' own pause message: the fake keeps it.
        self.addCleanup(mock.patch.stopall)

    def login(self, user):
        self.api.force_login(user)
        sess = self.api.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def rule(self, name="Retired", action=PrtgRetireRule.PAUSE, position=0, **kw):
        kw.setdefault("statuses", ["retired"])
        return PrtgRetireRule.objects.create(
            tenant=self.tenant, connection=self.conn, name=name, action=action,
            position=position, **kw,
        )

    def retire_dev(self, status=None):
        self.dev.status = status or self.retired
        self.dev.save()

    def vm(self, name="vm-1"):
        ct, _ = ClusterType.objects.get_or_create(tenant=self.tenant, name="PVE", slug="pve")
        cluster, _ = Cluster.objects.get_or_create(tenant=self.tenant, name="c1", type=ct)
        return VirtualMachine.objects.create(tenant=self.tenant, name=name, cluster=cluster)

    def rows(self, kind):
        return list(PrtgChange.objects.filter(connection=self.conn, kind=kind))


# ── delete with cleanup ──────────────────────────────────────────────────────


class DeleteTests(_Retire):
    def delete(self, obj=None, **params):
        obj = obj or self.dev
        base = "virtual-machines" if isinstance(obj, VirtualMachine) else "devices"
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        return self.api.delete(f"/api/{base}/{obj.id}/" + (f"?{qs}" if qs else ""))

    def test_keep_is_the_default_and_touches_nothing(self):
        link, _ = self.created()
        r = self.delete()
        self.assertEqual(r.status_code, 204, r.content)
        self.assertIsNotNone(self.fake.device(int(link.objid)))
        self.assertFalse(Device.objects.filter(pk=self.dev.pk).exists())

    def test_remove_deletes_a_device_danbyte_created(self):
        link, _ = self.created()
        objid = int(link.objid)
        r = self.delete(prtg="remove")
        self.assertEqual(r.status_code, 200, r.content)
        [res] = r.json()["prtg"]
        self.assertEqual((res["action"], res["ok"], res["queued"]), ("remove", True, False))
        self.assertIsNone(self.fake.device(objid))
        self.assertFalse(Device.objects.filter(pk=self.dev.pk).exists())
        self.assertTrue(JournalEntry.objects.filter(
            object_type="core.tenant", object_id=str(self.tenant.id),
            comments__contains="Deleted PRTG device").exists())

    def test_remove_pauses_a_device_danbyte_did_not_create(self):
        self.link(self.dev, THEIRS)
        r = self.delete(prtg="remove")
        [res] = r.json()["prtg"]
        self.assertEqual(res["action"], "pause")
        self.assertIn(self.fake.device(THEIRS)["status_raw"], PAUSED)

    def test_remove_anyway_deletes_a_device_danbyte_did_not_create(self):
        self.link(self.dev, THEIRS)
        r = self.delete(prtg="remove", prtg_force="1")
        [res] = r.json()["prtg"]
        self.assertEqual((res["action"], res["ok"]), ("remove", True))
        self.assertIsNone(self.fake.device(THEIRS))

    def test_pause_for_a_created_link(self):
        link, _ = self.created()
        r = self.delete(prtg="pause")
        [res] = r.json()["prtg"]
        self.assertEqual(res["action"], "pause")
        self.assertIn(self.fake.device(int(link.objid))["status_raw"], PAUSED)
        self.assertIn("[Danbyte]", self.fake.device(int(link.objid))["message_raw"])

    def test_a_vm(self):
        vm = self.vm()
        PrtgDeviceLink.objects.create(tenant=self.tenant, connection=self.conn,
                                      virtual_machine=vm, objid=str(THEIRS), name="srv")
        r = self.delete(vm, prtg="pause")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn(self.fake.device(THEIRS)["status_raw"], PAUSED)
        self.assertFalse(VirtualMachine.objects.filter(pk=vm.pk).exists())

    def test_prtg_failure_still_deletes_and_is_journaled(self):
        self.link(self.dev, 999999)  # PRTG has no such device
        r = self.delete(prtg="pause")
        self.assertEqual(r.status_code, 200, r.content)
        [res] = r.json()["prtg"]
        self.assertFalse(res["ok"])
        self.assertFalse(Device.objects.filter(pk=self.dev.pk).exists())
        self.assertTrue(JournalEntry.objects.filter(
            object_type="core.tenant", kind="warning",
            comments__contains="PRTG cleanup").exists())

    def test_unreachable_prtg_queues_the_rest(self):
        self.link(self.dev, THEIRS)
        with mock.patch("prtg.retire._do", side_effect=PrtgUnreachable("timed out")), \
                mock.patch("prtg.retire.queue", side_effect=_queued) as q:
            r = self.delete(prtg="pause")
        self.assertTrue(r.json()["prtg"][0]["queued"])
        q.assert_called_once()
        self.assertFalse(Device.objects.filter(pk=self.dev.pk).exists())
        # The job runs from the plain data once the device is gone.
        out = retire.run_delete_cleanup(q.call_args.args[0])
        self.assertEqual(out, {"done": 1, "failed": 0})
        self.assertIn(self.fake.device(THEIRS)["status_raw"], PAUSED)

    def test_bad_mode_and_no_permission(self):
        self.link(self.dev, THEIRS)
        self.assertEqual(self.delete(prtg="nuke").status_code, 400)
        user = get_user_model().objects.create_user("deleter")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="d", object_types=["device"], actions=["view", "delete"]
        )
        perm.tenants.set([self.tenant])
        perm.users.set([user])
        self.login(user)
        self.assertEqual(self.delete(prtg="pause").status_code, 403)
        self.assertNotIn(self.fake.device(THEIRS)["status_raw"], PAUSED)
        self.assertTrue(Device.objects.filter(pk=self.dev.pk).exists())
        self.assertEqual(self.delete().status_code, 204)

    def test_link_carries_the_connection_default(self):
        self.link(self.dev, THEIRS)
        self.conn.delete_default_remove = True
        self.conn.save()
        [row] = self.api.get(f"/api/prtg/links/?device={self.dev.id}").json()["results"]
        self.assertTrue(row["delete_default_remove"])
        self.assertFalse(row["created_here"])


class BulkDeleteTests(_Retire):
    def bulk(self, ids, **body):
        return self.api.post("/api/devices/bulk-delete/", {"ids": ids, **body},
                             format="json")

    def test_dry_run_counts_links_and_deletes_with_cleanup(self):
        link, _ = self.created()
        other = self.device("edge-02", "10.0.0.78")
        self.link(other, THEIRS)
        ids = [str(self.dev.id), str(other.id)]
        dry = self.bulk(ids, dry_run=True)
        self.assertEqual(dry.status_code, 200, dry.content)
        self.assertEqual(dry.json()["prtg"], {"linked": 2, "created": 1, "other": 1,
                                              "default_remove": False})
        r = self.bulk(ids, prtg="remove")
        self.assertEqual(r.json()["deleted"], 2)
        actions = sorted(x["action"] for x in r.json()["prtg_results"])
        self.assertEqual(actions, ["pause", "remove"])
        self.assertIsNone(self.fake.device(int(link.objid)))
        self.assertIn(self.fake.device(THEIRS)["status_raw"], PAUSED)
        self.assertFalse(Device.objects.filter(pk__in=ids).exists())

    def test_keep_and_vms(self):
        self.link(self.dev, THEIRS)
        r = self.bulk([str(self.dev.id)])
        self.assertEqual((r.json()["deleted"], r.json()["prtg_results"]), (1, []))
        self.assertNotIn(self.fake.device(THEIRS)["status_raw"], PAUSED)
        vm = self.vm()
        r = self.api.post("/api/virtual-machines/bulk-delete/",
                          {"ids": [str(vm.id)], "prtg": "pause"}, format="json")
        self.assertEqual(r.json()["deleted"], 1, r.content)

    def test_many_links_go_to_the_job(self):
        devs = [self.device(f"d{i}") for i in range(retire.INLINE_LINKS + 1)]
        for i, d in enumerate(devs):
            PrtgDeviceLink.objects.create(tenant=self.tenant, connection=self.conn,
                                          device=d, objid=str(5000 + i), name=d.name)
        with mock.patch("prtg.retire.queue", side_effect=_queued) as q:
            r = self.bulk([str(d.id) for d in devs], prtg="pause")
        self.assertTrue(all(x["queued"] for x in r.json()["prtg_results"]))
        self.assertEqual(len(q.call_args.args[0]), len(devs))

    def test_another_tenants_rows_and_links_are_out_of_reach(self):
        org = Organization.objects.create(name="P", slug="p")
        other = Tenant.objects.create(org=org, name="U", slug="u")
        IntegrationSettings.objects.update_or_create(
            tenant=other, defaults={"prtg_enabled": True})
        fconn = PrtgConnection.objects.create(tenant=other, name="f", url=self.fake.url,
                                              credentials={"api_key": self.fake.api_key})
        fdev = Device.objects.create(tenant=other, name="theirs")
        PrtgDeviceLink.objects.create(tenant=other, connection=fconn, device=fdev,
                                      objid=str(THEIRS))
        r = self.bulk([str(fdev.id)], prtg="remove", prtg_force=True)
        self.assertEqual(r.json()["deleted"], 0)
        self.assertIsNotNone(self.fake.device(THEIRS))
        self.assertTrue(Device.objects.filter(pk=fdev.pk).exists())
        r = self.api.delete(f"/api/devices/{fdev.id}/?prtg=remove&prtg_force=1")
        self.assertEqual(r.status_code, 404)
        self.assertIsNotNone(self.fake.device(THEIRS))


# ── retirement rules ─────────────────────────────────────────────────────────


class RuleMatchTests(_Retire):
    def test_status_tag_and_both(self):
        tag = Tag.objects.create(tenant=self.tenant, name="Decom", slug="decom")
        by_status = self.rule()
        by_tag = self.rule("Tagged", statuses=[], tags=["decom"])
        both = self.rule("Both", statuses=["retired"], tags=["decom"])
        empty = PrtgRetireRule(tenant=self.tenant, connection=self.conn, name="x")
        dev = Device.objects.get(pk=self.dev.pk)
        self.assertFalse(retire.rule_matches(by_status, dev, set()))
        self.retire_dev()
        dev = Device.objects.get(pk=self.dev.pk)
        self.assertTrue(retire.rule_matches(by_status, dev, set()))
        self.assertFalse(retire.rule_matches(by_tag, dev, set()))
        self.assertFalse(retire.rule_matches(both, dev, set()))
        self.dev.tags.add(tag)
        self.assertTrue(retire.rule_matches(by_tag, dev, {"decom"}))
        self.assertTrue(retire.rule_matches(both, dev, {"decom"}))
        self.assertFalse(retire.rule_matches(empty, dev, {"decom"}))
        # First by position wins.
        self.assertEqual(retire.first_rule([by_tag, by_status], dev, {"decom"}), by_tag)

    def test_another_tenants_rule_never_matches(self):
        org = Organization.objects.create(name="P", slug="p")
        other = Tenant.objects.create(org=org, name="U", slug="u")
        fconn = PrtgConnection.objects.create(tenant=other, name="f", url=self.fake.url)
        rule = PrtgRetireRule.objects.create(tenant=other, connection=fconn, name="r",
                                             statuses=["retired"])
        self.retire_dev()
        self.assertFalse(retire.rule_matches(rule, Device.objects.get(pk=self.dev.pk), set()))


class RulePlanTests(_Retire):
    def test_pause_then_resume(self):
        link, _ = self.created()
        self.rule()
        self.retire_dev(self.decom)
        self.assertEqual(self.plan()["pause"], 0)
        self.retire_dev()
        self.assertEqual(self.plan()["pause"], 1)
        [row] = self.rows(PrtgChange.PAUSE_DEVICE)
        self.assertIn("Matches rule Retired (status Retired)", row.detail["reason"])
        self.assertTrue(writer.ready(row))
        # Registration is not planned for a retiring object.
        self.assertFalse(self.rows(PrtgChange.ADD_SENSOR))
        writer.apply(row)
        link.refresh_from_db()
        self.assertEqual(link.rule_paused_name, "Retired")
        self.assertIsNotNone(link.rule_paused_at)
        self.assertIn(self.fake.device(int(link.objid))["status_raw"], PAUSED)
        self.assertEqual(self.read()["plan"]["pause"], 0)
        # Active again: resumed.
        self.dev.status = None
        self.dev.save()
        self.assertEqual(self.plan()["resume"], 1)
        [row] = self.rows(PrtgChange.RESUME_DEVICE)
        writer.apply(row)
        link.refresh_from_db()
        self.assertIsNone(link.rule_paused_at)
        self.assertNotIn(self.fake.device(int(link.objid))["status_raw"], PAUSED)
        self.assertEqual(self.plan()["resume"], 0)

    def test_resume_leaves_somebody_elses_pause(self):
        link, _ = self.created()
        self.rule()
        self.retire_dev()
        self.plan()
        writer.apply(self.rows(PrtgChange.PAUSE_DEVICE)[0])
        self.fake.set_status(int(link.objid), 7, "Paused by a person")
        self.dev.status = None
        self.dev.save()
        self.plan()
        out = writer.apply(self.rows(PrtgChange.RESUME_DEVICE)[0])
        self.assertIn("Left", out["detail"])
        self.assertIn(self.fake.device(int(link.objid))["status_raw"], PAUSED)

    def test_a_device_paused_by_hand_is_not_claimed(self):
        link = self.link(self.dev, THEIRS)
        link.status_raw = 7
        link.save()
        self.rule()
        self.retire_dev()
        self.assertEqual(self.plan()["pause"], 0)

    def test_nothing_stops_later_rules(self):
        self.created()
        self.rule("Keep", action=PrtgRetireRule.NOTHING, position=0)
        self.rule("Pause", position=1)
        self.retire_dev()
        self.assertEqual(self.plan()["pause"], 0)

    def test_excluded_objects_still_retire(self):
        self.created()
        self.rule()
        self.dev.prtg_sync = "never"
        self.retire_dev()
        self.conn.prune_devices = True
        self.conn.save()
        counts = self.plan()
        # The rule decides; pruning does not also propose a removal.
        self.assertEqual((counts["pause"], counts["remove_device"]), (1, 0))

    def test_delete_only_where_allowed(self):
        self.link(self.dev, THEIRS)
        rule = self.rule(action=PrtgRetireRule.DELETE, allow_auto=True)
        self.retire_dev()
        self.plan()
        [row] = self.rows(PrtgChange.REMOVE_DEVICE)
        self.assertFalse(row.detail["applicable"])
        self.assertFalse(writer.ready(row))
        self.assertIn("did not create", row.detail["reason"])
        with self.assertRaises(writer.Refused):
            writer.apply(row)
        rule.delete_any = True
        rule.save()
        self.plan()
        [row] = self.rows(PrtgChange.REMOVE_DEVICE)
        self.assertTrue(row.detail["applicable"] and row.detail["auto"])
        writer.apply(row)
        self.assertIsNone(self.fake.device(THEIRS))
        self.assertFalse(PrtgDeviceLink.objects.filter(device=self.dev).exists())

    def test_delete_any_must_still_be_on_at_apply(self):
        self.link(self.dev, THEIRS)
        rule = self.rule(action=PrtgRetireRule.DELETE, delete_any=True)
        self.retire_dev()
        self.plan()
        rule.delete_any = False
        rule.save()
        with self.assertRaises(writer.Refused):
            writer.apply(self.rows(PrtgChange.REMOVE_DEVICE)[0])
        self.assertIsNotNone(self.fake.device(THEIRS))

    def test_auto_apply_honours_allow_auto(self):
        link, _ = self.created()
        rule = self.rule(action=PrtgRetireRule.DELETE)
        self.retire_dev()
        self.plan()
        [row] = self.rows(PrtgChange.REMOVE_DEVICE)
        self.assertFalse(writer.ready(row))
        self.assertEqual(writer.apply_ready(self.conn)["applied"], 0)
        self.assertIsNotNone(self.fake.device(int(link.objid)))
        rule.allow_auto = True
        rule.save()
        self.plan()
        self.assertEqual(writer.apply_ready(self.conn)["applied"], 1)
        self.assertIsNone(self.fake.device(int(link.objid)))

    def test_auto_rows_wait_when_the_rule_changed_after_the_plan(self):
        link, _ = self.created()
        rule = self.rule(action=PrtgRetireRule.DELETE, allow_auto=True)
        self.retire_dev()
        self.plan()
        rule.allow_auto = False
        rule.save()
        self.assertEqual(writer.apply_ready(self.conn)["applied"], 0)
        self.assertIsNotNone(self.fake.device(int(link.objid)))

    def test_maintenance_leaves_a_rule_pause_alone(self):
        from prtg.maintenance import reconcile

        link, _ = self.created()
        self.rule()
        self.retire_dev()
        self.plan()
        writer.apply(self.rows(PrtgChange.PAUSE_DEVICE)[0])
        self.conn.sync_maintenance = True
        self.conn.save()
        counts = reconcile(self.conn)
        self.assertEqual(counts["resumed"], 0)
        self.assertIn(self.fake.device(int(link.objid))["status_raw"], PAUSED)


class RuleApiTests(_Retire):
    URL = "/api/prtg/retire-rules/"

    def test_crud_and_validation(self):
        r = self.api.post(self.URL, {"connection": str(self.conn.id), "name": "Retired",
                                     "statuses": ["retired"], "action": "pause",
                                     "allow_auto": True, "delete_any": True},
                          format="json")
        self.assertEqual(r.status_code, 201, r.content)
        # Only a delete is automatic or reaches other devices.
        self.assertFalse(r.json()["allow_auto"] or r.json()["delete_any"])
        r = self.api.post(self.URL, {"connection": str(self.conn.id), "name": "x",
                                     "statuses": [], "tags": []}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("statuses", r.json())
        listed = self.api.get(f"{self.URL}?connection={self.conn.id}").json()["results"]
        self.assertEqual([x["name"] for x in listed], ["Retired"])

    def test_tenant_isolation(self):
        org = Organization.objects.create(name="P", slug="p")
        other = Tenant.objects.create(org=org, name="U", slug="u")
        fconn = PrtgConnection.objects.create(tenant=other, name="f", url=self.fake.url)
        foreign = PrtgRetireRule.objects.create(tenant=other, connection=fconn, name="r",
                                                statuses=["retired"])
        self.assertEqual(self.api.get(f"{self.URL}{foreign.id}/").status_code, 404)
        r = self.api.post(self.URL, {"connection": str(fconn.id), "name": "x",
                                     "statuses": ["retired"]}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.api.get(self.URL).json()["count"], 0)
