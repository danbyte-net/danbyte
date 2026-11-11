"""A discovery profile scoped by the monitoring policy kinds (#451): the
monitoring resolver decides, global is explicit, and every saving gate of
the profile still holds."""
from __future__ import annotations

from django.test import override_settings

from api.models import (
    VRF,
    Device,
    DeviceRole,
    DeviceType,
    IPAddress,
    Manufacturer,
    Platform,
    Prefix,
    Region,
    Site,
)
from monitoring import policy_scopes
from monitoring.models import MonitoringPolicy
from monitoring.resolver import resolve_effective_checks

from . import scope, services, shared_scope
from .tests_discovery import ApiBase


@override_settings(DISCOVERY_ENABLED=True)
class SharedScopeBase(ApiBase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        t = cls.tenant
        cls.eu = Region.objects.create(tenant=t, name="Europe", slug="eu")
        cls.nl = Region.objects.create(tenant=t, name="NL", slug="nl", parent=cls.eu)
        cls.us = Region.objects.create(tenant=t, name="US", slug="us")
        cls.ams = Site.objects.create(tenant=t, name="AMS", region=cls.nl)
        cls.nyc = Site.objects.create(tenant=t, name="NYC", region=cls.us)
        cls.blue = VRF.objects.create(tenant=t, name="blue", rd="65000:1")
        cls.blue_net = Prefix.objects.create(tenant=t, cidr="10.7.0.0/24", vrf=cls.blue)
        cls.ams_net = Prefix.objects.create(tenant=t, cidr="10.8.0.0/24", site=cls.ams)
        vendor = Manufacturer.objects.create(tenant=t, name="V", slug="v")
        cls.t1 = DeviceType.objects.create(tenant=t, manufacturer=vendor, name="M1", model="M1")
        cls.t2 = DeviceType.objects.create(tenant=t, manufacturer=vendor, name="M2", model="M2")
        cls.r1 = DeviceRole.objects.create(tenant=t, name="Server", slug="server")
        cls.r2 = DeviceRole.objects.create(tenant=t, name="Switch", slug="switch")
        cls.p1 = Platform.objects.create(tenant=t, name="Linux", slug="linux")

    def setUp(self):
        super().setUp()
        h = self.host
        self.d1 = h("d1", "10.0.0.1", site=self.ams)
        Device.objects.filter(pk=self.d1.pk).update(role=self.r1, device_type=self.t1,
                                                    platform=self.p1)
        self.d2 = h("d2", "10.0.0.2", site=self.nyc)
        Device.objects.filter(pk=self.d2.pk).update(role=self.r2, device_type=self.t2)
        self.d3 = h("d3", "10.7.0.3", prefix=self.blue_net)
        IPAddress.objects.filter(pk=self.d3.primary_ip_id).update(vrf=self.blue)
        Device.objects.filter(pk=self.d3.pk).update(role=self.r1)
        self.v1 = h("v1", "10.8.0.4", vm=True, prefix=self.ams_net)
        self.v2 = h("v2", "10.7.0.5", vm=True, prefix=self.blue_net)
        IPAddress.objects.filter(pk=self.v2.primary_ip_id).update(vrf=self.blue)
        self.d4 = Device.objects.create(tenant=self.tenant, name="noaddr", role=self.r1)
        self.h("theirs", "10.0.0.9")

    def h(self, name, address):
        return self.host(name, address, tenant=self.other)

    def hosts(self, profile, user=None):
        devices, vms = scope._host_querysets(profile, user)
        return {d.name for d in devices} | {v.name for v in vms}

    def addresses(self, profile, user=None):
        return {str(ip.ip_address) for ip in services.address_queryset(profile, user)}


KINDS = {
    "region": ("regions", "eu", "region"),
    "vrf": ("vrfs", "blue", "vrf"),
    "platform": ("platforms", "p1", "platform"),
    "device_type": ("device_types", "t1", "device_type"),
    "device_role": ("device_roles", "r1", "device_role"),
}


class ResolverAgreementTests(SharedScopeBase):
    """For each new kind, the profile reads exactly the hosts and addresses
    a monitoring policy of that scope on the same object puts checks on."""

    def monitored(self, ip):
        return any(c.source == "policy" for c in resolve_effective_checks(ip))

    def test_each_kind_matches_the_monitoring_resolver(self):
        hosts = [self.d1, self.d2, self.d3, self.v1, self.v2]
        for kind, (field, attr, _policy_field) in KINDS.items():
            with self.subTest(kind):
                target = getattr(self, attr)
                policy = MonitoringPolicy.objects.create(
                    tenant=self.tenant, scope=kind, inherit=False,
                    **{policy_scopes.BY_VALUE[kind].field: target})
                profile = self.profile(name=f"p-{kind}")
                getattr(profile, field).add(target)
                expected = {h.name for h in hosts
                            if self.monitored(IPAddress.objects.get(pk=h.primary_ip_id))}
                self.assertTrue(expected, kind)
                self.assertEqual(self.hosts(profile), expected)
                ips = IPAddress.objects.filter(tenant=self.tenant)
                self.assertEqual(self.addresses(profile),
                                 {str(ip.ip_address) for ip in ips if self.monitored(ip)})
                policy.delete()

    def test_expected_members(self):
        # The fixture, read by hand, so the agreement above is not vacuous.
        for kind, want in {"region": {"d1", "v1"}, "vrf": {"d3", "v2"},
                           "platform": {"d1"}, "device_type": {"d1"},
                           "device_role": {"d1", "d3"}}.items():
            field, attr, _ = KINDS[kind]
            p = self.profile(name=f"x-{kind}")
            getattr(p, field).add(getattr(self, attr))
            self.assertEqual(self.hosts(p), want, kind)

    def test_registry_scopes_all_land_somewhere(self):
        for s in policy_scopes.SCOPES:
            self.assertIn(s.value, shared_scope.COPY_FIELDS)

    def test_skip_rules_still_apply(self):
        Device.objects.filter(pk=self.d1.pk).update(scan_exempt=True)
        p = self.profile()
        p.device_roles.add(self.r1)
        got = {str(t.host): t.skip for t in scope.resolve(p)}
        self.assertEqual(got["d1"], "exempt")
        self.assertEqual(got["d3"], "")


class GlobalTests(SharedScopeBase):
    URL = "/api/discovery/profiles/"

    def test_empty_scope_reads_nothing(self):
        p = self.profile()
        self.assertEqual(self.hosts(p), set())
        self.assertEqual(self.addresses(p), set())

    def test_global_is_explicit_and_stays_in_the_tenant(self):
        self.login(self.su)
        r = self.client.post(self.URL, {"name": "all", "scope_global": True}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("scope_global", r.json())
        r = self.client.post(self.URL, {"name": "all", "scope_global": True,
                                        "confirm_global": True}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(r.json()["scope"]["global"])
        from .models import InventoryProfile

        p = InventoryProfile.objects.get(pk=r.json()["id"])
        self.assertEqual(self.hosts(p), {"d1", "d2", "d3", "v1", "v2", "noaddr"})
        self.assertIn("no_address", {t.skip for t in scope.resolve(p)})
        self.assertNotIn("10.0.0.9", self.addresses(p))
        self.assertEqual(len(self.addresses(p)), 5)


class GateTests(SharedScopeBase):
    URL = "/api/discovery/profiles/"

    def test_a_scope_change_clears_the_authorisation(self):
        self.login(self.su)
        r = self.client.post(self.URL, {"name": "x", "device_role_ids": [str(self.r1.pk)],
                                        "authorisation": "CAB-1"}, format="json")
        pid = r.json()["id"]
        self.assertTrue(r.json()["authorised"])
        r = self.client.patch(f"{self.URL}{pid}/", {"vrf_ids": [str(self.blue.pk)]},
                              format="json")
        self.assertFalse(r.json()["authorised"])
        self.client.patch(f"{self.URL}{pid}/", {"authorisation": "CAB-2"}, format="json")
        r = self.client.patch(f"{self.URL}{pid}/", {"scope_global": True,
                                                    "confirm_global": True}, format="json")
        self.assertFalse(r.json()["authorised"])

    def test_a_site_limited_saver(self):
        grants = {"inventoryprofile": ["view", "add", "change"], "site": ["view"],
                  "device": ["view"], "virtualmachine": ["view"], "region": ["view"],
                  "devicerole": ["view"], "vrf": ["view"]}
        self.member("site", grants, sites=[self.ams])
        for body in ({"device_role_ids": [str(self.r1.pk)]}, {"vrf_ids": [str(self.blue.pk)]},
                     {"scope_global": True, "confirm_global": True},
                     {"region_ids": [str(self.us.pk)]}):
            r = self.client.post(self.URL, {"name": "x", **body}, format="json")
            self.assertEqual(r.status_code, 400, (body, r.content))
        # Every site under NL is theirs.
        r = self.client.post(self.URL, {"name": "nl", "region_ids": [str(self.nl.pk)]},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)

    def test_a_tenant_wide_saver_may(self):
        self.member("wide", {"inventoryprofile": ["view", "add"], "device": ["view"],
                             "virtualmachine": ["view"], "devicerole": ["view"]})
        r = self.client.post(self.URL, {"name": "x", "device_role_ids": [str(self.r1.pk)]},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)

    def test_members_must_be_viewable_and_in_the_tenant(self):
        self.member("noroles", {"inventoryprofile": ["view", "add"], "device": ["view"],
                                "virtualmachine": ["view"]})
        r = self.client.post(self.URL, {"name": "x", "device_role_ids": [str(self.r1.pk)]},
                             format="json")
        self.assertEqual(r.status_code, 400)
        self.login(self.su)
        theirs = Region.objects.create(tenant=self.other, name="X", slug="x")
        r = self.client.post(self.URL, {"name": "x", "region_ids": [str(theirs.pk)]},
                             format="json")
        self.assertEqual(r.status_code, 400)

    def test_preview_shows_the_new_kinds(self):
        p = self.profile()
        p.device_roles.add(self.r1)
        self.login(self.su)
        r = self.client.get(f"{self.URL}{p.pk}/hosts/")
        self.assertEqual({h["name"] for h in r.json()["results"]}, {"d1", "d3"})


class PolicyScopeApiTests(SharedScopeBase):
    def policy(self, tenant=None, **kw):
        return MonitoringPolicy.objects.create(tenant=tenant or self.tenant, **kw)

    def test_copy_answers_the_profile_field(self):
        pol = self.policy(scope="device_role", device_role=self.r1, match_name="web-*")
        self.login(self.su)
        r = self.client.get(f"/api/discovery/policy-scopes/{pol.pk}/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["field"], body["target"]["name"], body["filters"]),
                         ("device_role_ids", "Server", True))
        g = self.policy(scope="global")
        self.assertTrue(self.client.get(f"/api/discovery/policy-scopes/{g.pk}/").json()["global"])
        from .api import policy_scope_dict

        self.assertFalse(policy_scope_dict(self.policy(scope="vrf"))["copyable"])

    def test_rbac_and_isolation(self):
        pol = self.policy(scope="device_role", device_role=self.r1)
        url = f"/api/discovery/policy-scopes/{pol.pk}/"
        self.member("viewer", {"inventoryprofile": ["view"], "monitoringpolicy": ["view"],
                               "devicerole": ["view"]})
        self.assertEqual(self.client.get(url).status_code, 403)
        self.member("adder", {"inventoryprofile": ["view", "add"]})
        self.assertEqual(self.client.get(url).status_code, 404)
        self.member("both", {"inventoryprofile": ["view", "add"],
                             "monitoringpolicy": ["view"], "devicerole": ["view"]})
        self.assertEqual(self.client.get(url).status_code, 200)
        r = self.client.get("/api/discovery/policy-scopes/?search=server")
        self.assertEqual([p["id"] for p in r.json()["results"]], [str(pol.pk)])
        theirs = self.policy(tenant=self.other, scope="global")
        self.login(self.su)
        self.assertEqual(
            self.client.get(f"/api/discovery/policy-scopes/{theirs.pk}/").status_code, 404)
        ids = [p["id"] for p in self.client.get("/api/discovery/policy-scopes/").json()["results"]]
        self.assertNotIn(str(theirs.pk), ids)

    def test_profiles_covering_a_policy(self):
        pol = self.policy(scope="device_role", device_role=self.r1)
        mine = self.profile(name="roles")
        mine.device_roles.add(self.r1)
        self.profile(name="other")
        self.login(self.su)
        r = self.client.get(f"/api/discovery/profiles/?policy={pol.pk}")
        self.assertEqual([p["name"] for p in r.json()["results"]], ["roles"])
        self.assertNotIn("X-Danbyte-Unknown-Params", r)
        r = self.client.get("/api/discovery/profiles/?policy=nonsense")
        self.assertEqual(r.json()["results"], [])
