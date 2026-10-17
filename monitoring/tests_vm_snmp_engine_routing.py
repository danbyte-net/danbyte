"""Where a virtual machine's SNMP poll runs (#325).

A VM is an SNMP target like a device (``snmp_target.SnmpTarget``) and goes
through the same engine resolution and the same poll path: its site - else its
cluster's site - then the tenant default. Poll now on an Outpost-bound VM
queues there, the Outpost's work list carries it, its results ingest onto the
VM's row, and the core's scheduled poller and ``poll_snmp`` leave it alone.
Unbound VMs, and VMs bound to a disabled Outpost, poll from the core.
"""
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    IPAddress,
    Platform,
    Prefix,
    Site,
    VirtualMachine,
)
from core.models import Organization, Tenant
from monitoring import snmp_schedule
from monitoring.engines import (
    engine_for_target,
    engines_for_targets,
    set_binding,
    targets_for_engine,
)
from monitoring.models import (
    DeviceSnmp,
    MonitoringEngine,
    MonitoringSettings,
    SnmpProfile,
    SnmpProfileBinding,
)
from monitoring.snmp_target import DEVICE, VM, SnmpTarget

User = get_user_model()

TOKEN = "vm-route-tok"


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
        self.hq = Site.objects.create(tenant=self.tenant, name="hq")
        self.outpost = MonitoringEngine.objects.create(
            tenant=self.tenant, name="branch-op", slug="branch-op",
            kind="remote", transport="pull", token={"secret": TOKEN},
        )
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.9.2.0/24")
        self.profile = SnmpProfile.objects.create(
            tenant=self.tenant, name="v2", slug="v2", version="v2c", is_default=True,
        )
        ct = ClusterType.objects.create(tenant=self.tenant, name="ESXi", slug="esxi")
        self.cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct)

    def _ip(self):
        self._n = getattr(self, "_n", 0) + 1
        return IPAddress.objects.create(
            tenant=self.tenant, ip_address=f"10.9.2.{self._n}", prefix=self.prefix,
        )

    def _vm(self, name, *, polled=True, **kw):
        kw.setdefault("cluster", self.cluster)
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name=name, primary_ip=self._ip(), **kw
        )
        if polled:
            # An observed row makes a VM an SNMP target (snmp_target.candidates).
            DeviceSnmp.objects.create(
                tenant=self.tenant, vm=vm,
                polled_at=timezone.now() - timedelta(days=1),
            )
        return vm

    def _device(self, name, **kw):
        return Device.objects.create(
            tenant=self.tenant, name=name, primary_ip=self._ip(), **kw
        )

    def _poll(self, vm):
        return self.client.post(
            f"/api/monitoring/virtual-machines/{vm.id}/snmp-poll/", {}, format="json"
        )

    def _work(self):
        r = self.client.get("/api/outpost/snmp-work/", HTTP_AUTHORIZATION=f"Bearer {TOKEN}")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["devices"]

    def _work_ids(self):
        return {d["device_id"] for d in self._work()}

    def _post_results(self, rows):
        return self.client.post(
            "/api/outpost/snmp/", {"results": rows}, format="json",
            HTTP_AUTHORIZATION=f"Bearer {TOKEN}",
        )

    def _assert_queued(self, vm):
        r = self._poll(vm)
        self.assertEqual(r.status_code, 202, r.content)
        self.assertTrue(r.json()["queued_on_outpost"])
        self.assertEqual(r.json()["engine"], "branch-op")
        self.outpost.refresh_from_db()
        self.assertIsNotNone(self.outpost.snmp_requested_at)
        self.assertIn(str(vm.id), self._work_ids())


class VmPollNowRoutingTests(_Base):
    def test_a_site_binding_routes_poll_now_and_lists_the_vm(self):
        set_binding(self.tenant, "site", self.site.id, self.outpost)
        self._assert_queued(self._vm("chr-site", site=self.site))

    def test_a_vm_without_a_site_follows_its_clusters_site(self):
        self.cluster.site = self.site
        self.cluster.save(update_fields=["site"])
        set_binding(self.tenant, "site", self.site.id, self.outpost)
        self._assert_queued(self._vm("chr-cluster"))

    def test_the_vms_own_site_wins_over_its_clusters(self):
        self.cluster.site = self.site
        self.cluster.save(update_fields=["site"])
        set_binding(self.tenant, "site", self.site.id, self.outpost)
        vm = self._vm("chr-hq", site=self.hq)
        self.assertEqual(engine_for_target(vm).kind, MonitoringEngine.LOCAL)
        self.assertNotIn(str(vm.id), self._work_ids())

    def test_the_tenant_default_outpost_polls_unbound_vms(self):
        s = MonitoringSettings.for_tenant(self.tenant)
        s.default_engine = self.outpost
        s.save()
        self._assert_queued(self._vm("chr-default", site=self.hq))

    def test_the_first_poll_now_puts_a_never_polled_vm_on_the_work_list(self):
        set_binding(self.tenant, "site", self.site.id, self.outpost)
        vm = self._vm("chr-new", site=self.site, polled=False)
        self.assertNotIn(str(vm.id), self._work_ids())
        self._assert_queued(vm)
        row = DeviceSnmp.objects.get(vm=vm)
        self.assertIsNone(row.polled_at)
        self.assertEqual(row.profile_id, self.profile.id)

    def test_a_queued_vm_without_an_address_is_a_400(self):
        set_binding(self.tenant, "site", self.site.id, self.outpost)
        vm = self._vm("chr-noip", site=self.site, polled=False)
        vm.primary_ip = None
        vm.save(update_fields=["primary_ip"])
        r = self._poll(vm)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("primary IP", r.json()["detail"])
        self.assertFalse(DeviceSnmp.objects.filter(vm=vm).exists())

    def test_an_unbound_vm_polls_from_the_core(self):
        vm = self._vm("chr-core", site=self.hq)
        with patch("monitoring.views.poll_target") as poll:
            poll.return_value = (None, "no_target")
            r = self._poll(vm)
        self.assertEqual(r.status_code, 400, r.content)
        poll.assert_called_once()
        self.assertEqual(poll.call_args.args[0].key, (VM, vm.id))
        self.assertEqual(self._work_ids(), set())

    def test_a_disabled_outpost_falls_back_to_the_core(self):
        set_binding(self.tenant, "site", self.site.id, self.outpost)
        self.outpost.enabled = False
        self.outpost.save(update_fields=["enabled"])
        vm = self._vm("chr-off", site=self.site)
        with patch("monitoring.views.poll_target") as poll:
            poll.return_value = (None, "no_target")
            r = self._poll(vm)
        self.assertEqual(r.status_code, 400, r.content)
        poll.assert_called_once()


class VmPollWhereTests(_Base):
    """The VM's SNMP card says where Poll now runs, as a device's does."""

    def _where(self, vm):
        r = self.client.get(f"/api/monitoring/virtual-machines/{vm.id}/snmp/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["poll_outpost"]

    def test_an_outpost_vm_names_its_outpost(self):
        set_binding(self.tenant, "site", self.site.id, self.outpost)
        self.assertEqual(self._where(self._vm("chr-op", site=self.site)), "branch-op")
        self.assertEqual(
            self._where(self._vm("chr-op-new", site=self.site, polled=False)), "branch-op"
        )

    def test_a_core_vm_reads_null(self):
        self.assertIsNone(self._where(self._vm("chr-core", site=self.hq)))


class VmOutpostWorkAndIngestTests(_Base):
    def setUp(self):
        super().setUp()
        set_binding(self.tenant, "site", self.site.id, self.outpost)

    def test_work_items_keep_the_wire_shape_and_name_their_kind(self):
        vm = self._vm("chr", site=self.site)
        dev = self._device("sw", site=self.site)
        items = {d["device_id"]: d for d in self._work()}
        self.assertEqual(items[str(vm.id)]["kind"], VM)
        self.assertEqual(items[str(dev.id)]["kind"], DEVICE)
        self.assertEqual(items[str(vm.id)]["target"], vm.primary_ip.ip_address)
        for key in ("version", "params", "secret_params", "timeout_ms"):
            self.assertIn(key, items[str(vm.id)])

    def test_a_vm_override_address_is_what_the_outpost_polls(self):
        vm = self._vm("chr", site=self.site)
        SnmpProfileBinding.objects.create(
            tenant=self.tenant, scope="vm", object_id=vm.id, profile=self.profile,
            target="192.0.2.7",
        )
        items = {d["device_id"]: d for d in self._work()}
        self.assertEqual(items[str(vm.id)]["target"], "192.0.2.7")

    def test_an_agent_that_echoes_only_the_id_lands_on_the_vms_row(self):
        vm = self._vm("chr", site=self.site)
        r = self._post_results([{
            "device_id": str(vm.id), "reachable": True,
            "data": {"sys_name": "chr"}, "interfaces": [],
        }])
        self.assertEqual(r.json()["ingested"], 1)
        row = DeviceSnmp.objects.get(vm=vm)
        self.assertTrue(row.reachable)
        self.assertEqual(row.data["sys_name"], "chr")
        self.assertIsNone(row.device_id)

    def test_an_echoed_kind_must_match_the_target(self):
        vm = self._vm("chr", site=self.site)
        r = self._post_results([{
            "device_id": str(vm.id), "kind": "device", "reachable": True,
            "data": {"sys_name": "spoof"},
        }])
        self.assertEqual(r.json()["ingested"], 0)
        r = self._post_results([{
            "device_id": str(vm.id), "kind": "vm", "reachable": True,
            "data": {"sys_name": "chr"},
        }])
        self.assertEqual(r.json()["ingested"], 1)

    def test_a_core_vm_is_not_this_outposts_to_report(self):
        vm = self._vm("chr-hq", site=self.hq)
        r = self._post_results([{
            "device_id": str(vm.id), "reachable": True, "data": {"sys_name": "x"},
        }])
        self.assertEqual(r.json()["ingested"], 0)
        self.assertNotEqual(DeviceSnmp.objects.get(vm=vm).data, {"sys_name": "x"})

    def test_another_tenants_vm_is_never_reported(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        ct = ClusterType.objects.create(tenant=other, name="X", slug="x")
        cl = Cluster.objects.create(tenant=other, name="c", type=ct)
        theirs = VirtualMachine.objects.create(tenant=other, name="theirs", cluster=cl)
        DeviceSnmp.objects.create(tenant=other, vm=theirs)
        s = MonitoringSettings.for_tenant(self.tenant)
        s.default_engine = self.outpost
        s.save()
        self.assertNotIn(str(theirs.id), self._work_ids())
        r = self._post_results([{"device_id": str(theirs.id), "reachable": True}])
        self.assertEqual(r.json()["ingested"], 0)

    def test_a_vm_that_is_no_snmp_target_stays_off_the_work_list(self):
        vm = self._vm("plain", site=self.site, polled=False)
        self.assertNotIn(str(vm.id), self._work_ids())
        # A profile bound on its platform says it runs an agent.
        plat = Platform.objects.create(tenant=self.tenant, name="RouterOS", slug="ros")
        vm.platform = plat
        vm.save(update_fields=["platform"])
        SnmpProfileBinding.objects.create(
            tenant=self.tenant, scope="platform", object_id=plat.id, profile=self.profile,
        )
        self.assertIn(str(vm.id), self._work_ids())


class SharedResolutionTests(_Base):
    def test_batch_matches_the_per_target_walk_for_both_kinds(self):
        other = MonitoringEngine.objects.create(
            tenant=self.tenant, name="other-op", slug="other-op",
            kind="remote", transport="pull", token={"secret": "other-tok"},
        )
        set_binding(self.tenant, "site", self.site.id, self.outpost)
        set_binding(self.tenant, "site", self.hq.id, other)
        hq_cluster = Cluster.objects.create(
            tenant=self.tenant, name="c-hq", type=self.cluster.type, site=self.hq
        )
        self._vm("a", site=self.site)
        self._vm("b", cluster=hq_cluster)
        self._vm("c", site=self.site, cluster=hq_cluster)
        self._vm("d")
        self._device("e", site=self.hq)
        targets = [
            SnmpTarget(VM, v)
            for v in VirtualMachine.objects.filter(tenant=self.tenant).select_related("tenant")
        ] + [
            SnmpTarget(DEVICE, d)
            for d in Device.objects.filter(tenant=self.tenant).select_related("tenant")
        ]
        engines_for_targets(self.tenant, targets[:1])  # creates settings + local
        with CaptureQueriesContext(connection) as ctx:
            batch = engines_for_targets(self.tenant, targets)
        self.assertLessEqual(len(ctx.captured_queries), 5)
        for t in targets:
            self.assertEqual(batch[t.key].id, engine_for_target(t).id, t.obj.name)
        names = {t.obj.name for t in targets_for_engine(other)}
        self.assertEqual(names, {"b", "e"})


class VmScheduledPollTests(_Base):
    def setUp(self):
        super().setUp()
        set_binding(self.tenant, "site", self.site.id, self.outpost)
        self.remote = self._vm("chr-remote", site=self.site)
        self.local = self._vm("chr-local", site=self.hq)
        self.plain = self._vm("not-snmp", site=self.hq, polled=False)

    def test_the_scheduler_leaves_outpost_vms_to_their_outpost(self):
        keys = {t.key for t in snmp_schedule.candidates(self.tenant)}
        self.assertIn((VM, self.local.id), keys)
        self.assertNotIn((VM, self.remote.id), keys)
        self.assertNotIn((VM, self.plain.id), keys)

    def test_dispatch_enqueues_a_due_core_vm_with_its_kind(self):
        MonitoringSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"snmp_poll_interval_minutes": 15}
        )
        jobs = []

        class Queue:
            def enqueue(self, fn, *args, **kw):
                jobs.append(args)

        class Redis:
            def pipeline(self):
                return self

            def exists(self, key):
                return None

            def execute(self):
                return [0, 0] * 10

            def set(self, *a, **kw):
                return True

        with patch("monitoring.snmp_schedule._conn", return_value=Redis()), \
                patch("monitoring.snmp_schedule._queue", return_value=Queue()), \
                patch("monitoring.snmp_schedule.tick_budget", return_value=10):
            snmp_schedule.dispatch()
        self.assertEqual(jobs, [(str(self.local.id), str(self.tenant.id), VM)])

    def test_the_job_polls_a_core_vm_and_leaves_an_outpost_one(self):
        MonitoringSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"snmp_poll_interval_minutes": 15}
        )
        with patch("monitoring.snmp_schedule._conn") as conn, \
                patch("monitoring.mac_jobs._conn", return_value=conn.return_value), \
                patch("monitoring.snmp_poll.poll_target") as poll:
            conn.return_value.set.return_value = True
            poll.return_value = (DeviceSnmp(reachable=True), None)
            self.assertEqual(
                snmp_schedule.poll_scheduled(str(self.local.id), str(self.tenant.id), VM),
                "polled",
            )
            self.assertEqual(poll.call_args.args[0].key, (VM, self.local.id))
            poll.reset_mock()
            self.assertEqual(
                snmp_schedule.poll_scheduled(str(self.remote.id), str(self.tenant.id), VM),
                "remote",
            )
            poll.assert_not_called()
            # A VM id under the old two-argument job is not a device.
            self.assertEqual(
                snmp_schedule.poll_scheduled(str(self.local.id), str(self.tenant.id)),
                "skipped",
            )

    def test_poll_snmp_polls_core_vms_and_skips_outpost_ones(self):
        with patch("monitoring.management.commands.poll_snmp.poll_target") as poll:
            poll.return_value = (None, "no_target")
            call_command("poll_snmp")
        polled = {c.args[0].key for c in poll.call_args_list}
        self.assertIn((VM, self.local.id), polled)
        self.assertNotIn((VM, self.remote.id), polled)
        self.assertNotIn((VM, self.plain.id), polled)

    def test_a_core_vm_poll_writes_its_own_row(self):
        with patch("monitoring.snmp_poll.fetch_for") as fetch:
            fetch.return_value = {"reachable": True, "data": {"sys_name": "chr"}}
            r = self._poll(self.local)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["poll_outpost"])
        self.assertEqual(fetch.call_args.args[0], self.local.primary_ip.ip_address)
        self.assertEqual(DeviceSnmp.objects.get(vm=self.local).data["sys_name"], "chr")
