"""Bulk edit and safe bulk delete on the L2VPN list, and the VRF bulk edit on
the virtual switch list: the dry run names what goes with the overlays, the
writes stay in the caller's tenant and grant and are logged, a VRF lands only
on an EVPN overlay (the edit form's rule, per row), and a switch - filled by
the sync - takes only its VRF."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import L2VPN, VLAN, VRF, L2VPNTermination, Status, VirtualSwitch
from audit.models import ChangeAction, ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, Tenant

L2VPNS = "/api/l2vpns/"
SWITCHES = "/api/virtual-switches/"


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        other_org = Organization.objects.create(name="Other", slug="other")
        self.other = Tenant.objects.create(org=other_org, name="Other", slug="other")
        self.login(User.objects.create_superuser("root", "r@a.c", "pw"))

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def member(self, slug, actions):
        user = User.objects.create_user("member", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(name="p", object_types=[slug],
                                               actions=list(actions))
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.login(user)

    def delete(self, url, ids, dry_run=False):
        return self.client.post(f"{url}bulk-delete/",
                                {"ids": [str(i) for i in ids], "dry_run": dry_run},
                                format="json")

    def update(self, url, ids, fields):
        return self.client.post(f"{url}bulk-update/",
                                {"ids": [str(i) for i in ids], "fields": fields},
                                format="json")

    def fields(self, url):
        r = self.client.get(f"{url}bulk-edit-fields/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


class L2VPNBulkTests(_Base):
    def setUp(self):
        super().setUp()
        self.vxlan = L2VPN.objects.create(tenant=self.tenant, name="Blue", slug="blue",
                                          type="vxlan", identifier=10100)
        self.evpn = L2VPN.objects.create(tenant=self.tenant, name="Red", slug="red",
                                         type="vxlan-evpn", identifier=10200)
        self.theirs = L2VPN.objects.create(tenant=self.other, name="Blue", slug="blue",
                                           type="vxlan")
        vlan = VLAN.objects.create(tenant=self.tenant, vlan_id=100, name="v100")
        L2VPNTermination.objects.create(l2vpn=self.vxlan, vlan=vlan)

    def test_dry_run_counts_the_terminations(self):
        r = self.delete(L2VPNS, [self.vxlan.id, self.evpn.id], dry_run=True)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["deleted"], 2)
        self.assertEqual(body["impact"], [{"label": "L2VPN terminations", "count": 1}])
        self.assertEqual(L2VPN.objects.filter(tenant=self.tenant).count(), 2)

    def test_delete_stays_in_the_tenant_and_logs(self):
        r = self.delete(L2VPNS, [self.vxlan.id, self.theirs.id])
        self.assertEqual(r.json()["deleted"], 1)
        self.assertFalse(L2VPN.objects.filter(pk=self.vxlan.pk).exists())
        self.assertTrue(L2VPN.objects.filter(pk=self.theirs.pk).exists())
        self.assertTrue(ChangeLogEntry.objects.filter(
            action=ChangeAction.DELETE, object_id=str(self.vxlan.pk)).exists())

    def test_edit_fields(self):
        body = self.fields(L2VPNS)
        self.assertEqual([f["key"] for f in body["fields"]],
                         ["status_id", "vrf_id", "description"])
        self.assertTrue(body["tags"])
        self.assertEqual(body["custom_fields"], "l2vpn")

    def test_edit_writes_status_description_and_tags(self):
        status = Status.objects.create(tenant=self.tenant, name="Live", slug="live",
                                       available_to=["l2vpn"])
        tag = Tag.objects.create(tenant=self.tenant, name="core", slug="core")
        r = self.update(L2VPNS, [self.vxlan.id, self.evpn.id, self.theirs.id], {
            "status_id": str(status.id), "description": "fabric", "add_tag_ids": [tag.id],
        })
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 2)
        self.vxlan.refresh_from_db()
        self.theirs.refresh_from_db()
        self.assertEqual((self.vxlan.status_id, self.vxlan.description), (status.id, "fabric"))
        self.assertEqual([t.slug for t in self.vxlan.tags.all()], ["core"])
        self.assertEqual(self.theirs.description, "")
        self.assertTrue(ChangeLogEntry.objects.filter(
            action=ChangeAction.UPDATE, object_id=str(self.vxlan.pk)).exists())

    def test_a_vrf_only_lands_on_an_evpn_overlay(self):
        vrf = VRF.objects.create(tenant=self.tenant, name="prod")
        r = self.update(L2VPNS, [self.evpn.id, self.vxlan.id], {"vrf_id": str(vrf.id)})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("Blue", str(r.json()))
        self.evpn.refresh_from_db()
        self.assertIsNone(self.evpn.vrf_id)
        r = self.update(L2VPNS, [self.evpn.id], {"vrf_id": str(vrf.id)})
        self.assertEqual(r.status_code, 200, r.content)
        self.evpn.refresh_from_db()
        self.assertEqual(self.evpn.vrf_id, vrf.id)

    def test_another_tenants_vrf_is_refused(self):
        foreign = VRF.objects.create(tenant=self.other, name="x")
        r = self.update(L2VPNS, [self.evpn.id], {"vrf_id": str(foreign.id)})
        self.assertEqual(r.status_code, 400, r.content)

    def test_the_grants(self):
        self.member("l2vpn", ["view", "change"])
        self.assertEqual(self.delete(L2VPNS, [self.evpn.id]).status_code, 403)
        self.assertEqual(self.update(L2VPNS, [self.evpn.id], {"description": "x"}).status_code,
                         200)


class VirtualSwitchBulkTests(_Base):
    def setUp(self):
        super().setUp()
        self.a = VirtualSwitch.objects.create(tenant=self.tenant, name="vmbr0")
        self.b = VirtualSwitch.objects.create(tenant=self.tenant, name="vmbr1")
        self.theirs = VirtualSwitch.objects.create(tenant=self.other, name="vmbr0")
        self.vrf = VRF.objects.create(tenant=self.tenant, name="prod")

    def test_edit_sets_the_vrf_in_the_tenant_only(self):
        self.assertEqual([f["key"] for f in self.fields(SWITCHES)["fields"]], ["vrf_id"])
        r = self.update(SWITCHES, [self.a.id, self.b.id, self.theirs.id],
                        {"vrf_id": str(self.vrf.id)})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 2)
        self.a.refresh_from_db()
        self.theirs.refresh_from_db()
        self.assertEqual(self.a.vrf_id, self.vrf.id)
        self.assertIsNone(self.theirs.vrf_id)
        self.assertTrue(ChangeLogEntry.objects.filter(
            action=ChangeAction.UPDATE, object_id=str(self.a.pk)).exists())
        foreign = VRF.objects.create(tenant=self.other, name="x")
        r = self.update(SWITCHES, [self.a.id], {"vrf_id": str(foreign.id)})
        self.assertEqual(r.status_code, 400, r.content)

    def test_edit_refuses_sync_owned_fields(self):
        self.assertEqual(self.update(SWITCHES, [self.a.id], {"mtu": 9000}).status_code, 400)

    def test_view_only_may_not_edit(self):
        self.member("virtualswitch", ["view"])
        r = self.update(SWITCHES, [self.a.id], {"vrf_id": str(self.vrf.id)})
        self.assertEqual(r.status_code, 403, r.content)
