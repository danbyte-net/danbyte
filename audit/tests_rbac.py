"""Audit + journal reads respect the caller's per-type view grants — a member
who can't view devices must not read device change history. (Secops #5.)"""
from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Device, Prefix
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant


class AuditRbacTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")
        # Two audited objects of different types.
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant)
        )
        self.device = Device.objects.create(tenant=self.tenant, name="dev-1")

        # A member granted view on prefixes only.
        self.user = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="prefix view", object_types=["prefix"], actions=["view"]
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)

        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _types(self, url):
        rows = self.client.get(url).json()["results"]
        return {r["object_type"] for r in rows}

    def test_changelog_scoped_to_viewable_types(self):
        types = self._types("/api/changelog/?page_size=200")
        self.assertIn("api.prefix", types)
        self.assertNotIn("api.device", types)

    def test_superuser_sees_all_changelog_types(self):
        su = User.objects.create_user("su", password="x", is_superuser=True)
        UserProfile.objects.create(user=su).tenants.add(self.tenant)
        self.client.force_login(su)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        types = self._types("/api/changelog/?page_size=200")
        self.assertIn("api.device", types)


class CanActOnObjectVerbTests(APITestCase):
    """`_can_act_on_object` gained an `action` parameter so the planned-change
    apply path can ask "may this caller CHANGE this exact row?" reusing the same
    tenant clamp and tenant-less site binding the view check already had."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")
        self.other = Tenant.objects.create(org=org, name="Two", slug="two")
        self.device = Device.objects.create(tenant=self.tenant, name="dev-1")

    def _grant(self, username, types, actions, tenant=None):
        user = User.objects.create_user(username, password="x")
        UserProfile.objects.create(user=user).tenants.add(tenant or self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"p-{username}", object_types=list(types), actions=list(actions)
        )
        perm.users.add(user)
        perm.tenants.add(tenant or self.tenant)
        return user

    def _request(self, user):
        from rest_framework.test import APIRequestFactory

        request = APIRequestFactory().get("/")
        request.user = user
        request.session = {"current_tenant_id": str(self.tenant.id)}
        return request

    def test_change_verb_denies_a_view_only_grant(self):
        from audit.api import _can_act_on_object, _can_view_object

        request = self._request(self._grant("viewonly", ["device"], ["view"]))
        self.assertTrue(_can_view_object(request, "api.device", str(self.device.id)))
        self.assertTrue(
            _can_act_on_object(request, "api.device", str(self.device.id), "view")
        )
        self.assertFalse(
            _can_act_on_object(request, "api.device", str(self.device.id), "change")
        )

    def test_change_verb_allows_a_change_grant(self):
        from audit.api import _can_act_on_object

        request = self._request(
            self._grant("editor", ["device"], ["view", "change"])
        )
        self.assertTrue(
            _can_act_on_object(request, "api.device", str(self.device.id), "change")
        )

    def test_tenant_less_target_in_a_foreign_tenant_is_denied(self):
        """Interfaces have no tenant FK — they bind through their site path. An
        unscoped grant must not reach another tenant's port."""
        from api.models import Interface
        from audit.api import _can_act_on_object

        foreign_dev = Device.objects.create(tenant=self.other, name="theirs")
        foreign = Interface.objects.create(device=foreign_dev, name="Gi0/1")
        request = self._request(
            self._grant("ifeditor", ["interface"], ["view", "change"])
        )
        self.assertFalse(
            _can_act_on_object(
                request, "api.interface", str(foreign.id), "change"
            )
        )
