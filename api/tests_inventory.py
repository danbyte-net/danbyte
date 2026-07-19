"""Ansible inventory + per-device render (IaC Phase 1)."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import (
    ConfigContext, Device, DeviceRole, DeviceType, IPAddress, Manufacturer,
    Platform, Prefix, Region, Site, ExportTemplate,
)
from auth_api.models import UserProfile
from core.models import Organization, Tenant


from api.test_utils import status_for


class InventoryTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.su = User.objects.create_user("su", password="x", is_superuser=True)
        prof = UserProfile.objects.create(user=self.su)
        prof.tenants.add(self.tenant)
        prof.current_tenant = self.tenant
        prof.save()
        eu = Region.objects.create(tenant=self.tenant, name="EU", slug="eu")
        site = Site.objects.create(tenant=self.tenant, name="AMS", region=eu)
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="Cisco", slug="cisco")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="C9300")
        role = DeviceRole.objects.create(tenant=self.tenant, name="Switch", slug="switch")
        plat = Platform.objects.create(tenant=self.tenant, name="IOS", slug="ios")
        pfx = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant))
        ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.5", prefix=pfx)
        self.dev = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=dt, site=site,
            role=role, platform=plat, primary_ip=ip,
            status=status_for(self.tenant),  # status is a FK — must serialize as a slug
        )
        cc = ConfigContext.objects.create(
            tenant=self.tenant, name="base", data={"ntp": ["10.0.0.1"]}
        )
        cc.regions.add(eu)
        self.client.force_login(self.su)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def test_inventory_shape(self):
        inv = self.client.get("/api/inventory/ansible/?has_primary_ip=1").json()
        self.assertIn("site_ams", inv)
        self.assertIn("sw1", inv["site_ams"]["hosts"])
        self.assertIn("region_eu", inv)
        self.assertIn("platform_ios", inv)
        self.assertIn("status_active", inv)  # grouped by status slug, not the FK object
        hv = inv["_meta"]["hostvars"]["sw1"]
        self.assertEqual(hv["ansible_host"], "10.0.0.5")
        self.assertEqual(hv["danbyte"]["platform"], "ios")
        self.assertEqual(hv["danbyte"]["status"], "active")
        # config context resolved via the region-ancestor chain
        self.assertEqual(hv["config_context"]["ntp"], ["10.0.0.1"])

    def test_custom_fields_in_hostvars_and_grouping(self):
        # A boolean custom field set on the device surfaces as a hostvar and, when
        # truthy, also as a ``cf_<name>`` group a playbook can target directly.
        self.dev.custom_fields = {"install_btop": True, "owner": "neteng"}
        self.dev.save()
        inv = self.client.get("/api/inventory/ansible/").json()
        hv = inv["_meta"]["hostvars"]["sw1"]
        self.assertEqual(hv["danbyte"]["custom_fields"]["install_btop"], True)
        self.assertEqual(hv["danbyte"]["custom_fields"]["owner"], "neteng")
        self.assertIn("cf_install_btop", inv)
        self.assertIn("sw1", inv["cf_install_btop"]["hosts"])
        # Non-boolean CFs don't spawn groups.
        self.assertNotIn("cf_owner", inv)

    def test_interfaces_in_hostvars(self):
        from api.models import Interface
        eth0 = Interface.objects.create(
            device=self.dev, name="eth0",
            mac_address="00:11:22:33:44:55", mtu=1500, enabled=True,
        )
        # Bind the existing 10.0.0.5 IP to eth0 so it shows under the interface.
        ip = self.dev.primary_ip
        ip.assigned_interface = eth0
        ip.save()
        inv = self.client.get("/api/inventory/ansible/").json()
        ifaces = inv["_meta"]["hostvars"]["sw1"]["danbyte"]["interfaces"]
        self.assertEqual(len(ifaces), 1)
        eth = ifaces[0]
        self.assertEqual(eth["name"], "eth0")
        self.assertEqual(eth["mac_address"], "00:11:22:33:44:55")
        self.assertEqual(eth["mtu"], 1500)
        self.assertTrue(eth["enabled"])
        # IP carries the bare address + a CIDR built from the prefix mask.
        self.assertEqual(eth["ip_addresses"][0]["address"], "10.0.0.5")
        self.assertEqual(eth["ip_addresses"][0]["cidr"], "10.0.0.5/24")

    def test_per_device_inventory_preview(self):
        self.dev.custom_fields = {"install_btop": True}
        self.dev.save()
        r = self.client.get(f"/api/devices/{self.dev.id}/inventory/")
        self.assertEqual(r.status_code, 200, r.content)
        data = r.json()
        self.assertEqual(data["host"], "sw1")
        self.assertEqual(data["ansible_host"], "10.0.0.5")
        # groups this host belongs to, incl. the boolean-CF group
        self.assertIn("role_switch", data["groups"])
        self.assertIn("platform_ios", data["groups"])
        self.assertIn("cf_install_btop", data["groups"])
        # hostvars mirror the fleet export for this host
        self.assertEqual(data["hostvars"]["danbyte"]["platform"], "ios")
        self.assertEqual(
            data["hostvars"]["danbyte"]["custom_fields"]["install_btop"], True
        )

    def test_has_primary_ip_filter(self):
        Device.objects.create(
            tenant=self.tenant, name="noip",
            device_type=self.dev.device_type, site=self.dev.site,
        )
        inv = self.client.get("/api/inventory/ansible/?has_primary_ip=1").json()
        self.assertNotIn("noip", inv["_meta"]["hostvars"])
        inv2 = self.client.get("/api/inventory/ansible/").json()
        self.assertIn("noip", inv2["_meta"]["hostvars"])

    def test_device_render(self):
        tmpl = ExportTemplate.objects.create(
            tenant=self.tenant, name="cfg", object_type="device",
            template_code="hostname {{ device.name }}\n"
                          "{% for s in config_context.ntp %}ntp {{ s }}\n{% endfor %}",
        )
        r = self.client.get(f"/api/devices/{self.dev.id}/render/?template={tmpl.id}")
        self.assertEqual(r.status_code, 200)
        self.assertIn("hostname sw1", r.json()["output"])
        self.assertIn("ntp 10.0.0.1", r.json()["output"])

    def test_render_bad_template_400(self):
        r = self.client.get(f"/api/devices/{self.dev.id}/render/?template=")
        self.assertEqual(r.status_code, 400)
