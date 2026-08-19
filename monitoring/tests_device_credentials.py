"""DeviceCredential - CRUD, tenant isolation, and the reveal capability verb.

A device credential links a device to an *externally-authored* secret: Danbyte
stores only the reference (provider + path), never the value. The secret is only
ever returned by the ``reveal`` action, which is gated on the new ``reveal`` RBAC
verb (independent of ``change``), re-checks device access, and is audited.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Device
from auth_api import rbac
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant

from .models import DeviceCredential, StoredSecret

BASE = "/api/monitoring/device-credentials/"


class _Mixin:
    def _user(self, name, superuser=False):
        u = User.objects.create_user(name, password="x", is_superuser=superuser)
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        return u

    def _grant(self, user, slug_actions, *, object_types=None):
        """Grant ``user`` a set of (slug -> actions) in the active tenant.

        ``slug_actions`` is {object_type_slug: [actions]}; each becomes its own
        ObjectPermission so the actions per type stay independent.
        """
        for slug, actions in slug_actions.items():
            perm = ObjectPermission.objects.create(
                name=f"{slug}:{','.join(actions)}",
                object_types=object_types or [slug],
                actions=actions,
            )
            perm.users.add(user)
            perm.tenants.add(self.tenant)

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()


class DeviceCredentialCrudTests(_Mixin, APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")
        self.device = Device.objects.create(tenant=self.tenant, name="sw1")
        self.su = self._user("root", superuser=True)
        self._login(self.su)

    def _make(self, **over):
        data = {
            "device": str(self.device.id),
            "name": "admin login",
            "kind": "ssh_password",
            "username": "netadmin",
            "secret_provider": "local",
            "secret_path": "creds/sw1/admin",
        }
        data.update(over)
        return self.client.post(BASE, data, format="json")

    def test_crud_happy_path(self):
        r = self._make()
        self.assertEqual(r.status_code, 201, r.content)
        cid = r.json()["id"]
        # list + retrieve
        self.assertEqual(self.client.get(BASE).status_code, 200)
        r = self.client.get(f"{BASE}{cid}/")
        self.assertEqual(r.status_code, 200)
        # update
        r = self.client.patch(f"{BASE}{cid}/", {"username": "root"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["username"], "root")
        # delete
        self.assertEqual(self.client.delete(f"{BASE}{cid}/").status_code, 204)
        self.assertFalse(DeviceCredential.objects.filter(pk=cid).exists())

    def test_secret_value_never_serialised(self):
        r = self._make(secret_path="creds/x")
        body = r.json()
        # Only the reference is exposed - provider + path, never a value column.
        self.assertEqual(body["secret_provider"], "local")
        self.assertEqual(body["secret_path"], "creds/x")
        for banned in ("secret", "value", "password", "secret_value", "private_key"):
            self.assertNotIn(banned, body)
        # And in list + detail.
        for obj in self.client.get(BASE).json()["results"]:
            for banned in ("secret", "value", "password"):
                self.assertNotIn(banned, obj)
        detail = self.client.get(f"{BASE}{r.json()['id']}/").json()
        for banned in ("secret", "value", "password"):
            self.assertNotIn(banned, detail)

    def test_cross_tenant_device_rejected_on_create(self):
        other_org = Organization.objects.create(name="P", slug="p")
        other = Tenant.objects.create(org=other_org, name="Two", slug="two")
        foreign = Device.objects.create(tenant=other, name="theirs")
        r = self._make(device=str(foreign.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("device", r.json())


class DeviceCredentialTenantIsolationTests(_Mixin, APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")
        self.other = Tenant.objects.create(org=org, name="Two", slug="two")
        self.other_device = Device.objects.create(tenant=self.other, name="sw2")
        self.other_cred = DeviceCredential.objects.create(
            tenant=self.other, device=self.other_device, name="x",
            kind="ssh_password", secret_provider="local", secret_path="p",
        )
        self.su = self._user("root", superuser=True)
        self._login(self.su)  # active tenant = One

    def test_other_tenant_credential_is_404(self):
        # Superuser, but the active tenant is One - a Two credential is invisible.
        self.assertEqual(
            self.client.get(f"{BASE}{self.other_cred.id}/").status_code, 404
        )
        self.assertEqual(
            self.client.post(f"{BASE}{self.other_cred.id}/reveal/").status_code, 404
        )


class DeviceCredentialRevealRbacTests(_Mixin, APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")
        self.device = Device.objects.create(tenant=self.tenant, name="sw1")
        self.cred = DeviceCredential.objects.create(
            tenant=self.tenant, device=self.device, name="admin",
            kind="ssh_password", secret_provider="local",
            secret_path="creds/sw1/admin",
        )
        # Enable the local secret store and seed the referenced secret.
        dep = DeploymentSettings.load()
        dep.secrets_provider = "local"
        dep.save(update_fields=["secrets_provider"])
        StoredSecret.objects.create(
            tenant=self.tenant, ref="creds/sw1/admin",
            value={"password": "hunter2"},
        )

    def _disable_store(self):
        dep = DeploymentSettings.load()
        dep.secrets_provider = ""
        dep.save(update_fields=["secrets_provider"])

    # ── the verb itself is fail-closed and independent of change ────────────
    def test_reveal_denied_without_reveal_verb(self):
        u = self._user("editor")
        # Can view AND change the credential, and view the device - but no reveal.
        self._grant(u, {"devicecredential": ["view", "change"], "device": ["view"]})
        self._login(u)
        self.assertEqual(
            self.client.post(f"{BASE}{self.cred.id}/reveal/").status_code, 403
        )

    def test_reveal_allowed_with_reveal_verb(self):
        u = self._user("revealer")
        self._grant(u, {"devicecredential": ["view", "reveal"], "device": ["view"]})
        self._login(u)
        r = self.client.post(f"{BASE}{self.cred.id}/reveal/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["secret"], {"password": "hunter2"})

    def test_reveal_requires_device_view(self):
        # Has reveal on the credential but no view on the device → 403.
        u = self._user("noguest")
        self._grant(u, {"devicecredential": ["view", "reveal"]})
        self._login(u)
        self.assertEqual(
            self.client.post(f"{BASE}{self.cred.id}/reveal/").status_code, 403
        )

    def test_reveal_superuser_allowed(self):
        self._login(self._user("root", superuser=True))
        r = self.client.post(f"{BASE}{self.cred.id}/reveal/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["secret"], {"password": "hunter2"})

    def test_reveal_writes_audit_entry(self):
        from audit.models import ChangeAction, ChangeLogEntry

        self._login(self._user("root", superuser=True))
        self.client.post(f"{BASE}{self.cred.id}/reveal/")
        entry = ChangeLogEntry.objects.filter(
            action=ChangeAction.REVEAL, object_id=str(self.cred.id)
        ).first()
        self.assertIsNotNone(entry)
        self.assertEqual(entry.object_type, "monitoring.devicecredential")

    # ── fail closed when no store is enabled ────────────────────────────────
    def test_reveal_fails_closed_when_store_disabled(self):
        self._disable_store()
        self._login(self._user("root", superuser=True))
        r = self.client.post(f"{BASE}{self.cred.id}/reveal/")
        self.assertEqual(r.status_code, 400)
        self.assertIn("detail", r.json())

    def test_managed_secret_is_written_and_revealed(self):
        # Create a managed credential with a typed password: Danbyte stores it in
        # the active store under its own ref, and reveal returns it - no manual
        # StoredSecret seeding.
        u = self._user("mgr", superuser=True)
        self._login(u)
        r = self.client.post(
            BASE,
            {
                "device": str(self.device.id),
                "name": "managed",
                "kind": "ssh_password",
                "username": "netadmin",
                "secret_managed": True,
                "password": "s3cret",
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertTrue(body["secret_set"])
        self.assertEqual(body["secret_provider"], "local")
        self.assertNotIn("password", body)
        rev = self.client.post(f"{BASE}{body['id']}/reveal/")
        self.assertEqual(rev.status_code, 200, rev.content)
        self.assertEqual(rev.json()["secret"], {"password": "s3cret"})

    def test_reveal_400_when_nothing_at_path(self):
        self.cred.secret_path = "creds/does-not-exist"
        self.cred.save(update_fields=["secret_path"])
        self._login(self._user("root", superuser=True))
        r = self.client.post(f"{BASE}{self.cred.id}/reveal/")
        self.assertEqual(r.status_code, 400)

    def test_reveal_never_resolves_another_tenants_secret(self):
        # Another tenant holds a secret at the *same ref path* - the local store
        # must scope by tenant so this tenant's reveal can never read it. Drop
        # this tenant's own secret so only the other tenant's remains at the ref.
        StoredSecret.objects.filter(tenant=self.tenant, ref="creds/sw1/admin").delete()
        other_org = Organization.objects.create(name="P", slug="p")
        other = Tenant.objects.create(org=other_org, name="Two", slug="two")
        StoredSecret.objects.create(
            tenant=other, ref="creds/sw1/admin", value={"password": "leaked"}
        )
        self._login(self._user("root", superuser=True))
        r = self.client.post(f"{BASE}{self.cred.id}/reveal/")
        # Nothing at the path *for this tenant* → fail closed, no cross-tenant read.
        self.assertEqual(r.status_code, 400)


class RbacVerbVocabularyTests(_Mixin, APITestCase):
    """The verb extension is additive: connect/reveal are grantable and
    independent, and the existing four verbs still resolve unchanged."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")

    def test_reveal_is_independent_of_change(self):
        u = self._user("editor")
        self._grant(u, {"devicecredential": ["view", "change"]})
        self.assertTrue(rbac.has_action(u, self.tenant, "devicecredential", "change"))
        self.assertFalse(rbac.has_action(u, self.tenant, "devicecredential", "reveal"))
        self.assertFalse(rbac.has_action(u, self.tenant, "devicecredential", "connect"))

    def test_reveal_grant_grants_only_reveal(self):
        u = self._user("revealer")
        self._grant(u, {"devicecredential": ["reveal"]})
        self.assertTrue(rbac.has_action(u, self.tenant, "devicecredential", "reveal"))
        self.assertFalse(rbac.has_action(u, self.tenant, "devicecredential", "change"))

    def test_superuser_has_all_verbs(self):
        su = self._user("root", superuser=True)
        for verb in ("view", "add", "change", "delete", "connect", "reveal"):
            self.assertTrue(rbac.has_action(su, self.tenant, "devicecredential", verb))

    def test_wildcard_grant_covers_new_verbs(self):
        u = self._user("star")
        self._grant(u, {"devicecredential": ["reveal", "connect"]}, object_types=["*"])
        self.assertTrue(rbac.has_action(u, self.tenant, "devicecredential", "reveal"))
        self.assertTrue(rbac.has_action(u, self.tenant, "device", "connect"))

    def test_existing_four_verb_grant_unchanged(self):
        # A pre-existing CRUD grant still resolves exactly its four verbs - the
        # new verbs neither leak in nor drop the old ones.
        u = self._user("crud")
        self._grant(u, {"prefix": ["view", "add", "change", "delete"]})
        eff = rbac.effective_actions(u, self.tenant)["prefix"]
        self.assertEqual(eff, {"view", "add", "change", "delete"})
