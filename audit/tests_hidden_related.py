"""The change log names a related row only when the caller may view it
(#413): an address the caller can read must not reveal, through its history,
the device or interface of another site it is bound to."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.db import connection
from django.test.utils import CaptureQueriesContext

from api.models import Device, Interface, IPAddress, Site
from api.test_utils import status_for
from api.tests_site_scope_gaps import SiteBIpFixture
from audit.models import ChangeLogEntry
from auth_api.api import assemble_site_role
from core.models import Organization, Tenant


class _SharedIpBoundToHiddenDevice(SiteBIpFixture):
    def setUp(self):
        super().setUp()
        # A shared address bound to the site-B device, then moved off it, so
        # its history holds the hidden rows on both sides of a diff.
        self.ip_shared.assigned_interface = self.eth0
        self.ip_shared.switch = self.dev_b
        self.ip_shared.save()
        self.dev_a = Device.objects.create(tenant=self.tenant, name="a-srv", site=self.site_a)
        self.ip_shared.switch = self.dev_a
        self.ip_shared.save()
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self._login()

    def _history(self):
        r = self.client.get(
            f"/api/changelog/?object_type=api.ipaddress&object_id={self.ip_shared.id}"
        )
        self.assertEqual(r.status_code, 200, r.content)
        return r

    def _secrets(self):
        return ("b-payroll-srv", str(self.dev_b.id), str(self.eth0.id), "eth0")


class ChangeLogListHidesRelatedTests(_SharedIpBoundToHiddenDevice):
    def test_list_names_no_hidden_row(self):
        r = self._history()
        body = r.content.decode()
        for secret in self._secrets():
            self.assertNotIn(secret, body)

    def test_hidden_side_is_null_and_flagged(self):
        rows = self._history().json()["results"]
        moves = [row for row in rows if "switch" in row["changes"]]
        diffs = [row["changes"]["switch"] for row in moves]
        to_b = next(d for d in diffs if d.get("new_hidden"))
        self.assertIsNone(to_b["new"])
        self.assertNotIn("new_label", to_b)
        to_a = next(d for d in diffs if d.get("old_hidden") and not d.get("new_hidden"))
        self.assertIsNone(to_a["old"])
        # The row the caller can see keeps its id and name.
        self.assertEqual(to_a["new"], str(self.dev_a.id))
        self.assertEqual(to_a["new_label"], "a-srv")

    def test_visible_catalog_and_prefix_keep_labels(self):
        st = status_for(self.tenant)
        ChangeLogEntry.objects.create(
            tenant=self.tenant, action="update", object_type="api.ipaddress",
            object_label="IP address", object_id=str(self.ip_shared.id),
            object_repr=str(self.ip_shared),
            changes={
                "prefix": {"old": str(self.pfx_b.id), "new": str(self.pfx_shared.id)},
                "status": {"old": None, "new": str(st.id)},
            },
        )
        rows = self._history().json()["results"]
        diff = next(row for row in rows if "prefix" in row["changes"])["changes"]
        self.assertEqual(diff["prefix"]["new_label"], str(self.pfx_shared))
        self.assertTrue(diff["prefix"]["old_hidden"])
        self.assertIsNone(diff["prefix"]["old"])
        self.assertEqual(diff["status"]["new_label"], str(st))

    def test_global_list_hides_too(self):
        r = self.client.get("/api/changelog/?object_type=api.ipaddress&page_size=100")
        self.assertEqual(r.status_code, 200)
        for secret in ("b-payroll-srv", str(self.dev_b.id), str(self.eth0.id)):
            self.assertNotIn(secret, r.content.decode())

    def test_superuser_sees_names(self):
        admin = User.objects.create_superuser("root", password="x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        body = self._history().content.decode()
        self.assertIn("b-payroll-srv", body)
        self.assertNotIn("_hidden", body)


class ChangeLogDetailHidesRelatedTests(_SharedIpBoundToHiddenDevice):
    def _details(self):
        out = []
        for row in self._history().json()["results"]:
            d = self.client.get(f"/api/changelog/{row['id']}/")
            self.assertEqual(d.status_code, 200, d.content)
            out.append(d)
        return out

    def test_detail_names_no_hidden_row(self):
        for d in self._details():
            body = d.content.decode()
            for secret in self._secrets():
                self.assertNotIn(secret, body)

    def test_snapshots_null_hidden_values(self):
        bound = [
            d.json() for d in self._details()
            if "switch" in (d.json()["hidden_related"]["post_change"])
        ]
        self.assertTrue(bound)
        entry = bound[0]
        self.assertIsNone(entry["post_change"]["switch"])
        self.assertIsNone(entry["post_change"]["assigned_interface"])
        self.assertIn("assigned_interface", entry["hidden_related"]["post_change"])
        # The visible prefix is still named.
        self.assertEqual(entry["post_change"]["prefix"], str(self.pfx_shared.id))
        self.assertEqual(entry["related_labels"][str(self.pfx_shared.id)], str(self.pfx_shared))


class ChangeLogOtherTenantRowTests(SiteBIpFixture):
    """An unscoped grant still never names another tenant's row."""

    def test_foreign_tenant_site_is_hidden(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        foreign = Site.objects.create(tenant=other, name="Foreign HQ")
        ChangeLogEntry.objects.create(
            tenant=self.tenant, action="update", object_type="api.prefix",
            object_label="Prefix", object_id=str(self.pfx_shared.id),
            object_repr=str(self.pfx_shared),
            changes={"site": {"old": None, "new": str(foreign.id)}},
        )
        self._grant(["prefix", "site"], sites=[])
        self._login()
        r = self.client.get(
            f"/api/changelog/?object_type=api.prefix&object_id={self.pfx_shared.id}"
        )
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("Foreign HQ", r.content.decode())
        self.assertNotIn(str(foreign.id), r.content.decode())


class ChangeLogScopedPageCostTests(SiteBIpFixture):
    """A scoped reader's page costs the same number of queries at any size:
    one visibility and one label query per related model."""

    def setUp(self):
        super().setUp()
        st = status_for(self.tenant)
        for i in range(12):
            dev = Device.objects.create(tenant=self.tenant, name=f"b-{i}", site=self.site_b)
            iface = Interface.objects.create(device=dev, name=f"e{i}")
            ip = IPAddress.objects.create(
                tenant=self.tenant, ip_address=f"10.250.0.{20 + i}",
                prefix=self.pfx_shared, status=st,
            )
            ip.assigned_interface = iface
            ip.switch = dev
            ip.save()
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self._login()

    def _queries(self, url):
        self.client.get(url)
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx.captured_queries), r

    def test_page_cost_is_flat(self):
        base = "/api/changelog/?object_type=api.ipaddress&action=update"
        small, _ = self._queries(f"{base}&page_size=2")
        big, r = self._queries(f"{base}&page_size=12")
        self.assertEqual(small, big, "a bigger page must not cost more queries")
        self.assertNotIn('"b-', r.content.decode())
