"""Security round-6 regression tests.

Each class pins one confirmed finding from the round-6 adversarial audit so the
exact cross-tenant / cross-site / privilege-escalation gap can't silently
reopen. The through-line mirrors earlier rounds: a grant scoped to Site A (or
tenant A) must never reach Site-B / tenant-B rows through a side channel
(related-object listing, search, import, automation, engine stats), and a
deployment admin must stay strictly below a superuser.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APITestCase

from api.models import Device, DeviceType, IPAddress, Site
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, Tenant


def _custom_user(username, tenant):
    user = User.objects.create_user(username, password="x")
    UserProfile.objects.create(user=user, role="custom").tenants.add(tenant)
    return user


def _grant(user, tenant, object_types, actions, *, site=None,
           constraints=None, scoped=True):
    perm = ObjectPermission.objects.create(
        name=f"{user.username}-{'-'.join(object_types)}-{'-'.join(actions)}",
        object_types=list(object_types),
        actions=list(actions),
        constraints=constraints,
    )
    perm.users.add(user)
    # A tenant-narrowed grant is skipped by can_manage_deployment (deployment
    # admin = an UNSCOPED change-on-user grant), so pass scoped=False there.
    if scoped:
        perm.tenants.add(tenant)
    if site is not None:
        perm.sites.add(site)
    return perm


class LoginMixin:
    def _login(self, user, tenant):
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str(tenant.id)
        session.save()


# ── #5 — deployment admin must not take over a superuser ─────────────────────
class SuperuserTargetGuardTests(LoginMixin, APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Esc Org", slug="esc-org")
        self.tenant = Tenant.objects.create(org=org, name="Esc", slug="esc")
        # A non-superuser deployment admin = unscoped change-on-`user` grant.
        self.admin = _custom_user("dep-admin", self.tenant)
        _grant(self.admin, self.tenant, ["user"], ["view", "change"], scoped=False)
        self.superuser = User.objects.create_superuser("root", password="rootpw")
        self.victim = _custom_user("victim", self.tenant)

    def test_cannot_reset_superuser_password(self):
        self._login(self.admin, self.tenant)
        resp = self.client.patch(
            f"/api/users/{self.superuser.pk}/",
            {"password": "attacker"},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)
        self.superuser.refresh_from_db()
        self.assertFalse(self.superuser.check_password("attacker"))

    def test_cannot_send_reset_to_superuser(self):
        self.superuser.email = "root@example.test"
        self.superuser.save()
        self._login(self.admin, self.tenant)
        resp = self.client.post(f"/api/users/{self.superuser.pk}/send-reset/")
        self.assertEqual(resp.status_code, 403)

    def test_can_still_edit_a_normal_user(self):
        self._login(self.admin, self.tenant)
        resp = self.client.patch(
            f"/api/users/{self.victim.pk}/",
            {"first_name": "Renamed"},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)


# ── #16 — ObjectPermission list is tenant-scoped ─────────────────────────────
class ObjectPermissionScopeTests(LoginMixin, APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="OP Org", slug="op-org")
        self.tenant_a = Tenant.objects.create(org=org, name="A", slug="op-a")
        self.tenant_b = Tenant.objects.create(org=org, name="B", slug="op-b")
        self.user = _custom_user("op-viewer", self.tenant_a)
        _grant(self.user, self.tenant_a, ["objectpermission"], ["view"])
        # A permission that applies only to tenant B.
        self.foreign = ObjectPermission.objects.create(
            name="tenant-b-secret", object_types=["device"], actions=["view"]
        )
        self.foreign.tenants.add(self.tenant_b)

    def test_foreign_tenant_permission_not_listed(self):
        self._login(self.user, self.tenant_a)
        resp = self.client.get("/api/object-permissions/")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        rows = data["results"] if isinstance(data, dict) else data
        names = {r["name"] for r in rows}
        self.assertNotIn("tenant-b-secret", names)


# ── #17 — global search tags are tenant-scoped ───────────────────────────────
class SearchTagScopeTests(LoginMixin, APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="ST Org", slug="st-org")
        self.tenant_a = Tenant.objects.create(org=org, name="A", slug="st-a")
        self.tenant_b = Tenant.objects.create(org=org, name="B", slug="st-b")
        self.user = _custom_user("searcher", self.tenant_a)
        Tag.objects.create(tenant=self.tenant_b, name="secretproj", slug="secretproj")

    def test_foreign_tenant_tag_not_returned(self):
        self._login(self.user, self.tenant_a)
        resp = self.client.get("/api/search/", {"q": "secretproj"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["groups"]["tags"], [])


# ── #7 — tag usage is per-type + site scoped ─────────────────────────────────
class TagUsageScopeTests(LoginMixin, APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="TU Org", slug="tu-org")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="tu")
        self.site_a = Site.objects.create(tenant=self.tenant, name="TU Site A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="TU Site B")
        self.tag = Tag.objects.create(tenant=self.tenant, name="shared", slug="shared")
        self.dev_a = Device.objects.create(
            tenant=self.tenant, site=self.site_a, name="tu-dev-a"
        )
        self.dev_b = Device.objects.create(
            tenant=self.tenant, site=self.site_b, name="tu-dev-b"
        )
        self.dev_a.tags.add(self.tag)
        self.dev_b.tags.add(self.tag)
        self.user = _custom_user("tag-viewer", self.tenant)
        _grant(self.user, self.tenant, ["tag"], ["view"])
        _grant(self.user, self.tenant, ["device"], ["view"], site=self.site_a)

    def test_usage_excludes_out_of_scope_site_devices(self):
        self._login(self.user, self.tenant)
        resp = self.client.get(f"/api/tags/{self.tag.id}/usage/")
        self.assertEqual(resp.status_code, 200)
        ids = {row["id"] for row in resp.json()["results"]}
        self.assertIn(str(self.dev_a.id), ids)
        self.assertNotIn(str(self.dev_b.id), ids)


# ── #12 — automation deploy honours device row/site scope ────────────────────
class AutomationDeployScopeTests(LoginMixin, APITestCase):
    def setUp(self):
        from integrations.models import AutomationTarget

        org = Organization.objects.create(name="AD Org", slug="ad-org")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="ad")
        self.site_a = Site.objects.create(tenant=self.tenant, name="AD Site A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="AD Site B")
        self.dev_b = Device.objects.create(
            tenant=self.tenant, site=self.site_b, name="ad-dev-b"
        )
        self.target = AutomationTarget.objects.create(
            tenant=self.tenant, name="awx", kind="webhook",
            base_url="https://awx.example.test", enabled=True,
        )
        self.user = _custom_user("deployer", self.tenant)
        _grant(self.user, self.tenant, ["automationtarget"], ["view", "change"])
        _grant(self.user, self.tenant, ["device"], ["view"], site=self.site_a)

    def test_cannot_deploy_out_of_scope_device(self):
        self._login(self.user, self.tenant)
        resp = self.client.post(
            f"/api/automation-targets/{self.target.id}/deploy/",
            {"device_ids": [str(self.dev_b.id)]},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)


# ── #18 — generic-import tag creation binds to the caller's tenant ───────────
class IoImportTagTenantTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="IO Org", slug="io-org")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="io")

    def test_commit_creates_tag_in_object_tenant(self):
        from api.io import io_for

        handler = io_for("site")
        site = Site(tenant=self.tenant, name="Imported Site")
        handler.commit(site, ["fromimport"])
        tag = Tag.objects.get(name="fromimport")
        self.assertEqual(tag.tenant_id, self.tenant.id)


# ── #19 — bulk-import FK resolution honours site scope ───────────────────────
class BulkImportFkSiteTests(TestCase):
    def setUp(self):
        from django.core.exceptions import ValidationError  # noqa: F401

        org = Organization.objects.create(name="FK Org", slug="fk-org")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="fk")
        self.site_a = Site.objects.create(tenant=self.tenant, name="FK Site A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="FK Site B")
        self.user = _custom_user("importer", self.tenant)
        _grant(self.user, self.tenant, ["site"], ["view"], site=self.site_a)

    def test_resolve_fk_denies_out_of_scope_site(self):
        from django.core.exceptions import ValidationError

        from api.bulk_import import _resolve_fk

        field = Device._meta.get_field("site")
        # In-scope site resolves.
        self.assertEqual(
            _resolve_fk(field, "FK Site A", self.tenant, self.user).id,
            self.site_a.id,
        )
        # Out-of-scope site is not resolvable for this site-scoped user.
        with self.assertRaises(ValidationError):
            _resolve_fk(field, "FK Site B", self.tenant, self.user)


# ── #10 — journal notes can't target a foreign tenant's tenant-less object ───
class JournalTenantlessObjectTests(LoginMixin, APITestCase):
    def setUp(self):
        from api.models import Interface

        org = Organization.objects.create(name="JL Org", slug="jl-org")
        self.tenant_a = Tenant.objects.create(org=org, name="A", slug="jl-a")
        self.tenant_b = Tenant.objects.create(org=org, name="B", slug="jl-b")
        site_b = Site.objects.create(tenant=self.tenant_b, name="JL Site B")
        dev_b = Device.objects.create(
            tenant=self.tenant_b, site=site_b, name="jl-dev-b"
        )
        # Interface has no direct tenant field — its tenant path is device__site.
        self.iface_b = Interface.objects.create(device=dev_b, name="eth0")
        self.user = _custom_user("journaler", self.tenant_a)
        # Unscoped view on interface (the built-in Read-only role shape).
        _grant(self.user, self.tenant_a, ["interface"], ["view"], scoped=False)

    def test_cannot_journal_foreign_tenant_interface(self):
        self._login(self.user, self.tenant_a)
        resp = self.client.post(
            "/api/journal/",
            {
                "object_type": "api.interface",
                "object_id": str(self.iface_b.id),
                "kind": "info",
                "comments": "cross-tenant note",
            },
            format="json",
        )
        self.assertIn(resp.status_code, (403, 404))


# ── #3 — webhook payloads never carry secret fields in cleartext ─────────────
class WebhookSecretMaskTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="WH Org", slug="wh-org")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="wh")

    def test_additional_headers_are_masked(self):
        from integrations.models import Webhook
        from integrations.webhooks import _field_dict

        hook = Webhook.objects.create(
            tenant=self.tenant, name="hook",
            payload_url="https://sink.example.test",
            additional_headers="Authorization: Bearer supersecret",
        )
        out = _field_dict(hook)
        self.assertEqual(out["additional_headers"], "•••")
        self.assertNotIn("supersecret", str(out))
