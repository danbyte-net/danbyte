"""Planned changes: stage a form submission, see the diff, apply it — and every
way that must fail.

Plans are staged the way the UI stages them: the object's own edit form submits
its **complete** write payload and the server keeps only what differs. So these
tests post whole payloads, not single fields.

The security shape under test: planning needs *view* on the target, applying an
edit needs *change* on it (not on the task), applying a create needs *add*, and
applying can never move an object outside the applier's own scope.
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
        # One board per test — its slug is unique per tenant, so a second
        # _board() call in the same test would collide.
        if board is None:
            if not hasattr(self, "_cached_board"):
                self._cached_board = self._board()
            board = self._cached_board
        return Task.objects.create(
            tenant=self.tenant, board=board,
            status=board.statuses.get(name="To do"), title="Replace core switch",
            **kw,
        )

    def _iface(self, dev, name="Gi2/1", **kw):
        kw.setdefault("type", "1000base-t")
        return Interface.objects.create(device=dev, name=name, **kw)

    def _iface_payload(self, dev, **over):
        """A full interface write body, as InterfaceForm submits it."""
        base = {
            "device_id": str(dev.id), "name": "Gi2/1", "type": "1000base-t",
            "enabled": True, "description": "", "mode": "", "mtu": None,
            "speed": "", "mgmt_only": False,
        }
        base.update(over)
        return base

    def _device_payload(self, dev, **over):
        """A device write body, as DeviceForm submits it (the subset that
        matters here — the serializer accepts a partial for an edit)."""
        base = {
            "name": dev.name,
            "device_type_id": str(dev.device_type_id),
            "site_id": str(dev.site_id),
            "role_id": str(dev.role_id),
            "status_id": str(dev.status_id) if dev.status_id else None,
            "description": dev.description,
            "serial_number": dev.serial_number,
        }
        base.update(over)
        return base

    def _plan(self, task, obj_type, obj_id, payload, **extra):
        return self.client.post(
            "/api/planning/planned-changes/",
            {"task": str(task.id), "object_type": obj_type,
             "object_id": str(obj_id), "payload": payload, **extra},
            format="json",
        )

    def _plan_create(self, task, obj_type, payload, **extra):
        return self.client.post(
            "/api/planning/planned-changes/",
            {"task": str(task.id), "kind": "create", "object_type": obj_type,
             "payload": payload, **extra},
            format="json",
        )

    def _apply(self, pid, **body):
        return self.client.post(
            f"/api/planning/planned-changes/{pid}/apply/", body, format="json"
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

    def _grant(self, user, types, actions):
        perm = ObjectPermission.objects.create(
            name=f"extra-{user.username}-{'-'.join(types)}", enabled=True,
            object_types=list(types), actions=list(actions),
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)

    def _as(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()


class DiffTests(_PlanBase):
    """The whole point of staging a full form payload: only real changes stick."""

    def test_only_changed_fields_are_stored(self):
        dev = self._device()
        iface = self._iface(dev, enabled=True, description="uplink")
        task = self._task()

        # Same name/type as the live row, only `enabled` differs.
        r = self._plan(task, "interface", iface.id, self._iface_payload(
            dev, name="Gi2/1", enabled=False, description="uplink",
        ))
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(set(body["payload"]), {"enabled"})
        self.assertEqual(body["before"], {"enabled": True})
        self.assertEqual(
            body["display"],
            [{"field": "enabled", "label": "Enabled", "from": "Yes", "to": "No"}],
        )

    def test_several_fields_in_one_change_set(self):
        dev = self._device()
        iface = self._iface(dev, enabled=True, description="")
        r = self._plan(self._task(), "interface", iface.id, self._iface_payload(
            dev, enabled=False, description="to be replaced", mtu=9000,
        ))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(
            set(r.json()["payload"]), {"enabled", "description", "mtu"}
        )
        labels = {d["label"] for d in r.json()["display"]}
        self.assertEqual(labels, {"Enabled", "Description", "MTU"})

    def test_a_no_op_save_stages_nothing(self):
        dev = self._device()
        iface = self._iface(dev, enabled=True)
        r = self._plan(self._task(), "interface", iface.id,
                       self._iface_payload(dev, enabled=True))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("Nothing changed", str(r.content))
        self.assertEqual(PlannedChange.objects.count(), 0)

    def test_fk_diffs_render_as_names_not_ids(self):
        dev = self._device()
        decomm = Status.objects.create(
            tenant=self.tenant, name="Decommissioning", slug="decomm",
            available_to=["device"],
        )
        r = self._plan(self._task(), "device", dev.id,
                       self._device_payload(dev, status_id=str(decomm.id)))
        self.assertEqual(r.status_code, 201, r.content)
        row = r.json()["display"][0]
        self.assertEqual(row["label"], "Status")
        self.assertEqual(row["to"], "Decommissioning")
        self.assertEqual(row["from"], str(dev.status))

    def test_payload_is_validated_at_plan_time(self):
        """A plan is held to the same rules a real write would be."""
        dev = self._device()
        iface = self._iface(dev)
        r = self._plan(self._task(), "interface", iface.id,
                       self._iface_payload(dev, mode="bogus"))
        self.assertEqual(r.status_code, 400, r.content)

        foreign_site = Site.objects.create(tenant=self.other, name="Theirs")
        r = self._plan(self._task(), "device", dev.id,
                       self._device_payload(dev, site_id=str(foreign_site.id)))
        self.assertEqual(r.status_code, 400, r.content)


class ApplyUpdateTests(_PlanBase):
    def test_apply_writes_the_change_set(self):
        dev = self._device()
        iface = self._iface(dev, enabled=True)
        pid = self._plan(self._task(), "interface", iface.id, self._iface_payload(
            dev, enabled=False, description="planned swap",
        )).json()["id"]

        r = self._apply(pid)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["state"], "applied")
        iface.refresh_from_db()
        self.assertFalse(iface.enabled)
        self.assertEqual(iface.description, "planned swap")
        pc = PlannedChange.objects.get(id=pid)
        self.assertIsNotNone(pc.applied_at)
        self.assertEqual(pc.applied_by, self.admin)

    def test_apply_device_status(self):
        dev = self._device()
        decomm = Status.objects.create(
            tenant=self.tenant, name="Decommissioning", slug="decomm",
            available_to=["device"],
        )
        pid = self._plan(self._task(), "device", dev.id,
                         self._device_payload(dev, status_id=str(decomm.id))
                         ).json()["id"]
        self.assertEqual(self._apply(pid).status_code, 200)
        dev.refresh_from_db()
        self.assertEqual(dev.status_id, decomm.id)

    def test_planning_autocreates_the_task_link(self):
        dev = self._device()
        task = self._task()
        self._plan(task, "device", dev.id,
                   self._device_payload(dev, description="planned"))
        self.assertTrue(
            task.links.filter(object_type="api.device", object_id=dev.id).exists()
        )

    def test_one_changelog_entry_and_a_journal_note_naming_the_task(self):
        dev = self._device()
        iface = self._iface(dev, enabled=True)
        task = self._task()
        pid = self._plan(task, "interface", iface.id,
                         self._iface_payload(dev, enabled=False)).json()["id"]
        before = ChangeLogEntry.objects.filter(
            object_type="api.interface", object_id=str(iface.id)
        ).count()
        self._apply(pid)

        # Exactly one new entry — the serializer save fires the audit signal;
        # nothing should also call log_bulk_update.
        self.assertEqual(
            ChangeLogEntry.objects.filter(
                object_type="api.interface", object_id=str(iface.id)
            ).count(),
            before + 1,
        )
        note = JournalEntry.objects.filter(
            object_type="api.interface", object_id=str(iface.id)
        ).first()
        self.assertIsNotNone(note)
        self.assertIn("Replace core switch", note.comments)
        self.assertIn("Enabled: Yes → No", note.comments)

    def test_effective_date_falls_back_to_the_task_due_date(self):
        dev = self._device()
        task = self._task(due_date="2026-09-01")
        r = self._plan(task, "device", dev.id,
                       self._device_payload(dev, description="later"))
        self.assertEqual(r.json()["effective_date"], "2026-09-01")

        iface = self._iface(dev, name="Gi3/1")
        r = self._plan(task, "interface", iface.id,
                       self._iface_payload(dev, name="Gi3/1", description="fri"),
                       planned_for="2026-08-28")
        self.assertEqual(r.json()["effective_date"], "2026-08-28")

    def test_cancel_writes_nothing(self):
        dev = self._device()
        iface = self._iface(dev, enabled=True)
        pid = self._plan(self._task(), "interface", iface.id,
                         self._iface_payload(dev, enabled=False)).json()["id"]
        r = self.client.post(
            f"/api/planning/planned-changes/{pid}/cancel/", {}, format="json"
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["state"], "cancelled")
        iface.refresh_from_db()
        self.assertTrue(iface.enabled)
        self.assertEqual(self._apply(pid).status_code, 400)

    def test_several_change_sets_on_one_object_are_allowed(self):
        """A task may stage more than one edit to the same object — the old
        per-field uniqueness would have blocked this."""
        dev = self._device()
        iface = self._iface(dev, enabled=True, description="")
        task = self._task()
        self.assertEqual(
            self._plan(task, "interface", iface.id,
                       self._iface_payload(dev, enabled=False)).status_code, 201
        )
        self.assertEqual(
            self._plan(task, "interface", iface.id,
                       self._iface_payload(dev, description="second")).status_code,
            201,
        )


class ApplyCreateTests(_PlanBase):
    def test_plan_and_apply_a_new_interface(self):
        dev = self._device()
        task = self._task()
        r = self._plan_create(task, "interface", self._iface_payload(
            dev, name="Gi9/9", enabled=True, description="new uplink",
        ))
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["kind"], "create")
        self.assertIsNone(body["object_id"])
        self.assertFalse(body["stale"], "a create can't be stale")
        labels = {d["label"] for d in body["display"]}
        self.assertIn("Name", labels)

        r = self._apply(body["id"])
        self.assertEqual(r.status_code, 200, r.content)
        created = Interface.objects.filter(device=dev, name="Gi9/9").first()
        self.assertIsNotNone(created)
        pc = PlannedChange.objects.get(id=body["id"])
        self.assertEqual(pc.created_object_id, created.id)
        # The task now touches a real object.
        self.assertTrue(
            pc.task.links.filter(
                object_type="api.interface", object_id=created.id
            ).exists()
        )
        note = JournalEntry.objects.filter(
            object_type="api.interface", object_id=str(created.id)
        ).first()
        self.assertIsNotNone(note)
        self.assertIn("Created from task", note.comments)

    def test_create_is_validated_at_plan_time(self):
        dev = self._device()
        r = self._plan_create(self._task(), "interface",
                              self._iface_payload(dev, name=""))
        self.assertEqual(r.status_code, 400, r.content)

    def test_applying_a_create_needs_add_not_change(self):
        dev = self._device()
        task = self._task()
        pid = self._plan_create(task, "interface", self._iface_payload(
            dev, name="Gi8/8")).json()["id"]

        planner = self._member(
            "creator", types=["task", "plannedchange", "tasklink"],
            actions=["view", "add", "change", "delete"],
        )
        # change but NOT add on interfaces.
        self._grant(planner, ["interface", "device"], ["view", "change"])
        self._as(planner)
        r = self._apply(pid)
        self.assertEqual(r.status_code, 403, r.content)
        self.assertFalse(Interface.objects.filter(name="Gi8/8").exists())


class StaleTests(_PlanBase):
    def test_stale_conflicts_then_force_applies(self):
        dev = self._device()
        iface = self._iface(dev, enabled=True)
        pid = self._plan(self._task(), "interface", iface.id,
                         self._iface_payload(dev, enabled=False)).json()["id"]

        # Someone disables it out of band: the plan's premise is gone.
        iface.enabled = False
        iface.save(update_fields=["enabled"])

        detail = self.client.get(f"/api/planning/planned-changes/{pid}/").json()
        self.assertTrue(detail["stale"])

        r = self._apply(pid)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertTrue(r.json()["stale"])
        self.assertEqual(r.json()["stale_fields"], ["enabled"])
        self.assertEqual(r.json()["current_display"], {"enabled": "No"})
        self.assertEqual(PlannedChange.objects.get(id=pid).state, "planned")

        r = self._apply(pid, force=True)
        self.assertEqual(r.status_code, 200, r.content)
        pc = PlannedChange.objects.get(id=pid)
        self.assertEqual(pc.state, "applied")
        # The applied row records what it actually overwrote.
        self.assertEqual(pc.before["enabled"], False)

    def test_an_unrelated_edit_does_not_make_a_plan_stale(self):
        """Staleness is per-key: only the fields this plan touches matter."""
        dev = self._device()
        iface = self._iface(dev, enabled=True, description="")
        pid = self._plan(self._task(), "interface", iface.id,
                         self._iface_payload(dev, enabled=False)).json()["id"]
        iface.description = "someone else's note"
        iface.save(update_fields=["description"])

        detail = self.client.get(f"/api/planning/planned-changes/{pid}/").json()
        self.assertFalse(detail["stale"])
        self.assertEqual(self._apply(pid).status_code, 200)


class PermissionTests(_PlanBase):
    def test_apply_requires_change_on_the_target_not_the_task(self):
        dev = self._device()
        iface = self._iface(dev, enabled=True)
        pid = self._plan(self._task(), "interface", iface.id,
                         self._iface_payload(dev, enabled=False)).json()["id"]

        planner = self._member(
            "planner", types=["task", "plannedchange", "tasklink", "board",
                              "taskstatus"],
            actions=["view", "add", "change", "delete"],
        )
        self._grant(planner, ["interface", "device"], ["view"])
        self._as(planner)

        r = self._apply(pid)
        self.assertEqual(r.status_code, 403, r.content)
        iface.refresh_from_db()
        self.assertTrue(iface.enabled, "the target must be untouched")

    def test_planning_needs_only_view_on_the_target(self):
        dev = self._device()
        task = self._task()
        planner = self._member(
            "readplanner", types=["task", "plannedchange", "tasklink", "device"],
            actions=["view", "add", "change"],
        )
        self._as(planner)
        r = self._plan(task, "device", dev.id,
                       self._device_payload(dev, description="swap me"))
        self.assertEqual(r.status_code, 201, r.content)

    def test_cannot_plan_on_an_object_you_cannot_view(self):
        foreign = self._device(tenant=self.other, name="theirs")
        task = self._task()
        planner = self._member(
            "scoped", types=["task", "plannedchange", "tasklink", "device"],
            actions=["view", "add", "change"],
        )
        self._as(planner)
        r = self._plan(task, "device", foreign.id, {"description": "nope"})
        self.assertIn(r.status_code, (400, 403))
        self.assertEqual(PlannedChange.objects.count(), 0)

    def test_apply_on_deleted_target_fails_closed(self):
        dev = self._device()
        iface = self._iface(dev, enabled=True)
        pid = self._plan(self._task(), "interface", iface.id,
                         self._iface_payload(dev, enabled=False)).json()["id"]
        iface.delete()
        r = self._apply(pid)
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
            payload={"description": "x"}, before={"description": ""},
            display=[{"field": "description", "label": "Description",
                      "from": "", "to": "x"}],
        )
        self.assertEqual(
            self.client.get("/api/planning/planned-changes/").json()["count"], 0
        )
        self.assertEqual(
            self.client.get("/api/planning/planned-changes/map/").json()["targets"],
            {},
        )


class ImmutabilityTests(_PlanBase):
    def test_retarget_and_rewrite_rejected(self):
        dev = self._device()
        iface = self._iface(dev, enabled=True)
        other = self._iface(dev, name="Gi2/2")
        pid = self._plan(self._task(), "interface", iface.id,
                         self._iface_payload(dev, enabled=False)).json()["id"]
        for payload in (
            {"object_id": str(other.id)},
            {"payload": {"enabled": True}},
            {"kind": "create"},
        ):
            r = self.client.patch(
                f"/api/planning/planned-changes/{pid}/", payload, format="json"
            )
            self.assertEqual(r.status_code, 400, payload)

    def test_applied_row_is_immutable_and_undeletable(self):
        dev = self._device()
        iface = self._iface(dev, enabled=True)
        pid = self._plan(self._task(), "interface", iface.id,
                         self._iface_payload(dev, enabled=False)).json()["id"]
        self._apply(pid)
        self.assertEqual(
            self.client.patch(f"/api/planning/planned-changes/{pid}/",
                              {"note": "x"}, format="json").status_code, 400
        )
        self.assertEqual(
            self.client.delete(f"/api/planning/planned-changes/{pid}/").status_code,
            400,
        )

    def test_unknown_object_type_rejected(self):
        dev = self._device()
        r = self._plan(self._task(), "nope", dev.id, {"description": "x"})
        self.assertEqual(r.status_code, 400)

    def test_empty_payload_rejected(self):
        dev = self._device()
        r = self._plan(self._task(), "device", dev.id, {})
        self.assertEqual(r.status_code, 400)


class MapTests(_PlanBase):
    def test_map_groups_open_plans_by_target(self):
        dev = self._device()
        iface = self._iface(dev, enabled=True, description="")
        task = self._task(due_date="2026-09-10")
        self._plan(task, "interface", iface.id,
                   self._iface_payload(dev, enabled=False))
        self._plan(task, "interface", iface.id,
                   self._iface_payload(dev, description="planned"),
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
        self.assertTrue(row["samples"])
        self.assertIn(row["samples"][0]["field"], {"Enabled", "Description"})

    def test_map_excludes_applied_and_cancelled(self):
        dev = self._device()
        iface = self._iface(dev, enabled=True)
        pid = self._plan(self._task(), "interface", iface.id,
                         self._iface_payload(dev, enabled=False)).json()["id"]
        self._apply(pid)
        self.assertEqual(
            self.client.get("/api/planning/planned-changes/map/").json()["targets"],
            {},
        )
