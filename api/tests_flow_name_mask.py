"""#453: a generated application flow's name names the hosts at its ends. A
reader who may not view an end reads it as Hidden in that name on every path
that serves it - the change log (object, diff, snapshots, cause, search), the
picker, the export and its filters, templates, global search, custom-field
labels, a requirement's excluded pairs and their journal notes, and the
agent's change history. A reader who sees both ends, and a superuser, read
the stored name."""
from __future__ import annotations

import json

from django.contrib.auth.models import User
from jinja2.sandbox import SecurityError

from api import flow_requirements as fr
from api.export_templates import render_export_template
from api.label_templates import render_label
from api.models import ApplicationFlow, ExportTemplate, LabelTemplate
from api.tests_flow_requirements import FLOWS, REQS, _Base
from audit.bulk import log_bulk_update
from audit.context import cause
from audit.models import ChangeLogEntry
from auth_api.api import assemble_site_role
from auth_api.models import ApiToken, ObjectPermission, UserProfile, hash_api_key
from core.models import DeploymentSettings
from integrations.models import IntegrationSettings

SECRETS = ("broker-b", "10.2.0.5")


class _Fixture(_Base):
    separation = False

    def setUp(self):
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = self.separation
        dep.save(update_fields=["enhanced_site_separation", "updated_at"])
        super().setUp()
        self.req = self.requirement()
        fr.resolve(self.req)
        self.far = ApplicationFlow.objects.get(
            requirement=self.req, source_ip=self.wms1.primary_ip,
            destination_ip=self.broker_b.primary_ip)
        self.near = ApplicationFlow.objects.get(
            requirement=self.req, source_ip=self.wms1.primary_ip,
            destination_ip=self.broker_a.primary_ip)
        self.assertIn("broker-b", self.far.name)
        self.masked = "WMS to Broker: wms-1 → Hidden"
        self.viewer = self._user("viewer-a", [self.site_a])
        self.both = self._user("viewer-ab", [self.site_a, self.site_b])
        self.login(self.viewer)

    def _user(self, name, sites):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        assemble_site_role(self.tenant, "viewer", sites, user_ids=[user.id])
        return user

    def get(self, url):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200,
                         getattr(r, "streaming_content", None) or r.content)
        return r

    def assertMasked(self, text):
        for secret in SECRETS:
            self.assertNotIn(secret, text)

    def as_both(self):
        self.login(self.both)


class ChangeLogTests(_Fixture):
    def _history(self, flow):
        return self.get(f"/api/changelog/?object_type=api.applicationflow&object_id={flow.pk}")

    def test_entry_and_snapshot_are_masked(self):
        r = self._history(self.far)
        self.assertMasked(r.content.decode())
        rows = r.json()["results"]
        self.assertTrue(rows)
        self.assertTrue(all(row["object_repr"] == self.masked for row in rows))
        detail = self.get(f"/api/changelog/{rows[-1]['id']}/")
        self.assertMasked(detail.content.decode())
        self.assertEqual(detail.json()["post_change"]["name"], self.masked)

    def test_a_flow_with_both_ends_in_view_reads_as_stored(self):
        rows = self._history(self.near).json()["results"]
        self.assertEqual(rows[0]["object_repr"], self.near.name)

    def test_name_diff_and_cause_are_masked(self):
        old = self.far.name
        with cause("Requirement 'WMS to Broker': changed on broker-b"):
            self.far.name = f"{old} (10.1.0.11 → 10.2.0.5)"
            self.far.save()
        r = self._history(self.far)
        self.assertMasked(r.content.decode())
        row = next(x for x in r.json()["results"] if "name" in x["changes"])
        self.assertEqual(row["changes"]["name"], {"old": self.masked, "new": self.masked})
        self.assertEqual(row["cause"], "Requirement 'WMS to Broker'")
        self.as_both()
        row = next(x for x in self._history(self.far).json()["results"]
                   if "name" in x["changes"])
        self.assertEqual(row["changes"]["name"]["old"], old)
        # A site-scoped reader never reads the trigger: it may name any site.
        self.assertEqual(row["cause"], "Requirement 'WMS to Broker'")
        self.login(self.admin)
        row = next(x for x in self._history(self.far).json()["results"]
                   if "name" in x["changes"])
        self.assertIn("broker-b", row["cause"])

    def test_a_bulk_entry_without_snapshots_reads_the_live_row(self):
        log_bulk_update([self.far], {"description": "edited"})
        r = self._history(self.far)
        self.assertMasked(r.content.decode())

    def test_search_does_not_match_a_masked_name(self):
        found = self.get("/api/changelog/?search=broker-b").json()["results"]
        self.assertFalse([x for x in found if x["object_type"] == "api.applicationflow"])
        # A term the masked name keeps still finds the entry.
        found = self.get("/api/changelog/?search=WMS to Broker").json()["results"]
        far = [x for x in found if x["object_id"] == str(self.far.pk)]
        self.assertTrue(far)
        self.assertMasked(json.dumps(far))
        self.as_both()
        found = self.get("/api/changelog/?search=broker-b").json()["results"]
        self.assertIn(str(self.far.pk), {x["object_id"] for x in found})

    def test_reader_of_both_sites_and_superuser_read_the_name(self):
        for user in (self.both, self.admin):
            self.login(user)
            rows = self._history(self.far).json()["results"]
            self.assertEqual(rows[0]["object_repr"], self.far.name)

    def test_stored_history_is_not_rewritten(self):
        self._history(self.far)
        entry = ChangeLogEntry.objects.filter(object_id=str(self.far.pk)).first()
        self.assertEqual(entry.object_repr, self.far.name)


class ExclusionTests(_Fixture):
    def setUp(self):
        super().setUp()
        self.stored = self.far.name
        self.login(self.admin)
        r = self.client.delete(f"{FLOWS}{self.far.pk}/")
        self.assertEqual(r.status_code, 204, r.content)
        self.login(self.viewer)

    def test_excluded_pair_label_is_masked(self):
        r = self.get(f"{REQS}{self.req.pk}/")
        self.assertMasked(r.content.decode())
        self.assertEqual([e["label"] for e in r.json()["exclusions"]], [self.masked])
        r = self.get(f"{REQS}{self.req.pk}/exclusions/")
        self.assertEqual([e["label"] for e in r.json()], [self.masked])
        self.as_both()
        r = self.get(f"{REQS}{self.req.pk}/exclusions/")
        self.assertEqual([e["label"] for e in r.json()], [self.stored])

    def test_journal_note_is_masked(self):
        url = f"/api/journal/?object_type=api.applicationflowrequirement&object_id={self.req.pk}"
        r = self.get(url)
        self.assertMasked(r.content.decode())
        notes = [n["comments"] for n in r.json()["results"]]
        self.assertIn(f"Excluded the pair {self.masked}.", notes)
        self.as_both()
        notes = [n["comments"] for n in self.get(url).json()["results"]]
        self.assertIn(f"Excluded the pair {self.stored}.", notes)

    def test_restored_pair_note_stays_hidden(self):
        excl = self.req.exclusions.get()
        self.login(self.admin)
        r = self.client.delete(f"{REQS}{self.req.pk}/exclusions/{excl.pk}/")
        self.assertEqual(r.status_code, 204, r.content)
        ApplicationFlow.objects.filter(requirement=self.req, name=self.stored).delete()
        self.login(self.viewer)
        url = f"/api/journal/?object_type=api.applicationflowrequirement&object_id={self.req.pk}"
        self.assertMasked(self.get(url).content.decode())

    def test_exclusion_and_flow_deletion_history_is_masked(self):
        r = self.get("/api/changelog/?object_type=api.applicationflowrequirementexclusion")
        self.assertMasked(r.content.decode())
        r = self.get(f"/api/changelog/?object_type=api.applicationflow&object_id={self.far.pk}")
        self.assertMasked(r.content.decode())
        self.as_both()
        r = self.get(f"/api/changelog/?object_type=api.applicationflow&object_id={self.far.pk}")
        self.assertIn("broker-b", r.content.decode())


class PickerExportTests(_Fixture):
    def test_picker_masks_the_name(self):
        rows = self.get(f"{FLOWS}?picker=1&requirement={self.req.pk}").json()["results"]
        self.assertMasked(json.dumps(rows))
        self.assertIn(self.masked, {r["name"] for r in rows})
        self.as_both()
        rows = self.get(f"{FLOWS}?picker=1&requirement={self.req.pk}").json()["results"]
        self.assertIn(self.far.name, {r["name"] for r in rows})

    def test_export_masks_the_name_and_refuses_a_name_filter(self):
        r = self.get("/api/io/applicationflow/export/?fmt=json")
        body = b"".join(r.streaming_content).decode()
        self.assertMasked(body)
        self.assertIn(self.masked, {row["name"] for row in json.loads(body)})
        r = self.client.get("/api/io/applicationflow/export/",
                            {"fmt": "json", "name": self.far.name})
        self.assertEqual(r.status_code, 400)
        self.as_both()
        r = self.get("/api/io/applicationflow/export/?fmt=json")
        self.assertIn("broker-b", b"".join(r.streaming_content).decode())

    def test_custom_field_label_is_masked(self):
        url = f"/api/customization/object-labels/?model=applicationflow&ids={self.far.pk}"
        r = self.get(url)
        self.assertEqual([x["label"] for x in r.json()["results"]], [self.masked])
        self.as_both()
        self.assertEqual([x["label"] for x in self.get(url).json()["results"]],
                         [self.far.name])

    def test_global_search_masks_the_title_and_does_not_match_it(self):
        from api.search_index import rebuild

        rebuild(["applicationflow"])
        hits = self.get("/api/search/?q=broker-b&type=applicationflow").json()["hits"]
        # A near miss on a visible flow (broker-a) may still rank.
        self.assertNotIn(str(self.far.pk), {h["id"] for h in hits})
        self.assertMasked(json.dumps([h["title"] for h in hits]))
        hits = self.get("/api/search/?q=WMS to Broker&type=applicationflow").json()["hits"]
        self.assertMasked(json.dumps(hits))
        self.assertIn(self.masked, {h["title"] for h in hits})
        self.as_both()
        hits = self.get("/api/search/?q=broker-b&type=applicationflow").json()["hits"]
        self.assertIn(str(self.far.pk), {h["id"] for h in hits})

    def test_a_site_editor_may_repeat_the_masked_name(self):
        # A Site A viewer who may also change Site A's flows.
        editor = self._user("editor-a", [self.site_a])
        perm = ObjectPermission.objects.create(
            name="flows-a", object_types=["applicationflow"], actions=["change"],
            enabled=True)
        perm.tenants.add(self.tenant)
        perm.users.add(editor)
        perm.sites.add(self.site_a)
        self.login(editor)
        shown = self.get(f"{FLOWS}{self.far.pk}/").json()["name"]
        self.assertEqual(shown, self.masked)
        r = self.client.patch(f"{FLOWS}{self.far.pk}/", {"name": shown, "description": "x"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.far.refresh_from_db()
        self.assertIn("broker-b", self.far.name)
        self.assertEqual(self.far.description, "x")


class TemplateTests(_Fixture):
    def test_export_template_leaves_masked_rows_out(self):
        tmpl = ExportTemplate(tenant=self.tenant, name="t", object_type="applicationflow",
                              template_code="{% for f in objects %}{{ f.name }}|{{ f }};"
                                            "{% endfor %}")
        out = render_export_template(tmpl, self.tenant, self.viewer)
        self.assertMasked(out)
        self.assertIn(self.near.name, out)
        self.assertIn("broker-b", render_export_template(tmpl, self.tenant, self.both))

    def test_label_template_refuses_a_masked_flow(self):
        tmpl = LabelTemplate(tenant=self.tenant, name="l", object_type="applicationflow",
                             template_html="{{ obj.name }}")
        with self.assertRaises(SecurityError):
            render_label(tmpl, self.far, tenant=self.tenant, user=self.viewer)
        render_label(tmpl, self.near, tenant=self.tenant, user=self.viewer)
        render_label(tmpl, self.far, tenant=self.tenant, user=self.both)


class AgentTests(_Fixture):
    def test_agent_change_history_masks_the_name(self):
        key = "dbt_" + "b" * 48
        ApiToken.objects.create(user=self.viewer, tenant=self.tenant, name="a",
                                key_hash=hash_api_key(key), prefix=key[:11], scope="full")
        IntegrationSettings.objects.create(tenant=self.tenant, ai_access_enabled=True)
        old = self.far.name
        self.far.name = f"{old} x"
        self.far.save()
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": "changes",
                           "arguments": {"type": "applicationflow", "id": str(self.far.pk)}}}
        r = self.client.post("/api/mcp/", json.dumps(body), content_type="application/json",
                             HTTP_AUTHORIZATION=f"Token {key}")
        self.assertEqual(r.status_code, 200, r.content)
        result = r.json()["result"]
        self.assertFalse(result.get("isError"), result)
        self.assertMasked(json.dumps(result))
        entries = result["structuredContent"]["entries"]
        self.assertTrue(any("name" in e["changes"] for e in entries))


class ReleasedFlowTests(_Fixture):
    """A detached or released flow is hand-made, but its name was built from
    the hosts at its ends: it reads masked until someone renames it."""

    def _detach(self):
        self.login(self.admin)
        r = self.client.post(f"{FLOWS}{self.far.pk}/detach/")
        self.assertEqual(r.status_code, 200, r.content)
        self.far.refresh_from_db()
        self.assertFalse(self.far.generated)
        self.assertTrue(self.far.name_generated)
        self.login(self.viewer)

    def _release(self):
        self.far.overridden_fields = ["ports"]
        self.far.ports = "5671"
        self.far.save()
        fr.release_all(self.req)
        self.far.refresh_from_db()
        self.assertEqual((self.far.generated, self.far.requirement_id), (False, None))
        self.assertTrue(self.far.name_generated)

    def _reads(self, user=None):
        if user is not None:
            self.login(user)
        return self.get(f"{FLOWS}{self.far.pk}/").json()["name"]

    def test_a_detached_flow_reads_masked_everywhere(self):
        self._detach()
        self.assertEqual(self._reads(), self.masked)
        rows = self.get(f"{FLOWS}?picker=1&application={self.wms.pk}").json()["results"]
        self.assertMasked(json.dumps(rows))
        self.assertFalse(self.get(f"{FLOWS}?search=broker-b").json()["results"])
        r = self.get(f"/api/changelog/?object_type=api.applicationflow&object_id={self.far.pk}")
        self.assertMasked(r.content.decode())
        self.assertTrue(all(x["object_repr"] == self.masked for x in r.json()["results"]))
        found = self.get("/api/changelog/?search=broker-b").json()["results"]
        self.assertFalse([x for x in found if x["object_type"] == "api.applicationflow"])
        r = self.get("/api/io/applicationflow/export/?fmt=json")
        self.assertMasked(b"".join(r.streaming_content).decode())

    def test_a_released_flow_reads_masked(self):
        self._release()
        self.assertEqual(self._reads(), self.masked)
        r = self.get(f"/api/changelog/?object_type=api.applicationflow&object_id={self.far.pk}")
        self.assertMasked(r.content.decode())

    def test_reader_of_both_sites_and_superuser_read_the_name(self):
        self._detach()
        self.assertEqual(self._reads(self.both), self.far.name)
        self.assertEqual(self._reads(self.admin), self.far.name)

    def test_renaming_takes_the_name(self):
        self._detach()
        self.login(self.admin)
        r = self.client.patch(f"{FLOWS}{self.far.pk}/", {"name": "Broker uplink"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.far.refresh_from_db()
        self.assertFalse(self.far.name_generated)
        self.assertEqual(self._reads(self.viewer), "Broker uplink")
        # The rename's own entry: the old name stays masked, the new one is
        # the user's.
        rows = self.get(f"/api/changelog/?object_type=api.applicationflow"
                        f"&object_id={self.far.pk}").json()["results"]
        renamed = next(x for x in rows if "name" in x["changes"])
        self.assertEqual(renamed["changes"]["name"],
                         {"old": self.masked, "new": "Broker uplink"})

    def test_repeating_the_masked_name_keeps_it(self):
        self._detach()
        editor = self._user("editor-a", [self.site_a])
        perm = ObjectPermission.objects.create(
            name="flows-a", object_types=["applicationflow"], actions=["change"],
            enabled=True)
        perm.tenants.add(self.tenant)
        perm.users.add(editor)
        perm.sites.add(self.site_a)
        self.login(editor)
        r = self.client.patch(f"{FLOWS}{self.far.pk}/",
                              {"name": self.masked, "description": "y"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["name"], self.masked)
        kept = ApplicationFlow.objects.get(pk=self.far.pk)
        self.assertEqual((kept.name, kept.name_generated, kept.description),
                         (self.far.name, True, "y"))

    def test_history_written_before_the_flag_reads_masked(self):
        self._detach()
        for e in ChangeLogEntry.objects.filter(object_id=str(self.far.pk)):
            for snap in (e.pre_change, e.post_change):
                if isinstance(snap, dict):
                    snap.pop("name_generated", None)
            e.save(update_fields=["pre_change", "post_change"])
        r = self.get(f"/api/changelog/?object_type=api.applicationflow&object_id={self.far.pk}")
        self.assertMasked(r.content.decode())

    def test_migration_marks_detached_and_released_flows(self):
        import importlib

        from django.apps import apps

        mig = importlib.import_module("api.migrations.0229_applicationflow_name_generated")
        self._detach()
        ApplicationFlow.objects.update(name_generated=False)
        renamed = self.near
        self.login(self.admin)
        r = self.client.post(f"{FLOWS}{renamed.pk}/detach/")
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.patch(f"{FLOWS}{renamed.pk}/", {"name": "mine → there"},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        ApplicationFlow.objects.update(name_generated=False)
        mig.mark_generated_names(apps, None)
        self.far.refresh_from_db()
        renamed.refresh_from_db()
        self.assertTrue(self.far.name_generated)
        self.assertFalse(renamed.name_generated)
        self.assertTrue(all(ApplicationFlow.objects.filter(generated=True)
                            .values_list("name_generated", flat=True)))


class BindingKeyTests(_Fixture):
    """A pair's binding key names its address and device by id: a reader who
    may not view one reads it as null, and Restore goes by the exclusion's
    id."""

    def setUp(self):
        super().setUp()
        self.key = self.far.binding_key
        self.ids = {str(self.broker_b.pk), str(self.broker_b.primary_ip_id)}
        self.assertTrue(all(i in self.key for i in self.ids))

    def assertNoIds(self, text):
        for i in self.ids:
            self.assertNotIn(i, text)

    def _exclude(self):
        self.login(self.admin)
        r = self.client.delete(f"{FLOWS}{self.far.pk}/")
        self.assertEqual(r.status_code, 204, r.content)
        self.login(self.viewer)

    def test_excluded_pair_key_is_null(self):
        self._exclude()
        r = self.get(f"{REQS}{self.req.pk}/")
        self.assertNoIds(r.content.decode())
        (row,) = r.json()["exclusions"]
        self.assertIsNone(row["binding_key"])
        self.assertTrue(row["id"])
        (row,) = self.get(f"{REQS}{self.req.pk}/exclusions/").json()
        self.assertIsNone(row["binding_key"])
        for user in (self.both, self.admin):
            self.login(user)
            (row,) = self.get(f"{REQS}{self.req.pk}/exclusions/").json()
            self.assertEqual(row["binding_key"], self.key)

    def test_restore_goes_by_the_exclusion_id(self):
        self._exclude()
        (row,) = self.get(f"{REQS}{self.req.pk}/exclusions/").json()
        self.login(self.admin)
        r = self.client.delete(f"{REQS}{self.req.pk}/exclusions/{row['id']}/")
        self.assertEqual(r.status_code, 204, r.content)
        self.assertTrue(ApplicationFlow.objects.filter(requirement=self.req,
                                                       binding_key=self.key).exists())

    def test_change_log_nulls_the_key(self):
        self._exclude()
        url = f"/api/changelog/?object_type=api.applicationflow&object_id={self.far.pk}"
        rows = self.get(url).json()["results"]
        self.assertTrue(rows)
        for row in rows:
            detail = self.get(f"/api/changelog/{row['id']}/")
            self.assertNoIds(detail.content.decode())
            for snap in (detail.json()["pre_change"], detail.json()["post_change"]):
                if snap:
                    self.assertIsNone(snap["binding_key"])
        self.as_both()
        row = self.get(url).json()["results"][-1]
        detail = self.get(f"/api/changelog/{row['id']}/").json()
        self.assertEqual(detail["post_change"]["binding_key"], self.key)

    def test_excluded_pair_entry_nulls_the_key(self):
        # Excluded pairs are not a grantable type: the masker answers for
        # whoever reads their entries.
        from api.flow_names import FlowNames

        self._exclude()
        entry = ChangeLogEntry.objects.get(
            object_type="api.applicationflowrequirementexclusion")
        data = {"object_repr": entry.object_repr, "changes": dict(entry.changes or {}),
                "post_change": dict(entry.post_change)}
        shown = FlowNames(self.viewer, self.tenant).mask_history(entry, dict(data))
        self.assertIsNone(shown["post_change"]["binding_key"])
        self.assertNoIds(json.dumps(shown, default=str))
        kept = FlowNames(self.both, self.tenant).mask_history(entry, dict(data))
        self.assertEqual(kept["post_change"]["binding_key"], self.key)

    def test_export_leaves_the_key_out(self):
        r = self.get("/api/io/applicationflow/export/?fmt=json")
        body = b"".join(r.streaming_content).decode()
        self.assertNoIds(body)
        far = next(x for x in json.loads(body) if x["id"] == str(self.far.pk))
        self.assertEqual(far["binding_key"], "")
        near = next(x for x in json.loads(body) if x["id"] == str(self.near.pk))
        self.assertEqual(near["binding_key"], self.near.binding_key)
        self.as_both()
        r = self.get("/api/io/applicationflow/export/?fmt=json")
        self.assertIn(self.key, b"".join(r.streaming_content).decode())

    def test_export_template_cannot_print_the_key(self):
        tmpl = ExportTemplate(tenant=self.tenant, name="t",
                              object_type="applicationflowrequirement",
                              template_code="{% for r in objects %}"
                                            "{% for e in r.exclusions.all() %}"
                                            "{{ e.binding_key }};{% endfor %}{% endfor %}")
        self._exclude()
        self.assertNoIds(render_export_template(tmpl, self.tenant, self.viewer))
        self.assertIn(self.key, render_export_template(tmpl, self.tenant, self.both))


class ChangeLogSeparationTests(ChangeLogTests):
    separation = True


class ReleasedFlowSeparationTests(ReleasedFlowTests):
    separation = True


class BindingKeySeparationTests(BindingKeyTests):
    separation = True


class ExclusionSeparationTests(ExclusionTests):
    separation = True


class PickerExportSeparationTests(PickerExportTests):
    separation = True


class TemplateSeparationTests(TemplateTests):
    separation = True
