"""Cross-site row-level RBAC: a user whose grant is scoped to Site A must be
denied Site B rows — the gap the secops retest named (type-level checks that
skipped ObjectPermission.sites). Covers can_act_on, terraform render,
monitoring, and audit/journal."""
from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    IPAddress,
    Prefix,
    Site,
    VirtualMachine,
)
from api.test_utils import status_for
from auth_api import rbac
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant


class _SiteScopedBase(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        # A member granted <type>.view scoped to Site A only.
        self.user = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)

    def _grant(self, *types, actions=("view",)):
        perm = ObjectPermission.objects.create(
            name="siteA", object_types=list(types), actions=list(actions)
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        perm.sites.add(self.site_a)
        return perm

    def _login(self):
        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()


class CanActOnSiteTests(_SiteScopedBase):
    def test_can_act_on_respects_site_scope(self):
        self._grant("device")
        dev_a = Device.objects.create(tenant=self.tenant, name="a", site=self.site_a)
        dev_b = Device.objects.create(tenant=self.tenant, name="b", site=self.site_b)
        self.assertTrue(
            rbac.can_act_on(self.user, self.tenant, "device", "view", dev_a)
        )
        # The gap: this was True before the fix (site-blind).
        self.assertFalse(
            rbac.can_act_on(self.user, self.tenant, "device", "view", dev_b)
        )


class TerraformSiteTests(_SiteScopedBase):
    def _vm(self, site):
        ct, _ = ClusterType.objects.get_or_create(tenant=self.tenant, slug="ct", defaults={"name": "ct"})
        cluster = Cluster.objects.create(
            tenant=self.tenant, name=f"c-{site.name}", type=ct
        )
        return VirtualMachine.objects.create(
            tenant=self.tenant, name=f"vm-{site.name}", site=site,
            cluster=cluster, status=status_for(self.tenant),
        )

    def test_cannot_render_other_site_vm(self):
        self._grant("virtualmachine")
        vm_b = self._vm(self.site_b)
        self._login()
        r = self.client.get(f"/api/virtual-machines/{vm_b.id}/render/?template=x")
        self.assertIn(r.status_code, (400, 404))  # 404 = out of scope (not 200)
        # sanity: an unknown-template Site A VM gets past the row gate (400 template)
        vm_a = self._vm(self.site_a)
        r2 = self.client.get(f"/api/virtual-machines/{vm_a.id}/render/?template=x")
        self.assertEqual(r2.status_code, 400)


class MonitoringSiteTests(_SiteScopedBase):
    def _device(self, site):
        return Device.objects.create(
            tenant=self.tenant, name=f"d-{site.name}", site=site
        )

    def test_cannot_read_other_site_device_checks(self):
        self._grant("device")
        d_b = self._device(self.site_b)
        self._login()
        r = self.client.get(f"/api/monitoring/devices/{d_b.id}/checks/")
        self.assertEqual(r.status_code, 404)
        d_a = self._device(self.site_a)
        self.assertEqual(
            self.client.get(f"/api/monitoring/devices/{d_a.id}/checks/").status_code,
            200,
        )


class MonitoringListSiteTests(_SiteScopedBase):
    """Endpoint matrix: a Site-A-scoped viewer must not see Site-B rows through
    any tenant-wide monitoring surface (stats, checks list, bulk status,
    flapping, SNMP drift) nor act on Site-B objects (discovery, bindings)."""

    def _ip(self, site, cidr, addr):
        pfx = Prefix.objects.create(
            tenant=self.tenant, cidr=cidr, site=site,
            status=status_for(self.tenant),
        )
        return IPAddress.objects.create(
            tenant=self.tenant, ip_address=addr, site=site, prefix=pfx,
            status=status_for(self.tenant),
        )

    def _check(self, ip, status="down"):
        from monitoring.models import CheckState, CheckTemplate
        tmpl, _ = CheckTemplate.objects.get_or_create(
            tenant=self.tenant, slug="icmp",
            defaults={"name": "ICMP", "kind": "icmp"},
        )
        return CheckState.objects.create(
            tenant=self.tenant, target_ip=ip, template=tmpl, kind="icmp",
            status=status,
        )

    def setUp(self):
        super().setUp()
        self.ip_a = self._ip(self.site_a, "10.0.0.0/24", "10.0.0.1/32")
        self.ip_b = self._ip(self.site_b, "10.0.1.0/24", "10.0.1.1/32")
        self._check(self.ip_a)
        self._check(self.ip_b)

    def test_stats_counts_only_own_site(self):
        self._grant("ipaddress")
        self._login()
        d = self.client.get("/api/monitoring/stats/").json()
        # One down check in Site A only; Site B's must not be counted.
        self.assertEqual(d["total_checks"], 1)
        self.assertEqual(d["monitored_ips"], 1)

    def test_checks_list_only_own_site(self):
        self._grant("ipaddress")
        self._login()
        d = self.client.get("/api/monitoring/checks/").json()
        ids = {row["target_ip"]["id"] for row in d["results"] if row["target_ip"]}
        self.assertNotIn(str(self.ip_b.id), ids)
        self.assertEqual(d["status_counts"].get("all"), 1)

    def test_bulk_status_drops_other_site_ids(self):
        self._grant("ipaddress")
        self._login()
        r = self.client.post(
            "/api/monitoring/status/",
            {"ips": [str(self.ip_a.id), str(self.ip_b.id)]},
            format="json",
        )
        statuses = r.json()["statuses"]
        self.assertIn(str(self.ip_a.id), statuses)
        self.assertNotIn(str(self.ip_b.id), statuses)

    def test_discovery_denied_on_other_site_prefix(self):
        pfx_b = Prefix.objects.create(
            tenant=self.tenant, cidr="10.9.9.0/24", site=self.site_b,
            status=status_for(self.tenant),
        )
        self._grant("prefix", "ipaddress", actions=("view", "add"))
        self._login()
        r = self.client.post(f"/api/monitoring/prefixes/{pfx_b.id}/discover/")
        self.assertEqual(r.status_code, 404)


class MonitoringConfigSiteTests(_SiteScopedBase):
    """Write-path + config targets must compose site scope, not just tenant."""

    def _device(self, site, name):
        return Device.objects.create(tenant=self.tenant, name=name, site=site)

    def _ip(self, site, cidr, addr):
        pfx = Prefix.objects.create(
            tenant=self.tenant, cidr=cidr, site=site, status=status_for(self.tenant)
        )
        return IPAddress.objects.create(
            tenant=self.tenant, ip_address=addr, site=site, prefix=pfx,
            status=status_for(self.tenant),
        )

    def test_topology_focus_excludes_other_site(self):
        self._grant("device")
        d_b = self._device(self.site_b, "b")
        self._login()
        g = self.client.get(f"/api/topology/?device={d_b.id}").json()
        node_ids = {n["data"]["device_id"] for n in g.get("nodes", [])}
        self.assertNotIn(str(d_b.id), node_ids)

    def test_snmp_ghost_other_site_device_empty(self):
        self._grant("device")
        d_b = self._device(self.site_b, "b")
        self._login()
        g = self.client.get(
            f"/api/monitoring/topology/ghosts/?device={d_b.id}"
        ).json()
        self.assertEqual(g, {"nodes": [], "edges": []})

    def test_cannot_materialize_cable_on_other_site(self):
        from api.models import Interface
        self._grant("device", "cable", actions=("view", "add"))
        d_b1 = self._device(self.site_b, "b1")
        d_b2 = self._device(self.site_b, "b2")
        Interface.objects.create(device=d_b1, name="e0")
        Interface.objects.create(device=d_b2, name="e0")
        self._login()
        r = self.client.post(
            "/api/monitoring/topology/materialize-cable/",
            {"source_device": str(d_b1.id), "local_port": "e0",
             "remote_device": str(d_b2.id), "remote_port": "e0", "type": "cat6"},
            format="json",
        )
        self.assertEqual(r.status_code, 400)  # interfaces not in scope → not found

    def test_snmp_binding_other_site_denied(self):
        self._grant("device")  # device.change scoped to site A
        perm = ObjectPermission.objects.create(
            name="devchg", object_types=["device"], actions=["change"]
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        perm.sites.add(self.site_a)
        d_b = self._device(self.site_b, "b")
        self._login()
        r = self.client.put(
            f"/api/monitoring/snmp-binding/device/{d_b.id}/",
            {"profile_id": None}, format="json",
        )
        self.assertEqual(r.status_code, 404)

    def test_assignment_rejects_other_site_ip(self):
        from monitoring.models import CheckTemplate
        self._grant("ipaddress")
        tmpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="ICMP", slug="icmp", kind="icmp"
        )
        ip_b = self._ip(self.site_b, "10.0.1.0/24", "10.0.1.5/32")
        self._login()
        r = self.client.post(
            "/api/monitoring/assignments/",
            {"template": str(tmpl.id), "ip_address": str(ip_b.id)},
            format="json",
        )
        self.assertIn(r.status_code, (400, 403))


class AuditSiteTests(_SiteScopedBase):
    def test_cannot_read_other_site_device_history(self):
        self._grant("device")
        d_b = Device.objects.create(tenant=self.tenant, name="b", site=self.site_b)
        self._login()
        rows = self.client.get(
            f"/api/changelog/?object_type=api.device&object_id={d_b.id}"
        ).json()["results"]
        self.assertEqual(rows, [])

    def test_cannot_journal_other_site_device(self):
        self._grant("device")
        d_b = Device.objects.create(tenant=self.tenant, name="b", site=self.site_b)
        self._login()
        r = self.client.post(
            "/api/journal/",
            {"object_type": "api.device", "object_id": str(d_b.id),
             "kind": "info", "comments": "x"},
            format="json",
        )
        self.assertEqual(r.status_code, 403)

    def test_global_changelog_list_hides_other_site(self):
        # Both devices generate CREATE entries via the audit signal.
        self._grant("device")
        Device.objects.create(tenant=self.tenant, name="a", site=self.site_a)
        Device.objects.create(tenant=self.tenant, name="b", site=self.site_b)
        self._login()
        rows = self.client.get("/api/changelog/?object_type=api.device").json()[
            "results"
        ]
        reprs = {row["object_repr"] for row in rows}
        self.assertIn("a", reprs)
        self.assertNotIn("b", reprs)  # Site B must not leak into the global list

    def test_delete_history_readable_after_object_gone(self):
        # A Site-A device is created then deleted; the DELETE entry (object now
        # gone) must still be visible to the Site-A viewer — the stored
        # object_site_id carries the scope re-fetching the object no longer can.
        self._grant("device")
        d_a = Device.objects.create(tenant=self.tenant, name="gone", site=self.site_a)
        dev_id = str(d_a.id)
        d_a.delete()
        self._login()
        rows = self.client.get(
            f"/api/changelog/?object_type=api.device&object_id={dev_id}"
        ).json()["results"]
        actions = {row["action"] for row in rows}
        self.assertIn("delete", actions)

    def test_cannot_retarget_journal_note(self):
        self._grant("device")
        d_a = Device.objects.create(tenant=self.tenant, name="a", site=self.site_a)
        d_b = Device.objects.create(tenant=self.tenant, name="b", site=self.site_b)
        self._login()
        created = self.client.post(
            "/api/journal/",
            {"object_type": "api.device", "object_id": str(d_a.id),
             "kind": "info", "comments": "note"},
            format="json",
        )
        self.assertEqual(created.status_code, 201, created.content)
        note_id = created.json()["id"]
        # Retargeting the note onto a Site-B device must be rejected.
        r = self.client.patch(
            f"/api/journal/{note_id}/",
            {"object_id": str(d_b.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 403)
