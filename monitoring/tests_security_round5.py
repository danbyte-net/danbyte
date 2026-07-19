"""Security regressions for the final public-release authorization pass."""

from unittest.mock import patch

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import (
    Cable,
    CableTermination,
    Device,
    DeviceRole,
    FrontPort,
    Interface,
    IPAddress,
    Prefix,
    RearPort,
    Site,
)
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import CheckState, CheckTemplate


class _ScopedMonitoringBase(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Security R5", slug="security-r5")
        self.tenant = Tenant.objects.create(org=org, name="Primary", slug="primary")
        self.site_a = Site.objects.create(tenant=self.tenant, name="Site A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="Site B")
        self.user = User.objects.create_user("scoped-r5", password="x")
        UserProfile.objects.create(user=self.user, role="custom").tenants.add(
            self.tenant
        )
        self._grant_index = 0

    def _grant(self, *types, actions=("view",), sites=(), constraints=None):
        self._grant_index += 1
        permission = ObjectPermission.objects.create(
            name=f"round5-{self._grant_index}",
            object_types=list(types),
            actions=list(actions),
            constraints=constraints,
        )
        permission.users.add(self.user)
        permission.tenants.add(self.tenant)
        if sites:
            permission.sites.add(*sites)
        return permission

    def _login(self):
        self.client.force_login(self.user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _prefix(self, cidr, site, *, auto_assign_site=False):
        return Prefix.objects.create(
            tenant=self.tenant,
            cidr=cidr,
            site=site,
            auto_assign_site=auto_assign_site,
            status=status_for(self.tenant),
        )

    def _cable(self, a, b):
        cable = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cable, end="A", interface=a)
        CableTermination.objects.create(cable=cable, end="B", interface=b)
        return cable


class DiscoveryDestinationScopeTests(_ScopedMonitoringBase):
    def test_site_grant_cannot_seed_shared_or_constraint_unknown_rows(self):
        shared_destination = self._prefix(
            "10.10.0.0/24", self.site_a, auto_assign_site=False
        )
        constrained_destination = self._prefix(
            "10.11.0.0/24", self.site_a, auto_assign_site=True
        )
        self._grant("prefix", sites=(self.site_a,))
        unconstrained = self._grant(
            "ipaddress", actions=("add",), sites=(self.site_a,)
        )
        self._grant(
            "ipaddress",
            actions=("add",),
            sites=(self.site_a,),
            constraints={"description__icontains": "approved"},
        )
        self._login()

        response = self.client.post(
            f"/api/monitoring/prefixes/{shared_destination.id}/discover/"
        )
        self.assertEqual(response.status_code, 403)

        unconstrained.delete()
        response = self.client.post(
            f"/api/monitoring/prefixes/{constrained_destination.id}/discover/"
        )
        self.assertEqual(response.status_code, 403)

    def test_exact_site_destination_is_allowed_and_nmap_uses_same_gate(self):
        allowed = Prefix.objects.create(
            tenant=self.tenant,
            cidr="10.0.0.0/8",
            site=self.site_a,
            auto_assign_site=True,
            status=status_for(self.tenant, "container"),
        )
        shared_destination = self._prefix(
            "10.20.0.0/24", self.site_a, auto_assign_site=False
        )
        self._grant("prefix", sites=(self.site_a,))
        self._grant("ipaddress", actions=("add",), sites=(self.site_a,))
        self._login()

        response = self.client.post(
            f"/api/monitoring/prefixes/{allowed.id}/discover/"
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json().get("skipped"), "too_large")

        with patch("monitoring.views.sweep_prefix") as sweep:
            response = self.client.post(
                f"/api/monitoring/prefixes/{shared_destination.id}/nmap-sweep/"
            )
        self.assertEqual(response.status_code, 403)
        sweep.assert_not_called()


class ChildRollupScopeTests(_ScopedMonitoringBase):
    def setUp(self):
        super().setUp()
        self.prefix = self._prefix("10.30.0.0/24", self.site_a)
        self.visible = IPAddress.objects.create(
            tenant=self.tenant,
            prefix=self.prefix,
            site=self.site_a,
            ip_address="10.30.0.10/32",
            status=status_for(self.tenant),
        )
        self.hidden = IPAddress.objects.create(
            tenant=self.tenant,
            prefix=self.prefix,
            site=self.site_a,
            ip_address="10.30.0.20/32",
            status=status_for(self.tenant),
        )
        template = CheckTemplate.objects.create(
            tenant=self.tenant, name="ICMP", slug="icmp-r5", kind="icmp"
        )
        for target, state in ((self.visible, "up"), (self.hidden, "down")):
            CheckState.objects.create(
                tenant=self.tenant,
                target_ip=target,
                template=template,
                kind="icmp",
                status=state,
            )
        self._grant("prefix", sites=(self.site_a,))
        self._grant(
            "ipaddress",
            sites=(self.site_a,),
            constraints={"ip_address": self.visible.ip_address},
        )
        self._login()

    def test_prefix_status_excludes_constraint_hidden_children(self):
        response = self.client.post(
            "/api/monitoring/status/",
            {"prefixes": [str(self.prefix.id)]},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        row = response.json()["statuses"][str(self.prefix.id)]
        self.assertEqual(row["status"], "up")
        self.assertEqual(row["counts"], {"up": 1})
        self.assertEqual(row["monitored_ips"], 1)

    def test_bulk_check_materializes_only_viewable_children(self):
        with (
            patch("monitoring.scheduler.materialise_ip") as materialise,
            patch("monitoring.scheduler.dispatch", return_value={"jobs": 0}),
            patch("monitoring.views._seed_check_run", return_value="run-r5"),
        ):
            response = self.client.post(
                "/api/monitoring/bulk-check-now/",
                {"prefix_ids": [str(self.prefix.id)]},
                format="json",
            )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["targets"], 1)
        self.assertEqual(materialise.call_count, 1)
        self.assertEqual(materialise.call_args.args[0], self.visible)


class CableAndTopologyScopeTests(_ScopedMonitoringBase):
    def test_cable_list_requires_every_endpoint_to_be_in_scope(self):
        a1 = Device.objects.create(tenant=self.tenant, site=self.site_a, name="a1")
        a2 = Device.objects.create(tenant=self.tenant, site=self.site_a, name="a2")
        b1 = Device.objects.create(tenant=self.tenant, site=self.site_b, name="b1")
        ia1 = Interface.objects.create(device=a1, name="eth0")
        ia2 = Interface.objects.create(device=a2, name="eth0")
        ib1 = Interface.objects.create(device=b1, name="eth0")
        allowed = self._cable(ia1, ia2)
        hidden = self._cable(
            Interface.objects.create(device=a1, name="eth1"), ib1
        )
        self._grant("cable", sites=(self.site_a,))
        self._login()

        response = self.client.get("/api/cables/?page_size=200")
        self.assertEqual(response.status_code, 200, response.content)
        ids = {row["id"] for row in response.json()["results"]}
        self.assertIn(str(allowed.id), ids)
        self.assertNotIn(str(hidden.id), ids)

    def test_materialize_rolls_back_when_cable_grant_misses_endpoints(self):
        b1 = Device.objects.create(tenant=self.tenant, site=self.site_b, name="b1")
        b2 = Device.objects.create(tenant=self.tenant, site=self.site_b, name="b2")
        Interface.objects.create(device=b1, name="eth0")
        Interface.objects.create(device=b2, name="eth0")
        self._grant("device", sites=(self.site_b,))
        self._grant("cable", actions=("add",), sites=(self.site_a,))
        self._login()

        response = self.client.post(
            "/api/monitoring/topology/materialize-cable/",
            {
                "source_device": str(b1.id),
                "local_port": "eth0",
                "remote_device": str(b2.id),
                "remote_port": "eth0",
                "type": "cat6",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(Cable.objects.filter(tenant=self.tenant).count(), 0)

    def test_hidden_panel_name_cannot_survive_topology_collapse(self):
        server = Device.objects.create(
            tenant=self.tenant, site=self.site_a, name="visible-server"
        )
        switch = Device.objects.create(
            tenant=self.tenant, site=self.site_a, name="visible-switch"
        )
        panel = Device.objects.create(
            tenant=self.tenant, site=self.site_b, name="hidden-panel"
        )
        server_if = Interface.objects.create(device=server, name="eth0")
        switch_if = Interface.objects.create(device=switch, name="eth0")
        rear = RearPort.objects.create(device=panel, name="rear", positions=1)
        front = FrontPort.objects.create(
            device=panel,
            name="front",
            rear_port=rear,
            rear_port_position=1,
        )
        cable_a = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(
            cable=cable_a, end="A", interface=server_if
        )
        CableTermination.objects.create(
            cable=cable_a, end="B", front_port=front
        )
        cable_b = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cable_b, end="A", rear_port=rear)
        CableTermination.objects.create(
            cable=cable_b, end="B", interface=switch_if
        )
        self._grant("device", sites=(self.site_a,))
        self._login()

        response = self.client.get("/api/topology/?collapse_panels=1")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("hidden-panel", response.content.decode())
        names = {node["data"]["name"] for node in response.json()["nodes"]}
        self.assertEqual(names, {"visible-server", "visible-switch"})


class SnmpBindingAndRunScopeTests(_ScopedMonitoringBase):
    def test_binding_targets_require_device_scope_covering_the_target(self):
        role = DeviceRole.objects.create(
            tenant=self.tenant, name="Core", slug="core-r5"
        )
        self._grant("device", actions=("change",), sites=(self.site_a,))
        self._login()

        allowed = self.client.put(
            f"/api/monitoring/snmp-binding/site/{self.site_a.id}/",
            {"profile_id": None},
            format="json",
        )
        denied_site = self.client.put(
            f"/api/monitoring/snmp-binding/site/{self.site_b.id}/",
            {"profile_id": None},
            format="json",
        )
        denied_global = self.client.put(
            f"/api/monitoring/snmp-binding/device_role/{role.id}/",
            {"profile_id": None},
            format="json",
        )
        self.assertEqual(allowed.status_code, 200, allowed.content)
        self.assertEqual(denied_site.status_code, 404)
        self.assertEqual(denied_global.status_code, 404)

        self._grant("device", actions=("change",))
        response = self.client.put(
            f"/api/monitoring/snmp-binding/device_role/{role.id}/",
            {"profile_id": None},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.content)

    def test_progress_ids_are_tenant_and_owner_bound(self):
        self._login()
        other = User.objects.create_user("other-r5", password="x")
        foreign_progress = {
            "run_id": "discover-r5",
            "tenant": str(self.tenant.id),
            "owner": str(other.id),
            "done": False,
            "percent": 10,
        }
        with patch(
            "monitoring.discovery.run_progress", return_value=foreign_progress
        ):
            response = self.client.get(
                "/api/monitoring/discover-runs/discover-r5/"
            )
        self.assertEqual(response.json()["found"], False)
        self.assertNotIn("owner", response.json())

        class FakeConnection:
            def hgetall(inner_self, key):
                return {
                    b"tenant": str(self.tenant.id).encode(),
                    b"owner": str(other.id).encode(),
                    b"total": b"9",
                    b"ids": b"[]",
                }

        with patch("django_rq.get_connection", return_value=FakeConnection()):
            response = self.client.get("/api/monitoring/check-runs/check-r5/")
        self.assertEqual(response.json()["found"], False)
        self.assertNotIn("total", response.json())
