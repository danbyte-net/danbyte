"""The SLA API: revisions, groups, members, exclusions, and figures a
site-scoped viewer may see."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Device, DeviceRole, DeviceType, IPAddress, Manufacturer, Prefix, Site
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from . import sla
from .models import (
    CheckState,
    CheckTemplate,
    SlaAgreement,
    SlaCheckGroup,
    SlaMember,
    SlaPeriodResult,
    StateTransition,
)

A = "/api/monitoring/sla-agreements/"


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site_a = Site.objects.create(tenant=self.tenant, name="Alpha")
        self.site_b = Site.objects.create(tenant=self.tenant, name="Bravo")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant, "container")
        )
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        self.dtype = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="R", slug="r")
        self.ping = CheckTemplate.objects.create(
            tenant=self.tenant, name="Ping", slug="ping", kind="icmp"
        )
        self.dev_a = self.device("a1", 1, self.site_a)
        self.dev_b = self.device("b1", 2, self.site_b)
        self.admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.login(self.admin)

    def device(self, name, n, site):
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address=f"10.0.0.{n}", prefix=self.prefix
        )
        dev = Device.objects.create(
            tenant=self.tenant, name=name, device_type=self.dtype, role=self.role, site=site,
            status=status_for(self.tenant), primary_ip=ip,
        )
        ip.assigned_device = dev
        ip.save()
        CheckState.objects.create(
            tenant=self.tenant, target_ip=ip, template=self.ping, kind="icmp", status="up"
        )
        StateTransition.objects.create(
            tenant=self.tenant, target_ip=ip, template=self.ping, kind="icmp",
            from_status="up", to_status="up", at=timezone.now() - timedelta(days=90),
        )
        return dev

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def agreement(self, **kw):
        r = self.client.post(A, {"name": "Gold", "target_pct": "99.9", "timezone": "UTC", **kw},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def group(self, agreement_id, **kw):
        r = self.client.post(
            "/api/monitoring/sla-check-groups/",
            {"agreement": agreement_id, "name": "Leafs",
             "items": [{"template": str(self.ping.id)}], **kw},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()


class AgreementTests(_Base):
    def test_rule_changes_write_a_revision_and_names_do_not(self):
        a = self.agreement()
        self.assertEqual(a["revision"], 1)
        self.client.patch(f"{A}{a['id']}/", {"description": "Renamed"}, format="json")
        r = self.client.patch(f"{A}{a['id']}/", {"target_pct": "99.95"}, format="json")
        self.assertEqual(r.json()["revision"], 2)
        revs = self.client.get(f"{A}{a['id']}/revisions/").json()
        self.assertEqual([x["number"] for x in revs], [2, 1])

    def test_validation(self):
        bad = [
            {"target_pct": "101"},
            {"timezone": "Mars/Olympus"},
            {"service_hours": {"funday": [["08:00", "17:00"]]}},
            {"service_hours": {"mon": [["17:00", "08:00"]]}},
            {"warning_pct": "99.0"},  # below the 99.9 target
        ]
        for extra in bad:
            r = self.client.post(A, {"name": "X", "target_pct": "99.9", **extra}, format="json")
            self.assertEqual(r.status_code, 400, extra)

    def test_group_items_are_written_and_foreign_templates_refused(self):
        a = self.agreement()
        g = self.group(a["id"])
        self.assertEqual([i["template_name"] for i in g["items"]], ["Ping"])
        org = Organization.objects.create(name="O", slug="o")
        other = Tenant.objects.create(org=org, name="O", slug="o")
        foreign = CheckTemplate.objects.create(tenant=other, name="P", slug="p", kind="icmp")
        r = self.client.patch(
            f"/api/monitoring/sla-check-groups/{g['id']}/",
            {"items": [{"template": str(foreign.id)}]}, format="json",
        )
        self.assertEqual(r.status_code, 400)


class MemberTests(_Base):
    def test_bulk_add_skip_and_leave(self):
        a = self.agreement()
        g = self.group(a["id"])
        body = {"agreement": a["id"], "group": g["id"], "objects": [
            {"object_type": "api.device", "object_id": str(self.dev_a.id)},
            {"object_type": "api.device", "object_id": str(self.dev_b.id)},
        ]}
        r = self.client.post("/api/monitoring/sla-members/bulk-add/", body, format="json")
        self.assertEqual(r.json(), {"created": 2, "skipped": 0})
        r = self.client.post("/api/monitoring/sla-members/bulk-add/", body, format="json")
        self.assertEqual(r.json(), {"created": 0, "skipped": 2})
        m = SlaMember.objects.get(object_id=self.dev_a.id)
        self.assertEqual(m.object_site_id, self.site_a.id)
        # Removing keeps the row, marked as left.
        self.client.delete(f"/api/monitoring/sla-members/{m.id}/")
        m.refresh_from_db()
        self.assertIsNotNone(m.left_at)

    def test_a_foreign_object_is_refused(self):
        a = self.agreement()
        g = self.group(a["id"])
        org = Organization.objects.create(name="O", slug="o")
        other = Tenant.objects.create(org=org, name="O", slug="o")
        site = Site.objects.create(tenant=other, name="Z")
        mfr = Manufacturer.objects.create(tenant=other, name="M", slug="m")
        dev = Device.objects.create(
            tenant=other, name="z", site=site, status=status_for(other),
            device_type=DeviceType.objects.create(tenant=other, manufacturer=mfr, model="X"),
            role=DeviceRole.objects.create(tenant=other, name="R", slug="r"),
        )
        r = self.client.post("/api/monitoring/sla-members/", {
            "agreement": a["id"], "group": g["id"], "object_type": "api.device",
            "object_id": str(dev.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)

    def test_a_group_of_another_agreement_is_refused(self):
        a = self.agreement()
        b = self.agreement(name="Silver")
        g = self.group(b["id"])
        r = self.client.post("/api/monitoring/sla-members/", {
            "agreement": a["id"], "group": g["id"], "object_type": "api.device",
            "object_id": str(self.dev_a.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)


class ExclusionTests(_Base):
    def test_reason_required_and_frozen_periods_locked(self):
        a = self.agreement()
        agreement = SlaAgreement.objects.get(pk=a["id"])
        now = timezone.now()
        body = {"agreement": a["id"], "starts_at": (now - timedelta(hours=2)).isoformat(),
                "ends_at": (now - timedelta(hours=1)).isoformat(), "reason": " "}
        r = self.client.post("/api/monitoring/sla-exclusions/", body, format="json")
        self.assertEqual(r.status_code, 400)
        body["reason"] = "Provider fibre cut"
        self.assertEqual(
            self.client.post("/api/monitoring/sla-exclusions/", body, format="json").status_code,
            201,
        )
        prev = sla.previous_period(agreement, now)
        SlaPeriodResult.objects.create(
            tenant=self.tenant, agreement=agreement, period_key=prev[0],
            period_start=prev[1], period_end=prev[2], state="frozen",
        )
        body["starts_at"] = (prev[1] + timedelta(days=1)).isoformat()
        body["ends_at"] = (prev[1] + timedelta(days=2)).isoformat()
        r = self.client.post("/api/monitoring/sla-exclusions/", body, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("frozen", str(r.json()))


class FiguresScopeTests(_Base):
    def setUp(self):
        super().setUp()
        a = self.agreement()
        g = self.group(a["id"])
        self.agreement_id = a["id"]
        for dev in (self.dev_a, self.dev_b):
            SlaMember.objects.create(
                tenant=self.tenant, agreement_id=a["id"], group_id=g["id"],
                object_type="api.device", object_id=dev.id, object_site=dev.site,
                joined_at=timezone.now() - timedelta(days=60),
            )
        # b1 has been down the last hour.
        StateTransition.objects.create(
            tenant=self.tenant, target_ip=self.dev_b.primary_ip, template=self.ping,
            kind="icmp", from_status="up", to_status="down",
            at=timezone.now() - timedelta(hours=1),
        )
        r = self.client.post(f"{A}{a['id']}/recompute/")
        self.assertEqual(r.status_code, 200, r.content)

    def test_everything_for_an_unscoped_viewer(self):
        body = self.client.get(f"{A}{self.agreement_id}/figures/").json()
        self.assertTrue(body["computed"])
        self.assertIsNone(body["limited"])
        self.assertEqual(body["figures"]["members"], 2)
        self.assertLess(body["figures"]["availability"], 100)
        self.assertEqual(len(body["members"]), 2)

    def test_a_site_scoped_viewer_sees_only_their_members(self):
        viewer = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=viewer, role="custom").tenants.add(self.tenant)
        sla_perm = ObjectPermission.objects.create(
            name="sla", object_types=["slaagreement"], actions=["view"]
        )
        sla_perm.users.add(viewer)
        sla_perm.tenants.add(self.tenant)
        dev_perm = ObjectPermission.objects.create(
            name="dev", object_types=["device"], actions=["view"]
        )
        dev_perm.users.add(viewer)
        dev_perm.tenants.add(self.tenant)
        dev_perm.sites.add(self.site_a)
        self.login(viewer)
        body = self.client.get(f"{A}{self.agreement_id}/figures/").json()
        self.assertEqual(body["limited"], {"hidden_members": 1})
        self.assertEqual([m["name"] for m in body["members"]], ["a1"])
        # b1's outage is not in the figure a1's viewer gets.
        self.assertEqual(body["figures"]["availability"], 100.0)
        self.assertEqual(body["incidents"], [])
        self.assertEqual(body["days"], [])
        listed = self.client.get(A).json()["results"][0]
        self.assertEqual(listed["current"]["figures"]["availability"], 100.0)

    def test_no_sla_permission_no_access(self):
        user = User.objects.create_user("nobody", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(name="v", object_types=["vlan"], actions=["view"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.login(user)
        self.assertEqual(self.client.get(A).status_code, 403)
        self.assertEqual(
            self.client.get(f"/api/monitoring/sla-members/?agreement={self.agreement_id}").status_code,
            403,
        )
        self.assertEqual(SlaCheckGroup.objects.count(), 1)
