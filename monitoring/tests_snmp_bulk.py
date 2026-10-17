"""Bulk Poll / Refresh MACs / Sync from the SNMP drift page (#419).

The endpoints queue RQ jobs; these tests hold the queue and Redis in memory
and run the queued jobs by hand, so both halves - the request-time selection
and the job's re-check - are exercised.
"""
from __future__ import annotations

import uuid
from unittest import mock

from api.models import Device, Interface, VirtualChassis
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission
from core.models import Organization, Tenant
from monitoring import snmp_bulk
from monitoring.mac_jobs import lock_key
from monitoring.models import DeviceSnmp, MonitoringEngine, SnmpProfile
from monitoring.tests_mac_sightings import (
    ACC_IFACES,
    CORE_IFACES,
    FakeQueue,
    FakeRedis,
    _Base,
    acc_fdb,
    iface_row,
    result,
)


class BulkRedis(FakeRedis):
    def hincrby(self, key, field, n):
        h = self.hashes.setdefault(key, {})
        k = field.encode()
        h[k] = str(int(h.get(k, b"0")) + n).encode()


class _BulkBase(_Base):
    def setUp(self):
        super().setUp()
        for dev, addr in ((self.acc, "10.10.0.3"), (self.core, "10.10.0.4")):
            Device.objects.filter(pk=dev.pk).update(primary_ip=self.ip(addr))
            dev.refresh_from_db()
        SnmpProfile.objects.create(tenant=self.tenant, name="p", slug="p", is_default=True,
                                   secret_params={"community": "public"})
        self.redis, self.queue = BulkRedis(), FakeQueue()
        self.modes = []
        for p in (
            mock.patch("monitoring.snmp_bulk._conn", return_value=self.redis),
            mock.patch("monitoring.snmp_bulk._queue", return_value=self.queue),
            mock.patch("monitoring.mac_jobs._conn", return_value=self.redis),
            mock.patch("monitoring.snmp_poll.fetch_snmp", side_effect=self.fetch),
        ):
            p.start()
            self.addCleanup(p.stop)

    def fetch(self, target, version, params, secret_params, timeout_ms, mac_mode="full"):
        self.modes.append((target, mac_mode))
        if target == "10.10.0.4":
            return result(CORE_IFACES)
        return result(ACC_IFACES, acc_fdb())

    def bulk(self, action, devices):
        path = {"poll": "bulk-poll", "macs": "bulk-mac-refresh", "sync": "bulk-sync"}[action]
        return self.client.post(
            f"/api/monitoring/snmp-drift/{path}/",
            {"devices": [str(getattr(d, "id", d)) for d in devices]},
            format="json",
        )

    def run_jobs(self):
        jobs, self.queue.jobs = self.queue.jobs, []
        return [fn(*args) for fn, args in jobs]

    def status(self, run_id):
        return self.client.get(f"/api/monitoring/snmp-drift/bulk-runs/{run_id}/").json()

    def queued_ids(self):
        return [i for _fn, args in self.queue.jobs for i in args[4]]


class BulkPollTests(_BulkBase):
    def test_poll_queues_one_job_per_device_and_reads_quick(self):
        r = self.bulk("poll", [self.acc, self.core])
        self.assertEqual(r.status_code, 202, r.content)
        body = r.json()
        self.assertEqual((body["requested"], body["queued"], body["skipped"]), (2, 2, 0))
        self.assertEqual(len(self.queue.jobs), 2)
        run = self.status(body["run_id"])
        self.assertEqual((run["done"], run["total"], run["processed"]), (False, 2, 0))

        self.run_jobs()
        self.assertEqual(sorted(m for _t, m in self.modes), ["quick", "quick"])
        run = self.status(body["run_id"])
        self.assertTrue(run["done"])
        self.assertEqual(run["counts"]["ok"], 2)
        self.assertTrue(DeviceSnmp.objects.filter(device=self.core, reachable=True).exists())
        self.assertEqual(self.redis.kv, {})  # single-flight keys released

    def test_refresh_macs_reads_the_whole_table(self):
        r = self.bulk("macs", [self.acc])
        self.assertEqual(r.status_code, 202, r.content)
        self.run_jobs()
        self.assertEqual(self.modes, [("10.10.0.3", "full")])
        self.assertEqual(self.status(r.json()["run_id"])["action"], "macs")

    def test_a_device_being_read_is_busy_not_read_twice(self):
        self.redis.set(lock_key(self.acc.id), "other-run")
        run_id = self.bulk("poll", [self.acc]).json()["run_id"]
        self.run_jobs()
        self.assertEqual(self.modes, [])
        self.assertEqual(self.status(run_id)["counts"]["busy"], 1)

    def test_a_stack_is_polled_once_through_its_owner(self):
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        Device.objects.filter(pk=self.acc.pk).update(virtual_chassis=vc, vc_position=1)
        member = Device.objects.create(tenant=self.tenant, name="sw-acc-03-2",
                                       site=self.site_a, virtual_chassis=vc, vc_position=2)
        vc.master = self.acc
        vc.save()
        r = self.bulk("poll", [member, self.acc])
        self.assertEqual(r.json()["queued"], 1)
        self.assertEqual(self.queued_ids(), [str(self.acc.id)])

    def test_an_outpost_device_goes_to_its_outpost_once(self):
        from monitoring.engines import set_binding

        engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="branch", slug="branch", kind="remote",
            transport="pull", token={"secret": "s"},
        )
        set_binding(self.tenant, "site", self.site_b.id, engine)
        Device.objects.filter(pk__in=[self.acc.pk, self.gw.pk]).update(site=self.site_b)
        r = self.bulk("poll", [self.acc, self.gw, self.core])
        self.assertEqual(r.status_code, 202, r.content)
        body = r.json()
        self.assertEqual(body["queued"], 1)
        self.assertEqual(body["outposts"], [{"name": "branch", "devices": 2, "stale": False}])
        self.assertEqual(self.queued_ids(), [str(self.core.id)])
        engine.refresh_from_db()
        self.assertIsNotNone(engine.snmp_requested_at)

    def test_all_on_outposts_answers_without_a_run(self):
        from monitoring.engines import set_binding

        engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="branch", slug="branch", kind="remote",
            transport="pull", token={"secret": "s"},
        )
        set_binding(self.tenant, "site", self.site_a.id, engine)
        r = self.bulk("macs", [self.acc])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["run_id"])
        self.assertEqual(self.queue.jobs, [])

    def test_without_redis_it_says_so(self):
        with mock.patch("monitoring.snmp_bulk._conn", side_effect=ConnectionError("down")):
            r = self.bulk("poll", [self.acc])
        self.assertEqual(r.status_code, 503)


class BulkScopeTests(_BulkBase):
    def test_bulk_needs_device_change(self):
        self.login(self.user_with(["device"]))
        for action in ("poll", "macs", "sync"):
            with self.subTest(action=action):
                self.assertEqual(self.bulk(action, [self.acc]).status_code, 403)
        self.assertEqual(self.queue.jobs, [])

    def test_a_site_scoped_grant_only_reaches_its_sites(self):
        Device.objects.filter(pk=self.core.pk).update(site=self.site_b)
        self.login(self.user_with(["device"], actions=("view", "change"), sites=[self.site_a]))
        for action in ("poll", "macs", "sync"):
            with self.subTest(action=action):
                r = self.bulk(action, [self.acc, self.core])
                self.assertEqual(r.status_code, 202, r.content)
                self.assertEqual((r.json()["queued"], r.json()["skipped"]), (1, 1))
                self.assertEqual(self.queued_ids(), [str(self.acc.id)])
                self.queue.jobs = []

    def test_another_tenants_device_is_skipped(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        theirs = Device.objects.create(tenant=other, name="theirs")
        for action in ("poll", "sync"):
            with self.subTest(action=action):
                r = self.bulk(action, [theirs, self.acc])
                self.assertEqual((r.json()["queued"], r.json()["skipped"]), (1, 1))
                self.assertEqual(self.queued_ids(), [str(self.acc.id)])
                self.queue.jobs = []
        # Even a job that names it by hand finds nothing.
        run_id = snmp_bulk.start("poll", self.tenant, self.admin, [theirs])
        self.run_jobs()
        self.assertEqual(self.status(run_id)["counts"]["denied"], 1)
        self.assertEqual(self.modes, [])

    def test_the_job_checks_the_grant_again(self):
        changer = self.user_with(["device"], actions=("view", "change"))
        self.login(changer)
        r = self.bulk("sync", [self.acc])
        self.assertEqual(r.status_code, 202)
        ObjectPermission.objects.filter(users=changer).delete()  # revoked after the click
        self.run_jobs()
        self.assertEqual(self.status(r.json()["run_id"])["counts"]["denied"], 1)

    def test_bad_bodies_and_the_cap(self):
        cases = [
            {},
            {"devices": []},
            {"devices": "x"},
            {"devices": ["not-an-id"]},
            {"devices": [str(uuid.uuid4()) for _ in range(snmp_bulk.MAX_DEVICES + 1)]},
        ]
        for body in cases:
            with self.subTest(n=len(body.get("devices") or [])):
                r = self.client.post("/api/monitoring/snmp-drift/bulk-poll/", body,
                                     format="json")
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn("devices", r.json())
        self.assertEqual(self.queue.jobs, [])

    def test_sync_runs_in_chunks(self):
        extra = [
            Device.objects.create(tenant=self.tenant, name=f"sw-{i}", site=self.site_a)
            for i in range(snmp_bulk.CHUNK["sync"] + 5)
        ]
        r = self.bulk("sync", extra)
        self.assertEqual(r.json()["queued"], len(extra))
        self.assertEqual([len(args[4]) for _fn, args in self.queue.jobs],
                         [snmp_bulk.CHUNK["sync"], 5])

    def test_a_run_is_only_its_owners(self):
        run_id = self.bulk("poll", [self.acc]).json()["run_id"]
        self.login(self.user_with(["device"], actions=("view", "change")))
        self.assertEqual(self.status(run_id), {"run_id": run_id, "found": False, "done": True})
        org = Organization.objects.create(name="X", slug="x")
        other = Tenant.objects.create(org=org, name="X", slug="x")
        self.login(self.admin, tenant=other)
        self.assertFalse(self.status(run_id)["found"])
        self.login(self.admin)
        self.assertFalse(self.status("nope")["found"])
        self.assertTrue(self.status(run_id)["found"])


class BulkSyncTests(_BulkBase):
    def test_sync_applies_the_observation_under_the_callers_name(self):
        self.poll(self.acc, result([*ACC_IFACES, iface_row(10111, "Gi1/0/11")], acc_fdb()))
        r = self.bulk("sync", [self.acc, self.core])
        self.assertEqual(r.status_code, 202, r.content)
        run_id = r.json()["run_id"]
        self.run_jobs()
        created = Interface.objects.get(device=self.acc, name="Gi1/0/11")
        run = self.status(run_id)
        self.assertTrue(run["done"])
        # The core was never polled: nothing to apply, and it says so.
        self.assertEqual((run["counts"]["ok"], run["counts"]["unreachable"]), (1, 1))
        self.assertGreaterEqual(run["sync"]["interfaces_created"], 1)
        entry = ChangeLogEntry.objects.filter(object_id=str(created.id)).first()
        self.assertIsNotNone(entry)
        self.assertEqual(entry.user_id, self.admin.id)
        self.assertEqual(entry.request_id, run_id)
        # The device record itself is left alone, as the single Sync does.
        self.acc.refresh_from_db()
        self.assertEqual(self.acc.name, "sw-acc-03")

    def test_sync_never_polls(self):
        self.poll(self.acc, result(ACC_IFACES, acc_fdb()))
        self.bulk("sync", [self.acc])
        self.run_jobs()
        self.assertEqual(self.modes, [])
