"""Triage is its own grant: ``compliancetriage.change`` acknowledges, snoozes
and reopens; editing rules neither needs it nor comes with it."""
from __future__ import annotations

from django.contrib.auth.models import Group

from auth_api import rbac
from auth_api.builtin_groups import ensure_builtin_groups
from auth_api.models import UserProfile
from auth_api.object_types import is_registered, registry_payload

from .models import ComplianceTriage
from .tests_overview import TRIAGE, _Base

CHANGELOG = "/api/changelog/"
RULES = "/api/compliance-rules/"


class TriagePermissionTests(_Base):
    def ack(self):
        return self.client.post(
            TRIAGE,
            {"action": "acknowledge",
             "items": [{"rule_id": str(self.serial.id), "object_id": str(self.sw1.id)}]},
            format="json",
        )

    def edit_rule(self):
        return self.client.patch(
            f"{RULES}{self.serial.id}/", {"description": "edited"}, format="json"
        )

    def test_registered_object_type(self):
        self.assertTrue(is_registered("compliancetriage"))
        entry = next(e for e in registry_payload() if e["slug"] == "compliancetriage")
        self.assertEqual((entry["label"], entry["group"]), ("Compliance triage", "Governance"))
        self.assertIn("change", entry["actions"])

    def test_rule_editor_without_triage_is_refused(self):
        self.login_as("editor", ["compliancerule", "device"], ["view", "change"])
        r = self.ack()
        self.assertEqual(r.status_code, 403)
        self.assertIn("compliancetriage.change", r.json()["detail"])
        self.assertFalse(ComplianceTriage.objects.exists())
        self.assertEqual(self.edit_rule().status_code, 200)

    def test_triage_only_user_triages_but_cannot_edit_rules(self):
        self.login_as("triager", ["compliancetriage", "device"], ["view", "change"])
        # Triage needs to see the object, not the rule's own grant.
        self.assertEqual(self.ack().status_code, 200)
        self.assertTrue(ComplianceTriage.objects.exists())
        self.assertIn(self.edit_rule().status_code, (403, 404))
        self.serial.refresh_from_db()
        self.assertEqual(self.serial.description, "")

    def test_triage_still_needs_the_object(self):
        self.login_as("blind", ["compliancetriage"], ["view", "change"])
        self.assertEqual(self.ack().status_code, 400)
        self.assertFalse(ComplianceTriage.objects.exists())

    def test_builtin_operator_has_triage(self):
        from django.contrib.auth.models import User

        ensure_builtin_groups()
        user = User.objects.create_user("op", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        user.groups.add(Group.objects.get(name="Operator"))
        acts = rbac.effective_actions(user, self.tenant)
        self.assertTrue({"view", "change"} <= acts["compliancetriage"])
        self.assertIn("change", acts["compliancerule"])
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.assertEqual(self.ack().status_code, 200)

    def test_builtin_read_only_cannot_triage(self):
        from django.contrib.auth.models import User

        ensure_builtin_groups()
        user = User.objects.create_user("ro", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        user.groups.add(Group.objects.get(name="Read-only"))
        acts = rbac.effective_actions(user, self.tenant)
        self.assertEqual(acts["compliancetriage"], {"view"})
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.assertEqual(self.ack().status_code, 403)


class TriageChangeLogVisibilityTests(_Base):
    """Triage rows are an object type now, so their change log reaches the
    people granted to view them - not only superusers."""

    def setUp(self):
        super().setUp()
        r = self.client.post(
            TRIAGE,
            {"action": "acknowledge",
             "items": [{"rule_id": str(self.serial.id), "object_id": str(self.sw1.id)}]},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)

    def entries(self):
        r = self.client.get(CHANGELOG + "?object_type=compliance.compliancetriage")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        return body["results"] if isinstance(body, dict) else body

    def test_viewer_with_triage_view_sees_it(self):
        self.login_as("reader", ["compliancetriage"], ["view"])
        self.assertEqual(len(self.entries()), 1)

    def test_viewer_without_triage_view_does_not(self):
        self.login_as("rules-only", ["compliancerule", "device"], ["view"])
        self.assertEqual(self.entries(), [])
