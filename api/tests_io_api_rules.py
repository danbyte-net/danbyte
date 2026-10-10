"""Spreadsheet import writes through the type's API: its serializer and the
viewset's create/update hooks, so a rule the API enforces outside serializer
validation applies to imported rows too (#364, #365)."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Contact, ContactAssignment, Device, Rack, Site
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant


class _Case(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")

    def _user(self, name, grants, *, superuser=False, sites=None):
        u = User.objects.create_user(name, password="x", is_superuser=superuser)
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        for slug, actions in grants.items():
            perm = ObjectPermission.objects.create(
                name=f"{name}-{slug}", object_types=[slug], actions=list(actions),
            )
            perm.users.add(u)
            perm.tenants.add(self.tenant)
            if sites:
                perm.sites.set(sites)
        return u

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _import(self, slug, rows, dry_run=False):
        resp = self.client.post(f"/api/io/{slug}/import/",
                                {"rows": rows, "dry_run": dry_run}, format="json")
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()


class ScriptTrustTests(_Case):
    """#364 - import cannot mark a script trusted, keep a trusted script
    trusted across a code change, or reassign its owner."""

    def setUp(self):
        super().setUp()
        from scripting.models import Script

        self.author = self._user("author", {"script": ["view", "add", "change", "run"]})
        self.editor = self._user("editor", {"script": ["view", "change", "run"]})
        self.approver = self._user("approver",
                                   {"script": ["view", "change", "run", "trust"]})
        self.script = Script.objects.create(
            tenant=self.tenant, name="S", source="print('hi')", owner=self.author,
            visibility="users",
        )
        self.script.shared_users.add(self.editor, self.approver)

    def _reload(self):
        self.script.refresh_from_db()
        return self.script

    def test_trusted_cannot_be_set(self):
        self._login(self.editor)
        for dry in (True, False):
            self._import("script", [{"id": str(self.script.id), "trusted": "True"}],
                         dry_run=dry)
        self.assertFalse(self._reload().trusted)
        self.assertEqual(self.client.post(f"/api/scripts/{self.script.id}/trust/").status_code,
                         403)

    def test_a_code_change_clears_trust(self):
        type(self.script).objects.filter(pk=self.script.pk).update(trusted=True)
        self._login(self.editor)
        res = self._import("script", [{"id": str(self.script.id), "source": "print('mine')"}])
        self.assertEqual((res["updated"], res["errors"]), (1, []))
        s = self._reload()
        self.assertEqual(s.source, "print('mine')")
        self.assertFalse(s.trusted)

    def test_a_holder_of_trust_keeps_it_trusted(self):
        type(self.script).objects.filter(pk=self.script.pk).update(trusted=True)
        self._login(self.approver)
        res = self._import("script", [{"id": str(self.script.id), "source": "print('ok')"}])
        self.assertEqual((res["updated"], res["errors"]), (1, []))
        self.assertTrue(self._reload().trusted)

    def test_an_unrelated_edit_keeps_trust(self):
        type(self.script).objects.filter(pk=self.script.pk).update(trusted=True)
        self._login(self.editor)
        res = self._import("script", [{"id": str(self.script.id), "description": "doc"}])
        self.assertEqual((res["updated"], res["errors"]), (1, []))
        self.assertTrue(self._reload().trusted)

    def test_owner_cannot_be_reassigned(self):
        self._login(self.editor)
        res = self._import("script", [{"id": str(self.script.id),
                                       "owner": str(self.editor.id)}])
        self.assertEqual(res["errors"], [])
        self.assertEqual(self._reload().owner_id, self.author.id)

    def test_a_created_script_belongs_to_the_importer_untrusted(self):
        from scripting.models import Script

        self._login(self.author)
        res = self._import("script", [{
            "name": "new", "slug": "new", "source": "print(1)", "trusted": "True",
            "owner": str(self.approver.id),
        }])
        self.assertEqual((res["created"], res["errors"]), (1, []))
        s = Script.objects.get(tenant=self.tenant, name="new")
        self.assertFalse(s.trusted)
        self.assertEqual(s.owner_id, self.author.id)

    def test_trust_and_owner_are_not_offered_as_import_columns(self):
        self._login(self.editor)
        names = {f["name"] for f in self.client.get("/api/io/script/fields/").json()["fields"]}
        self.assertIn("source", names)
        self.assertNotIn("trusted", names)
        self.assertNotIn("owner", names)


class DeviceCredentialPathTests(_Case):
    """#365 - only a deployment administrator may point a credential at an
    external secret path, through import as through the API."""

    def setUp(self):
        super().setUp()
        self.dev = Device.objects.create(tenant=self.tenant, name="sw-b")
        self.op = self._user("op", {
            "devicecredential": ["view", "add", "change", "reveal"], "device": ["view"],
        })
        self.root = self._user("root", {}, superuser=True)

    def _row(self, **kw):
        row = {"device": "sw-b", "name": "y", "kind": "ssh_password",
               "secret_managed": "False", "secret_provider": "vault",
               "secret_path": "secret/data/prod/core-routers"}
        row.update(kw)
        return row

    def test_operator_cannot_create_an_external_credential(self):
        from monitoring.models import DeviceCredential

        self._login(self.op)
        api = self.client.post("/api/monitoring/device-credentials/", {
            "device": str(self.dev.id), "name": "x", "kind": "ssh_password",
            "secret_managed": False, "secret_path": "secret/data/prod/core-routers",
        }, format="json")
        self.assertEqual(api.status_code, 403)
        for dry in (True, False):
            res = self._import("devicecredential", [self._row()], dry_run=dry)
            self.assertEqual(res["created"], 0)
            self.assertIn("deployment administrator", res["errors"][0]["error"])
        self.assertFalse(DeviceCredential.objects.filter(tenant=self.tenant).exists())

    def test_operator_cannot_repoint_an_external_credential(self):
        from monitoring.models import DeviceCredential

        cred = DeviceCredential.objects.create(
            tenant=self.tenant, device=self.dev, name="y", kind="ssh_password",
            secret_managed=False, secret_path="kv/data/team/ssh",
        )
        self._login(self.op)
        res = self._import("devicecredential", [self._row(id=str(cred.id))])
        self.assertEqual(res["updated"], 0)
        self.assertIn("deployment administrator", res["errors"][0]["error"])
        cred.refresh_from_db()
        self.assertEqual(cred.secret_path, "kv/data/team/ssh")
        # Editing the login of the external credential stays open.
        res = self._import("devicecredential", [
            {"id": str(cred.id), "username": "ops"}])
        self.assertEqual((res["updated"], res["errors"]), (1, []))

    def test_a_managed_credential_ignores_a_supplied_path(self):
        from monitoring.models import DeviceCredential

        self._login(self.op)
        res = self._import("devicecredential", [self._row(
            secret_managed="True", secret_path=f"danbyte/data/{self.other.id}/x")])
        self.assertEqual((res["created"], res["errors"]), (1, []))
        cred = DeviceCredential.objects.get(tenant=self.tenant, name="y")
        self.assertTrue(cred.secret_managed)
        self.assertEqual(cred.secret_path, "")

    def test_a_deployment_admin_may(self):
        from monitoring.models import DeviceCredential

        self._login(self.root)
        res = self._import("devicecredential", [self._row()])
        self.assertEqual((res["created"], res["errors"]), (1, []))
        cred = DeviceCredential.objects.get(tenant=self.tenant, name="y")
        self.assertEqual(cred.secret_path, "secret/data/prod/core-routers")


class ViewsetHookTests(_Case):
    """Rules that live in a viewset's create/update hooks, beyond the two
    reported types."""

    def test_contact_assignment_target_must_be_in_the_tenant(self):
        contact = Contact.objects.create(tenant=self.tenant, name="c")
        theirs = Site.objects.create(tenant=self.other, name="Theirs")
        self._login(self._user("root", {}, superuser=True))
        res = self._import("contactassignment", [{
            "contact": "c", "object_type": "api.site", "object_id": str(theirs.id),
        }])
        self.assertEqual(res["created"], 0)
        self.assertIn("object_id", res["errors"][0]["error"])
        self.assertFalse(ContactAssignment.objects.filter(contact=contact).exists())

    def test_a_site_scoped_editor_cannot_move_a_row_out_of_their_sites(self):
        ams = Site.objects.create(tenant=self.tenant, name="AMS")
        Site.objects.create(tenant=self.tenant, name="LON")
        rack = Rack.objects.create(tenant=self.tenant, site=ams, name="R1")
        # Racks only in AMS; every site may be seen and named.
        user = self._user("ams", {"rack": ["view", "add", "change"]}, sites=[ams])
        perm = ObjectPermission.objects.create(name="sites", object_types=["site"],
                                               actions=["view"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self._login(user)
        res = self._import("rack", [{"id": str(rack.id), "name": "R1", "site": "LON"}])
        self.assertEqual(res["updated"], 0)
        self.assertTrue(res["errors"])
        rack.refresh_from_db()
        self.assertEqual(rack.site_id, ams.id)

    def test_a_type_the_api_cannot_write_is_not_importable(self):
        self._login(self._user("root", {}, superuser=True))
        resp = self.client.post("/api/io/acmeorder/import/",
                                {"rows": [{"id": "x"}]}, format="json")
        self.assertEqual(resp.status_code, 400)
        types = {t["slug"]: t for t in self.client.get("/api/io/types/").json()["object_types"]}
        self.assertFalse(types["acmeorder"]["can_import"])
        self.assertTrue(types["acmeorder"]["can_export"])

    def test_read_only_api_fields_are_export_only(self):
        # IPAddress.discovered is read-only in the API.
        from api.models import IPAddress, Prefix
        from api.test_utils import status_for

        st = status_for(self.tenant)
        net = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24", status=st)
        ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.1",
                                      prefix=net, status=st)
        self._login(self._user("root", {}, superuser=True))
        res = self._import("ipaddress", [{"id": str(ip.id), "discovered": "True"}])
        self.assertEqual(res["errors"], [])
        ip.refresh_from_db()
        self.assertFalse(ip.discovered)
