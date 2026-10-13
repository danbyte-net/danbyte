"""Site-scoped grants and the rows that belong to a site through another
object: IP addresses in another site's prefix (#413), services, NAT rules,
VLAN groups and the other types that hang off a device, VM or prefix (#414),
and the site record itself for the one-click site roles (#415)."""
import importlib

from django.apps import apps as django_apps
from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    DeviceRole,
    DeviceType,
    FHRPGroup,
    FHRPGroupAssignment,
    Interface,
    IPAddress,
    IPRange,
    NATRule,
    Prefix,
    Service,
    Site,
    SiteMarker,
    Tunnel,
    TunnelTermination,
    VirtualChassis,
    VirtualDisk,
    VirtualMachine,
    VirtualSwitch,
    VLANGroup,
)
from api.test_utils import status_for
from audit.models import ChangeLogEntry
from auth_api import rbac
from auth_api.api import assemble_site_role
from auth_api.models import ObjectPermission, UserProfile
from auth_api.site_paths import SITE_PATHS
from core.models import Organization, Tenant
from integrations.models import DeviceConfigSnapshot, DeviceConfigState


class _TwoSites(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site_a = Site.objects.create(tenant=self.tenant, name="SiteA")
        self.site_b = Site.objects.create(tenant=self.tenant, name="SiteB")
        self.user = User.objects.create_user("u", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)

    def _grant(self, types, actions=("view",), sites=None):
        perm = ObjectPermission.objects.create(
            name="g", object_types=list(types), actions=list(actions)
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        perm.sites.set(sites if sites is not None else [self.site_a])
        return perm

    def _login(self):
        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _ids(self, url):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        rows = body["results"] if isinstance(body, dict) and "results" in body else body
        return {row["id"] for row in rows}

    def _export(self, slug):
        r = self.client.get(f"/api/io/{slug}/export/?fmt=csv")
        self.assertEqual(r.status_code, 200)
        return b"".join(r.streaming_content).decode()


class SiteBIpFixture(_TwoSites):
    """The report's setup: prefix, device and IP at site B, with the IP's own
    site left empty (the prefix does not auto-assign its site)."""

    def setUp(self):
        super().setUp()
        st = status_for(self.tenant)
        self.pfx_b = Prefix.objects.create(
            tenant=self.tenant, cidr="10.2.0.0/24", site=self.site_b, status=st
        )
        self.dev_b = Device.objects.create(
            tenant=self.tenant, name="b-payroll-srv", site=self.site_b
        )
        self.eth0 = Interface.objects.create(device=self.dev_b, name="eth0")
        self.ip_b = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.2.0.5", prefix=self.pfx_b,
            dns_name="payroll-db.b.example", description="site B secret",
            assigned_interface=self.eth0, status=st,
        )
        self.pfx_a = Prefix.objects.create(
            tenant=self.tenant, cidr="10.1.0.0/24", site=self.site_a, status=st
        )
        self.ip_a = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.1.0.5", prefix=self.pfx_a, status=st
        )
        # A supernet nobody owns: its addresses are shared context.
        self.pfx_shared = Prefix.objects.create(
            tenant=self.tenant, cidr="10.250.0.0/24", status=st
        )
        self.ip_shared = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.250.0.9", prefix=self.pfx_shared,
            status=st,
        )


class SiteViewerIpTests(SiteBIpFixture):
    """#413: an IP in another site's prefix is outside a site-scoped grant."""

    def setUp(self):
        super().setUp()
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self._login()

    def test_list_hides_other_sites_prefix_ips(self):
        ids = self._ids("/api/ips/")
        self.assertNotIn(str(self.ip_b.id), ids)
        self.assertIn(str(self.ip_a.id), ids)
        self.assertIn(str(self.ip_shared.id), ids)

    def test_detail_is_404(self):
        self.assertEqual(self.client.get(f"/api/ips/{self.ip_b.id}/").status_code, 404)
        self.assertEqual(self.client.get(f"/api/ips/{self.ip_a.id}/").status_code, 200)

    def test_export_leaves_it_out(self):
        text = self._export("ipaddress")
        self.assertNotIn("payroll-db.b.example", text)
        self.assertIn("10.1.0.5", text)

    def test_search_leaves_it_out(self):
        r = self.client.get("/api/search/?q=payroll")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("b-payroll-srv", r.content.decode())
        self.assertNotIn(str(self.ip_b.id), r.content.decode())

    def test_explicit_ip_site_still_counts(self):
        # An address carrying site A itself stays in A's scope.
        self.ip_b.site = self.site_a
        self.ip_b.save()
        self.assertIn(str(self.ip_b.id), self._ids("/api/ips/"))

    def test_explicit_other_site_wins_over_own_prefix(self):
        # An address placed at site B inside site A's prefix is site B's.
        self.ip_a.site = self.site_b
        self.ip_a.save()
        self.assertNotIn(str(self.ip_a.id), self._ids("/api/ips/"))

    def test_engine_matches(self):
        self.assertFalse(rbac.can_act_on(self.user, self.tenant, "ipaddress", "view", self.ip_b))
        self.assertTrue(rbac.can_act_on(self.user, self.tenant, "ipaddress", "view", self.ip_a))


class SiteEditorIpWriteTests(SiteBIpFixture):
    def setUp(self):
        super().setUp()
        self._grant(["ipaddress", "prefix"], actions=("view", "add", "change", "delete"))
        self._login()

    def test_cannot_patch_or_delete_other_sites_ip(self):
        r = self.client.patch(f"/api/ips/{self.ip_b.id}/", {"description": "x"}, format="json")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.client.delete(f"/api/ips/{self.ip_b.id}/").status_code, 404)
        self.ip_b.refresh_from_db()
        self.assertEqual(self.ip_b.description, "site B secret")

    def test_shared_ip_is_readable_not_writable(self):
        self.assertEqual(self.client.get(f"/api/ips/{self.ip_shared.id}/").status_code, 200)
        r = self.client.patch(
            f"/api/ips/{self.ip_shared.id}/", {"description": "x"}, format="json"
        )
        self.assertEqual(r.status_code, 404)

    def test_own_site_ip_is_writable(self):
        r = self.client.patch(f"/api/ips/{self.ip_a.id}/", {"description": "ok"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)


class HiddenRelatedOnVisibleIpTests(SiteBIpFixture):
    """#413: an address the caller may read never names a device, interface
    or prefix the caller can't see."""

    def setUp(self):
        super().setUp()
        # Shared address bound to the hidden site-B device.
        self.ip_shared.assigned_interface = self.eth0
        self.ip_shared.switch = self.dev_b
        self.ip_shared.save()
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self._login()

    def test_detail_redacts_hidden_device_and_interface(self):
        r = self.client.get(f"/api/ips/{self.ip_shared.id}/")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertIsNone(body["assigned_device"])
        self.assertIsNone(body["assigned_interface"])
        self.assertIsNone(body["switch"])
        self.assertNotIn("b-payroll-srv", r.content.decode())
        # The prefix it lives in is shared, so it stays.
        self.assertEqual(body["prefix"]["id"], str(self.pfx_shared.id))

    def test_list_redacts_hidden_device(self):
        r = self.client.get("/api/ips/")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("b-payroll-srv", r.content.decode())
        self.assertNotIn("eth0", r.content.decode())

    def test_export_redacts_hidden_device(self):
        text = self._export("ipaddress")
        self.assertIn("10.250.0.9", text)
        self.assertNotIn("b-payroll-srv", text)
        self.assertNotIn(str(self.dev_b.id), text)

    def test_search_hit_does_not_name_hidden_device(self):
        r = self.client.get("/api/search/?q=10.250.0.9")
        self.assertEqual(r.status_code, 200)
        hits = [h for h in r.json()["hits"] if h["id"] == str(self.ip_shared.id)]
        self.assertEqual(len(hits), 1, r.content)
        self.assertNotIn("device", hits[0]["context"])
        self.assertNotIn("interface", hits[0]["context"])
        self.assertNotIn("b-payroll-srv", r.content.decode())

    def test_hidden_prefix_is_redacted(self):
        # An address explicitly placed at site A inside site B's prefix.
        self.ip_b.site = self.site_a
        self.ip_b.save()
        body = self.client.get(f"/api/ips/{self.ip_b.id}/").json()
        self.assertIsNone(body["prefix"])
        self.assertIsNone(body["assigned_device"])

    def test_visible_relations_are_kept(self):
        dev_a = Device.objects.create(tenant=self.tenant, name="a-srv", site=self.site_a)
        self.ip_a.assigned_device = dev_a
        self.ip_a.save()
        body = self.client.get(f"/api/ips/{self.ip_a.id}/").json()
        self.assertEqual(body["assigned_device"]["name"], "a-srv")
        self.assertEqual(body["prefix"]["id"], str(self.pfx_a.id))

    def test_superuser_sees_everything(self):
        admin = User.objects.create_superuser("root", password="x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        body = self.client.get(f"/api/ips/{self.ip_shared.id}/").json()
        self.assertEqual(body["assigned_device"]["name"], "b-payroll-srv")


class SiteLimitedAllObjectsTests(_TwoSites):
    """#414: a site-limited "*" grant reaches none of site B's rows."""

    def setUp(self):
        super().setUp()
        st = status_for(self.tenant)
        self.b_core = Device.objects.create(tenant=self.tenant, name="b-core", site=self.site_b)
        self.a_core = Device.objects.create(tenant=self.tenant, name="a-core", site=self.site_a)
        self.pfx_b = Prefix.objects.create(
            tenant=self.tenant, cidr="10.9.0.0/24", site=self.site_b, status=st
        )
        self.rows_b = {
            "/api/ip-ranges/": IPRange.objects.create(
                tenant=self.tenant, prefix=self.pfx_b,
                start_address="10.9.0.10", end_address="10.9.0.20",
            ),
            "/api/nat-rules/": NATRule.objects.create(
                tenant=self.tenant, name="b-nat", device=self.b_core
            ),
            "/api/services/": Service.objects.create(
                tenant=self.tenant, name="b-ssh", device=self.b_core
            ),
            "/api/vlan-groups/": VLANGroup.objects.create(
                tenant=self.tenant, name="b-vg", slug="b-vg", site=self.site_b
            ),
            "/api/virtual-chassis/": VirtualChassis.objects.create(
                tenant=self.tenant, name="b-vc", master=self.b_core
            ),
            "/api/config-snapshots/": DeviceConfigSnapshot.objects.create(
                tenant=self.tenant, device=self.b_core, status="drift",
            ),
            "/api/config-states/": DeviceConfigState.objects.create(
                tenant=self.tenant, device=self.b_core
            ),
        }
        self.svc_a = Service.objects.create(tenant=self.tenant, name="a-ssh", device=self.a_core)
        self._grant(["*"], actions=("view", "add", "change", "delete"))
        self._login()

    def test_device_baseline(self):
        self.assertEqual(self.client.get(f"/api/devices/{self.b_core.id}/").status_code, 404)

    def test_lists_and_details_hide_site_b_rows(self):
        for url, obj in self.rows_b.items():
            with self.subTest(url=url):
                self.assertNotIn(str(obj.id), self._ids(url))
                self.assertEqual(self.client.get(f"{url}{obj.id}/").status_code, 404)

    def test_writes_on_site_b_rows_are_refused(self):
        svc = self.rows_b["/api/services/"]
        r = self.client.patch(f"/api/services/{svc.id}/", {"name": "pwned"}, format="json")
        self.assertEqual(r.status_code, 404)
        svc.refresh_from_db()
        self.assertEqual(svc.name, "b-ssh")
        nat = self.rows_b["/api/nat-rules/"]
        self.assertEqual(self.client.delete(f"/api/nat-rules/{nat.id}/").status_code, 404)
        self.assertTrue(NATRule.objects.filter(pk=nat.pk).exists())

    def test_create_on_site_b_device_is_refused(self):
        r = self.client.post(
            "/api/services/", {"name": "new", "device_id": str(self.b_core.id)}, format="json"
        )
        self.assertIn(r.status_code, (400, 403, 404))
        self.assertFalse(Service.objects.filter(name="new").exists())

    def test_own_site_rows_stay_writable(self):
        self.assertIn(str(self.svc_a.id), self._ids("/api/services/"))
        r = self.client.patch(f"/api/services/{self.svc_a.id}/", {"name": "a-ssh2"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_bulk_delete_skips_site_b(self):
        svc = self.rows_b["/api/services/"]
        self.client.post(
            "/api/services/bulk-delete/", {"ids": [str(svc.id)]}, format="json"
        )
        self.assertTrue(Service.objects.filter(pk=svc.pk).exists())

    def test_export_leaves_site_b_out(self):
        text = self._export("service")
        self.assertNotIn("b-ssh", text)
        self.assertIn("a-ssh", text)


class OtherDerivedSiteTypesTests(_TwoSites):
    """#414: the engine scopes the remaining types by their owner's site."""

    def test_each_type_follows_its_owner(self):
        ct = ClusterType.objects.create(tenant=self.tenant, name="ct", slug="ct")
        cluster_b = Cluster.objects.create(
            tenant=self.tenant, name="cb", type=ct, site=self.site_b
        )
        vm_b = VirtualMachine.objects.create(
            tenant=self.tenant, name="vm-b", site=self.site_b, cluster=cluster_b,
            status=status_for(self.tenant),
        )
        dev_b = Device.objects.create(tenant=self.tenant, name="b", site=self.site_b)
        iface_b = Interface.objects.create(device=dev_b, name="ge0")
        grp = FHRPGroup.objects.create(tenant=self.tenant, protocol="vrrp2", group_id=1)
        tunnel = Tunnel.objects.create(tenant=self.tenant, name="t1")
        rows = {
            "fhrpgroupassignment": FHRPGroupAssignment.objects.create(
                fhrp_group=grp, interface=iface_b
            ),
            "tunneltermination": TunnelTermination.objects.create(
                tunnel=tunnel, interface=iface_b
            ),
            "sitemarker": SiteMarker.objects.create(
                tenant=self.tenant, latitude=1, longitude=1, device=dev_b,
                role_type=DeviceRole.objects.create(tenant=self.tenant, name="r", slug="r"),
            ),
            "virtualdisk": VirtualDisk.objects.create(vm=vm_b, key="d0"),
            "virtualswitch": VirtualSwitch.objects.create(
                tenant=self.tenant, name="vs", cluster=cluster_b
            ),
            "vlangroup": VLANGroup.objects.create(
                tenant=self.tenant, name="cg", slug="cg", cluster=cluster_b
            ),
            "service": Service.objects.create(
                tenant=self.tenant, name="vm-svc", virtual_machine=vm_b
            ),
        }
        self._grant(["*"], actions=("view", "add", "change", "delete"))
        for slug, obj in rows.items():
            for action in ("view", "change"):
                with self.subTest(slug=slug, action=action):
                    self.assertFalse(rbac.can_act_on(self.user, self.tenant, slug, action, obj))


class SiteRoleOwnSiteTests(_TwoSites):
    """#415: both site roles can open the sites they cover."""

    def _role(self, role, silo=False):
        assemble_site_role(
            self.tenant, role, [self.site_a], user_ids=[self.user.id], silo=silo
        )
        self._login()

    def test_viewer_reads_own_site_only(self):
        self._role("viewer")
        self.assertEqual(self.client.get(f"/api/sites/{self.site_a.id}/").status_code, 200)
        self.assertEqual(self.client.get(f"/api/sites/{self.site_b.id}/").status_code, 404)
        self.assertEqual(self._ids("/api/sites/"), {str(self.site_a.id)})

    def test_viewer_cannot_write_site(self):
        self._role("viewer")
        r = self.client.patch(f"/api/sites/{self.site_a.id}/", {"name": "x"}, format="json")
        self.assertEqual(r.status_code, 403)

    def test_silo_editor_reads_own_site_but_cannot_change_or_delete_it(self):
        self._role("editor", silo=True)
        self.assertEqual(self.client.get(f"/api/sites/{self.site_a.id}/").status_code, 200)
        self.assertEqual(self._ids("/api/sites/"), {str(self.site_a.id)})
        r = self.client.patch(f"/api/sites/{self.site_a.id}/", {"name": "x"}, format="json")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.client.delete(f"/api/sites/{self.site_a.id}/").status_code, 403)
        self.assertTrue(Site.objects.filter(pk=self.site_a.pk, name="SiteA").exists())

    def test_silo_editor_imports_into_own_site(self):
        self._role("editor", silo=True)
        # The device-type catalog is not part of the role; grant it apart so
        # the row only depends on the site lookup.
        self._grant(["devicetype"], sites=[])
        DeviceType.objects.create(tenant=self.tenant, name="X")
        r = self.client.post(
            "/api/io/device/import/",
            {"format": "csv", "content": "name,site,device_type\nnew-in-a,SiteA,X\n"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["errors"], [], r.content)
        self.assertTrue(Device.objects.filter(name="new-in-a", site=self.site_a).exists())

    def test_editor_does_not_manage_site_records(self):
        self._role("editor")
        self.assertFalse(rbac.has_action(self.user, self.tenant, "site", "change") and
                         rbac.can_act_on(self.user, self.tenant, "site", "change", self.site_a))
        self.assertFalse(rbac.can_act_on(self.user, self.tenant, "site", "delete", self.site_a))

    def test_viewer_sees_its_sites_services(self):
        dev_a = Device.objects.create(tenant=self.tenant, name="a", site=self.site_a)
        svc = Service.objects.create(tenant=self.tenant, name="a-ssh", device=dev_a)
        self._role("viewer")
        self.assertEqual(self.client.get(f"/api/services/{svc.id}/").status_code, 200)

    def test_editor_edits_its_sites_services(self):
        dev_a = Device.objects.create(tenant=self.tenant, name="a", site=self.site_a)
        svc = Service.objects.create(tenant=self.tenant, name="a-ssh", device=dev_a)
        self._role("editor", silo=True)
        r = self.client.patch(f"/api/services/{svc.id}/", {"name": "a-ssh2"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_viewer_does_not_get_config_snapshots(self):
        # Config history holds secrets: device view never implies it, and the
        # site roles leave it out.
        self._role("viewer")
        self.assertFalse(rbac.has_action(self.user, self.tenant, "deviceconfigsnapshot", "view"))


AUDIT_BACKFILL = importlib.import_module("audit.migrations.0013_backfill_site_scope_0_18")


class AuditHistoryBackfillTests(SiteBIpFixture):
    """History written before 0.18 for the newly scoped types gets its site,
    so a site-limited reader no longer sees it as shared."""

    def _entry(self, obj, site=None):
        return ChangeLogEntry.objects.create(
            tenant=self.tenant, action="create",
            object_type=obj._meta.label_lower, object_label=obj._meta.verbose_name,
            object_id=str(obj.pk), object_repr=str(obj)[:255], object_site_id=site,
        )

    def test_frozen_paths_match(self):
        for label, path in AUDIT_BACKFILL.SITE_PATHS.items():
            self.assertEqual(SITE_PATHS[label.split(".")[1]], path, label)

    def test_backfill(self):
        svc = Service.objects.create(tenant=self.tenant, name="b-ssh", device=self.dev_b)
        gone = Service.objects.create(tenant=self.tenant, name="gone", device=self.dev_b)
        ip_entry = self._entry(self.ip_b)
        shared_entry = self._entry(self.ip_shared)
        svc_entry = self._entry(svc)
        gone_entry = self._entry(gone)
        gone.delete()
        AUDIT_BACKFILL.forwards(django_apps, None)
        for e in (ip_entry, shared_entry, svc_entry, gone_entry):
            e.refresh_from_db()
        self.assertEqual(ip_entry.object_site_id, self.site_b.id)
        self.assertIsNone(shared_entry.object_site_id)
        self.assertEqual(svc_entry.object_site_id, self.site_b.id)
        self.assertEqual(gone_entry.object_site_id, AUDIT_BACKFILL.UNKNOWN_SITE)
        # A second run changes nothing.
        AUDIT_BACKFILL.forwards(django_apps, None)
        shared_entry.refresh_from_db()
        self.assertIsNone(shared_entry.object_site_id)

    def test_new_history_is_stamped_with_the_derived_site(self):
        from audit.site_capture import entry_site_id

        svc = Service.objects.create(tenant=self.tenant, name="b-ssh", device=self.dev_b)
        self.assertEqual(entry_site_id(svc), self.site_b.id)
        self.assertEqual(entry_site_id(self.ip_b), self.site_b.id)
        self.assertIsNone(entry_site_id(self.ip_shared))

    def test_site_viewer_does_not_read_site_b_history(self):
        svc = Service.objects.create(tenant=self.tenant, name="b-ssh", device=self.dev_b)
        ChangeLogEntry.objects.filter(object_id=str(svc.pk)).delete()
        self._entry(svc)
        svc_a = Service.objects.create(
            tenant=self.tenant, name="a-ssh",
            device=Device.objects.create(tenant=self.tenant, name="a", site=self.site_a),
        )
        self._entry(svc_a)
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self._login()
        url = "/api/changelog/?object_type=api.service"
        self.assertIn("b-ssh", self.client.get(url).content.decode())  # NULL = shared
        AUDIT_BACKFILL.forwards(django_apps, None)
        body = self.client.get(url).content.decode()
        self.assertNotIn("b-ssh", body)
        self.assertIn("a-ssh", body)
