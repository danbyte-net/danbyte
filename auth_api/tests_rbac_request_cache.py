"""The per-request RBAC memo (#241): one lookup per request, and never a
stale answer when a grant, a group membership or the site-separation flag
(#297) changes mid-request."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import Group, User
from django.test import RequestFactory, TestCase
from rest_framework.test import APITestCase

from api.models import Device, Site
from audit.models import JournalEntry
from core.effective_settings import effective_separation, separation_enabled
from core.models import DeploymentSettings, Organization, Tenant, TenantSettings

from . import rbac
from .models import ObjectPermission, UserProfile


class RequestCacheTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.user = User.objects.create_user("u", password="x")

    def within_request(self, fn):
        out = {}

        def view(_request):
            out["value"] = fn()
            return None

        rbac.RequestCacheMiddleware(view)(RequestFactory().get("/"))
        return out["value"]

    def grant(self, **kw):
        perm = ObjectPermission.objects.create(
            name=kw.get("name", "p"), object_types=["device"], actions=["view"])
        return perm

    def test_a_grant_added_mid_request_is_seen(self):
        def run():
            before = rbac.applicable_permissions(self.user, self.tenant)
            self.grant().users.add(self.user)
            after = rbac.applicable_permissions(self.user, self.tenant)
            return len(before), len(after)

        self.assertEqual(self.within_request(run), (0, 1))

    def test_leaving_a_group_mid_request_is_seen(self):
        group = Group.objects.create(name="ops")
        self.grant().groups.add(group)
        self.user.groups.add(group)

        def run():
            before = rbac.applicable_permissions(self.user, self.tenant)
            self.user.groups.remove(group)
            after = rbac.applicable_permissions(self.user, self.tenant)
            return len(before), len(after)

        self.assertEqual(self.within_request(run), (1, 0))

    def test_the_memo_is_one_query_and_ends_with_the_request(self):
        self.grant().users.add(self.user)

        def run():
            rbac.applicable_permissions(self.user, self.tenant)
            with self.assertNumQueries(0):
                rbac.applicable_permissions(self.user, self.tenant)

        self.within_request(run)
        self.assertIsNone(rbac._request_cache.get())
        # Outside a request nothing is memoised.
        with self.assertNumQueries(3):
            rbac.applicable_permissions(self.user, self.tenant)

    def test_the_separation_flag_is_read_once_per_request(self):
        """Every catalog-type RBAC check asks for the flag: 23 times, two
        queries each, on a site-limited user's journal page (#297)."""

        def run():
            separation_enabled(self.tenant)
            with self.assertNumQueries(0):
                return separation_enabled(self.tenant)

        self.assertFalse(self.within_request(run))
        # Outside a request every call reads the settings rows again.
        with self.assertNumQueries(2):
            separation_enabled(self.tenant)

    def test_a_settings_change_mid_request_is_seen(self):
        def run():
            seen = [separation_enabled(self.tenant)]
            dep = DeploymentSettings.load()
            dep.enhanced_site_separation = True
            dep.save()
            seen.append(separation_enabled(self.tenant))
            ts = TenantSettings.objects.create(tenant=self.tenant, override_separation=True)
            seen.append(separation_enabled(self.tenant))
            ts.delete()
            seen.append(separation_enabled(self.tenant))
            return seen

        self.assertEqual(self.within_request(run), [False, True, False, True])


class SeparationLookupsPerRequestTests(APITestCase):
    def test_a_site_limited_journal_page_reads_the_flag_once(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        site = Site.objects.create(tenant=tenant, name="HQ")
        device = Device.objects.create(tenant=tenant, name="sw1", site=site)
        JournalEntry.objects.create(
            tenant=tenant, object_type="api.device", object_id=str(device.pk),
            object_site_id=site.pk, comments="note",
        )
        user = User.objects.create_user("local", password="x")
        UserProfile.objects.create(user=user).tenants.add(tenant)
        perm = ObjectPermission.objects.create(name="hq", object_types=["*"], actions=["view"])
        perm.users.add(user)
        perm.sites.set([site])
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(tenant.id)
        s.save()

        with mock.patch(
            "core.effective_settings.effective_separation", wraps=effective_separation
        ) as lookup:
            r = self.client.get("/api/journal/?page_size=10")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(r.json()["results"]), 1)
        self.assertEqual(lookup.call_count, 1)
