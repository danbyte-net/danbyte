"""Links stay where they were matched, and neither a pin nor a sync hands out
a config its author could not already read.

- #398: unlinking a node and pinning it again is judged like moving the link
  directly - the node remembers its last confirmed target.
- #399: a sync's new match for a node it had seen before is *proposed*: no
  config is served through it until a connection manager confirms it.
- #400: a matched link is kept when its object is still among the
  candidates; the namesakes become a warning.
- #405: only a confirmed link is kept that way; a proposal yields to the
  node's last confirmed target.
- #406: a connection that synced before node memory existed treats a node
  missing from memory as seen before until its next sync records them all.
"""
from __future__ import annotations

import importlib
from unittest import mock

from django.apps import apps as django_apps

from api.models import Device
from monitoring.tests_snmp_schedule import FakeQueue, FakeRedis

from . import schedule
from .client import OxidizedError
from .models import OxidizedConnection, OxidizedNode, OxidizedNodeLink
from .sync import sync_nodes
from .tests import FAKE, node
from .tests_pin_scope import LINK, SECRET, _PinBase

MANAGE = (["oxidizedconnection"], ["view", "change"], None)
LINKS = (["oxidizednodelink"], ["view", "add", "delete"], None)


def _confirm(client, link):
    return client.post(f"{LINK}{link.id}/confirm/")


# ─── #398: unlink, then pin ─────────────────────────────────────────────────


class UnlinkThenPinTests(_PinBase):
    def test_cross_kind_unlink_then_pin_is_refused(self):
        """VM view_config tenant-wide, no device view_config: core1's node
        may not reach a VM by unlinking it first."""
        self.login(self.member(
            (["device", "virtualmachine"], ["view"], None),
            (["virtualmachine"], ["view_config"], None),
            LINKS, MANAGE,
        ))
        self.assertEqual(self.cfg(self.core).status_code, 403)
        vm = {"virtual_machine_id": str(self.vm.id)}
        self.assertEqual(self.pin(**vm).status_code, 400)
        self.assertEqual(self.client.delete(f"{LINK}{self.core_link.id}/").status_code, 204)
        r = self.pin(**vm)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("full_name", r.json())
        self.assertNotIn("TOPSECRET", self.client.get(self.vm_url()).content.decode())

    def test_same_kind_unlink_then_pin_is_refused(self):
        """Device view in site A only, view_config tenant-wide: the site-B
        device's node may not land on their own device."""
        self.login(self.member(
            (["device"], ["view"], self.site_a),
            (["device"], ["view_config"], None),
            LINKS, MANAGE,
        ))
        self.sw_link.delete()
        self.assertEqual(self.pin().status_code, 400)
        self.assertEqual(self.client.delete(f"{LINK}{self.core_link.id}/").status_code, 204)
        r = self.pin()
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(self.cfg().status_code, 404)

    def test_a_link_the_sync_dropped_is_remembered_too(self):
        """core1's node leaves Oxidized and comes back unmatched: it is still
        core1's config."""
        self.login(self.member(
            (["device", "virtualmachine"], ["view"], None),
            (["virtualmachine"], ["view_config"], None),
            LINKS, MANAGE,
        ))
        FAKE["nodes"] = [node("sw1", ip="10.9.0.10")]
        sync_nodes(self.conn)
        self.assertFalse(OxidizedNodeLink.objects.filter(full_name="core1").exists())
        r = self.pin(virtual_machine_id=str(self.vm.id))
        self.assertEqual(r.status_code, 400, r.content)

    def test_a_link_a_pin_replaced_is_remembered_too(self):
        """A pin to core1 frees core1's own node; that node is still core1's."""
        self.login()
        r = self.pin(full="ghost", device_id=str(self.core.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(
            OxidizedNode.objects.get(connection=self.conn, full_name="core1").last_device_id,
            self.core.id,
        )
        self.login(self.member(
            (["device", "virtualmachine"], ["view"], None),
            (["virtualmachine"], ["view_config"], None),
            LINKS, MANAGE,
        ))
        self.assertEqual(self.pin(virtual_machine_id=str(self.vm.id)).status_code, 400)

    def test_a_reader_of_the_old_object_may_still_unlink_and_pin(self):
        self.login(self.member(
            (["device"], ["view", "view_config"], self.site_a),
            LINKS, MANAGE,
        ))
        other = Device.objects.create(tenant=self.tenant, name="sw2", site=self.site_a)
        self.assertEqual(self.client.delete(f"{LINK}{self.sw_link.id}/").status_code, 204)
        r = self.pin(full="sw1", device_id=str(other.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self.cfg(other).json()["config"], "hostname sw1\n")

    def test_an_administrator_without_view_config_is_unaffected(self):
        self.login(self.builtin("Administrator"))
        self.assertEqual(self.client.delete(f"{LINK}{self.core_link.id}/").status_code, 204)
        self.assertEqual(self.pin(virtual_machine_id=str(self.vm.id)).status_code, 201)

    def test_once_the_old_object_is_deleted_the_unmatched_rule_applies(self):
        self.login()
        self.assertEqual(self.client.delete(f"{LINK}{self.core_link.id}/").status_code, 204)
        self.core.delete()
        self.assertIsNone(
            OxidizedNode.objects.get(connection=self.conn, full_name="core1").last_target
        )
        self.login(self.member(
            (["virtualmachine"], ["view"], None),
            (["virtualmachine"], ["view_config"], self.site_a),
            LINKS, MANAGE,
        ))
        self.assertEqual(self.pin(virtual_machine_id=str(self.vm.id)).status_code, 400)


# ─── #400: matched links are sticky ─────────────────────────────────────────


class StickyMatchTests(_PinBase):
    def setUp(self):
        super().setUp()
        OxidizedNodeLink.objects.all().delete()
        FAKE["nodes"] = [node("core1", ip="192.0.2.1"), node("sw1", ip="10.9.0.10")]
        sync_nodes(self.conn)
        self.assertEqual(OxidizedNodeLink.objects.get(full_name="core1").device_id, self.core.id)

    def test_a_vm_named_like_the_device_does_not_unlink_it(self):
        self.make_vm("CORE1", site=self.site_a)
        summary = sync_nodes(self.conn)
        lk = OxidizedNodeLink.objects.get(full_name="core1")
        self.assertEqual(lk.device_id, self.core.id)
        self.assertFalse(lk.proposed)
        self.assertEqual(summary["warning_count"], 1)
        self.assertIn("share the name 'core1'", summary["warnings"][0]["reason"])
        self.assertIn("kept", summary["warnings"][0]["reason"])
        self.assertNotIn("core1", [u["full_name"] for u in summary["unmatched"]])
        self.login()
        self.assertIn("TOPSECRET", self.cfg(self.core).json()["config"])

    def test_the_warning_is_on_the_unmatched_endpoint_and_the_card(self):
        self.make_vm("core1", site=self.site_a)
        sync_nodes(self.conn)
        self.login()
        r = self.client.get(f"/api/oxidized/connections/{self.conn.id}/unmatched/").json()
        self.assertEqual(r["warning_count"], 1)
        self.assertEqual(r["warnings"][0]["full_name"], "core1")
        card = self.client.get(f"/api/oxidized/connections/{self.conn.id}/").json()
        self.assertEqual(card["sync"]["warning_count"], 1)

    def test_an_address_shared_with_a_new_vm_keeps_the_link(self):
        self.vrf_ip("10.9.0.10/24", assigned_vm=self.make_vm("other"))
        summary = sync_nodes(self.conn)
        self.assertEqual(OxidizedNodeLink.objects.get(full_name="sw1").device_id, self.device.id)
        self.assertIn("share the address", summary["warnings"][0]["reason"])

    def test_without_a_link_two_namesakes_still_link_nothing(self):
        Device.objects.create(tenant=self.tenant, name="dup", site=self.site_a)
        self.make_vm("DUP", site=self.site_b)
        FAKE["nodes"].append(node("dup"))
        summary = sync_nodes(self.conn)
        self.assertFalse(OxidizedNodeLink.objects.filter(full_name="dup").exists())
        self.assertIn("share the name", summary["unmatched"][0]["reason"])

    def test_a_second_node_on_the_linked_device_leaves_the_link(self):
        FAKE["nodes"].append(node("sw1-mgmt", ip="10.9.0.10"))
        FAKE["nodes"][1] = node("sw1", ip="")  # still matches sw1 by name
        summary = sync_nodes(self.conn)
        self.assertEqual(OxidizedNodeLink.objects.get(device=self.device).full_name, "sw1")
        reasons = {u["full_name"]: u["reason"] for u in summary["unmatched"]}
        self.assertIn("linked to node sw1", reasons["sw1-mgmt"])
        self.assertIn("kept", summary["warnings"][0]["reason"])

    def test_the_link_still_follows_when_its_object_no_longer_matches(self):
        """Sticky only among candidates: a device renamed away loses the
        match, and the node is unmatched."""
        self.core.name = "core1-old"
        self.core.save()
        sync_nodes(self.conn)
        self.assertFalse(OxidizedNodeLink.objects.filter(full_name="core1").exists())


# ─── #399: a new match for a node seen before is proposed ───────────────────


class _SyncBase(_PinBase):
    def setUp(self):
        super().setUp()
        OxidizedNodeLink.objects.all().delete()
        self.conn.auto_sync = True
        self.conn.save()
        FAKE["nodes"] = [
            node("core1", ip="192.0.2.1"), node("sw1", ip="10.9.0.10"),
            node("ghost", ip="192.0.2.9"),
        ]
        sync_nodes(self.conn)

    def ghost(self):
        return OxidizedNodeLink.objects.get(full_name="ghost")

    def site_a_vm_user(self):
        return self.member(
            (["virtualmachine"], ["view", "add", "view_config"], self.site_a),
            (["cluster"], ["view"], None),
            (["oxidizednodelink"], ["view", "add"], None),
            MANAGE,
            username="vmuser",
        )


class ProposedLinkTests(_SyncBase):
    def test_the_first_sync_links_straight_away(self):
        got = dict(OxidizedNodeLink.objects.values_list("full_name", "proposed"))
        self.assertEqual(got, {"core1": False, "sw1": False})
        self.assertEqual(
            set(OxidizedNode.objects.values_list("full_name", flat=True)),
            {"core1", "sw1", "ghost"},
        )

    def test_reported_scenario_with_the_scheduled_sync(self):
        self.login(self.site_a_vm_user())
        r = self.pin(full="ghost", virtual_machine_id=str(self.vm.id))
        self.assertEqual(r.status_code, 400, r.content)
        r = self.client.post("/api/virtual-machines/", {
            "name": "ghost", "cluster_id": str(self.cluster.id), "site_id": str(self.site_a.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        vm_id = r.json()["id"]
        redis, queue = FakeRedis(), FakeQueue()
        with mock.patch("oxidized.schedule._conn", return_value=redis), \
                mock.patch("oxidized.schedule._queue", return_value=queue):
            self.conn.last_sync_attempt_at = None
            self.conn.save()
            schedule.dispatch()
            self.assertEqual([fn(*a) for fn, a in queue.jobs], ["synced"])
        lk = self.ghost()
        self.assertEqual(str(lk.virtual_machine_id), vm_id)
        self.assertTrue(lk.proposed)
        r = self.client.get(f"/api/oxidized/virtual-machines/{vm_id}/config/")
        self.assertEqual(r.status_code, 404)
        self.assertNotIn("TOPSECRET", r.content.decode())
        self.assertEqual(
            self.client.get(f"/api/oxidized/virtual-machines/{vm_id}/").json()["links"], []
        )
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.last_sync_summary["proposed"], 1)

    def test_a_manual_sync_proposes_too(self):
        vm = self.make_vm("ghost", site=self.site_a)
        self.login()
        r = self.client.post(f"/api/oxidized/connections/{self.conn.id}/sync/")
        self.assertEqual(r.json()["proposed"], 1)
        self.assertTrue(self.ghost().proposed)
        self.assertEqual(self.client.get(self.vm_url(vm)).status_code, 404)

    def test_the_proposer_cannot_confirm_it(self):
        self.make_vm("ghost", site=self.site_a)
        sync_nodes(self.conn)
        self.login(self.site_a_vm_user())
        r = _confirm(self.client, self.ghost())
        self.assertEqual(r.status_code, 400, r.content)
        self.assertTrue(self.ghost().proposed)

    def test_nor_unlink_and_pin_it(self):
        vm = self.make_vm("ghost", site=self.site_a)
        sync_nodes(self.conn)
        self.login(self.member(
            (["virtualmachine"], ["view", "view_config"], self.site_a), LINKS, MANAGE,
        ))
        self.assertEqual(self.client.delete(f"{LINK}{self.ghost().id}/").status_code, 204)
        self.assertEqual(self.pin(full="ghost", virtual_machine_id=str(vm.id)).status_code, 400)

    def test_a_tenant_wide_reader_confirms_and_the_config_is_served(self):
        vm = self.make_vm("ghost", site=self.site_a)
        sync_nodes(self.conn)
        self.login(self.member(
            (["virtualmachine"], ["view", "view_config"], None), LINKS, MANAGE,
        ))
        r = _confirm(self.client, self.ghost())
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["proposed"])
        self.assertIn("TOPSECRET", self.client.get(self.vm_url(vm)).json()["config"])
        sync_nodes(self.conn)  # stays confirmed
        self.assertFalse(self.ghost().proposed)

    def test_an_administrator_confirms_without_reading(self):
        self.make_vm("ghost", site=self.site_a)
        sync_nodes(self.conn)
        self.login(self.builtin("Administrator"))
        self.assertEqual(_confirm(self.client, self.ghost()).status_code, 200)

    def test_confirming_needs_change_on_the_connection(self):
        self.make_vm("ghost", site=self.site_a)
        sync_nodes(self.conn)
        self.login(self.member(
            (["virtualmachine"], ["view", "view_config"], None), LINKS,
            (["oxidizedconnection"], ["view"], None),
        ))
        self.assertEqual(_confirm(self.client, self.ghost()).status_code, 403)
        self.assertTrue(self.ghost().proposed)

    def test_confirming_another_sites_link_is_404(self):
        self.make_vm("ghost", site=self.site_b)
        sync_nodes(self.conn)
        self.login(self.member((["*"], ["view", "add", "change", "delete"], self.site_a)))
        self.assertEqual(_confirm(self.client, self.ghost()).status_code, 404)

    def test_a_confirmed_link_is_not_confirmed_again(self):
        self.login()
        lk = OxidizedNodeLink.objects.get(full_name="sw1")
        self.assertEqual(_confirm(self.client, lk).status_code, 400)

    def test_an_address_given_to_a_new_object_is_proposed_too(self):
        vm = self.make_vm("innocent", site=self.site_a)
        self.vrf_ip("192.0.2.9/32", assigned_vm=vm)
        sync_nodes(self.conn)
        self.assertTrue(self.ghost().proposed)

    def test_a_node_that_moves_to_another_object_is_proposed(self):
        self.core.name = "core1-old"
        self.core.save()
        self.make_vm("core1", site=self.site_a)
        sync_nodes(self.conn)
        lk = OxidizedNodeLink.objects.get(full_name="core1")
        self.assertIsNotNone(lk.virtual_machine_id)
        self.assertTrue(lk.proposed)
        self.login()
        self.assertEqual(self.client.get(self.vm_url(lk.virtual_machine)).status_code, 404)
        self.assertEqual(
            OxidizedNode.objects.get(full_name="core1").last_device_id, self.core.id
        )

    def test_a_node_new_to_oxidized_links_to_an_existing_object(self):
        Device.objects.create(tenant=self.tenant, name="edge9", site=self.site_a)
        FAKE["nodes"].append(node("edge9"))
        sync_nodes(self.conn)
        self.assertFalse(OxidizedNodeLink.objects.get(full_name="edge9").proposed)

    def test_an_unlinked_node_comes_back_to_its_object_confirmed(self):
        self.login()
        lk = OxidizedNodeLink.objects.get(full_name="sw1")
        self.assertEqual(self.client.delete(f"{LINK}{lk.id}/").status_code, 204)
        sync_nodes(self.conn)
        self.assertFalse(OxidizedNodeLink.objects.get(full_name="sw1").proposed)

    def test_a_pinned_node_left_unpinned_is_known(self):
        """A pin names the node, so a later match of it is proposed."""
        self.login()
        r = self.pin(full="later", device_id=str(self.core.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(OxidizedNode.objects.filter(full_name="later").exists())


class BackfillTests(_SyncBase):
    def test_the_migration_records_linked_and_unmatched_nodes(self):
        mig = importlib.import_module("oxidized.migrations.0004_node_memory_proposed_links")
        OxidizedNode.objects.all().delete()
        OxidizedConnection.objects.filter(pk=self.conn.pk).update(last_sync_summary={
            "unmatched": [{"full_name": "ghost"}, {"full_name": ""}, {}],
        })
        mig.backfill_nodes(django_apps, None)
        self.assertEqual(
            set(OxidizedNode.objects.values_list("full_name", flat=True)),
            {"core1", "sw1", "ghost"},
        )
        mig.backfill_nodes(django_apps, None)  # idempotent
        self.assertEqual(OxidizedNode.objects.count(), 3)


# ─── #405: a proposed link holds nothing ────────────────────────────────────


class ProposedHoldsNothingTests(_SyncBase):
    def propose_core1_to_a_vm(self):
        self.core.name = "core1-old"
        self.core.save()
        vm = self.make_vm("core1", site=self.site_a)
        sync_nodes(self.conn)
        lk = OxidizedNodeLink.objects.get(full_name="core1")
        self.assertEqual((lk.virtual_machine_id, lk.proposed), (vm.id, True))
        return vm

    def test_reported_scenario_the_remembered_device_wins(self):
        vm = self.propose_core1_to_a_vm()
        self.core.name = "core1"
        self.core.save()
        reasons = []
        for _ in range(2):
            summary = sync_nodes(self.conn)
            lk = OxidizedNodeLink.objects.get(full_name="core1")
            self.assertEqual(lk.device_id, self.core.id)
            self.assertFalse(lk.proposed)
            reasons += [w["reason"] for w in summary["warnings"] if w["full_name"] == "core1"]
        self.assertFalse(OxidizedNodeLink.objects.filter(virtual_machine=vm).exists())
        self.assertIn("last confirmed link is restored", reasons[0])
        self.assertIn("existing link is kept", reasons[1])
        self.login()
        self.assertIn("TOPSECRET", self.cfg(self.core).json()["config"])
        self.assertEqual(self.client.get(self.vm_url(vm)).status_code, 404)

    def test_a_proposal_does_not_survive_a_namesake(self):
        """Without a remembered target, an ambiguous rung drops the proposal."""
        self.make_vm("ghost", site=self.site_a)
        sync_nodes(self.conn)
        self.assertTrue(self.ghost().proposed)
        Device.objects.create(tenant=self.tenant, name="ghost", site=self.site_a)
        summary = sync_nodes(self.conn)
        self.assertFalse(OxidizedNodeLink.objects.filter(full_name="ghost").exists())
        reasons = {u["full_name"]: u["reason"] for u in summary["unmatched"]}
        self.assertIn("share the name", reasons["ghost"])

    def test_a_proposal_does_not_hold_its_target_against_another_node(self):
        vm = self.make_vm("ghost", site=self.site_a)
        sync_nodes(self.conn)
        self.assertTrue(self.ghost().proposed)
        self.vrf_ip("192.0.2.77/32", assigned_vm=vm)
        FAKE["nodes"].append(node("ghost-b", ip="192.0.2.77"))
        summary = sync_nodes(self.conn)
        self.assertFalse(OxidizedNodeLink.objects.filter(virtual_machine=vm).exists())
        reasons = {u["full_name"]: u["reason"] for u in summary["unmatched"]}
        self.assertIn("2 nodes match", reasons["ghost"])
        self.assertIn("2 nodes match", reasons["ghost-b"])

    def test_the_remembered_node_holds_its_target_against_another_node(self):
        self.propose_core1_to_a_vm()
        self.core.name = "core1"
        self.core.save()
        self.vrf_ip("10.9.0.77/32", assigned_device=self.core)
        FAKE["nodes"].append(node("core1-mgmt", ip="10.9.0.77"))
        summary = sync_nodes(self.conn)
        lk = OxidizedNodeLink.objects.get(device=self.core)
        self.assertEqual((lk.full_name, lk.proposed), ("core1", False))
        reasons = {u["full_name"]: u["reason"] for u in summary["unmatched"]}
        self.assertIn("linked to node core1", reasons["core1-mgmt"])

    def test_a_confirmed_link_still_beats_a_remembered_one(self):
        """The node's confirmed link is kept even when its remembered object
        is among the namesakes too."""
        self.propose_core1_to_a_vm()
        self.login()
        lk = OxidizedNodeLink.objects.get(full_name="core1")
        self.assertEqual(_confirm(self.client, lk).status_code, 200)
        self.core.name = "core1"
        self.core.save()
        sync_nodes(self.conn)
        lk = OxidizedNodeLink.objects.get(full_name="core1")
        self.assertIsNotNone(lk.virtual_machine_id)
        self.assertFalse(lk.proposed)


# ─── #406: nodes the upgrade could not list count as seen before ────────────


class IncompleteMemoryTests(_SyncBase):
    def upgrade_forgot(self, *names):
        OxidizedNode.objects.filter(full_name__in=names).delete()
        OxidizedConnection.objects.filter(pk=self.conn.pk).update(node_memory_complete=False)
        self.conn.refresh_from_db()

    def test_a_new_connection_has_seen_nothing(self):
        conn = OxidizedConnection.objects.create(tenant=self.tenant, name="new", url="http://x")
        self.assertTrue(conn.node_memory_complete)
        self.conn.refresh_from_db()
        self.assertTrue(self.conn.node_memory_complete)

    def test_reported_scenario_a_node_beyond_the_cap_is_proposed(self):
        FAKE["nodes"].append(node("zz-secret"))
        FAKE["configs"]["zz-secret"] = SECRET
        self.upgrade_forgot("zz-secret")
        dev = Device.objects.create(tenant=self.tenant, name="zz-secret", site=self.site_a)
        summary = sync_nodes(self.conn)
        lk = OxidizedNodeLink.objects.get(full_name="zz-secret")
        self.assertEqual((lk.device_id, lk.proposed), (dev.id, True))
        self.assertEqual(summary["proposed"], 1)
        self.login()
        self.assertEqual(self.cfg(dev).status_code, 404)
        self.conn.refresh_from_db()
        self.assertTrue(self.conn.node_memory_complete)
        self.assertTrue(OxidizedNode.objects.filter(full_name="zz-secret").exists())

    def test_existing_links_stay_confirmed(self):
        self.upgrade_forgot()
        sync_nodes(self.conn)
        got = dict(OxidizedNodeLink.objects.values_list("full_name", "proposed"))
        self.assertEqual(got, {"core1": False, "sw1": False})

    def test_a_node_new_to_oxidized_after_that_sync_links_straight_away(self):
        self.upgrade_forgot()
        sync_nodes(self.conn)
        Device.objects.create(tenant=self.tenant, name="edge9", site=self.site_a)
        FAKE["nodes"].append(node("edge9"))
        sync_nodes(self.conn)
        self.assertFalse(OxidizedNodeLink.objects.get(full_name="edge9").proposed)

    def test_a_failed_sync_leaves_the_memory_incomplete(self):
        self.upgrade_forgot()
        with mock.patch(
            "oxidized.sync.OxidizedClient.nodes", side_effect=OxidizedError("down")
        ):
            self.assertEqual(sync_nodes(self.conn)["error"], "down")
        self.conn.refresh_from_db()
        self.assertFalse(self.conn.node_memory_complete)

    def test_the_migration_marks_connections_that_have_synced(self):
        mig = importlib.import_module("oxidized.migrations.0005_node_memory_complete")
        fresh = OxidizedConnection.objects.create(tenant=self.tenant, name="new", url="http://x")
        OxidizedConnection.objects.update(node_memory_complete=False)
        mig.mark_complete(django_apps, None)
        self.conn.refresh_from_db()
        fresh.refresh_from_db()
        self.assertFalse(self.conn.node_memory_complete)  # synced in setUp
        self.assertTrue(fresh.node_memory_complete)
