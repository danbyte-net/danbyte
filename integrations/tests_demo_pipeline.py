"""The opt-in demo pipeline (``seed_pipeline_demo``): idempotent seeding, and
both demo scripts really running in the sandbox against a live API."""
from __future__ import annotations

import json
import tempfile
from io import StringIO
from unittest import mock

from django.contrib.auth.models import User
from django.core.management import call_command
from django.test import LiveServerTestCase, TestCase, override_settings

from api.models import (
    Cable,
    CableTermination,
    Device,
    DeviceRole,
    DeviceType,
    Interface,
    IPAddress,
    Manufacturer,
    Platform,
    Prefix,
    Site,
)
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from integrations import demo_pipeline as D
from integrations import pipelines as P
from integrations.models import AutomationTarget, DeployPipeline, DeployRun
from scripting.models import Script


def _seed_counts(tenant):
    return (
        Script.objects.filter(tenant=tenant).count(),
        AutomationTarget.objects.filter(tenant=tenant).count(),
        DeployPipeline.objects.filter(tenant=tenant).count(),
        DeployPipeline.objects.get(tenant=tenant, name=D.PIPELINE).steps.count(),
    )


class SeedTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="U", slug="u")

    def test_seeds_once_and_updates_in_place(self):
        call_command("seed_pipeline_demo", tenant="t", stdout=StringIO())
        self.assertEqual(_seed_counts(self.tenant), (2, 3, 1, 2))
        p = DeployPipeline.objects.get(tenant=self.tenant, name=D.PIPELINE)
        self.assertTrue(p.enabled)
        self.assertFalse(p.auto_on_change)
        self.assertEqual(p.object_types, ["device"])
        self.assertEqual(p.roles.count(), 0)
        steps = list(p.steps.order_by("order"))
        self.assertEqual([s.target.name for s in steps], [D.VNETS_TARGET, D.CHECK_TARGET])
        self.assertTrue(all(s.stop_on_failure for s in steps))
        hook = AutomationTarget.objects.get(tenant=self.tenant, name=D.WEBHOOK_TARGET)
        self.assertFalse(hook.enabled)
        self.assertFalse(hook.pipeline_steps.exists())
        for s in Script.objects.filter(tenant=self.tenant):
            self.assertFalse(s.trusted)
            self.assertEqual(s.token_scope, "read")
            self.assertIn("device_ids", [x["name"] for x in s.params_schema])

        # Edits are put back (code, steps) or kept (switches).
        script = Script.objects.get(tenant=self.tenant, name=D.VNETS_SCRIPT)
        script.source = "print('edited')"
        script.save()
        t = AutomationTarget.objects.get(tenant=self.tenant, name=D.VNETS_TARGET)
        t.extra_vars = {"vnet_pattern": "c{n:04}"}
        t.save()
        steps[1].delete()
        call_command("seed_pipeline_demo", tenant="t", stdout=StringIO())
        self.assertEqual(_seed_counts(self.tenant), (2, 3, 1, 2))
        script.refresh_from_db()
        self.assertEqual(script.source, D.VNETS_SOURCE)
        t.refresh_from_db()
        self.assertEqual(t.extra_vars, {"vnet_pattern": "c{n:04}"})
        # Nothing reaches another tenant.
        self.assertFalse(Script.objects.filter(tenant=self.other).exists())
        self.assertFalse(AutomationTarget.objects.filter(tenant=self.other).exists())

    def test_unknown_tenant(self):
        from django.core.management.base import CommandError

        with self.assertRaises(CommandError):
            call_command("seed_pipeline_demo", tenant="nope", stdout=StringIO())


class DemoRunTests(LiveServerTestCase):
    """The pipeline runs for real: each script step is a sandboxed child that
    reads the data through the live API with its run token."""

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        # A TransactionTestCase flushes everything, the seeded RBAC groups too.
        from auth_api.builtin_groups import ensure_builtin_groups

        ensure_builtin_groups()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        o = override_settings(MEDIA_ROOT=self.tmp.name,
                              DANBYTE_INTERNAL_URL=self.live_server_url)
        o.enable()
        self.addCleanup(o.disable)
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.op = User.objects.create_user("op", password="x")
        prof = UserProfile.objects.create(user=self.op, role="custom")
        prof.tenants.add(self.tenant)
        prof.current_tenant = self.tenant
        prof.save()
        for slug, acts in (
            ("device", ["view"]), ("interface", ["view"]), ("cable", ["view"]),
            ("script", ["view", "run"]), ("scriptrun", ["view"]),
            ("deploypipeline", ["view"]), ("deploypipelinerun", ["view"]),
            ("automationtarget", ["view"]),
        ):
            p = ObjectPermission.objects.create(
                name=f"op-{slug}", object_types=[slug], actions=acts, enabled=True,
            )
            p.users.add(self.op)
            p.tenants.add(self.tenant)

        t = self.tenant
        site = Site.objects.create(tenant=t, name="AMS")
        mfr = Manufacturer.objects.create(tenant=t, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=t, manufacturer=mfr, model="X")
        role = DeviceRole.objects.create(tenant=t, name="Router", slug="router")
        plat = Platform.objects.create(tenant=t, name="IOS", slug="ios")
        pfx = Prefix.objects.create(tenant=t, cidr="10.0.0.0/24", status=status_for(t))
        ip = IPAddress.objects.create(tenant=t, ip_address="10.0.0.5", prefix=pfx)
        self.r1 = Device.objects.create(tenant=t, name="r1", device_type=dt, site=site,
                                        role=role, platform=plat, primary_ip=ip)
        self.sw1 = Device.objects.create(tenant=t, name="sw1", device_type=dt, site=site,
                                         role=role)
        self.cable(("r1", "gi1"), ("sw1", "ge1"), vnet="c0001", label="C1")

        D.seed(t)
        self.pipeline = DeployPipeline.objects.get(tenant=t, name=D.PIPELINE)

        from scripting.runner import run_script

        patches = [
            # Run each script at once, in this process, instead of on RQ.
            mock.patch("scripting.runner.enqueue", side_effect=lambda sr: run_script(str(sr.id))),
            mock.patch("django_rq.get_queue", side_effect=RuntimeError("no redis")),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def cable(self, a, b, vnet="", label=""):
        devs = {"r1": self.r1, "sw1": self.sw1}
        c = Cable.objects.create(tenant=self.tenant, pve_vnet=vnet, label=label)
        for end, (dev, name) in (("A", a), ("B", b)):
            iface = Interface.objects.get_or_create(device=devs[dev], name=name)[0]
            CableTermination.objects.create(cable=c, end=end, interface=iface)
        return c

    def run_pipeline(self, device, **kw):
        run = P.start(self.pipeline, [device.id], user=self.op, **kw)
        run.refresh_from_db()
        steps = {
            dr.pipeline_step: dr
            for dr in DeployRun.objects.filter(pipeline_run=run).select_related("script_run")
        }
        return run, steps

    def test_both_steps_succeed_for_a_complete_device(self):
        run, steps = self.run_pipeline(self.r1)
        log1 = steps[1].script_run.log
        log2 = steps[2].script_run.log if 2 in steps else ""
        self.assertEqual(run.status, "succeeded", (run.detail, log1, log2))
        self.assertEqual(steps[1].status, "succeeded")
        self.assertIn("gi1 -> sw1 ge1  c0001  missing", log1)
        out = steps[1].script_run.outputs.get(name="vnet-plan.json")
        with out.file.open("rb") as fh:
            plan = json.loads(fh.read())
        self.assertEqual([v["name"] for v in plan["vnets_to_create"]], ["c0001"])
        self.assertEqual(plan["nics_wrong_vnet"], [])

        self.assertEqual(steps[2].status, "succeeded", log2)
        self.assertIn("Step 1 Proxmox VNets (demo): succeeded (vnet-plan.json)", log2)
        self.assertIn("vnet-plan.json: 1 to create, 0 wrong", log2)
        self.assertIn("r1  ok", log2)

    def test_dry_run_is_logged(self):
        run, steps = self.run_pipeline(self.r1, dry_run=True)
        self.assertEqual(run.status, "succeeded", run.detail)
        self.assertIn("dry run", steps[1].script_run.log)
        self.assertIn("dry run", steps[2].script_run.log)

    def test_a_cable_without_a_vnet_fails_step_one(self):
        self.cable(("r1", "gi2"), ("sw1", "ge2"), label="C2")
        run, steps = self.run_pipeline(self.r1)
        sr = steps[1].script_run
        self.assertEqual(run.status, "failed", sr.log)
        self.assertEqual(steps[1].status, "failed")
        self.assertEqual(sr.exit_code, 1, sr.log)
        self.assertIn("gi2 -> sw1 ge2  -  no VNet", sr.log)
        self.assertIn("FAILED: r1 gi2: C2 has no VNet", sr.log)
        self.assertNotIn(2, steps)  # stop on failure

    def test_a_pattern_names_the_vnet(self):
        c2 = self.cable(("r1", "gi2"), ("sw1", "ge2"), label="C2")
        t = AutomationTarget.objects.get(tenant=self.tenant, name=D.VNETS_TARGET)
        t.extra_vars = {"vnet_pattern": "c{n:04}"}
        t.save()
        run, steps = self.run_pipeline(self.r1)
        self.assertEqual(run.status, "succeeded", steps[1].script_run.log)
        self.assertIn(f"gi2 -> sw1 ge2  c{c2.numid:04}  missing", steps[1].script_run.log)

    def test_config_check_fails_without_required_fields(self):
        run, steps = self.run_pipeline(self.sw1)
        self.assertEqual(steps[1].status, "succeeded", steps[1].script_run.log)
        sr = steps[2].script_run
        self.assertEqual(run.status, "failed", sr.log)
        self.assertIn("sw1  missing primary IP, platform", sr.log)

    def test_compares_with_synced_proxmox_data(self):
        from api.models import Cluster, ClusterType, VirtualMachine
        from integrations.models import (
            IntegrationSettings,
            VirtGuest,
            VirtNetwork,
            VirtualizationSource,
        )

        IntegrationSettings.objects.create(tenant=self.tenant, virt_proxmox_enabled=True)
        p = ObjectPermission.objects.create(
            name="op-virt", actions=["view"], enabled=True,
            object_types=["virtualizationsource", "virtualmachine", "virtnetwork"],
        )
        p.users.add(self.op)
        p.tenants.add(self.tenant)
        src = VirtualizationSource.objects.create(
            tenant=self.tenant, name="lab", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"}, sync_networks=True,
            vnet_zone="lab",
        )
        VirtNetwork.objects.create(source=src, ext_key="c0001", name="c0001", sdn_zone="lab")
        self.cable(("r1", "gi2"), ("sw1", "ge2"), vnet="c0002", label="C2")
        ctype = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        cluster = Cluster.objects.create(tenant=self.tenant, name="cl1", type=ctype)
        for vmid, dev, nics in (
            (101, self.r1, [{"key": "net0", "name": "gi1", "mac": "", "bridge": "c0001"},
                            {"key": "net1", "name": "gi2", "mac": "", "bridge": "vmbr0"}]),
            (102, self.sw1, [{"key": "net0", "name": "ge1", "mac": "", "bridge": "c0001"},
                             {"key": "net1", "name": "ge2", "mac": "", "bridge": "vmbr0"}]),
        ):
            vm = VirtualMachine.objects.create(tenant=self.tenant, name=f"vm{vmid}",
                                               cluster=cluster, represents_device=dev)
            VirtGuest.objects.create(source=src, vmid=vmid, vm=vm, nics=nics)
        run, steps = self.run_pipeline(self.r1)
        log = steps[1].script_run.log
        self.assertEqual(steps[1].status, "succeeded", log)
        self.assertIn("Comparing with synced Proxmox data.", log)
        self.assertIn("gi1 -> sw1 ge1  c0001  ok", log)
        self.assertIn("gi2 -> sw1 ge2  c0002  missing, NIC on vmbr0", log)
        with steps[1].script_run.outputs.get(name="vnet-plan.json").file.open("rb") as fh:
            plan = json.loads(fh.read())
        self.assertEqual([v["name"] for v in plan["vnets_to_create"]], ["c0002"])
        self.assertEqual([(w["interface"], w["current"], w["wanted"])
                          for w in plan["nics_wrong_vnet"]], [("gi2", "vmbr0", "c0002")])
