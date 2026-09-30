"""A virtual chassis through the SLA API: adding one, who sees its figure,
and the list columns for stacks and their member devices."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from django.utils import timezone

from api.models import Device, DeviceRole, DeviceType, Manufacturer, VirtualChassis
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import SlaMember, StateTransition
from .tests_sla_api import A, _Base

VC = "api.virtualchassis"
ADD = "/api/monitoring/sla-members/bulk-add/"
STATUS = "/api/monitoring/sla-status/"


class _StackBase(_Base):
    """sw1 at Alpha: a1 (with the address) is master, a2 has none."""

    def setUp(self):
        super().setUp()
        self.vc = VirtualChassis.objects.create(tenant=self.tenant, name="sw1")
        self.a2 = Device.objects.create(
            tenant=self.tenant, name="a2", device_type=self.dtype, role=self.role,
            site=self.site_a, status=status_for(self.tenant),
        )
        for pos, d in ((1, self.dev_a), (2, self.a2)):
            d.virtual_chassis = self.vc
            d.vc_position = pos
            d.save()
        self.vc.master = self.dev_a
        self.vc.save()
        a = self.agreement()
        self.agreement_id = a["id"]
        self.group_id = self.group(a["id"])["id"]

    def add(self, *objs, **kw):
        return self.client.post(ADD, {
            "agreement": self.agreement_id, "group": self.group_id,
            "objects": [{"object_type": t, "object_id": str(i)} for t, i in objs], **kw,
        }, format="json")

    def viewer(self, name, site, types=("slaagreement", "virtualchassis", "device")):
        """Can view (and add to) SLAs; sees devices at ``site`` only."""
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        for t in types:
            perm = ObjectPermission.objects.create(
                name=f"{name}-{t}", object_types=[t],
                actions=["view", "add", "change"] if t == "slaagreement" else ["view"],
            )
            perm.users.add(user)
            perm.tenants.add(self.tenant)
            if t == "device":
                perm.sites.add(site)
        return user


class AddStackTests(_StackBase):
    def test_bulk_add_a_chassis_at_its_masters_site(self):
        r = self.add((VC, self.vc.id))
        self.assertEqual(r.json(), {"created": 1, "skipped": 0}, r.content)
        m = SlaMember.objects.get(object_type=VC)
        self.assertEqual(m.object_site_id, self.site_a.id)
        rows = self.client.get(
            f"/api/monitoring/sla-members/?agreement={self.agreement_id}").json()["results"]
        self.assertEqual(rows[0]["object"]["name"], "sw1")

    def test_a_chassis_of_another_tenant_is_refused(self):
        org = Organization.objects.create(name="O", slug="o")
        other = Tenant.objects.create(org=org, name="O", slug="o")
        foreign = VirtualChassis.objects.create(tenant=other, name="theirs")
        self.assertEqual(self.add((VC, foreign.id)).status_code, 400)

    def test_an_empty_chassis_is_refused(self):
        empty = VirtualChassis.objects.create(tenant=self.tenant, name="empty")
        r = self.add((VC, empty.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("without members", str(r.json()))

    def test_a_viewer_who_cannot_see_the_master_cannot_add_the_stack(self):
        self.login(self.viewer("bravo", self.site_b))
        self.assertEqual(self.add((VC, self.vc.id)).status_code, 403)
        self.login(self.viewer("alpha", self.site_a))
        self.assertEqual(self.add((VC, self.vc.id)).status_code, 200)

    def test_a_group_role_from_another_tenant_is_refused(self):
        org = Organization.objects.create(name="O", slug="o")
        other = Tenant.objects.create(org=org, name="O", slug="o")
        role = DeviceRole.objects.create(tenant=other, name="R", slug="r")
        r = self.client.patch(
            f"/api/monitoring/sla-check-groups/{self.group_id}/",
            {"use_selector": True, "match_roles": [str(role.id)]}, format="json",
        )
        self.assertEqual(r.status_code, 400)


class _WithStackFigures(_StackBase):
    """sw1 and b1 in the agreement; sw1's master down the last hour."""

    def setUp(self):
        super().setUp()
        self.add((VC, self.vc.id), ("api.device", self.dev_b.id))
        SlaMember.objects.filter(agreement_id=self.agreement_id).update(
            joined_at=timezone.now() - timedelta(days=60))
        StateTransition.objects.create(
            tenant=self.tenant, target_ip=self.dev_a.primary_ip, template=self.ping,
            kind="icmp", from_status="up", to_status="down",
            at=timezone.now() - timedelta(hours=1),
        )
        r = self.client.post(f"{A}{self.agreement_id}/recompute/")
        self.assertEqual(r.status_code, 200, r.content)


class StackFigureTests(_WithStackFigures):
    def test_the_stack_is_one_member_measured_on_the_master(self):
        body = self.client.get(f"{A}{self.agreement_id}/figures/").json()
        names = {m["name"]: m for m in body["members"]}
        self.assertEqual(set(names), {"sw1", "b1"})
        self.assertLess(names["sw1"]["availability"], 100)
        csv = self.client.get(f"{A}{self.agreement_id}/report/?file=csv").content.decode()
        self.assertIn("sw1,virtualchassis,", csv)

    def test_a_viewer_at_another_site_does_not_see_the_stack(self):
        self.login(self.viewer("bravo", self.site_b))
        body = self.client.get(f"{A}{self.agreement_id}/figures/").json()
        self.assertEqual([m["name"] for m in body["members"]], ["b1"])
        self.assertEqual(body["limited"], {"hidden_members": 1})
        self.assertEqual(body["figures"]["availability"], 100.0)
        analysis = self.client.get(f"{A}{self.agreement_id}/analysis/").json()
        self.assertEqual([m["name"] for m in analysis["by_member"]], ["b1"])

    def test_a_viewer_at_the_masters_site_sees_it(self):
        self.login(self.viewer("alpha", self.site_a))
        body = self.client.get(f"{A}{self.agreement_id}/figures/").json()
        self.assertEqual([m["name"] for m in body["members"]], ["sw1"])
        r = self.client.get(f"{A}{self.agreement_id}/analysis/?member={self.vc.id}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([m["name"] for m in r.json()["by_member"]], ["sw1"])

    def test_a_viewer_without_chassis_permission_does_not_see_it(self):
        self.login(self.viewer("devonly", self.site_a, types=("slaagreement", "device")))
        body = self.client.get(f"{A}{self.agreement_id}/figures/").json()
        self.assertEqual(body["members"], [])


class StackStatusTests(_WithStackFigures):
    def post(self, **body):
        r = self.client.post(STATUS, body, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["results"]

    def test_the_vc_kind_lists_the_stacks_figure_and_measured_address(self):
        org = Organization.objects.create(name="O", slug="o")
        other = Tenant.objects.create(org=org, name="O", slug="o")
        foreign = VirtualChassis.objects.create(tenant=other, name="theirs")
        got = self.post(kind="vc", ids=[str(self.vc.id), str(foreign.id)])
        self.assertEqual(list(got), [str(self.vc.id)])
        entry = got[str(self.vc.id)]
        self.assertEqual(entry["lowest"]["agreement"]["name"], "Gold")
        self.assertEqual(entry["measured"]["device"]["name"], "a1")
        self.assertEqual(entry["measured"]["ip"]["address"], "10.0.0.1")

    def test_a_stack_members_device_gets_the_stacks_figure(self):
        got = self.post(kind="device", ids=[str(self.a2.id), str(self.dev_b.id)])
        [entry] = got[str(self.a2.id)]["sla"]
        self.assertEqual(entry["via_stack"], {"id": str(self.vc.id), "name": "sw1"})
        self.assertNotIn("via_stack", got[str(self.dev_b.id)]["sla"][0])

    def test_the_stack_stays_hidden_from_another_sites_viewer(self):
        self.login(self.viewer("bravo", self.site_b))
        self.assertEqual(self.post(kind="vc", ids=[str(self.vc.id)]), {})


class SelectorTypeTests(_StackBase):
    def test_role_and_type_selectors_fold_the_stack(self):
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="N", slug="n")
        other = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="Y", name="Y")
        self.dev_b.device_type = other
        self.dev_b.save()
        r = self.client.patch(
            f"/api/monitoring/sla-check-groups/{self.group_id}/",
            {"use_selector": True, "match_roles": [str(self.role.id)],
             "match_device_types": [str(self.dtype.id)]}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.client.patch(f"{A}{self.agreement_id}/", {"status": "active"}, format="json")
        self.client.post(f"{A}{self.agreement_id}/recompute/")
        body = self.client.get(f"{A}{self.agreement_id}/figures/").json()
        self.assertEqual([m["name"] for m in body["members"]], ["sw1"])
        self.assertTrue(body["members"][0]["selected"])
