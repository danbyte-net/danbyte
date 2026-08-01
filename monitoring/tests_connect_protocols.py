"""ConnectProtocol — tenant-scoped CRUD catalog + per-tenant seeding.

A Connect protocol is a launch-URL template (``ssh://{username}@{host}`` etc.)
the device Connect menu renders client-side. No secret is involved, so this is
plain tenant-scoped CRUD — the interesting behaviour is tenant isolation and the
editable seeded catalog.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .connect_protocol_seeds import seed_builtin_connect_protocols
from .models import ConnectProtocol

BASE = "/api/monitoring/connect-protocols/"


class _Mixin:
    def _user(self, name, superuser=False):
        u = User.objects.create_user(name, password="x", is_superuser=superuser)
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        return u

    def _grant(self, user, actions):
        perm = ObjectPermission.objects.create(
            name=f"connectprotocol:{','.join(actions)}",
            object_types=["connectprotocol"],
            actions=actions,
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()


class ConnectProtocolCrudTests(_Mixin, APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")
        self.su = self._user("root", superuser=True)
        self._login(self.su)

    def test_create_and_list(self):
        r = self.client.post(
            BASE,
            {"name": "Custom", "url_template": "myproto://{host}"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["url_template"], "myproto://{host}")

    def test_enabled_filter(self):
        ConnectProtocol.objects.create(
            tenant=self.tenant, name="On", url_template="a://{host}", enabled=True
        )
        ConnectProtocol.objects.create(
            tenant=self.tenant, name="Off", url_template="b://{host}", enabled=False
        )
        names = {p["name"] for p in self.client.get(f"{BASE}?enabled=1").json()["results"]}
        self.assertEqual(names, {"On"})

    def test_other_tenant_protocol_is_404(self):
        other_org = Organization.objects.create(name="P", slug="p")
        other = Tenant.objects.create(org=other_org, name="Two", slug="two")
        p = ConnectProtocol.objects.create(
            tenant=other, name="Theirs", url_template="x://{host}"
        )
        self.assertEqual(self.client.get(f"{BASE}{p.id}/").status_code, 404)

    def test_rbac_requires_change_to_edit(self):
        u = self._user("viewer")
        self._grant(u, ["view"])
        self._login(u)
        p = ConnectProtocol.objects.create(
            tenant=self.tenant, name="P", url_template="x://{host}"
        )
        # Can read, cannot mutate.
        self.assertEqual(self.client.get(f"{BASE}{p.id}/").status_code, 200)
        self.assertIn(
            self.client.patch(
                f"{BASE}{p.id}/", {"name": "Renamed"}, format="json"
            ).status_code,
            (403, 404),
        )


class ConnectProtocolTargetingTests(_Mixin, APITestCase):
    def setUp(self):
        from api.models import Device, DeviceRole, DeviceType, Manufacturer

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")
        self.su = self._user("root", superuser=True)
        self._login(self.su)
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="Switch"
        )
        self.role = DeviceRole.objects.create(
            tenant=self.tenant, name="Access", slug="access"
        )
        self.device = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=self.dt, role=self.role
        )

    def test_device_filter_is_a_union_of_untargeted_type_and_role(self):
        untargeted = ConnectProtocol.objects.create(
            tenant=self.tenant, name="SSH", url_template="ssh://{host}"
        )
        by_type = ConnectProtocol.objects.create(
            tenant=self.tenant, name="ByType", url_template="a://{host}"
        )
        by_type.device_types.add(self.dt)
        by_role = ConnectProtocol.objects.create(
            tenant=self.tenant, name="ByRole", url_template="b://{host}"
        )
        by_role.roles.add(self.role)
        other = ConnectProtocol.objects.create(
            tenant=self.tenant, name="Other", url_template="c://{host}"
        )
        from api.models import DeviceRole

        other.roles.add(DeviceRole.objects.create(
            tenant=self.tenant, name="Core", slug="core"
        ))

        names = {
            p["name"]
            for p in self.client.get(
                f"{BASE}?device={self.device.id}"
            ).json()["results"]
        }
        # Untargeted + type-match + role-match show; the foreign-role one doesn't.
        self.assertEqual(names, {"SSH", "ByType", "ByRole"})
        self.assertNotIn("Other", names)

    def test_device_filter_rejects_foreign_tenant_device(self):
        from api.models import Device

        other_org = Organization.objects.create(name="P", slug="p")
        other = Tenant.objects.create(org=other_org, name="Two", slug="two")
        d2 = Device.objects.create(tenant=other, name="theirs")
        ConnectProtocol.objects.create(
            tenant=self.tenant, name="SSH", url_template="ssh://{host}"
        )
        r = self.client.get(f"{BASE}?device={d2.id}")
        self.assertEqual(r.json()["results"], [])


class ConnectProtocolSeedTests(_Mixin, APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")

    def test_seed_is_idempotent_and_editable(self):
        first = seed_builtin_connect_protocols(self.tenant)
        self.assertEqual(first, 5)
        # Second run creates nothing (keyed on name).
        self.assertEqual(seed_builtin_connect_protocols(self.tenant), 0)
        ssh = ConnectProtocol.objects.get(tenant=self.tenant, name="SSH")
        self.assertEqual(ssh.url_template, "ssh://{username}@{host}")
        # Editing then re-seeding must not clobber the operator's change.
        ssh.url_template = "ssh://{username}@{host}:{port}"
        ssh.save(update_fields=["url_template"])
        seed_builtin_connect_protocols(self.tenant)
        ssh.refresh_from_db()
        self.assertEqual(ssh.url_template, "ssh://{username}@{host}:{port}")
