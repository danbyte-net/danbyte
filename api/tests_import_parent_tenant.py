"""An import names related rows by id or natural key. Rows tenant-scoped only
through a parent - an interface through its device - must resolve inside the
importing tenant, as their serializer fields do."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Device, Interface, MACAddress
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant


class ParentScopedForeignKeyImportTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        other = Tenant.objects.create(org=org, name="X", slug="x")
        mine = Device.objects.create(tenant=self.tenant, name="sw-1")
        self.my_iface = Interface.objects.create(device=mine, name="eth0")
        theirs = Device.objects.create(tenant=other, name="their-sw")
        self.their_iface = Interface.objects.create(device=theirs, name="eth0")
        admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=admin).tenants.add(self.tenant)
        self.client.force_login(admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _import(self, iface):
        content = f"mac_address,assigned_interface\n00:11:22:33:44:55,{iface.id}\n"
        return self.client.post("/api/io/macaddress/import/",
                                {"format": "csv", "content": content}, format="json")

    def test_another_tenants_interface_is_not_found(self):
        r = self._import(self.their_iface)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["created"], 0, r.json())
        self.assertFalse(MACAddress.objects.filter(assigned_interface=self.their_iface).exists())

    def test_the_tenants_own_interface_is(self):
        r = self._import(self.my_iface)
        self.assertEqual(r.json()["created"], 1, r.json())

    def test_a_member_cannot_reach_another_tenants_interface_either(self):
        u = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(
            name="mac-io", object_types=["macaddress", "interface", "device"],
            actions=["view", "add", "change"],
        )
        grant.users.add(u)
        self.client.force_login(u)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")
        r = self._import(self.their_iface)
        self.assertEqual(r.json()["created"], 0, r.json())
        self.assertFalse(MACAddress.objects.filter(assigned_interface=self.their_iface).exists())

    def test_aux_ports_resolve_inside_the_tenant(self):
        from django.core.exceptions import ValidationError

        from api.bulk_import import _resolve_fk
        from api.models import AuxPort, PortReservation

        field = PortReservation._meta.get_field("aux_port")
        mine = AuxPort.objects.create(device=self.my_iface.device, name="aux0")
        theirs = AuxPort.objects.create(device=self.their_iface.device, name="aux0")
        self.assertEqual(_resolve_fk(field, str(mine.id), self.tenant), mine)
        with self.assertRaises(ValidationError):
            _resolve_fk(field, str(theirs.id), self.tenant)
