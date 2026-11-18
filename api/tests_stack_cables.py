"""A stack's rings outside the 3D views (api.stack_cables): the derived link
on a port's page (``/api/devices/<id>/stack-links/``), part-number lengths,
and auto-connect - the rings recorded as cables and kept in step."""
from __future__ import annotations

from decimal import Decimal
from io import StringIO

from django.contrib.auth.models import User
from django.core.management import call_command
from django.test import SimpleTestCase

from auth_api.models import ObjectPermission, UserProfile

from .models import AccessoryType, Cable, CableTermination, Device, Interface, VirtualChassis
from .stack_cables import part_length, reconcile, shortest_part
from .tests_stack_links import SPWR, STACK, _PowerBase


class PartLengthTests(SimpleTestCase):
    def test_lengths_from_suffixes(self):
        self.assertEqual(part_length("STACK-T1-50CM"), (Decimal("50"), "cm"))
        self.assertEqual(part_length("STACK-T1-1M"), (Decimal("1"), "m"))
        self.assertEqual(part_length("STACK-T1-3M="), (Decimal("3"), "m"))
        self.assertEqual(part_length("CAB-SPWR-150CM"), (Decimal("150"), "cm"))
        self.assertEqual(part_length("CAB-SPWR-30cm"), (Decimal("30"), "cm"))
        self.assertEqual(part_length("X-0.5M"), (Decimal("0.5"), "m"))
        self.assertIsNone(part_length("STACK-T1"))
        self.assertIsNone(part_length("C9300M"))
        self.assertIsNone(part_length(""))

    def test_shortest_part(self):
        self.assertEqual(shortest_part(["STACK-T1-1M", "STACK-T1-50CM", "STACK-T1-3M"]),
                         ("STACK-T1-50CM", (Decimal("50"), "cm")))
        self.assertEqual(shortest_part(["ODD", "CAB-SPWR-150CM", "CAB-SPWR-30CM"])[0],
                         "CAB-SPWR-30CM")
        self.assertEqual(shortest_part(["ODD"]), ("ODD", None))
        self.assertEqual(shortest_part([]), ("", None))


class DerivedLinkTests(_PowerBase):
    def _get(self, dev):
        res = self.client.get(f"/api/devices/{dev.id}/stack-links/")
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()["ports"]

    def test_a_member_sees_both_rings(self):
        ports = self._get(self.members[1])
        by_name = {v["name"]: v for v in ports.values()}
        self.assertEqual(sorted(by_name), ["StackPort2/1", "StackPort2/2",
                                           "StackPower1/A", "StackPower1/B"])
        far = by_name["StackPort2/1"]["far"]
        self.assertEqual((far["device_name"], far["port"]), ("sw3", "StackPort3/2"))
        self.assertEqual(by_name["StackPower1/B"]["kind"], "power")
        iface = Interface.objects.get(device=self.members[1], name="StackPort2/1")
        self.assertIn(str(iface.id), ports)

    def test_a_recorded_cable_replaces_only_its_own_link(self):
        self._cable("StackPort1/1", "StackPort2/2")
        ports = self._get(self.members[1])
        names = sorted(v["name"] for v in ports.values())
        self.assertEqual(names, ["StackPort2/1", "StackPower1/A", "StackPower1/B"])

    def test_parts_for_record_cable(self):
        AccessoryType.objects.create(tenant=self.tenant, vendor="Cisco", name="STACK-T1",
                                     kind="cord", connector="stack", fits=[STACK],
                                     parts=["STACK-T1-50CM", "STACK-T1-1M"])
        ports = self._get(self.members[0])
        data = [v for v in ports.values() if v["kind"] == "data"]
        self.assertTrue(data)
        self.assertEqual(data[0]["parts"], ["STACK-T1-50CM", "STACK-T1-1M"])

    def test_not_a_member_nothing(self):
        Device.objects.filter(pk=self.members[1].pk).update(virtual_chassis=None,
                                                            vc_position=None)
        self.assertEqual(self._get(self.members[1]), {})

    def test_a_hidden_far_end_is_left_out(self):
        user = User.objects.create_user("u", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        g = ObjectPermission.objects.create(name="r", object_types=["device"],
                                            actions=["view"],
                                            constraints={"name__in": ["sw1", "sw2"]})
        g.users.add(user)
        g.tenants.add(self.tenant)
        rest = ObjectPermission.objects.create(name="rest", actions=["view"],
                                               object_types=["interface", "powerport"])
        rest.users.add(user)
        rest.tenants.add(self.tenant)
        self._login(user)
        ports = self._get(self.members[1])
        # sw2's ring to sw3 is not listed; to sw1 it is.
        fars = {v["far"]["device_name"] for v in ports.values()}
        self.assertEqual(fars, {"sw1"})

    def test_another_tenant_404(self):
        other = Device.objects.create(tenant=self.other, name="x", device_type=self.dt)
        res = self.client.get(f"/api/devices/{other.id}/stack-links/")
        self.assertEqual(res.status_code, 404)


class AutoConnectTests(_PowerBase):
    def _on(self, **kw):
        VirtualChassis.objects.filter(pk=self.vc.pk).update(**kw)
        self.vc.refresh_from_db()
        return reconcile(self.vc)

    def _auto(self, source="stack"):
        out = []
        for c in Cable.objects.filter(auto_chassis=self.vc, auto_source=source):
            ends = {}
            for t in c.terminations.all():
                p = t.interface or t.power_port
                ends[t.end] = f"{p.device.name}:{p.name}"
            out.append((ends["A"], ends["B"]))
        return sorted(out)

    def test_on_records_the_ring_and_is_idempotent(self):
        AccessoryType.objects.create(tenant=self.tenant, vendor="Cisco", name="STACK-T1",
                                     kind="cord", connector="stack", fits=[STACK],
                                     parts=["STACK-T1-1M", "STACK-T1-50CM"])
        self.assertEqual(self._on(auto_connect_stack=True), {"created": 3, "deleted": 0})
        self.assertEqual(self._auto(), [
            ("sw1:StackPort1/1", "sw2:StackPort2/2"),
            ("sw2:StackPort2/1", "sw3:StackPort3/2"),
            ("sw3:StackPort3/1", "sw1:StackPort1/2"),
        ])
        c = Cable.objects.filter(auto_source="stack").first()
        self.assertEqual((c.label, c.length, c.length_unit), ("STACK-T1-50CM", 50, "cm"))
        self.assertEqual(reconcile(self.vc), {"created": 0, "deleted": 0})
        self.assertEqual(self._auto("stack-power"), [])
        # The 3D view now draws them as recorded.
        links = self._payload()["stacks"][0]["links"]
        self.assertFalse(any(lk["derived"] for lk in links if lk["kind"] == "data"))

    def test_chain_and_power_rings(self):
        self._add(5)
        self._on(auto_connect_stack=True, auto_connect_power=True, stack_topology="chain")
        self.assertEqual(len(self._auto()), 4)
        # Rings of at most four: 1-4 closed, 5 alone gets none.
        power = self._auto("stack-power")
        self.assertEqual(len(power), 4)
        self.assertIn(("sw4:StackPower1/B", "sw1:StackPower1/A"), power)
        self.assertEqual(Cable.objects.filter(auto_source="stack-power").first().type, "stack-power")

    def test_existing_cable_respected(self):
        manual = self._cable("StackPort1/1", "StackPort3/2", label="MINE")
        self._on(auto_connect_stack=True)
        # 1/1 is taken: that link is skipped; 3/2 too.
        self.assertEqual(self._auto(), [("sw3:StackPort3/1", "sw1:StackPort1/2")])
        manual.refresh_from_db()
        self.assertEqual((manual.label, manual.auto_source), ("MINE", ""))

    def test_off_deletes_only_auto_cables(self):
        self._on(auto_connect_stack=True)
        released = Cable.objects.filter(auto_source="stack").first()
        res = self.client.patch(f"/api/cables/{released.id}/", {"label": "KEEP"},
                                format="json")
        self.assertEqual(res.status_code, 200, res.content)
        released.refresh_from_db()
        self.assertEqual((released.auto_source, released.auto_chassis_id), ("", None))
        self.assertEqual(self._on(auto_connect_stack=False), {"created": 0, "deleted": 2})
        self.assertEqual(list(Cable.objects.values_list("label", flat=True)), ["KEEP"])

    def test_member_changes_follow_on_commit(self):
        self._on(auto_connect_stack=True)
        with self.captureOnCommitCallbacks(execute=True):
            dev = Device.objects.get(pk=self.members[2].pk)
            dev.virtual_chassis = None
            dev.vc_position = None
            dev.save()
        self.assertEqual(self._auto(), [("sw1:StackPort1/1", "sw2:StackPort2/2"),
                                        ("sw2:StackPort2/1", "sw1:StackPort1/2")])
        with self.captureOnCommitCallbacks(execute=True):
            vc = VirtualChassis.objects.get(pk=self.vc.pk)
            vc.stack_topology = "chain"
            vc.save()
        self.assertEqual(self._auto(), [("sw1:StackPort1/1", "sw2:StackPort2/2")])

    def test_renumber_follows(self):
        self._on(auto_connect_stack=True)
        with self.captureOnCommitCallbacks(execute=True):
            for dev, pos in ((self.members[1], 9), ):
                d = Device.objects.get(pk=dev.pk)
                d.vc_position = pos
                d.save()
        # Member order is now sw1, sw3, sw2(9).
        self.assertIn(("sw1:StackPort1/1", "sw3:StackPort3/2"), self._auto())

    def test_deleting_the_stack_keeps_its_cables_plain(self):
        self._on(auto_connect_stack=True)
        VirtualChassis.objects.get(pk=self.vc.pk).delete()
        self.assertEqual(Cable.objects.count(), 3)
        self.assertFalse(Cable.objects.exclude(auto_source="").exists())

    def test_command_reconciles(self):
        VirtualChassis.objects.filter(pk=self.vc.pk).update(auto_connect_power=True)
        out = StringIO()
        call_command("reconcile_stack_cables", stdout=out)
        self.assertIn("3 created", out.getvalue())
        self.assertEqual(len(self._auto("stack-power")), 3)
        self.assertTrue(all(c.terminations.filter(power_port__type=SPWR).count() == 2
                            for c in Cable.objects.filter(auto_source="stack-power")))

    def test_changelog_names_the_stack(self):
        from audit.models import ChangeLogEntry

        self._on(auto_connect_stack=True)
        causes = set(ChangeLogEntry.objects.filter(object_type="api.cable")
                     .values_list("cause", flat=True))
        self.assertIn("Auto-connect: stack STACK", causes)


class AutoConnectRightsTests(_PowerBase):
    def _user(self, actions_by_type):
        user = User.objects.create_user("op", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        for i, (types, actions) in enumerate(actions_by_type):
            g = ObjectPermission.objects.create(name=f"g{i}", object_types=types,
                                                actions=actions)
            g.users.add(user)
            g.tenants.add(self.tenant)
        self._login(user)

    def _toggle(self):
        return self.client.patch(f"/api/virtual-chassis/{self.vc.id}/",
                                 {"auto_connect_stack": True}, format="json")

    def test_vc_change_alone_is_refused(self):
        self._user([(["virtualchassis"], ["view", "change"])])
        res = self._toggle()
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("auto_connect_stack", res.json())
        self.vc.refresh_from_db()
        self.assertFalse(self.vc.auto_connect_stack)

    def test_with_cable_add_and_delete_it_turns_on(self):
        self._user([(["virtualchassis"], ["view", "change"]),
                    (["cable"], ["view", "add", "delete"])])
        with self.captureOnCommitCallbacks(execute=True):
            res = self._toggle()
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.json()["auto_connect_stack"])
        self.assertEqual(Cable.objects.filter(auto_source="stack").count(), 3)
