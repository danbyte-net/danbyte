"""Bulk select on the Scripts list: enable and disable through the bulk
edit, safe bulk delete and export of the selection - each only over the
scripts the caller sees, as the list itself."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import UserProfile
from core.models import Organization, Tenant
from scripting.models import Script, ScriptRun

from .tests_api import grant

URL = "/api/scripts/"


class ScriptBulkTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        U = get_user_model()
        self.author = U.objects.create_user("author", "w@e.com", "x")
        self.someone = U.objects.create_user("someone", "s@e.com", "x")
        self.reader = U.objects.create_user("reader", "r@e.com", "x")
        for u in (self.author, self.someone, self.reader):
            UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
            grant(u, self.tenant, ["view"] if u is self.reader
                  else ["view", "add", "change", "delete"])
        self.mine = self._script("Mine", self.author)
        self.shared = self._script("Shared", self.someone, visibility="global")
        self.private = self._script("Private", self.someone, source="print('secret-plan')")
        self.theirs = Script.objects.create(tenant=self.other, name="Theirs",
                                            owner=self.someone, visibility="global")
        self.login(self.author)

    def _script(self, name, owner, **kw):
        kw.setdefault("source", "print('hi')")
        return Script.objects.create(tenant=self.tenant, name=name, owner=owner, **kw)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def post(self, action, ids, **body):
        return self.client.post(f"{URL}{action}/", {"ids": [str(i) for i in ids], **body},
                                format="json")

    def ok(self, r, code=200):
        self.assertEqual(r.status_code, code, r.content)
        return r.json() if r.content else None

    def everyone(self):
        return [self.mine.id, self.shared.id, self.private.id, self.theirs.id]

    def test_describes_its_fields(self):
        body = self.ok(self.client.get(f"{URL}bulk-edit-fields/"))
        self.assertEqual([f["key"] for f in body["fields"]], ["enabled", "description"])

    def test_disable_touches_only_the_scripts_the_caller_sees(self):
        body = self.ok(self.post("bulk-update", self.everyone(), fields={"enabled": False}))
        self.assertEqual(body["updated"], 2)
        for s in (self.mine, self.shared, self.private, self.theirs):
            s.refresh_from_db()
        self.assertEqual([s.enabled for s in (self.mine, self.shared, self.private, self.theirs)],
                         [False, False, True, True])
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="scripting.script", object_id=str(self.mine.pk)).exists())

    def test_what_runs_is_no_bulk_edit(self):
        for fields in ({"source": "x"}, {"run_as": "owner"}, {"trusted": True},
                       {"visibility": "global"}, {"schedule_enabled": True}):
            r = self.post("bulk-update", [self.mine.id], fields=fields)
            self.assertEqual(r.status_code, 400, fields)

    def test_bulk_delete_previews_runs_and_skips_the_unseen(self):
        ScriptRun.objects.create(script=self.mine)
        body = self.ok(self.post("bulk-delete", self.everyone(), dry_run=True))
        self.assertEqual(sorted(body["deleted_ids"]),
                         sorted([str(self.mine.id), str(self.shared.id)]))
        self.assertIn({"label": "script runs", "count": 1}, body["impact"])
        self.ok(self.post("bulk-delete", self.everyone()))
        self.assertEqual(set(Script.objects.values_list("name", flat=True)),
                         {"Private", "Theirs"})

    def test_a_reader_may_neither_edit_nor_delete(self):
        self.login(self.reader)
        self.assertEqual(self.post("bulk-update", [self.shared.id],
                                   fields={"enabled": False}).status_code, 403)
        self.assertEqual(self.post("bulk-delete", [self.shared.id]).status_code, 403)

    def test_export_leaves_out_the_scripts_the_caller_cannot_see(self):
        for body in ({"fmt": "json", "ids": [str(i) for i in self.everyone()]},
                     {"fmt": "json"}):
            r = self.client.post("/api/io/script/export/", body, format="json")
            self.assertEqual(r.status_code, 200)
            text = b"".join(r.streaming_content).decode()
            self.assertIn(str(self.mine.id), text)
            self.assertIn(str(self.shared.id), text)
            self.assertNotIn(str(self.private.id), text)
            self.assertNotIn("secret-plan", text)
            self.assertNotIn(str(self.theirs.id), text)

    def test_import_cannot_update_a_script_the_caller_cannot_see(self):
        r = self.client.post("/api/io/script/import/", {
            "format": "csv", "dry_run": False,
            "content": f"id,name,description\n{self.private.id},Private,Hijacked\n",
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 0)
        self.private.refresh_from_db()
        self.assertEqual(self.private.description, "")
