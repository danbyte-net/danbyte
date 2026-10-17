"""Pinning and unlinking Oxidized nodes never widens who reads a config (#386).

The config endpoints check ``view_config`` on the object in the URL and serve
whichever node is linked to it, so the pin itself is the gate: a pin must not
let its author read a node they could not already read, and only connection
managers may change the mapping at all.
"""
from __future__ import annotations

from api.models import Device
from auth_api.builtin_groups import BUILTINS
from auth_api.models import ObjectPermission

from .models import OxidizedNodeLink
from .sync import sync_nodes
from .tests import FAKE, node
from .tests_vm import _VmBase

LINK = "/api/oxidized/links/"
SECRET = "hostname core1\nsnmp-server community TOPSECRET RO\n"


class _PinBase(_VmBase):
    def setUp(self):
        super().setUp()
        self.core = Device.objects.create(tenant=self.tenant, name="core1", site=self.site_b)
        self.sw_link = self.link(full="sw1")
        self.core_link = self.link(device=self.core, full="core1")
        FAKE["configs"].update({"sw1": "hostname sw1\n", "core1": SECRET, "ghost": SECRET})

    def pin(self, full="core1", **target):
        target = target or {"device_id": str(self.device.id)}
        return self.client.post(LINK, {
            "connection_id": str(self.conn.id), "full_name": full, **target,
        }, format="json")

    def builtin(self, name, *extra, username="b"):
        """A member holding a built-in group's grant, plus ``extra`` grants."""
        actions, types = next((a, t) for n, _d, a, t in BUILTINS if n == name)
        return self.member((list(types), list(actions), None), *extra, username=username)

    def assert_unchanged(self):
        self.assertEqual(
            set(OxidizedNodeLink.objects.values_list("full_name", "device_id")),
            {("sw1", self.device.id), ("core1", self.core.id)},
        )


class ReportedScenarioTests(_PinBase):
    """view on every device, view_config in site A only, link view/add/delete."""

    def setUp(self):
        super().setUp()
        self.user = self.member(
            (["device"], ["view"], None),
            (["device"], ["view_config"], self.site_a),
            (["oxidizednodelink"], ["view", "add", "delete"], None),
        )
        self.login(self.user)

    def test_the_other_sites_config_stays_403(self):
        self.assertEqual(self.cfg(self.core).status_code, 403)

    def test_unlinking_needs_change_on_the_connection(self):
        for lk in (self.core_link, self.sw_link):
            self.assertEqual(self.client.delete(f"{LINK}{lk.id}/").status_code, 403)
        self.assert_unchanged()

    def test_pinning_needs_change_on_the_connection(self):
        OxidizedNodeLink.objects.all().delete()
        r = self.pin()
        self.assertEqual(r.status_code, 403, r.content)
        self.assertFalse(OxidizedNodeLink.objects.exists())
        self.assertNotIn("TOPSECRET", self.cfg().content.decode())

    def test_an_unmatched_node_cannot_be_pinned_either(self):
        self.sw_link.delete()
        FAKE["nodes"] = [node("ghost", ip="192.0.2.9")]
        r = self.pin(full="ghost")
        self.assertEqual(r.status_code, 403, r.content)
        self.assertEqual(self.cfg().status_code, 404)


class ConnectionManagerScopeTests(_PinBase):
    """The same reader, now also allowed to manage the connection: the pin
    still may not hand them a config they cannot read."""

    def setUp(self):
        super().setUp()
        self.user = self.member(
            (["device"], ["view"], None),
            (["device"], ["view_config"], self.site_a),
            (["oxidizednodelink"], ["view", "add", "delete"], None),
            (["oxidizedconnection"], ["view", "change"], None),
        )
        self.login(self.user)

    def test_a_node_linked_to_an_unreadable_device_is_refused(self):
        self.sw_link.delete()
        r = self.pin()
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("full_name", r.json())
        self.assertEqual(
            OxidizedNodeLink.objects.get(full_name="core1").device_id, self.core.id
        )
        self.assertEqual(self.cfg().status_code, 404)

    def test_unlink_then_pin_is_refused(self):
        self.assertEqual(self.client.delete(f"{LINK}{self.core_link.id}/").status_code, 204)
        r = self.pin()
        self.assertEqual(r.status_code, 400, r.content)
        self.assertNotIn("TOPSECRET", self.cfg().content.decode())

    def test_an_unmatched_node_needs_unrestricted_view_config(self):
        r = self.pin(full="ghost")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(OxidizedNodeLink.objects.get(device=self.device).full_name, "sw1")

    def test_a_node_of_a_readable_device_may_be_moved(self):
        other = Device.objects.create(tenant=self.tenant, name="sw2", site=self.site_a)
        self.link(device=other, full="sw2")
        r = self.pin(full="sw2")
        self.assertEqual(r.status_code, 201, r.content)

    def test_view_config_without_view_on_the_previous_device_is_refused(self):
        hidden = Device.objects.create(tenant=self.tenant, name="sw3", site=self.site_b)
        self.link(device=hidden, full="sw3")
        self.login(self.member(
            (["device"], ["view"], self.site_a),
            (["device"], ["view_config"], None),
            (["oxidizednodelink"], ["view", "add"], None),
            (["oxidizedconnection"], ["view", "change"], None),
            username="nv",
        ))
        r = self.pin(full="sw3")
        self.assertEqual(r.status_code, 400, r.content)

    def test_without_view_config_on_the_target_nothing_is_gained(self):
        """Pinning to a device the author cannot read configs on exposes
        nothing to them, so a manager may map it."""
        target = Device.objects.create(tenant=self.tenant, name="edge", site=self.site_b)
        r = self.pin(full="ghost", device_id=str(target.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self.cfg(target).status_code, 403)


class UnrestrictedReaderTests(_PinBase):
    def test_a_tenant_wide_reader_pins_an_unmatched_node(self):
        self.login(self.member(
            (["device"], ["view", "view_config"], None),
            (["oxidizednodelink"], ["view", "add"], None),
            (["oxidizedconnection"], ["view", "change"], None),
        ))
        r = self.pin(full="ghost")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIn("TOPSECRET", self.cfg().json()["config"])

    def test_a_row_limited_reader_is_not_tenant_wide(self):
        user = self.member(
            (["device"], ["view"], None),
            (["oxidizednodelink"], ["view", "add"], None),
            (["oxidizedconnection"], ["view", "change"], None),
        )
        perm = ObjectPermission.objects.create(
            name="rows", object_types=["device"], actions=["view_config"],
            constraints={"name": "sw1"},
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.login(user)
        self.assertEqual(self.pin(full="ghost").status_code, 400)


class SiteScopedManagerTests(_PinBase):
    """An Operator-style grant limited to site A: links follow site scope."""

    def setUp(self):
        super().setUp()
        self.user = self.member(
            (["*"], ["view", "add", "change", "delete"], self.site_a),
        )
        self.login(self.user)

    def test_links_list_follows_site_scope(self):
        rows = self.client.get(LINK).json()["results"]
        self.assertEqual([r["full_name"] for r in rows], ["sw1"])

    def test_another_sites_link_cannot_be_unlinked(self):
        self.assertEqual(self.client.delete(f"{LINK}{self.core_link.id}/").status_code, 404)
        self.assertEqual(self.client.delete(f"{LINK}{self.sw_link.id}/").status_code, 204)

    def test_another_sites_node_cannot_be_pulled_over(self):
        self.sw_link.delete()
        r = self.pin()
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(
            OxidizedNodeLink.objects.get(full_name="core1").device_id, self.core.id
        )

    def test_pinning_to_another_sites_device_is_refused(self):
        target = Device.objects.create(tenant=self.tenant, name="edge", site=self.site_b)
        r = self.pin(full="ghost", device_id=str(target.id))
        self.assertIn(r.status_code, (400, 403), r.content)
        self.assertFalse(OxidizedNodeLink.objects.filter(full_name="ghost").exists())

    def test_an_unmatched_node_goes_to_their_own_device(self):
        r = self.pin(full="ghost")
        self.assertEqual(r.status_code, 201, r.content)


class VmPinScopeTests(_PinBase):
    def test_a_devices_node_cannot_be_pulled_onto_a_readable_vm(self):
        self.login(self.member(
            (["device", "virtualmachine"], ["view"], None),
            (["virtualmachine"], ["view_config"], None),
            (["oxidizednodelink"], ["view", "add"], None),
            (["oxidizedconnection"], ["view", "change"], None),
        ))
        r = self.pin(virtual_machine_id=str(self.vm.id))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(self.client.get(self.vm_url()).status_code, 404)

    def test_a_site_scoped_vm_reader_cannot_pin_an_unmatched_node(self):
        self.login(self.member(
            (["virtualmachine"], ["view"], None),
            (["virtualmachine"], ["view_config"], self.site_a),
            (["oxidizednodelink"], ["view", "add"], None),
            (["oxidizedconnection"], ["view", "change"], None),
        ))
        r = self.pin(full="ghost", virtual_machine_id=str(self.vm.id))
        self.assertEqual(r.status_code, 400, r.content)

    def test_a_vm_link_follows_the_vms_site(self):
        other = self.make_vm("chr2", site=self.site_b)
        self.vm_link(vm=other, full="chr2")
        self.vm_link(full="chr1")
        self.login(self.member((["*"], ["view", "add", "change", "delete"], self.site_a)))
        rows = self.client.get(f"{LINK}?connection={self.conn.id}").json()["results"]
        self.assertEqual(sorted(r["full_name"] for r in rows), ["chr1", "sw1"])


class AdminWorkflowTests(_PinBase):
    """The built-in Administrator holds no view_config; mapping is unchanged."""

    def setUp(self):
        super().setUp()
        self.login(self.builtin("Administrator"))

    def test_pin_an_unmatched_node(self):
        FAKE["nodes"] = [node("ghost", ip="192.0.2.9")]
        sync_nodes(self.conn)
        r = self.pin(full="ghost")
        self.assertEqual(r.status_code, 201, r.content)

    def test_correct_a_wrong_match(self):
        self.sw_link.delete()
        r = self.pin()
        self.assertEqual(r.status_code, 201, r.content)

    def test_pin_to_a_vm_and_unlink(self):
        r = self.pin(full="ghost", virtual_machine_id=str(self.vm.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self.client.delete(f"{LINK}{r.json()['id']}/").status_code, 204)

    def test_superuser_unchanged(self):
        self.login()
        self.sw_link.delete()
        self.assertEqual(self.pin().status_code, 201)
        self.assertIn("TOPSECRET", self.cfg().json()["config"])

    def test_operator_pins_but_cannot_unlink(self):
        self.login(self.builtin("Operator", username="op"))
        r = self.pin(full="ghost")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self.client.delete(f"{LINK}{r.json()['id']}/").status_code, 403)


class SyncReasonScopeTests(_VmBase):
    """A sync matches against the whole tenant, so a claim reason can name a
    device or VM outside the caller's scope; the API names only what the
    caller can view."""

    UNMATCHED = "/api/oxidized/connections/{}/unmatched/"

    def setUp(self):
        super().setUp()
        self.hidden = Device.objects.create(
            tenant=self.tenant, name="secret-core", site=self.site_b
        )
        FAKE["nodes"] = [node("secret-core"), node("secret-core.example.net")]
        self.user = self.member((["*"], ["view"], self.site_a))

    def rows(self, key="results", user=None):
        self.login(user or self.user)
        r = self.client.get(self.UNMATCHED.format(self.conn.id))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertNotIn(str(self.hidden.id), r.content.decode())
        return {row["full_name"]: row["reason"] for row in r.json()[key]}

    def test_admin_sees_the_name(self):
        sync_nodes(self.conn)
        self.login()
        r = self.client.get(self.UNMATCHED.format(self.conn.id)).json()
        by = {row["full_name"]: row for row in r["results"]}
        self.assertEqual(by["secret-core"]["reason"], "2 nodes match secret-core.")
        self.assertEqual(
            set(by["secret-core"]), {"full_name", "name", "ip", "model", "reason"}
        )

    def test_site_scoped_reader_gets_no_name(self):
        sync_nodes(self.conn)
        self.assertEqual(self.rows()["secret-core"], "2 nodes match a device.")

    def test_in_scope_device_stays_named(self):
        self.hidden.site = self.site_a
        self.hidden.save()
        sync_nodes(self.conn)
        self.login(self.user)
        r = self.client.get(self.UNMATCHED.format(self.conn.id)).json()
        self.assertEqual(r["results"][0]["reason"], "2 nodes match secret-core.")

    def test_linked_holder_and_warning_redacted(self):
        self.link(device=self.hidden, full="secret-core")
        sync_nodes(self.conn)
        self.assertEqual(
            self.rows()["secret-core.example.net"], "A device is linked to node secret-core."
        )
        self.assertEqual(
            self.rows("warnings")["secret-core"],
            "2 nodes match a device; the existing link is kept.",
        )

    def test_vm_reason_redacted(self):
        self.hidden.delete()
        self.hidden = self.make_vm("secret-core", site=self.site_b)
        sync_nodes(self.conn)
        self.assertEqual(self.rows()["secret-core"], "2 nodes match a virtual machine.")

    def test_sync_response_is_redacted(self):
        user = self.member((["*"], ["view", "add", "change"], self.site_a), username="op")
        self.login(user)
        r = self.client.post(f"/api/oxidized/connections/{self.conn.id}/sync/")
        self.assertEqual(r.status_code, 200, r.content)
        reasons = {row["full_name"]: row["reason"] for row in r.json()["unmatched"]}
        self.assertEqual(reasons["secret-core"], "2 nodes match a device.")
        self.assertNotIn(str(self.hidden.id), r.content.decode())

    def test_summary_from_before_targets_is_redacted(self):
        def row(full, reason):
            return {"full_name": full, "name": full, "ip": "", "model": "", "reason": reason}

        self.conn.last_sync_summary = {"unmatched": [
            row("a", "secret-core is linked to node b."),
            row("c", "2 nodes match secret-core.example.net."),
            row("d", "No device or virtual machine matches."),
        ], "unmatched_count": 3}
        self.conn.save()
        got = self.rows()
        self.assertEqual(got["a"], "A device or virtual machine is linked to node b.")
        self.assertEqual(got["c"], "2 nodes match a device or virtual machine.")
        self.assertEqual(got["d"], "No device or virtual machine matches.")
        self.assertEqual(self.rows(user=self.admin)["a"], "secret-core is linked to node b.")
