"""The fences around routing objects: a tenant never sees another tenant's
rows, a site-scoped grant narrows device-bound rows to that site, a
foreign key from another tenant is refused on write, the keychain's key is
revealed only under audit, and the drift report renders the routing block
when it is handed a template.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import (
    L2VPN,
    VRF,
    Device,
    DeviceType,
    ExportTemplate,
    Interface,
    Manufacturer,
    Site,
)
from api.status_registry import seed_builtin_statuses
from audit.models import ChangeAction, ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant

from .models import (
    VTEP,
    BGPInstance,
    BGPPeerGroup,
    BGPSession,
    EIGRPInstance,
    ISISInstance,
    OSPFArea,
    OSPFInstance,
    PrefixList,
    RoutingKeychain,
    RoutingPolicy,
    StaticRoute,
)

User = get_user_model()

# Every routing list endpoint and the model it lists - the tenant fence is
# checked on all of them, not a sample.
LISTS = {
    "/api/routing/prefix-lists/": PrefixList,
    "/api/routing/policies/": RoutingPolicy,
    "/api/routing/keychains/": RoutingKeychain,
    "/api/routing/bgp-peer-groups/": BGPPeerGroup,
    "/api/routing/ospf-areas/": OSPFArea,
    "/api/routing/static-routes/": StaticRoute,
    "/api/routing/bgp-instances/": BGPInstance,
    "/api/routing/bgp-sessions/": BGPSession,
    "/api/routing/ospf-instances/": OSPFInstance,
    "/api/routing/isis-instances/": ISISInstance,
    "/api/routing/eigrp-instances/": EIGRPInstance,
    "/api/routing/vteps/": VTEP,
}


def _tenant(slug):
    org = Organization.objects.create(name=slug, slug=slug)
    t = Tenant.objects.create(org=org, name=slug, slug=slug)
    seed_builtin_statuses(t)
    return t


def _device(tenant, site, name):
    mfr, _ = Manufacturer.objects.get_or_create(tenant=tenant, name="C", defaults={"slug": "c"})
    dt, _ = DeviceType.objects.get_or_create(tenant=tenant, manufacturer=mfr, model="X")
    return Device.objects.create(tenant=tenant, name=name, device_type=dt, site=site)


def _fill(tenant, device, tag):
    """One of everything on ``device``, named after ``tag``."""
    asn = tenant.asns.create(asn=65000 + hash(tag) % 500)
    pl = PrefixList.objects.create(tenant=tenant, name=f"PL-{tag}")
    pol = RoutingPolicy.objects.create(tenant=tenant, name=f"POL-{tag}")
    kc = RoutingKeychain.objects.create(tenant=tenant, name=f"KC-{tag}")
    pg = BGPPeerGroup.objects.create(tenant=tenant, name=f"PG-{tag}")
    area = OSPFArea.objects.create(tenant=tenant, name=f"AREA-{tag}", area_id="0")
    sr = StaticRoute.objects.create(
        tenant=tenant, device=device, prefix="0.0.0.0/0", next_hop="10.0.0.1"
    )
    inst = BGPInstance.objects.create(tenant=tenant, device=device, asn=asn)
    sess = BGPSession.objects.create(
        tenant=tenant, instance=inst, remote_address="10.0.0.2", remote_asn=65001
    )
    ospf = OSPFInstance.objects.create(tenant=tenant, device=device, process_id="1")
    isis = ISISInstance.objects.create(
        tenant=tenant, device=device, process=tag, net="49.0001.0000.0000.0001.00"
    )
    eigrp = EIGRPInstance.objects.create(tenant=tenant, device=device, asn=100)
    vtep = VTEP.objects.create(tenant=tenant, device=device)
    return {
        PrefixList: pl, RoutingPolicy: pol, RoutingKeychain: kc, BGPPeerGroup: pg,
        OSPFArea: area, StaticRoute: sr, BGPInstance: inst, BGPSession: sess,
        OSPFInstance: ospf, ISISInstance: isis, EIGRPInstance: eigrp, VTEP: vtep,
    }


class TenantFenceTests(APITestCase):
    def setUp(self):
        self.a = _tenant("a")
        self.b = _tenant("b")
        self.site_a = Site.objects.create(tenant=self.a, name="A1")
        self.site_b = Site.objects.create(tenant=self.b, name="B1")
        self.dev_a = _device(self.a, self.site_a, "a-r1")
        self.dev_b = _device(self.b, self.site_b, "b-r1")
        self.rows_a = _fill(self.a, self.dev_a, "a")
        self.rows_b = _fill(self.b, self.dev_b, "b")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.a.id)
        s.save()

    def test_the_other_tenant_is_invisible_on_every_list_and_detail(self):
        for url, model in LISTS.items():
            with self.subTest(url=url):
                body = self.client.get(url).json()
                ids = {r["id"] for r in body["results"]}
                self.assertEqual(ids, {str(self.rows_a[model].id)}, url)
                self.assertEqual(
                    self.client.get(f"{url}{self.rows_b[model].id}/").status_code, 404, url
                )

    def test_foreign_keys_from_the_other_tenant_are_refused(self):
        r = self.client.post("/api/routing/static-routes/", {
            "device_id": str(self.dev_b.id), "prefix": "10.9.0.0/16", "next_hop": "10.0.0.9",
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("device_id", r.json())
        r = self.client.post("/api/routing/bgp-sessions/", {
            "instance_id": str(self.rows_b[BGPInstance].id), "remote_address": "10.0.0.7",
            "remote_asn": 65002,
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("instance_id", r.json())
        r = self.client.post("/api/routing/bgp-sessions/", {
            "instance_id": str(self.rows_a[BGPInstance].id), "remote_address": "10.0.0.7",
            "remote_asn": 65002, "peer_group_id": str(self.rows_b[BGPPeerGroup].id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("peer_group_id", r.json())
        other_l2 = L2VPN.objects.create(
            tenant=self.b, name="x", slug="x", type="vxlan", identifier=100
        )
        r = self.client.post("/api/routing/vtep-memberships/", {
            "vtep_id": str(self.rows_a[VTEP].id), "l2vpn_id": str(other_l2.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("l2vpn_id", r.json())
        # Nested rule rows go through the same fence: a prefix list of the
        # other tenant cannot be matched by this tenant's policy.
        r = self.client.patch(f"/api/routing/policies/{self.rows_a[RoutingPolicy].id}/", {
            "rules": [{"sequence": 10, "action": "permit",
                       "match_prefix_list_ids": [str(self.rows_b[PrefixList].id)]}],
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)

    def test_render_and_inventory_stay_inside_the_tenant(self):
        t = ExportTemplate.objects.create(
            tenant=self.a, name="t", object_type="device",
            template_code="{{ routing.bgp | length }} {{ routing.static_routes | length }}",
        )
        r = self.client.get(f"/api/devices/{self.dev_a.id}/render/?template={t.id}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["output"].strip(), "1 1")
        self.assertEqual(
            self.client.get(f"/api/devices/{self.dev_b.id}/render/?template={t.id}").status_code,
            404,
        )
        hosts = self.client.get("/api/inventory/ansible/?routing=1").json()["_meta"]["hostvars"]
        self.assertEqual(set(hosts), {"a-r1"})


class SiteScopeTests(APITestCase):
    """A grant limited to one site sees that site's device-bound rows and
    every tenant-wide catalog; the other site's rows are not there."""

    def setUp(self):
        self.t = _tenant("t")
        self.ams = Site.objects.create(tenant=self.t, name="AMS")
        self.lon = Site.objects.create(tenant=self.t, name="LON")
        self.d_ams = _device(self.t, self.ams, "ams1")
        self.d_lon = _device(self.t, self.lon, "lon1")
        self.rows_ams = _fill(self.t, self.d_ams, "ams")
        self.rows_lon = _fill(self.t, self.d_lon, "lon")
        self.user = User.objects.create_user("scoped")
        UserProfile.objects.create(user=self.user).tenants.add(self.t)
        perm = ObjectPermission.objects.create(
            name="ams only",
            object_types=[
                "staticroute", "bgpinstance", "bgpsession", "ospfinstance", "isisinstance",
                "eigrpinstance", "vtep", "prefixlist", "bgppeergroup",
            ],
            actions=["view"],
        )
        perm.users.add(self.user)
        perm.sites.set([self.ams])
        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.t.id)
        s.save()

    def test_device_bound_rows_narrow_to_the_site_catalogs_do_not(self):
        for url, model in LISTS.items():
            if model in (RoutingPolicy, RoutingKeychain, OSPFArea):
                continue  # no grant at all - 403 is the right answer, tested below
            with self.subTest(url=url):
                r = self.client.get(url)
                self.assertEqual(r.status_code, 200, url)
                ids = {x["id"] for x in r.json()["results"]}
                if model in (PrefixList, BGPPeerGroup):
                    self.assertEqual(
                        ids, {str(self.rows_ams[model].id), str(self.rows_lon[model].id)}
                    )
                else:
                    self.assertEqual(ids, {str(self.rows_ams[model].id)}, url)
                    self.assertEqual(
                        self.client.get(f"{url}{self.rows_lon[model].id}/").status_code,
                        404, url,
                    )
        self.assertEqual(self.client.get("/api/routing/policies/").status_code, 403)
        # The device's own tab count and render follow the same grant.
        self.assertEqual(self.client.get(f"/api/devices/{self.d_lon.id}/").status_code, 403)


class KeychainRevealTests(APITestCase):
    def setUp(self):
        self.t = _tenant("t")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.t.id)
        s.save()
        ds = DeploymentSettings.load()
        ds.secrets_provider = "local"
        ds.save(update_fields=["secrets_provider"])

    def test_key_is_write_only_and_reveal_is_audited(self):
        r = self.client.post("/api/routing/keychains/", {
            "name": "ISIS", "algorithm": "md5", "psk": "correct horse battery",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertTrue(body["psk_set"])
        self.assertNotIn("psk", body)
        kid = body["id"]
        for url in (f"/api/routing/keychains/{kid}/", "/api/routing/keychains/",
                    "/api/routing/keychains/?picker=1"):
            self.assertNotIn("horse", self.client.get(url).content.decode())
        r = self.client.post(f"/api/routing/keychains/{kid}/reveal-psk/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["psk"], "correct horse battery")
        entry = ChangeLogEntry.objects.filter(action=ChangeAction.REVEAL, object_id=kid).first()
        self.assertIsNotNone(entry)
        self.assertEqual(entry.changes, {"revealed": "psk"})
        # The render context says a key exists and never carries it.
        site = Site.objects.create(tenant=self.t, name="S")
        dev = _device(self.t, site, "r1")
        t = ExportTemplate.objects.create(
            tenant=self.t, name="t", object_type="device",
            template_code="{% for k in routing.keychains %}{{ k.name }}={{ k.key_set }}{% endfor %}",
        )
        out = self.client.get(f"/api/devices/{dev.id}/render/?template={t.id}").json()["output"]
        self.assertEqual(out.strip(), "ISIS=True")
        self.assertNotIn("horse", out)

    def test_without_a_store_a_key_is_refused_not_stored(self):
        ds = DeploymentSettings.load()
        ds.secrets_provider = ""
        ds.save(update_fields=["secrets_provider"])
        r = self.client.post("/api/routing/keychains/", {
            "name": "ISIS", "algorithm": "md5", "psk": "correct horse battery",
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("psk", r.json())
        self.assertFalse(RoutingKeychain.objects.filter(name="ISIS").exists())
        r = self.client.post("/api/routing/keychains/", {"name": "ISIS", "algorithm": "md5"},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)


class DriftTemplateTests(APITestCase):
    def setUp(self):
        self.t = _tenant("t")
        site = Site.objects.create(tenant=self.t, name="S")
        self.dev = _device(self.t, site, "r1")
        self.vrf = VRF.objects.create(tenant=self.t, name="CUST", rd="65000:1")
        Interface.objects.create(device=self.dev, name="eth0", vrf=self.vrf)
        StaticRoute.objects.create(
            tenant=self.t, device=self.dev, vrf=self.vrf, prefix="10.20.0.0/16",
            next_hop="10.1.1.2",
        )
        self.template = ExportTemplate.objects.create(
            tenant=self.t, name="t", object_type="device",
            template_code="{% for r in routing.static_routes %}ip route vrf {{ r.vrf }} {{ r.prefix }} {{ r.next_hop }}\n{% endfor %}",
        )
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.t.id)
        s.save()

    def test_drift_report_renders_the_routing_block_from_the_template(self):
        r = self.client.post(f"/api/devices/{self.dev.id}/config-state/", {
            "template": str(self.template.id),
            "actual_config": "ip route vrf CUST 10.20.0.0/16 10.1.1.2\n",
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["status"], "in_sync")
        r = self.client.post(f"/api/devices/{self.dev.id}/config-state/", {
            "template": str(self.template.id),
            "actual_config": "ip route vrf CUST 10.20.0.0/16 10.1.1.3\n",
        }, format="json")
        self.assertEqual(r.json()["status"], "drift")


class RelatedTabAndIOTests(APITestCase):
    """The routing that touches a VRF or a prefix shows on their pages, and a
    CSV of device-bound rows round-trips without duplicating them."""

    def setUp(self):
        from api.models import Prefix

        self.t = _tenant("t")
        site = Site.objects.create(tenant=self.t, name="S")
        self.dev = _device(self.t, site, "r1")
        self.vrf = VRF.objects.create(tenant=self.t, name="CUST", rd="65000:1")
        self.prefix = Prefix.objects.create(tenant=self.t, cidr="10.20.0.0/16")
        StaticRoute.objects.create(
            tenant=self.t, device=self.dev, vrf=self.vrf, prefix="10.20.0.0/16",
            prefix_obj=self.prefix, next_hop="10.1.1.2",
        )
        StaticRoute.objects.create(
            tenant=self.t, device=self.dev, prefix="0.0.0.0/0", next_hop="10.1.1.1",
        )
        asn = self.t.asns.create(asn=65000)
        inst = BGPInstance.objects.create(tenant=self.t, device=self.dev, vrf=self.vrf, asn=asn)
        BGPSession.objects.create(
            tenant=self.t, instance=inst, remote_address="10.0.0.2", remote_asn=65001
        )
        glob = BGPInstance.objects.create(tenant=self.t, device=self.dev, asn=asn)
        BGPSession.objects.create(
            tenant=self.t, instance=glob, remote_address="10.0.0.3", remote_asn=65001
        )
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.t.id)
        s.save()

    def test_vrf_and_prefix_pages_count_their_routing(self):
        body = self.client.get(f"/api/vrfs/{self.vrf.id}/").json()
        self.assertEqual((body["static_route_count"], body["bgp_session_count"]), (1, 1))
        row = self.client.get("/api/vrfs/").json()["results"][0]
        self.assertEqual((row["static_route_count"], row["bgp_session_count"]), (0, 0))
        self.assertEqual(
            self.client.get(f"/api/prefixes/{self.prefix.id}/").json()["static_route_count"], 1
        )
        self.assertEqual(
            self.client.get(f"/api/routing/bgp-sessions/?vrf={self.vrf.id}").json()["count"], 1
        )
        self.assertEqual(
            self.client.get("/api/routing/bgp-sessions/?vrf=global").json()["count"], 1
        )
        self.assertEqual(
            self.client.get(f"/api/routing/static-routes/?prefix_obj={self.prefix.id}").json()["count"],
            1,
        )

    def test_csv_keys_on_what_makes_a_row_unique(self):
        import csv
        import io

        def export(slug):
            r = self.client.get(f"/api/io/{slug}/export/?fmt=csv")
            body = b"".join(r.streaming_content).decode()
            return body, list(csv.DictReader(io.StringIO(body)))

        def reimport(slug, rows):
            out = io.StringIO()
            w = csv.DictWriter(out, fieldnames=[k for k in rows[0] if k != "id"])
            w.writeheader()
            for row in rows:
                w.writerow({k: v for k, v in row.items() if k != "id"})
            r = self.client.post(f"/api/io/{slug}/import/", {
                "format": "csv", "content": out.getvalue(), "dry_run": True,
            }, format="json")
            self.assertEqual(r.status_code, 200, r.content)
            return r.json()

        types = {
            t["slug"]: t for t in self.client.get("/api/io/types/").json()["object_types"]
        }
        self.assertEqual(types["bgpsession"]["natural_key"], ["instance", "remote_address"])
        self.assertEqual(types["staticroute"]["natural_key"], ["device", "prefix", "next_hop"])

        _, rows = export("bgpinstance")
        self.assertEqual({r["asn"] for r in rows}, {"65000"})
        # Without ids, the VRF instance is found by device + VRF and updated.
        res = reimport("bgpinstance", [r for r in rows if r["vrf"] == "CUST"])
        self.assertEqual((res["created"], res["updated"], res["errors"]), (0, 1, []))

        _, rows = export("bgpsession")
        res = reimport("bgpsession", rows)
        self.assertEqual((res["created"], res["updated"], res["errors"]), (0, 2, []))

        _, rows = export("staticroute")
        res = reimport("staticroute", rows)
        self.assertEqual((res["created"], res["updated"], res["errors"]), (0, 2, []))
