"""Planned changes: plan it, see it, apply it — and every way that must fail.

The security shape under test: planning needs *view* on the target, applying
needs *change* on the target (not on the task), and applying can never move an
object outside the applier's own scope.
"""
from __future__ import annotations

from django.contrib.auth.models import User

from api.models import Interface, Site, Status
from audit.models import ChangeLogEntry, JournalEntry
from auth_api.models import ObjectPermission, UserProfile

from .models import PlannedChange, Task
from .tests import Base


class _PlanBase(Base):
    def _task(self, board=None, **kw):
        board = board or self._board()
        return Task.objects.create(
            tenant=self.tenant, board=board,
            status=board.statuses.get(name="To do"), title="Replace core switch",
            **kw,
        )

    def _plan(self, task, obj_type, obj_id, field, new_value, **extra):
        return self.client.post(
            "/api/planning/planned-changes/",
            {"task": str(task.id), "object_type": obj_type,
             "object_id": str(obj_id), "field": field,
             "new_value": new_value, **extra},
            format="json",
        )

    def _member(self, username, *, types, actions, tenant=None):
        user = User.objects.create_user(username, f"{username}@x.com", "x")
        profile, _ = UserProfile.objects.get_or_create(user=user)
        profile.tenants.add(tenant or self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"p-{username}", enabled=True,
            object_types=list(types), actions=list(actions),
        )
        perm.users.add(user)
        perm.tenants.add(tenant or self.tenant)
        return user

    def _as(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()


class PlanAndApplyTests(_PlanBase):
    def test_plan_and_apply_interface_enabled(self):
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi2/1", enabled=True)
        task = self._task()

        r = self._plan(task, "interface", iface.id, "enabled", False)
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["current_display"], "Yes")
        self.assertEqual(body["new_display"], "No")
        self.assertEqual(body["state"], "planned")
        self.assertFalse(body["stale"])

        r = self.client.post(
            f"/api/planning/planned-changes/{body['id']}/apply/", {}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["state"], "applied")
        iface.refresh_from_db()
        self.assertFalse(iface.enabled)
        pc = PlannedChange.objects.get(id=body["id"])
        self.assertIsNotNone(pc.applied_at)
        self.assertEqual(pc.applied_by, self.admin)

    def test_plan_and_apply_device_status_fk(self):
        dev = self._device()
        decomm = Status.objects.create(
            tenant=self.tenant, name="Decommissioning", slug="decomm",
            available_to=["device"],
        )
        task = self._task()
        r = self._plan(task, "device", dev.id, "status_id", str(decomm.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["new_display"], "Decommissioning")

        r = self.client.post(
            f"/api/planning/planned-changes/{r.json()['id']}/apply/", {},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        dev.refresh_from_db()
        self.assertEqual(dev.status_id, decomm.id)

    def test_planning_autocreates_the_task_link(self):
        dev = self._device()
        task = self._task()
        self._plan(task, "device", dev.id, "description", "planned")
        self.assertTrue(
            task.links.filter(object_type="api.device", object_id=dev.id).exists()
        )

    def test_apply_writes_one_changelog_entry_and_a_journal_note(self):
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi2/1", enabled=True)
        task = self._task()
        pid = self._plan(task, "interface", iface.id, "enabled", False).json()["id"]
        before = ChangeLogEntry.objects.filter(
            object_type="api.interface", object_id=str(iface.id)
        ).count()
        self.client.post(f"/api/planning/planned-changes/{pid}/apply/", {},
                         format="json")

        entries = ChangeLogEntry.objects.filter(
            object_type="api.interface", object_id=str(iface.id)
        )
        # Exactly one new entry — the serializer save fires the audit signal;
        # nothing should also call log_bulk_update.
        self.assertEqual(entries.count(), before + 1)

        note = JournalEntry.objects.filter(
            object_type="api.interface", object_id=str(iface.id)
        ).first()
        self.assertIsNotNone(note)
        self.assertIn("Replace core switch", note.comments)
        self.assertIn("Yes", note.comments)
        self.assertIn("No", note.comments)

    def test_effective_date_falls_back_to_the_task_due_date(self):
        dev = self._device()
        task = self._task(due_date="2026-09-01")
        r = self._plan(task, "device", dev.id, "description", "later")
        self.assertEqual(r.json()["effective_date"], "2026-09-01")

        iface = Interface.objects.create(device=dev, name="Gi3/1")
        r = self._plan(task, "interface", iface.id, "description", "friday",
                       planned_for="2026-08-28")
        self.assertEqual(r.json()["effective_date"], "2026-08-28")

    def test_cancel_writes_nothing_to_the_target(self):
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi2/1", enabled=True)
        pid = self._plan(
            self._task(), "interface", iface.id, "enabled", False
        ).json()["id"]
        r = self.client.post(f"/api/planning/planned-changes/{pid}/cancel/", {},
                             format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["state"], "cancelled")
        iface.refresh_from_db()
        self.assertTrue(iface.enabled)
        r = self.client.post(f"/api/planning/planned-changes/{pid}/apply/", {},
                             format="json")
        self.assertEqual(r.status_code, 400)


class StaleTests(_PlanBase):
    def test_stale_conflicts_then_force_applies(self):
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi2/1", enabled=True)
        pid = self._plan(
            self._task(), "interface", iface.id, "enabled", False
        ).json()["id"]

        # Someone disables it out of band: the plan's premise is gone.
        iface.enabled = False
        iface.save(update_fields=["enabled"])

        detail = self.client.get(f"/api/planning/planned-changes/{pid}/").json()
        self.assertTrue(detail["stale"])

        r = self.client.post(f"/api/planning/planned-changes/{pid}/apply/", {},
                             format="json")
        self.assertEqual(r.status_code, 409, r.content)
        self.assertTrue(r.json()["stale"])
        self.assertEqual(r.json()["current_display"], "No")
        self.assertEqual(
            PlannedChange.objects.get(id=pid).state, "planned"
        )

        r = self.client.post(f"/api/planning/planned-changes/{pid}/apply/",
                             {"force": True}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        pc = PlannedChange.objects.get(id=pid)
        self.assertEqual(pc.state, "applied")
        # The applied row records what it actually overwrote, not the premise.
        self.assertEqual(pc.current_display, "No")


class PermissionTests(_PlanBase):
    def test_apply_requires_change_on_the_target_not_the_task(self):
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi2/1", enabled=True)
        task = self._task()
        pid = self._plan(task, "interface", iface.id, "enabled", False).json()["id"]

        # Full planning rights, plus VIEW on interfaces so the plan is visible —
        # but no interface:change.
        planner = self._member(
            "planner",
            types=["task", "plannedchange", "tasklink", "board", "taskstatus"],
            actions=["view", "add", "change", "delete"],
        )
        viewer_perm = ObjectPermission.objects.create(
            name="iface-view", enabled=True,
            object_types=["interface", "device"], actions=["view"],
        )
        viewer_perm.users.add(planner)
        viewer_perm.tenants.add(self.tenant)
        self._as(planner)

        r = self.client.post(f"/api/planning/planned-changes/{pid}/apply/", {},
                             format="json")
        self.assertEqual(r.status_code, 403, r.content)
        iface.refresh_from_db()
        self.assertTrue(iface.enabled, "the target must be untouched")

    def test_planning_needs_only_view_on_the_target(self):
        dev = self._device()
        task = self._task()
        planner = self._member(
            "readplanner",
            types=["task", "plannedchange", "tasklink", "device"],
            actions=["view", "add", "change"],
        )
        self._as(planner)
        r = self._plan(task, "device", dev.id, "description", "swap me")
        self.assertEqual(r.status_code, 201, r.content)

    def test_cannot_plan_on_an_object_you_cannot_view(self):
        foreign = self._device(tenant=self.other, name="theirs")
        task = self._task()
        planner = self._member(
            "scoped",
            types=["task", "plannedchange", "tasklink", "device"],
            actions=["view", "add", "change"],
        )
        self._as(planner)
        r = self._plan(task, "device", foreign.id, "description", "nope")
        self.assertIn(r.status_code, (400, 403))
        self.assertEqual(PlannedChange.objects.count(), 0)

    def test_apply_on_deleted_target_fails_closed(self):
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi2/1", enabled=True)
        pid = self._plan(
            self._task(), "interface", iface.id, "enabled", False
        ).json()["id"]
        iface.delete()
        r = self.client.post(f"/api/planning/planned-changes/{pid}/apply/", {},
                             format="json")
        self.assertIn(r.status_code, (400, 403))
        self.assertEqual(PlannedChange.objects.get(id=pid).state, "planned")

    def test_tenant_isolation_on_list_and_map(self):
        foreign_board = self._board(tenant=self.other, name="T", slug="t")
        foreign_task = Task.objects.create(
            tenant=self.other, board=foreign_board,
            status=foreign_board.statuses.get(name="To do"), title="theirs",
        )
        PlannedChange.objects.create(
            tenant=self.other, task=foreign_task, object_type="api.device",
            object_id=self._device(tenant=self.other, name="d2").id,
            field="description", new_value="x",
        )
        self.assertEqual(
            self.client.get("/api/planning/planned-changes/").json()["count"], 0
        )
        self.assertEqual(
            self.client.get("/api/planning/planned-changes/map/").json()["targets"],
            {},
        )


class ValidationTests(_PlanBase):
    def test_unknown_object_type_and_unplannable_field(self):
        dev = self._device()
        task = self._task()
        r = self._plan(task, "nope", dev.id, "description", "x")
        self.assertEqual(r.status_code, 400)

        r = self._plan(task, "device", dev.id, "enabled", True)
        self.assertEqual(r.status_code, 400)
        self.assertIn("Plannable", str(r.content))

    def test_invalid_choice_and_cross_tenant_fk_rejected(self):
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi2/1")
        task = self._task()
        self.assertEqual(
            self._plan(task, "interface", iface.id, "mode", "bogus").status_code, 400
        )
        foreign_site = Site.objects.create(tenant=self.other, name="Theirs")
        self.assertEqual(
            self._plan(task, "device", dev.id, "site_id",
                       str(foreign_site.id)).status_code,
            400,
        )

    def test_status_not_available_to_the_model_rejected(self):
        dev = self._device()
        wrong = Status.objects.create(
            tenant=self.tenant, name="Prefix-only", slug="po",
            available_to=["prefix"],
        )
        r = self._plan(self._task(), "device", dev.id, "status_id", str(wrong.id))
        self.assertEqual(r.status_code, 400, r.content)

    def test_no_op_plan_rejected(self):
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi2/1", enabled=True)
        r = self._plan(self._task(), "interface", iface.id, "enabled", True)
        self.assertEqual(r.status_code, 400)
        self.assertIn("already the current value", str(r.content))

    def test_duplicate_open_plan_rejected_but_replanning_after_apply_allowed(self):
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi2/1", enabled=True)
        task = self._task()
        first = self._plan(task, "interface", iface.id, "enabled", False)
        self.assertEqual(first.status_code, 201)
        dup = self._plan(task, "interface", iface.id, "enabled", False)
        self.assertIn(dup.status_code, (400, 409))

        self.client.post(
            f"/api/planning/planned-changes/{first.json()['id']}/apply/", {},
            format="json",
        )
        again = self._plan(task, "interface", iface.id, "enabled", True)
        self.assertEqual(again.status_code, 201, again.content)

    def test_retarget_and_field_change_rejected(self):
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi2/1", enabled=True)
        other_iface = Interface.objects.create(device=dev, name="Gi2/2")
        pid = self._plan(
            self._task(), "interface", iface.id, "enabled", False
        ).json()["id"]
        for payload in (
            {"object_id": str(other_iface.id)},
            {"field": "description"},
        ):
            r = self.client.patch(
                f"/api/planning/planned-changes/{pid}/", payload, format="json"
            )
            self.assertEqual(r.status_code, 400, payload)

    def test_applied_row_is_immutable_and_undeletable(self):
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi2/1", enabled=True)
        pid = self._plan(
            self._task(), "interface", iface.id, "enabled", False
        ).json()["id"]
        self.client.post(f"/api/planning/planned-changes/{pid}/apply/", {},
                         format="json")
        self.assertEqual(
            self.client.patch(f"/api/planning/planned-changes/{pid}/",
                              {"note": "x"}, format="json").status_code, 400
        )
        self.assertEqual(
            self.client.delete(f"/api/planning/planned-changes/{pid}/").status_code,
            400,
        )


class MapTests(_PlanBase):
    def test_map_groups_open_plans_by_target(self):
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi2/1", enabled=True)
        task = self._task(due_date="2026-09-10")
        self._plan(task, "interface", iface.id, "enabled", False)
        self._plan(task, "interface", iface.id, "description", "planned",
                   planned_for="2026-08-20")

        payload = self.client.get("/api/planning/planned-changes/map/").json()
        key = f"api.interface:{iface.id}"
        self.assertIn(key, payload["targets"])
        row = payload["targets"][key]
        self.assertEqual(row["count"], 2)
        self.assertEqual(row["tasks"], 1)
        self.assertEqual(row["task_title"], "Replace core switch")
        # The earliest effective date wins, per-change date beating the task's.
        self.assertEqual(row["next_due"], "2026-08-20")
        self.assertEqual(len(row["samples"]), 2)

    def test_map_excludes_applied_and_cancelled(self):
        dev = self._device()
        iface = Interface.objects.create(device=dev, name="Gi2/1", enabled=True)
        pid = self._plan(
            self._task(), "interface", iface.id, "enabled", False
        ).json()["id"]
        self.client.post(f"/api/planning/planned-changes/{pid}/apply/", {},
                         format="json")
        self.assertEqual(
            self.client.get("/api/planning/planned-changes/map/").json()["targets"],
            {},
        )
