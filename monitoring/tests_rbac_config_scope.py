"""Target-aware RBAC coverage for monitoring configuration endpoints."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import (
    Device,
    DeviceRole,
    DeviceType,
    IPAddress,
    Manufacturer,
    Prefix,
    Site,
    VRF,
)
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant

from .models import (
    AlertRule,
    CheckAssignment,
    CheckTemplate,
    MonitoringPolicy,
    Silence,
)


class MonitoringConfigScopeTests(APITestCase):
    CONFIG_TYPES = ["checkassignment", "monitoringpolicy", "alertrule", "silence"]
    TARGET_TYPES = [
        "ipaddress",
        "prefix",
        "device",
        "vrf",
        "devicetype",
        "devicerole",
    ]

    def setUp(self):
        org = Organization.objects.create(name="Config Scope", slug="config-scope")
        self.tenant = Tenant.objects.create(org=org, name="Main", slug="main")
        self.other_tenant = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site_a = Site.objects.create(tenant=self.tenant, name="Site A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="Site B")

        self.prefix_a = Prefix.objects.create(
            tenant=self.tenant,
            cidr="10.0.0.0/24",
            site=self.site_a,
            status=status_for(self.tenant),
        )
        self.prefix_b = Prefix.objects.create(
            tenant=self.tenant,
            cidr="10.0.1.0/24",
            site=self.site_b,
            status=status_for(self.tenant),
        )
        self.ip_a = IPAddress.objects.create(
            tenant=self.tenant,
            ip_address="10.0.0.10/32",
            prefix=self.prefix_a,
            site=self.site_a,
            status=status_for(self.tenant),
        )
        self.ip_b = IPAddress.objects.create(
            tenant=self.tenant,
            ip_address="10.0.1.10/32",
            prefix=self.prefix_b,
            site=self.site_b,
            status=status_for(self.tenant),
        )
        other_prefix = Prefix.objects.create(
            tenant=self.other_tenant,
            cidr="192.0.2.0/24",
            status=status_for(self.other_tenant),
        )
        self.other_ip = IPAddress.objects.create(
            tenant=self.other_tenant,
            ip_address="192.0.2.10/32",
            prefix=other_prefix,
            status=status_for(self.other_tenant),
        )

        self.device_a = Device.objects.create(
            tenant=self.tenant, name="device-a", site=self.site_a
        )
        self.device_b = Device.objects.create(
            tenant=self.tenant, name="device-b", site=self.site_b
        )
        self.template = CheckTemplate.objects.create(
            tenant=self.tenant, name="Ping", slug="ping", kind="icmp"
        )
        self.assignment_a = CheckAssignment.objects.create(
            tenant=self.tenant, template=self.template, ip_address=self.ip_a
        )
        self.assignment_b = CheckAssignment.objects.create(
            tenant=self.tenant, template=self.template, ip_address=self.ip_b
        )

        self.site_user = User.objects.create_user("site-user", password="x")
        UserProfile.objects.create(user=self.site_user).tenants.add(self.tenant)
        self._grant(
            self.site_user,
            "site-a-config",
            self.CONFIG_TYPES + self.TARGET_TYPES,
            sites=[self.site_a],
        )

        self.hq_user = User.objects.create_user("hq-user", password="x")
        UserProfile.objects.create(user=self.hq_user).tenants.add(self.tenant)
        self._grant(self.hq_user, "hq-config", ["*"], sites=[])

        self.superuser = User.objects.create_superuser(
            "root-config", "root@example.test", "x"
        )

        deployment = DeploymentSettings.load()
        deployment.enhanced_site_separation = True
        deployment.save(update_fields=["enhanced_site_separation", "updated_at"])

    def _grant(
        self,
        user,
        name,
        object_types,
        *,
        sites,
        actions=("view", "add", "change", "delete"),
        constraints=None,
    ):
        permission = ObjectPermission.objects.create(
            name=name,
            object_types=list(object_types),
            actions=list(actions),
            constraints=constraints,
        )
        permission.users.add(user)
        permission.tenants.add(self.tenant)
        permission.sites.set(sites)
        return permission

    def _login(self, user):
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    @staticmethod
    def _ids(response):
        return {row["id"] for row in response.json()["results"]}

    def test_assignment_actions_are_scoped_to_the_effective_target(self):
        self._login(self.site_user)

        listed = self.client.get("/api/monitoring/assignments/")
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(self._ids(listed), {str(self.assignment_a.id)})
        self.assertEqual(
            self.client.get(
                f"/api/monitoring/assignments/{self.assignment_b.id}/"
            ).status_code,
            404,
        )
        self.assertEqual(
            self.client.patch(
                f"/api/monitoring/assignments/{self.assignment_b.id}/",
                {"enabled": False},
                format="json",
            ).status_code,
            404,
        )
        self.assertEqual(
            self.client.delete(
                f"/api/monitoring/assignments/{self.assignment_b.id}/"
            ).status_code,
            404,
        )
        self.assertTrue(CheckAssignment.objects.filter(pk=self.assignment_b.pk).exists())

        allowed = self.client.patch(
            f"/api/monitoring/assignments/{self.assignment_a.id}/",
            {"enabled": False},
            format="json",
        )
        self.assertEqual(allowed.status_code, 200, allowed.content)

        moved = self.client.patch(
            f"/api/monitoring/assignments/{self.assignment_a.id}/",
            {"ip_address": str(self.ip_b.id)},
            format="json",
        )
        self.assertIn(moved.status_code, (400, 403))
        self.assignment_a.refresh_from_db()
        self.assertEqual(self.assignment_a.ip_address_id, self.ip_a.id)

    def test_exclusions_reject_inaccessible_rows_and_hide_corrupt_relations(self):
        self._login(self.site_user)
        second_template = CheckTemplate.objects.create(
            tenant=self.tenant, name="Ping 2", slug="ping-2", kind="icmp"
        )
        for exclusion in (self.ip_b, self.other_ip):
            response = self.client.post(
                "/api/monitoring/assignments/",
                {
                    "template": str(second_template.id),
                    "prefix": str(self.prefix_a.id),
                    "exclusions": [str(exclusion.id)],
                },
                format="json",
            )
            self.assertEqual(response.status_code, 400, response.content)

        corrupt = CheckAssignment.objects.create(
            tenant=self.tenant, template=second_template, prefix=self.prefix_a
        )
        corrupt.exclusions.add(self.other_ip)

        self._login(self.superuser)
        listed = self.client.get("/api/monitoring/assignments/")
        self.assertNotIn(str(corrupt.id), self._ids(listed))
        self.assertEqual(
            self.client.get(f"/api/monitoring/assignments/{corrupt.id}/").status_code,
            404,
        )
        self.assertIn(str(self.assignment_b.id), self._ids(listed))

    def test_alert_rule_actions_are_scoped_and_patch_checks_current_target(self):
        rule_a = AlertRule.objects.create(
            tenant=self.tenant, name="A", match_prefix=self.prefix_a
        )
        rule_b = AlertRule.objects.create(
            tenant=self.tenant, name="B", match_prefix=self.prefix_b
        )
        self._login(self.site_user)

        self.assertEqual(
            self._ids(self.client.get("/api/monitoring/alert-rules/")),
            {str(rule_a.id)},
        )
        self.assertEqual(
            self.client.get(f"/api/monitoring/alert-rules/{rule_b.id}/").status_code,
            404,
        )
        self.assertEqual(
            self.client.patch(
                f"/api/monitoring/alert-rules/{rule_b.id}/",
                {"enabled": False},
                format="json",
            ).status_code,
            404,
        )
        self.assertEqual(
            self.client.delete(
                f"/api/monitoring/alert-rules/{rule_b.id}/"
            ).status_code,
            404,
        )
        allowed = self.client.patch(
            f"/api/monitoring/alert-rules/{rule_a.id}/",
            {"enabled": False},
            format="json",
        )
        self.assertEqual(allowed.status_code, 200, allowed.content)

    def test_silence_actions_require_all_current_targets_in_scope(self):
        now = timezone.now()
        silence_a = Silence.objects.create(
            tenant=self.tenant,
            reason="A",
            match_prefix=self.prefix_a,
            match_ip=self.ip_a,
            starts_at=now,
            ends_at=now + timedelta(hours=1),
        )
        silence_b = Silence.objects.create(
            tenant=self.tenant,
            reason="B",
            match_prefix=self.prefix_b,
            match_ip=self.ip_b,
            starts_at=now,
            ends_at=now + timedelta(hours=1),
        )
        mixed = Silence.objects.create(
            tenant=self.tenant,
            reason="Mixed",
            match_prefix=self.prefix_a,
            match_ip=self.ip_b,
            starts_at=now,
            ends_at=now + timedelta(hours=1),
        )
        self._login(self.site_user)

        self.assertEqual(
            self._ids(self.client.get("/api/monitoring/silences/")),
            {str(silence_a.id)},
        )
        for method in (self.client.get, self.client.delete):
            self.assertEqual(
                method(f"/api/monitoring/silences/{silence_b.id}/").status_code,
                404,
            )
        self.assertEqual(
            self.client.get(f"/api/monitoring/silences/{mixed.id}/").status_code,
            404,
        )
        denied = self.client.patch(
            f"/api/monitoring/silences/{silence_b.id}/",
            {"reason": "changed"},
            format="json",
        )
        self.assertEqual(denied.status_code, 404)
        allowed = self.client.patch(
            f"/api/monitoring/silences/{silence_a.id}/",
            {"reason": "allowed"},
            format="json",
        )
        self.assertEqual(allowed.status_code, 200, allowed.content)

    def test_device_policy_actions_are_scoped(self):
        policy_a = MonitoringPolicy.objects.create(
            tenant=self.tenant, scope="device", device=self.device_a
        )
        policy_b = MonitoringPolicy.objects.create(
            tenant=self.tenant, scope="device", device=self.device_b
        )
        self._login(self.site_user)

        self.assertEqual(
            self._ids(self.client.get("/api/monitoring/policies/")),
            {str(policy_a.id)},
        )
        self.assertEqual(
            self.client.get(f"/api/monitoring/policies/{policy_b.id}/").status_code,
            404,
        )
        self.assertEqual(
            self.client.patch(
                f"/api/monitoring/policies/{policy_b.id}/",
                {"enabled": False},
                format="json",
            ).status_code,
            404,
        )
        self.assertEqual(
            self.client.delete(f"/api/monitoring/policies/{policy_b.id}/").status_code,
            404,
        )
        allowed = self.client.patch(
            f"/api/monitoring/policies/{policy_a.id}/",
            {"enabled": False},
            format="json",
        )
        self.assertEqual(allowed.status_code, 200, allowed.content)

    def test_enhanced_separation_scopes_vrf_and_device_type_policies(self):
        manufacturer = Manufacturer.objects.create(
            tenant=self.tenant, name="Vendor", slug="vendor"
        )
        type_a = DeviceType.objects.create(
            tenant=self.tenant,
            name="Type A",
            model="A",
            manufacturer=manufacturer,
            owning_site=self.site_a,
        )
        type_b = DeviceType.objects.create(
            tenant=self.tenant,
            name="Type B",
            model="B",
            manufacturer=manufacturer,
            owning_site=self.site_b,
        )
        type_global = DeviceType.objects.create(
            tenant=self.tenant, name="Type Global", model="G", manufacturer=manufacturer
        )
        vrf_a = VRF.objects.create(tenant=self.tenant, name="VRF A", owning_site=self.site_a)
        vrf_b = VRF.objects.create(tenant=self.tenant, name="VRF B", owning_site=self.site_b)
        vrf_global = VRF.objects.create(tenant=self.tenant, name="VRF Global")
        role = DeviceRole.objects.create(tenant=self.tenant, name="Core", slug="core")

        policies = {
            "type_a": MonitoringPolicy.objects.create(
                tenant=self.tenant, scope="device_type", device_type=type_a
            ),
            "type_b": MonitoringPolicy.objects.create(
                tenant=self.tenant, scope="device_type", device_type=type_b
            ),
            "type_global": MonitoringPolicy.objects.create(
                tenant=self.tenant, scope="device_type", device_type=type_global
            ),
            "vrf_a": MonitoringPolicy.objects.create(
                tenant=self.tenant, scope="vrf", vrf=vrf_a
            ),
            "vrf_b": MonitoringPolicy.objects.create(
                tenant=self.tenant, scope="vrf", vrf=vrf_b
            ),
            "vrf_global": MonitoringPolicy.objects.create(
                tenant=self.tenant, scope="vrf", vrf=vrf_global
            ),
            "role": MonitoringPolicy.objects.create(
                tenant=self.tenant, scope="device_role", device_role=role
            ),
        }
        self._login(self.site_user)
        visible = self._ids(self.client.get("/api/monitoring/policies/"))
        self.assertEqual(
            visible,
            {str(policies["type_a"].id), str(policies["vrf_a"].id)},
        )
        for key in ("type_b", "type_global", "vrf_b", "vrf_global", "role"):
            response = self.client.patch(
                f"/api/monitoring/policies/{policies[key].id}/",
                {"enabled": False},
                format="json",
            )
            self.assertEqual(response.status_code, 404, key)
        for key in ("type_a", "vrf_a"):
            response = self.client.patch(
                f"/api/monitoring/policies/{policies[key].id}/",
                {"enabled": False},
                format="json",
            )
            self.assertEqual(response.status_code, 200, response.content)

    def test_blanket_and_global_configuration_requires_unscoped_grant(self):
        now = timezone.now()
        global_rule = AlertRule.objects.create(tenant=self.tenant, name="Global")
        blanket = Silence.objects.create(
            tenant=self.tenant,
            reason="Blanket",
            starts_at=now,
            ends_at=now + timedelta(hours=1),
        )
        global_policy = MonitoringPolicy.objects.create(
            tenant=self.tenant, scope=MonitoringPolicy.SCOPE_GLOBAL
        )

        self._login(self.site_user)
        endpoints = (
            ("alert-rules", global_rule),
            ("silences", blanket),
            ("policies", global_policy),
        )
        for endpoint, obj in endpoints:
            self.assertNotIn(
                str(obj.id), self._ids(self.client.get(f"/api/monitoring/{endpoint}/"))
            )
            self.assertEqual(
                self.client.patch(
                    f"/api/monitoring/{endpoint}/{obj.id}/",
                    {"enabled": False} if endpoint != "silences" else {"reason": "x"},
                    format="json",
                ).status_code,
                404,
            )

        create_payloads = (
            ("alert-rules", {"name": "Another global"}),
            (
                "silences",
                {
                    "reason": "Another blanket",
                    "starts_at": now.isoformat(),
                    "ends_at": (now + timedelta(hours=2)).isoformat(),
                },
            ),
            ("policies", {"scope": "global"}),
        )
        for endpoint, payload in create_payloads:
            response = self.client.post(
                f"/api/monitoring/{endpoint}/", payload, format="json"
            )
            self.assertEqual(response.status_code, 403, response.content)

        self._login(self.hq_user)
        for endpoint, obj in endpoints:
            self.assertIn(
                str(obj.id), self._ids(self.client.get(f"/api/monitoring/{endpoint}/"))
            )
            response = self.client.patch(
                f"/api/monitoring/{endpoint}/{obj.id}/",
                {"enabled": False} if endpoint != "silences" else {"reason": "hq"},
                format="json",
            )
            self.assertEqual(response.status_code, 200, response.content)

    def test_site_a_targeted_creates_are_allowed(self):
        now = timezone.now()
        self._login(self.site_user)
        requests = (
            (
                "assignments",
                {"template": str(self.template.id), "prefix": str(self.prefix_a.id)},
            ),
            ("alert-rules", {"name": "Site A", "match_prefix": str(self.prefix_a.id)}),
            (
                "silences",
                {
                    "reason": "Site A",
                    "match_ip": str(self.ip_a.id),
                    "starts_at": now.isoformat(),
                    "ends_at": (now + timedelta(hours=1)).isoformat(),
                },
            ),
            ("policies", {"scope": "prefix", "prefix": str(self.prefix_a.id)}),
        )
        for endpoint, payload in requests:
            response = self.client.post(
                f"/api/monitoring/{endpoint}/", payload, format="json"
            )
            self.assertEqual(response.status_code, 201, response.content)

    def test_permission_constraints_remain_paired_with_their_site(self):
        user = User.objects.create_user("split-grants", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        self._grant(user, "targets", ["ipaddress"], sites=[], actions=("view",))
        self._grant(
            user,
            "enabled-a",
            ["checkassignment"],
            sites=[self.site_a],
            actions=("view",),
            constraints={"enabled": True},
        )
        self._grant(
            user,
            "disabled-b",
            ["checkassignment"],
            sites=[self.site_b],
            actions=("view",),
            constraints={"enabled": False},
        )
        second_template = CheckTemplate.objects.create(
            tenant=self.tenant, name="Disabled", slug="disabled", kind="icmp"
        )
        disabled_b = CheckAssignment.objects.create(
            tenant=self.tenant,
            template=second_template,
            ip_address=self.ip_b,
            enabled=False,
        )
        self._login(user)
        self.assertEqual(
            self._ids(self.client.get("/api/monitoring/assignments/")),
            {str(self.assignment_a.id), str(disabled_b.id)},
        )
        self._grant(
            user, "unscoped-config", ["checkassignment"], sites=[], actions=("view",)
        )
        self.assertEqual(
            self._ids(self.client.get("/api/monitoring/assignments/")),
            {str(self.assignment_a.id), str(self.assignment_b.id), str(disabled_b.id)},
        )
