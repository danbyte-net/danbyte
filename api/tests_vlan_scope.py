"""VLAN IDs are scoped, not tenant-global (#159).

Kyiv VLAN 105 and Warsaw VLAN 105 are different broadcast domains that share
a number. The constraint was tenant-wide, so the second one was refused; now
the namespace is the group, or - ungrouped - the site.

The other half of the change matters more than the constraint: everything
that resolves a bare VID it read off a switch or a hypervisor now has to say
whose 105 it means, and must decline rather than guess.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import VLAN, Cluster, ClusterType, Site, VLANGroup
from .vlan_scope import resolve_vid

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.kyiv = Site.objects.create(tenant=self.tenant, name="Kyiv")
        self.warsaw = Site.objects.create(tenant=self.tenant, name="Warsaw")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def post_vlan(self, vid, site=None, group=None, name="Users"):
        body = {"vlan_id": vid, "name": name}
        if site is not None:
            body["site_id"] = str(site.id)
        if group is not None:
            body["group_id"] = str(group.id)
        return self.client.post("/api/vlans/", body, format="json")


class UniquenessTests(_Base):
    def test_same_vid_at_two_sites_is_allowed(self):
        self.assertEqual(self.post_vlan(105, self.kyiv).status_code, 201)
        resp = self.post_vlan(105, self.warsaw)
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(VLAN.objects.filter(vlan_id=105).count(), 2)

    def test_same_vid_twice_at_one_site_is_refused(self):
        self.assertEqual(self.post_vlan(105, self.kyiv).status_code, 201)
        resp = self.post_vlan(105, self.kyiv, name="Users again")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("Kyiv", str(resp.json()))

    def test_site_less_vlans_stay_unique_per_tenant(self):
        """No site is not "every site" - it is one tenant-wide VLAN."""
        self.assertEqual(self.post_vlan(105).status_code, 201)
        resp = self.post_vlan(105, name="Dupe")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("no site", str(resp.json()))

    def test_a_group_still_scopes_the_vid_across_sites(self):
        grp = VLANGroup.objects.create(
            tenant=self.tenant, name="Campus", slug="campus"
        )
        self.assertEqual(self.post_vlan(105, self.kyiv, grp).status_code, 201)
        resp = self.post_vlan(105, self.warsaw, grp)
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertIn("Campus", str(resp.json()))

    def test_editing_a_vlan_does_not_collide_with_itself(self):
        made = self.post_vlan(105, self.kyiv).json()
        resp = self.client.patch(
            f"/api/vlans/{made['id']}/", {"name": "Renamed"}, format="json"
        )
        self.assertEqual(resp.status_code, 200, resp.content)


class ResolveVidTests(_Base):
    """The resolver every VID-consuming integration goes through."""

    def test_prefers_the_vlan_at_the_asking_site(self):
        k = VLAN.objects.create(
            tenant=self.tenant, vlan_id=105, name="K", site=self.kyiv
        )
        VLAN.objects.create(
            tenant=self.tenant, vlan_id=105, name="W", site=self.warsaw
        )
        vlan, why = resolve_vid(self.tenant, 105, site=self.kyiv)
        self.assertEqual((vlan, why), (k, "site"))

    def test_declines_when_the_vid_means_two_things(self):
        """The whole point: no site to check against and two candidates, so
        the answer is nothing, not a coin flip."""
        VLAN.objects.create(
            tenant=self.tenant, vlan_id=105, name="K", site=self.kyiv
        )
        VLAN.objects.create(
            tenant=self.tenant, vlan_id=105, name="W", site=self.warsaw
        )
        vlan, why = resolve_vid(self.tenant, 105, site=None)
        self.assertIsNone(vlan)
        self.assertEqual(why, "ambiguous")

    def test_a_site_with_no_vlan_of_its_own_does_not_borrow_another_site(self):
        VLAN.objects.create(
            tenant=self.tenant, vlan_id=105, name="K", site=self.kyiv
        )
        VLAN.objects.create(
            tenant=self.tenant, vlan_id=105, name="W", site=self.warsaw
        )
        third = Site.objects.create(tenant=self.tenant, name="Riga")
        vlan, why = resolve_vid(self.tenant, 105, site=third)
        self.assertIsNone(vlan)
        self.assertEqual(why, "ambiguous")

    def test_a_tenant_wide_vlan_answers_for_any_site(self):
        v = VLAN.objects.create(tenant=self.tenant, vlan_id=105, name="Mgmt")
        vlan, why = resolve_vid(self.tenant, 105, site=self.kyiv)
        self.assertEqual((vlan, why), (v, "global"))

    def test_matches_a_group_scoped_to_the_site(self):
        grp = VLANGroup.objects.create(
            tenant=self.tenant, name="Kyiv campus", slug="kyiv-campus",
            site=self.kyiv,
        )
        v = VLAN.objects.create(
            tenant=self.tenant, vlan_id=105, name="K", group=grp
        )
        VLAN.objects.create(
            tenant=self.tenant, vlan_id=105, name="W", site=self.warsaw
        )
        vlan, why = resolve_vid(self.tenant, 105, site=self.kyiv)
        self.assertEqual((vlan, why), (v, "group"))

    def test_matches_a_group_scoped_to_the_cluster(self):
        ctype = ClusterType.objects.create(
            tenant=self.tenant, name="Proxmox", slug="proxmox"
        )
        cluster = Cluster.objects.create(
            tenant=self.tenant, name="dc1", type=ctype
        )
        grp = VLANGroup.objects.create(
            tenant=self.tenant, name="dc1 nets", slug="dc1-nets", cluster=cluster
        )
        v = VLAN.objects.create(
            tenant=self.tenant, vlan_id=105, name="C", group=grp
        )
        VLAN.objects.create(
            tenant=self.tenant, vlan_id=105, name="W", site=self.warsaw
        )
        vlan, why = resolve_vid(self.tenant, 105, cluster=cluster)
        self.assertEqual((vlan, why), (v, "group"))

    def test_skips_the_excluded_group_prefix(self):
        """Virt sync ignores the VLANs it minted itself, so a resync matches
        the operator's VLAN rather than its own copy."""
        mine = VLANGroup.objects.create(
            tenant=self.tenant, name="virt", slug="virt-abc"
        )
        VLAN.objects.create(
            tenant=self.tenant, vlan_id=105, name="synced", group=mine
        )
        theirs = VLAN.objects.create(
            tenant=self.tenant, vlan_id=105, name="Users", site=self.kyiv
        )
        vlan, _ = resolve_vid(
            self.tenant, 105, site=self.kyiv, exclude_group_prefix="virt-"
        )
        self.assertEqual(vlan, theirs)

    def test_unknown_vid_is_none_not_ambiguous(self):
        vlan, why = resolve_vid(self.tenant, 999, site=self.kyiv)
        self.assertIsNone(vlan)
        self.assertEqual(why, "none")


class VlanVrfTests(_Base):
    """A VLAN documents the VRF its SVI lives in; the VRF lists its VLANs;
    a prefix on the VLAN in another VRF is flagged."""

    def test_link_filter_count_and_mismatch(self):
        from .models import VRF, Prefix

        prod = VRF.objects.create(tenant=self.tenant, name="PROD")
        lab = VRF.objects.create(tenant=self.tenant, name="LAB")
        r = self.client.post("/api/vlans/", {"vlan_id": 10, "name": "servers",
                                             "site_id": str(self.kyiv.id),
                                             "vrf_id": str(prod.id)}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        vlan = r.json()
        self.assertEqual(vlan["vrf"]["name"], "PROD")
        self.post_vlan(20, site=self.kyiv, name="loose")
        rows = self.client.get(f"/api/vlans/?vrf={prod.id}").json()["results"]
        self.assertEqual([x["vlan_id"] for x in rows], [10])
        self.assertEqual(self.client.get(f"/api/vrfs/{prod.id}/").json()["vlan_count"], 1)
        self.assertEqual(self.client.get(f"/api/vrfs/{lab.id}/").json()["vlan_count"], 0)
        ok = Prefix.objects.create(tenant=self.tenant, cidr="10.10.0.0/24", vrf=prod, vlan_id=vlan["id"])
        odd = Prefix.objects.create(tenant=self.tenant, cidr="10.20.0.0/24", vrf=lab, vlan_id=vlan["id"])
        self.assertFalse(self.client.get(f"/api/prefixes/{ok.id}/").json()["vlan_vrf_mismatch"])
        self.assertTrue(self.client.get(f"/api/prefixes/{odd.id}/").json()["vlan_vrf_mismatch"])
