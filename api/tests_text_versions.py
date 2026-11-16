"""Saved versions of template and script bodies, restore, and the
check-while-typing endpoint (#465)."""
from __future__ import annotations

import hashlib

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import ExportTemplate, LabelTemplate

User = get_user_model()

V1 = "  {# one #}\n{% for d in objects %}{{ d.name }}\n{% endfor %}\n"
V2 = V1 + "second\n\n  \n"
V3 = "third\n"


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Rival", slug="rival")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.login(self.admin)

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def member(self, name, actions, types=("exporttemplate",)):
        user = User.objects.create_user(name, "", "x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(
            name=name, object_types=list(types), actions=list(actions),
        )
        grant.users.add(user)
        return user


class ExportTemplateVersionTests(_Base):
    def make(self):
        r = self.client.post("/api/export-templates/", {
            "name": "devs", "object_type": "device", "template_code": V1,
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        tid = r.json()["id"]
        for body in (V2, V3):
            r = self.client.patch(f"/api/export-templates/{tid}/",
                                  {"template_code": body}, format="json")
            self.assertEqual(r.status_code, 200, r.content)
        # A save that leaves the body alone is not a version.
        self.client.patch(f"/api/export-templates/{tid}/",
                          {"description": "d"}, format="json")
        return tid

    def url(self, tid, rest=""):
        return f"/api/export-templates/{tid}/versions/{rest}"

    def test_lists_every_saved_body_newest_first(self):
        tid = self.make()
        r = self.client.get(self.url(tid))
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["count"], 3)
        rows = body["results"]
        self.assertEqual(
            [x["sha256"] for x in rows],
            [hashlib.sha256(t.encode()).hexdigest() for t in (V3, V2, V1)],
        )
        self.assertEqual(rows[0]["by"], "admin")
        self.assertEqual(rows[2]["action"], "create")
        self.assertEqual(rows[1]["size"], len(V2.encode()))
        self.assertEqual(rows[1]["lines"], len(V2.splitlines()))
        self.assertTrue(body["history_complete"])
        self.assertTrue(body["current_logged"])
        self.assertEqual(body["current"]["sha256"], rows[0]["sha256"])

    def test_paged(self):
        tid = self.make()
        r = self.client.get(self.url(tid) + "?page_size=2")
        self.assertEqual(len(r.json()["results"]), 2)
        self.assertIsNotNone(r.json()["next"])

    def test_text_is_byte_exact_and_diffs(self):
        tid = self.make()
        rows = self.client.get(self.url(tid)).json()["results"]
        v2, v1 = rows[1]["id"], rows[2]["id"]
        r = self.client.get(self.url(tid, f"{v2}/"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["text"], V2)
        r = self.client.get(self.url(tid, f"{v2}/?against={v1}"))
        diff = r.json()["diff"]
        self.assertTrue(diff.startswith("--- "))
        self.assertIn("+second", diff)
        r = self.client.get(self.url(tid, f"current/?against={v1}"))
        self.assertEqual(r.json()["text"], V3)
        self.assertIn("-{% endfor %}", r.json()["diff"])
        self.assertEqual(self.client.get(self.url(tid, "nope/")).status_code, 404)

    def test_restore_saves_a_new_version(self):
        tid = self.make()
        rows = self.client.get(self.url(tid)).json()["results"]
        v1 = rows[2]
        before = ChangeLogEntry.objects.filter(object_id=tid).count()
        r = self.client.post(self.url(tid, f"{v1['id']}/restore/"))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(ExportTemplate.objects.get(pk=tid).template_code, V1)
        self.assertEqual(ChangeLogEntry.objects.filter(object_id=tid).count(), before + 1)
        body = self.client.get(self.url(tid)).json()
        self.assertEqual(body["count"], 4)
        newest = body["results"][0]
        self.assertEqual(newest["sha256"], v1["sha256"])
        self.assertTrue(newest["cause"].startswith("Restored version from "))
        # The older entries are untouched.
        self.assertEqual(body["results"][3]["id"], v1["id"])
        # Restoring the current text again is refused, not logged twice.
        r = self.client.post(self.url(tid, f"{v1['id']}/restore/"))
        self.assertEqual(r.status_code, 400)

    def test_restore_runs_the_save_validators(self):
        tid = self.make()
        tmpl = ExportTemplate.objects.get(pk=tid)
        entry = ChangeLogEntry.objects.filter(object_id=tid, changes__has_key="template_code").first()
        entry.post_change = {**entry.post_change, "template_code": "{% if %}"}
        entry.save()
        r = self.client.post(self.url(tid, f"{entry.id}/restore/"))
        self.assertEqual(r.status_code, 400)
        self.assertIn("template_code", r.json())
        tmpl.refresh_from_db()
        self.assertEqual(tmpl.template_code, V3)

    def test_text_not_kept(self):
        tid = self.make()
        entry = ChangeLogEntry.objects.filter(object_id=tid, action="create").first()
        entry.post_change = None
        entry.save()
        rows = self.client.get(self.url(tid)).json()["results"]
        old = [x for x in rows if x["id"] == str(entry.id)][0]
        self.assertFalse(old["text_kept"])
        self.assertIsNone(old["sha256"])
        self.assertIsNone(self.client.get(self.url(tid, f"{entry.id}/")).json()["text"])
        r = self.client.post(self.url(tid, f"{entry.id}/restore/"))
        self.assertEqual(r.status_code, 400)

    def test_pruned_history_and_unlogged_body(self):
        tid = self.make()
        ChangeLogEntry.objects.filter(object_id=tid, action="create").delete()
        ExportTemplate.objects.filter(pk=tid).update(template_code="bulk\n")
        body = self.client.get(self.url(tid)).json()
        self.assertFalse(body["history_complete"])
        self.assertFalse(body["current_logged"])

    def test_rbac_view_reads_change_restores(self):
        tid = self.make()
        v1 = self.client.get(self.url(tid)).json()["results"][2]["id"]
        viewer = self.member("viewer", ["view"])
        self.login(viewer)
        self.assertEqual(self.client.get(self.url(tid)).status_code, 200)
        self.assertEqual(self.client.post(self.url(tid, f"{v1}/restore/")).status_code, 403)
        editor = self.member("editor", ["view", "change"])
        self.login(editor)
        r = self.client.post(self.url(tid, f"{v1}/restore/"))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            ChangeLogEntry.objects.filter(object_id=tid).first().user_name, "editor"
        )
        nobody = self.member("nobody", ["view"], types=("site",))
        self.login(nobody)
        self.assertEqual(self.client.get(self.url(tid)).status_code, 403)

    def test_other_tenant_cannot_read_or_restore(self):
        tid = self.make()
        v1 = self.client.get(self.url(tid)).json()["results"][2]["id"]
        self.login(self.admin, tenant=self.other)
        self.assertEqual(self.client.get(self.url(tid)).status_code, 404)
        self.assertEqual(self.client.get(self.url(tid, f"{v1}/")).status_code, 404)
        self.assertEqual(self.client.post(self.url(tid, f"{v1}/restore/")).status_code, 404)

    def test_version_of_another_template_is_unknown(self):
        tid = self.make()
        other = ExportTemplate.objects.create(
            tenant=self.tenant, name="other", object_type="device", template_code="x"
        )
        v1 = self.client.get(self.url(tid)).json()["results"][2]["id"]
        self.assertEqual(self.client.get(self.url(other.id, f"{v1}/")).status_code, 404)
        self.assertEqual(
            self.client.post(self.url(other.id, f"{v1}/restore/")).status_code, 404
        )


class LabelAndScriptVersionTests(_Base):
    def test_label_template_versions(self):
        r = self.client.post("/api/label-templates/", {
            "name": "lbl", "object_type": "device", "template_html": "<b>1</b>\n",
        }, format="json")
        lid = r.json()["id"]
        self.client.patch(f"/api/label-templates/{lid}/",
                          {"template_html": "<b>2</b>\n"}, format="json")
        rows = self.client.get(f"/api/label-templates/{lid}/versions/").json()["results"]
        self.assertEqual(len(rows), 2)
        r = self.client.post(f"/api/label-templates/{lid}/versions/{rows[1]['id']}/restore/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(LabelTemplate.objects.get(pk=lid).template_html, "<b>1</b>\n")

    def test_script_versions(self):
        from scripting.models import Script

        r = self.client.post("/api/scripts/", {
            "name": "S", "language": "python", "source": "a = 1\n",
        }, format="json")
        sid = r.json()["id"]
        self.client.patch(f"/api/scripts/{sid}/", {"source": "a = 2\n"}, format="json")
        rows = self.client.get(f"/api/scripts/{sid}/versions/").json()["results"]
        self.assertEqual(len(rows), 2)
        r = self.client.post(f"/api/scripts/{sid}/versions/{rows[1]['id']}/restore/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(Script.objects.get(pk=sid).source, "a = 1\n")


class TemplateCheckTests(_Base):
    def setUp(self):
        super().setUp()
        cache.clear()

    def test_ok_and_error_with_line(self):
        url = "/api/export-templates/validate/"
        r = self.client.post(url, {"template_code": "{{ x }}\n"}, format="json")
        self.assertEqual(r.json(), {"ok": True, "error": None})
        r = self.client.post(url, {"template_code": "a\nb\n{% for x in y %}\n"}, format="json")
        body = r.json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["error"]["line"], 3)
        self.assertIn("for", body["error"]["message"])
        r = self.client.post(url, {"template_code": "{{ x }"}, format="json")
        self.assertEqual(r.json()["error"]["line"], 1)

    def test_same_filters_as_save(self):
        # The address filters exist in the render environment.
        r = self.client.post("/api/export-templates/validate/",
                             {"template_code": "{{ x | netmask }}"}, format="json")
        self.assertTrue(r.json()["ok"], r.content)

    def test_nothing_is_rendered(self):
        r = self.client.post("/api/export-templates/validate/",
                             {"template_code": "{{ objects[0].name }}{{ 1/0 }}"}, format="json")
        self.assertTrue(r.json()["ok"])
        self.assertEqual(ExportTemplate.objects.count(), 0)

    def test_label_check(self):
        r = self.client.post("/api/label-templates/validate/",
                             {"template_html": "<b>{{ x }</b>"}, format="json")
        self.assertFalse(r.json()["ok"])

    def test_view_permission_is_enough_and_anonymous_refused(self):
        viewer = self.member("viewer", ["view"])
        self.login(viewer)
        r = self.client.post("/api/export-templates/validate/",
                             {"template_code": "x"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.client.logout()
        r = self.client.post("/api/export-templates/validate/",
                             {"template_code": "x"}, format="json")
        self.assertIn(r.status_code, (401, 403))

    def test_bad_payload_and_rate_limit(self):
        from . import text_versions

        url = "/api/export-templates/validate/"
        r = self.client.post(url, {"template_code": 5}, format="json")
        self.assertEqual(r.status_code, 400)
        for _ in range(text_versions.CHECK_LIMIT):
            self.client.post(url, {"template_code": "x"}, format="json")
        r = self.client.post(url, {"template_code": "x"}, format="json")
        self.assertEqual(r.status_code, 429)
