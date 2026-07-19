"""Tier-2 NetBox-parity tests: virtual chassis, L2VPN, VM-interface L2/L3,
tenant/contact group nesting, and config-template resolution."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant, TenantGroup
from .models import (
    ContactGroup, Device, DeviceRole, ExportTemplate, Interface, L2VPN,
    L2VPNTermination, Platform, RouteTarget, VirtualChassis, VirtualMachine,
    VLAN, VMInterface, VRF, resolve_config_template,
)

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()


class VirtualChassisTests(_Base):
    def setUp(self):
        super().setUp()
        self.vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack-1")
        self.d1 = Device.objects.create(
            tenant=self.tenant, name="sw1", virtual_chassis=self.vc, vc_position=1
        )
        self.d2 = Device.objects.create(
            tenant=self.tenant, name="sw2", virtual_chassis=self.vc, vc_position=2
        )

    def test_members_and_master_in_api(self):
        self.vc.master = self.d1
        self.vc.save()
        data = self.client.get(f"/api/virtual-chassis/{self.vc.id}/").json()
        self.assertEqual(data["member_count"], 2)
        members = {m["name"]: m for m in data["members"]}
        self.assertTrue(members["sw1"]["is_master"])
        self.assertFalse(members["sw2"]["is_master"])

    def test_duplicate_position_rejected(self):
        resp = self.client.patch(
            f"/api/devices/{self.d2.id}/",
            {"vc_position": 1},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("vc_position", resp.json())

    def test_master_must_be_member(self):
        loner = Device.objects.create(tenant=self.tenant, name="loner")
        resp = self.client.patch(
            f"/api/virtual-chassis/{self.vc.id}/",
            {"master_id": str(loner.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_delete_releases_members(self):
        resp = self.client.delete(f"/api/virtual-chassis/{self.vc.id}/")
        self.assertEqual(resp.status_code, 204)
        self.d1.refresh_from_db()
        self.assertIsNone(self.d1.virtual_chassis)
        self.assertIsNone(self.d1.vc_position)


class L2VPNTests(_Base):
    def setUp(self):
        super().setUp()
        self.rt = RouteTarget.objects.create(tenant=self.tenant, name="65000:100")
        self.l2vpn = L2VPN.objects.create(
            tenant=self.tenant, name="cust-a", slug="cust-a",
            type="vxlan-evpn", identifier=10100,
        )
        self.l2vpn.import_targets.add(self.rt)
        self.vlan = VLAN.objects.create(
            tenant=self.tenant, vlan_id=100, name="cust-a"
        )

    def test_l2vpn_api_shape(self):
        data = self.client.get(f"/api/l2vpns/{self.l2vpn.id}/").json()
        self.assertEqual(data["type"], "vxlan-evpn")
        self.assertEqual(data["identifier"], 10100)
        self.assertEqual(data["import_targets"][0]["name"], "65000:100")

    def test_termination_vlan(self):
        resp = self.client.post(
            "/api/l2vpn-terminations/",
            {"l2vpn_id": str(self.l2vpn.id), "vlan_id": str(self.vlan.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        # Same VLAN can't terminate a second L2VPN.
        other = L2VPN.objects.create(
            tenant=self.tenant, name="cust-b", slug="cust-b", type="vpls"
        )
        resp = self.client.post(
            "/api/l2vpn-terminations/",
            {"l2vpn_id": str(other.id), "vlan_id": str(self.vlan.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_termination_requires_exactly_one_endpoint(self):
        resp = self.client.post(
            "/api/l2vpn-terminations/",
            {"l2vpn_id": str(self.l2vpn.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)
        device = Device.objects.create(tenant=self.tenant, name="pe1")
        iface = Interface.objects.create(device=device, name="et-0/0/0")
        resp = self.client.post(
            "/api/l2vpn-terminations/",
            {
                "l2vpn_id": str(self.l2vpn.id),
                "vlan_id": str(self.vlan.id),
                "interface_id": str(iface.id),
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 400)


class VMInterfaceParityTests(_Base):
    def test_vlan_mode_vrf_roundtrip(self):
        from .models import Cluster, ClusterType

        ctype = ClusterType.objects.create(
            tenant=self.tenant, name="kvm", slug="kvm"
        )
        cluster = Cluster.objects.create(
            tenant=self.tenant, name="c1", type=ctype
        )
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="web-1", cluster=cluster
        )
        vlan = VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="prod")
        trunk = VLAN.objects.create(tenant=self.tenant, vlan_id=20, name="db")
        vrf = VRF.objects.create(tenant=self.tenant, name="cust", rd="65000:1")
        resp = self.client.post(
            "/api/vm-interfaces/",
            {
                "vm_id": str(vm.id), "name": "eth0", "mode": "tagged",
                "vlan_id": str(vlan.id), "tagged_vlan_ids": [str(trunk.id)],
                "vrf_id": str(vrf.id),
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        data = resp.json()
        self.assertEqual(data["mode"], "tagged")
        self.assertEqual(data["vlan"]["vlan_id"], 10)
        self.assertEqual(data["tagged_vlans"][0]["vlan_id"], 20)
        self.assertEqual(data["vrf"]["name"], "cust")


class GroupNestingTests(_Base):
    def test_tenant_group_tree_and_assignment(self):
        root = TenantGroup.objects.create(org=self.org, name="Customers", slug="customers")
        resp = self.client.post(
            "/api/tenant-groups/",
            {"name": "Enterprise", "slug": "enterprise", "parent_id": str(root.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        child_id = resp.json()["id"]
        # Cycle rejected.
        resp = self.client.patch(
            f"/api/tenant-groups/{root.id}/",
            {"parent_id": child_id},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)
        # Tenant can join a group.
        resp = self.client.patch(
            f"/api/tenants/{self.tenant.id}/",
            {"group_id": child_id},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["group"]["slug"], "enterprise")

    def test_contact_group_nesting(self):
        root = ContactGroup.objects.create(
            tenant=self.tenant, name="NOC", slug="noc"
        )
        resp = self.client.post(
            "/api/contact-groups/",
            {"name": "Tier 1", "slug": "tier-1", "parent_id": str(root.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        # Cycle rejected.
        resp = self.client.patch(
            f"/api/contact-groups/{root.id}/",
            {"parent_id": resp.json()["id"]},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)


class ConfigTemplateResolutionTests(_Base):
    def setUp(self):
        super().setUp()
        self.t_dev = ExportTemplate.objects.create(
            tenant=self.tenant, name="dev-tmpl", object_type="device",
            template_code="dev",
        )
        self.t_role = ExportTemplate.objects.create(
            tenant=self.tenant, name="role-tmpl", object_type="device",
            template_code="role",
        )
        self.t_plat = ExportTemplate.objects.create(
            tenant=self.tenant, name="plat-tmpl", object_type="device",
            template_code="plat",
        )
        self.role = DeviceRole.objects.create(
            tenant=self.tenant, name="core", slug="core",
            config_template=self.t_role,
        )
        self.platform = Platform.objects.create(
            tenant=self.tenant, name="ios", slug="ios",
            config_template=self.t_plat,
        )

    def test_resolution_order(self):
        d = Device.objects.create(
            tenant=self.tenant, name="r1",
            role=self.role, platform=self.platform,
        )
        self.assertEqual(resolve_config_template(d), self.t_role)
        d.config_template = self.t_dev
        d.save()
        self.assertEqual(resolve_config_template(d), self.t_dev)
        d.config_template = None
        d.role = None
        d.save()
        self.assertEqual(resolve_config_template(d), self.t_plat)
        d.platform = None
        d.save()
        self.assertIsNone(resolve_config_template(d))

    def test_render_falls_back_to_binding(self):
        d = Device.objects.create(tenant=self.tenant, name="r2", role=self.role)
        resp = self.client.get(f"/api/devices/{d.id}/render/")
        self.assertEqual(resp.status_code, 200, resp.content)
        data = resp.json()
        self.assertEqual(data["template"], "role-tmpl")
        self.assertEqual(data["output"], "role")

    def test_render_without_binding_400s(self):
        d = Device.objects.create(tenant=self.tenant, name="r3")
        resp = self.client.get(f"/api/devices/{d.id}/render/")
        self.assertEqual(resp.status_code, 400)


class PositionalInterfaceNameTests(_Base):
    """{position} tokens in component-template names: render at materialise,
    rename on stack join / move / leave."""

    def setUp(self):
        super().setUp()
        from .models import DeviceType, InterfaceTemplate

        self.dt = DeviceType.objects.create(tenant=self.tenant, name="C9300-24P")
        for i in (1, 2):
            InterfaceTemplate.objects.create(
                device_type=self.dt,
                name=f"GigabitEthernet{{position}}/0/{i}", type="1000base-t",
            )
        InterfaceTemplate.objects.create(
            device_type=self.dt, name="mgmt0", type="1000base-t"
        )
        self.vc = VirtualChassis.objects.create(tenant=self.tenant, name="stk")

    def _mk(self, name, **kw):
        resp = self.client.post(
            "/api/devices/",
            {"name": name, "device_type_id": str(self.dt.id), **kw},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        return resp.json()["id"]

    def _names(self, device_id):
        d = Device.objects.get(pk=device_id)
        return set(d.interfaces.values_list("name", flat=True))

    def test_materialise_renders_position(self):
        did = self._mk("sw1", virtual_chassis_id=str(self.vc.id), vc_position=2)
        self.assertEqual(
            self._names(did),
            {"GigabitEthernet2/0/1", "GigabitEthernet2/0/2", "mgmt0"},
        )

    def test_standalone_defaults_to_one(self):
        did = self._mk("solo")
        self.assertIn("GigabitEthernet1/0/1", self._names(did))

    def test_join_move_leave_renames(self):
        did = self._mk("sw2")  # standalone → 1/0/x
        # Join at position 3.
        resp = self.client.patch(
            f"/api/devices/{did}/",
            {"virtual_chassis_id": str(self.vc.id), "vc_position": 3},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["vc_renamed_interfaces"], 2)
        self.assertIn("GigabitEthernet3/0/1", self._names(did))
        # Move to position 2.
        resp = self.client.patch(
            f"/api/devices/{did}/", {"vc_position": 2}, format="json"
        )
        self.assertEqual(resp.json()["vc_renamed_interfaces"], 2)
        self.assertIn("GigabitEthernet2/0/2", self._names(did))
        # Leave the stack → back to the standalone default.
        resp = self.client.patch(
            f"/api/devices/{did}/",
            {"virtual_chassis_id": None, "vc_position": None,
             "vc_priority": None},
            format="json",
        )
        self.assertEqual(resp.json()["vc_renamed_interfaces"], 2)
        names = self._names(did)
        self.assertIn("GigabitEthernet1/0/1", names)
        self.assertIn("mgmt0", names)  # tokenless names never touched

    def test_conflict_is_skipped_not_clobbered(self):
        from .models import Interface

        did = self._mk("sw3")
        d = Device.objects.get(pk=did)
        # Hand-made interface already occupies the target name for port 1.
        blocker = Interface.objects.create(
            device=d, name="GigabitEthernet4/0/1"
        )
        resp = self.client.patch(
            f"/api/devices/{did}/",
            {"virtual_chassis_id": str(self.vc.id), "vc_position": 4},
            format="json",
        )
        # Port 2 renamed; port 1 skipped because its target name is taken.
        self.assertEqual(resp.json()["vc_renamed_interfaces"], 1)
        names = self._names(did)
        self.assertIn("GigabitEthernet1/0/1", names)   # left as-was
        self.assertIn("GigabitEthernet4/0/2", names)   # renamed
        blocker.refresh_from_db()
        self.assertEqual(blocker.name, "GigabitEthernet4/0/1")

    def test_zero_based_standalone_default(self):
        from .models import DeviceType, InterfaceTemplate

        dt = DeviceType.objects.create(tenant=self.tenant, name="EX4300")
        InterfaceTemplate.objects.create(
            device_type=dt, name="ge-{position:0}/0/0", type="1000base-t"
        )
        did = self._mk("jnp1")
        # _mk uses self.dt; make one with the Juniper type directly:
        resp = self.client.post(
            "/api/devices/",
            {"name": "jnp2", "device_type_id": str(dt.id)},
            format="json",
        )
        d = Device.objects.get(pk=resp.json()["id"])
        self.assertEqual(
            set(d.interfaces.values_list("name", flat=True)), {"ge-0/0/0"}
        )
