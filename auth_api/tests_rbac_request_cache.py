"""The per-request RBAC memo (#241): one lookup per request, and never a
stale answer when a grant or a group membership changes mid-request."""
from __future__ import annotations

from django.contrib.auth.models import Group, User
from django.test import RequestFactory, TestCase

from core.models import Organization, Tenant

from . import rbac
from .models import ObjectPermission


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
