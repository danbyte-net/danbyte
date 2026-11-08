"""Bulk select on the Oxidized linked nodes: unlink is the safe bulk delete,
each link going as its single unlink does (the node remembers its device);
confirm takes each proposed link through the single confirm's rules."""
from __future__ import annotations

from api.models import Device

from .models import OxidizedNode, OxidizedNodeLink
from .tests import _Base

URL = "/api/oxidized/links/"


class LinkBulkTests(_Base):
    def setUp(self):
        super().setUp()
        self.dev2 = Device.objects.create(tenant=self.tenant, name="sw2", site=self.site_a)
        self.a = self.link(full="core/sw1")
        self.b = self.link(device=self.dev2, full="core/sw2")
        self.b.proposed = True
        self.b.save(update_fields=["proposed"])
        self.login()

    def post(self, action, ids, **body):
        return self.client.post(f"{URL}{action}/", {"ids": [str(i) for i in ids], **body},
                                format="json")

    def test_unlink_previews_then_unlinks_and_the_node_remembers(self):
        r = self.post("bulk-delete", [self.a.id, self.b.id], dry_run=True)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(sorted(r.json()["deleted_ids"]), sorted([str(self.a.id), str(self.b.id)]))
        self.assertEqual(OxidizedNodeLink.objects.count(), 2)
        r = self.post("bulk-delete", [self.a.id, self.b.id])
        self.assertEqual(r.json()["deleted"], 2)
        self.assertFalse(OxidizedNodeLink.objects.exists())
        node = OxidizedNode.objects.get(full_name="core/sw1")
        self.assertEqual(node.last_device_id, self.device.id)

    def test_unlink_keeps_links_of_a_connection_the_caller_may_not_change(self):
        user = self.member((["oxidizednodelink"], ["view", "delete"], None),
                           (["oxidizedconnection"], ["view"], None))
        self.login(user)
        r = self.post("bulk-delete", [self.a.id])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted"], 0)
        self.assertEqual(r.json()["skipped"][0]["reason"],
                         "Unlinking needs the change permission on its connection.")
        self.assertTrue(OxidizedNodeLink.objects.filter(pk=self.a.pk).exists())

    def test_unlink_needs_the_delete_grant(self):
        user = self.member((["oxidizednodelink"], ["view"], None),
                           (["oxidizedconnection"], ["view", "change"], None))
        self.login(user)
        self.assertEqual(self.post("bulk-delete", [self.a.id]).status_code, 403)

    def test_confirm_takes_the_proposed_and_names_the_rest(self):
        r = self.post("bulk-confirm", [self.a.id, self.b.id])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["confirmed"], [str(self.b.id)])
        self.assertEqual(r.json()["skipped"], [{
            "id": str(self.a.id), "name": "core/sw1", "reason": "This link is not proposed.",
        }])
        self.b.refresh_from_db()
        self.assertFalse(self.b.proposed)

    def test_confirm_needs_change_on_the_connection(self):
        user = self.member((["oxidizednodelink"], ["view", "add"], None),
                           (["oxidizedconnection"], ["view"], None),
                           (["device"], ["view"], None))
        self.login(user)
        r = self.post("bulk-confirm", [self.b.id])
        self.assertEqual(r.json()["confirmed"], [])
        self.b.refresh_from_db()
        self.assertTrue(self.b.proposed)

    def test_another_tenants_links_fall_out(self):
        self.login(tenant=self.other_tenant)
        r = self.post("bulk-delete", [self.a.id])
        self.assertIn(r.status_code, (200, 404))
        self.assertTrue(OxidizedNodeLink.objects.filter(pk=self.a.pk).exists())
