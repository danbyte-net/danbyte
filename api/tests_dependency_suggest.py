"""Suggest dependencies from cables and LLDP (#450): direction from the
distance to the core and from uplink ports, redundancy groups, a patch
panel walked through, LLDP-only links, already-related pairs skipped, the
caller's view, and the confirm saving through the ordinary create."""
from __future__ import annotations

from django.utils import timezone

from api.models import (
    Cable,
    CableTermination,
    Device,
    DeviceDependency,
    FrontPort,
    Interface,
    RearPort,
)
from api.tests_device_dependencies import _Base
from monitoring.models import DeviceSnmp

SUGGEST = "/api/device-dependencies/suggest/"
CONFIRM = "/api/device-dependencies/suggest/confirm/"


class _SuggestBase(_Base):
    def setUp(self):
        super().setUp()
        self.n = 0

    def iface(self, device, name=None, **kw):
        self.n += 1
        return Interface.objects.create(device=device, name=name or f"eth{self.n}", **kw)

    def cable(self, a, b, type="cat6"):
        """A cable between two ports (a device gets a fresh interface)."""
        a = self.iface(a) if isinstance(a, Device) else a
        b = self.iface(b) if isinstance(b, Device) else b
        cab = Cable.objects.create(tenant=self.tenant, type=type)
        for end, p in (("A", a), ("B", b)):
            kw = {"interface": p} if isinstance(p, Interface) else (
                {"front_port": p} if isinstance(p, FrontPort) else {"rear_port": p})
            CableTermination.objects.create(cable=cab, end=end, **kw)
        return cab

    def suggest(self, core, **body):
        return self.ok(self.client.post(SUGGEST, {"core_device": str(core.pk), **body},
                                        format="json"))

    def pairs(self, body):
        return {(p["upstream"]["name"], p["downstream"]["name"]) for p in body["proposals"]}

    def proposal(self, body, up, down):
        return next(p for p in body["proposals"]
                    if (p["upstream"]["name"], p["downstream"]["name"]) == (up, down))


class SuggestTests(_SuggestBase):
    def test_chain_points_away_from_the_core(self):
        self.cable(self.core, self.dist, type="smf-os2")
        self.cable(self.dist, self.acc)
        body = self.suggest(self.core)
        self.assertEqual(self.pairs(body), {("core-1", "dist-2"), ("dist-2", "acc-7")})
        first = self.proposal(body, "core-1", "dist-2")
        self.assertEqual((first["distance"], first["direction"], first["evidence"]),
                         (1, "distance", "cable"))
        self.assertEqual(first["medium"]["name"], "Fibre")
        self.assertEqual(self.proposal(body, "dist-2", "acc-7")["medium"]["name"], "Ethernet")
        self.assertEqual(first["redundancy_group"], "")
        # The same graph read from the other end runs the other way.
        body = self.suggest(self.acc)
        self.assertEqual(self.pairs(body), {("acc-7", "dist-2"), ("dist-2", "core-1")})
        # Nothing was saved.
        self.assertFalse(DeviceDependency.objects.exists())

    def test_two_uplinks_share_a_group(self):
        dist_b = Device.objects.create(tenant=self.tenant, name="dist-3", site=self.site_a)
        self.cable(self.core, self.dist)
        self.cable(self.core, dist_b)
        self.cable(self.dist, self.acc)
        self.cable(dist_b, self.acc)
        body = self.suggest(self.core)
        a = self.proposal(body, "dist-2", "acc-7")
        b = self.proposal(body, "dist-3", "acc-7")
        self.assertEqual(a["redundancy_group"], "auto-core-1")
        self.assertEqual(b["redundancy_group"], "auto-core-1")
        self.assertEqual(self.proposal(body, "core-1", "dist-2")["redundancy_group"], "")

    def test_max_depth(self):
        self.cable(self.core, self.dist)
        self.cable(self.dist, self.acc)
        body = self.suggest(self.core, max_depth=1)
        self.assertEqual(self.pairs(body), {("core-1", "dist-2")})

    def test_patch_panel_is_walked_through(self):
        panel = Device.objects.create(tenant=self.tenant, name="pp-1", site=self.site_a)
        rear = RearPort.objects.create(device=panel, name="rear", positions=12)
        front = FrontPort.objects.create(device=panel, name="f1", rear_port=rear,
                                         rear_port_position=1)
        self.cable(self.core, front)
        self.cable(rear, self.acc)
        body = self.suggest(self.core)
        self.assertEqual(self.pairs(body), {("core-1", "acc-7")})

    def test_console_and_power_cables_do_not_count(self):
        from api.models import ConsolePort, ConsoleServerPort

        cab = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(
            cable=cab, end="A", console_server_port=ConsoleServerPort.objects.create(
                device=self.core, name="c1"))
        CableTermination.objects.create(
            cable=cab, end="B", console_port=ConsolePort.objects.create(
                device=self.dist, name="con"))
        self.assertEqual(self.suggest(self.core)["proposals"], [])

    def test_lldp_only_link(self):
        self.cable(self.core, self.dist)
        DeviceSnmp.objects.create(
            tenant=self.tenant, device=self.dist, reachable=True, polled_at=timezone.now(),
            data={"sys_name": "dist-2"},
            neighbors=[{"local_port": "Gi0/9", "remote_device": "acc-7",
                        "remote_port": "Gi0/1"}],
        )
        body = self.suggest(self.core)
        p = self.proposal(body, "dist-2", "acc-7")
        self.assertEqual(p["evidence"], "lldp")
        self.assertEqual(p["medium"]["name"], "Ethernet")
        self.assertEqual(p["ports"][0], {"downstream": "Gi0/1", "upstream": "Gi0/9",
                                          "evidence": "lldp"})
        body = self.suggest(self.core, use_lldp=False)
        self.assertEqual(self.pairs(body), {("core-1", "dist-2")})

    def test_uplink_port_orders_two_devices_at_one_distance(self):
        self.cable(self.core, self.dist)
        self.cable(self.core, self.acc)
        up_port = self.iface(self.acc, is_uplink=True)
        self.cable(up_port, self.dist)
        body = self.suggest(self.core)
        p = self.proposal(body, "dist-2", "acc-7")
        self.assertEqual(p["direction"], "uplink")
        self.assertNotIn(("acc-7", "dist-2"), self.pairs(body))
        # Without an uplink on either side, the link proposes nothing.
        Interface.objects.filter(pk=up_port.pk).update(is_uplink=False)
        body = self.suggest(self.core)
        self.assertEqual(self.pairs(body), {("core-1", "dist-2"), ("core-1", "acc-7")})

    def test_already_related_pairs_are_skipped(self):
        self.cable(self.core, self.dist)
        self.cable(self.dist, self.acc)
        self.dep(self.acc, self.dist, kind="peer")
        body = self.suggest(self.core)
        self.assertEqual(self.pairs(body), {("core-1", "dist-2")})
        self.assertEqual(body["skipped_existing"], 1)

    def test_caller_view_bounds_the_walk(self):
        self.cable(self.core, self.dist)
        self.cable(self.dist, self.remote)  # site B
        self.cable(self.remote, self.acc)  # back to site A, only through B
        user = self.member((["devicedependency", "device", "cable"], ["view"]),
                           sites=[self.site_a])
        self.login(user)
        body = self.suggest(self.core)
        self.assertEqual(self.pairs(body), {("core-1", "dist-2")})
        self.assertNotIn("remote-1", str(body))
        # A core the caller may not view is not found.
        r = self.client.post(SUGGEST, {"core_device": str(self.remote.pk)}, format="json")
        self.assertEqual(r.status_code, 400)
        # Without dependency view, no suggestions at all.
        self.login(self.member((["device", "cable"], ["view"])))
        r = self.client.post(SUGGEST, {"core_device": str(self.core.pk)}, format="json")
        self.assertEqual(r.status_code, 403)

    def test_other_tenant(self):
        r = self.client.post(SUGGEST, {"core_device": str(self.foreign.pk)}, format="json")
        self.assertEqual(r.status_code, 400)
        other_dev = Device.objects.create(tenant=self.other, name="their-sw")
        cab = Cable.objects.create(tenant=self.other)
        CableTermination.objects.create(cable=cab, end="A",
                                        interface=self.iface(self.foreign))
        CableTermination.objects.create(cable=cab, end="B", interface=self.iface(other_dev))
        self.assertEqual(self.suggest(self.core)["proposals"], [])

    def test_site_limits_the_walk(self):
        self.cable(self.core, self.dist)
        self.cable(self.core, self.remote)
        body = self.suggest(self.core, site=str(self.site_a.pk))
        self.assertEqual(self.pairs(body), {("core-1", "dist-2")})


class ConfirmTests(_SuggestBase):
    def row(self, up, down, **kw):
        return {"upstream_id": str(up.pk), "downstream_id": str(down.pk), **kw}

    def test_saves_each_row_and_refuses_a_cycle_per_row(self):
        self.dep(self.acc, self.core)  # core depends on acc already
        body = self.ok(self.client.post(CONFIRM, {"rows": [
            self.row(self.core, self.dist, medium_id=str(self.fibre.pk)),
            self.row(self.dist, self.acc, redundancy_group="auto-core-1"),
            self.row(self.core, self.remote),
        ]}, format="json"))
        self.assertEqual(body["created"], 2)
        ok = [r["ok"] for r in body["results"]]
        self.assertEqual(ok, [True, False, True])
        self.assertIn("cycle", str(body["results"][1]["errors"]).lower())
        self.assertIn("acc-7", str(body["results"][1]["errors"]))
        self.assertEqual(DeviceDependency.objects.filter(tenant=self.tenant).count(), 3)
        made = DeviceDependency.objects.get(upstream=self.core, downstream=self.dist)
        self.assertEqual(made.medium, self.fibre)
        from audit.models import ChangeLogEntry

        self.assertTrue(ChangeLogEntry.objects.filter(object_id=made.pk).exists())

    def test_needs_add_and_keeps_site_scope(self):
        viewer = self.member((["devicedependency", "device"], ["view"]))
        self.login(viewer)
        r = self.client.post(CONFIRM, {"rows": [self.row(self.core, self.dist)]},
                             format="json")
        self.assertEqual(r.status_code, 403)
        # A site editor of A records A's dependencies, not B's.
        editor = self.member((["devicedependency"], ["view", "add"], [self.site_a]),
                             (["device"], ["view"]))
        self.login(editor)
        body = self.ok(self.client.post(CONFIRM, {"rows": [
            self.row(self.core, self.dist), self.row(self.core, self.remote),
        ]}, format="json"))
        self.assertEqual([r["ok"] for r in body["results"]], [True, False])
        self.assertFalse(DeviceDependency.objects.filter(downstream=self.remote).exists())

    def test_foreign_ids_are_not_found(self):
        body = self.ok(self.client.post(CONFIRM, {"rows": [
            self.row(self.core, self.foreign)]}, format="json"))
        self.assertFalse(body["results"][0]["ok"])
        self.assertIn("downstream_id", body["results"][0]["errors"])
