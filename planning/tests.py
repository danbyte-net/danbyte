"""Planning — boards, statuses, tasks, generic links."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Device, DeviceRole, DeviceType, Manufacturer, Site
from api.test_utils import status_for
from core.models import Organization, Tenant

from .models import (
    Board,
    Milestone,
    Task,
    TaskLink,
    TaskStatus,
    seed_default_statuses,
)


class Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.admin = User.objects.create_superuser("admin", "a@x.com", "x")
        self.client.force_login(self.admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _board(self, tenant=None, name="Ops", slug="ops"):
        board = Board.objects.create(
            tenant=tenant or self.tenant, name=name, slug=slug
        )
        seed_default_statuses(board)
        return board

    def _device(self, tenant=None, name="dev1"):
        tenant = tenant or self.tenant
        site = Site.objects.create(tenant=tenant, name=f"S-{name}")
        mfr, _ = Manufacturer.objects.get_or_create(
            tenant=tenant, slug="m", defaults={"name": "M"}
        )
        dtype, _ = DeviceType.objects.get_or_create(
            tenant=tenant, model="X", defaults={"manufacturer": mfr}
        )
        role = DeviceRole.objects.create(
            tenant=tenant, name=f"R-{name}", slug=f"r-{name}"
        )
        return Device.objects.create(
            tenant=tenant, name=name, device_type=dtype, site=site, role=role,
            status=status_for(tenant),
        )


class BoardApiTests(Base):
    def test_create_board_seeds_four_editable_statuses(self):
        r = self.client.post(
            "/api/planning/boards/",
            {"name": "DC migration", "slug": "dc-migration"}, format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        board = Board.objects.get(slug="dc-migration")
        names = list(board.statuses.values_list("name", flat=True))
        self.assertEqual(names, ["Backlog", "To do", "In progress", "Done"])
        # Editable: rename one.
        st = board.statuses.get(name="Done")
        r = self.client.patch(
            f"/api/planning/statuses/{st.id}/", {"name": "Shipped"}, format="json"
        )
        self.assertEqual(r.status_code, 200)

    def test_seed_is_idempotent(self):
        board = self._board()
        seed_default_statuses(board)
        self.assertEqual(board.statuses.count(), 4)

    def test_default_flagged_statuses_template_new_boards(self):
        # Columns flagged is_default replace the builtin four on new boards,
        # deduplicated by name (case-insensitive), lightest first.
        src = self._board(name="Template", slug="template")
        TaskStatus.objects.create(
            tenant=self.tenant, board=src, name="Triage",
            semantic_group="unstarted", color="#3b82f6", weight=50,
            is_default=True,
        )
        done = src.statuses.get(name="Done")
        done.is_default = True
        done.save(update_fields=["is_default"])
        # A same-named duplicate on another board must not collide.
        other = self._board(name="Other", slug="other-src")
        dup = other.statuses.get(name="Done")
        dup.is_default = True
        dup.save(update_fields=["is_default"])

        r = self.client.post(
            "/api/planning/boards/",
            {"name": "Fresh", "slug": "fresh"}, format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        fresh = Board.objects.get(slug="fresh")
        names = list(fresh.statuses.values_list("name", flat=True))
        self.assertEqual(names, ["Triage", "Done"])
        # Copies are plain columns, not templates themselves.
        self.assertFalse(fresh.statuses.filter(is_default=True).exists())

    def test_board_edit_and_tags(self):
        from core.models import Tag

        board = self._board()
        tag = Tag.objects.create(tenant=self.tenant, name="noc", slug="noc")
        r = self.client.patch(
            f"/api/planning/boards/{board.id}/",
            {"name": "Renamed", "description": "d", "tag_ids": [tag.id]},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        data = self.client.get("/api/planning/boards/").json()["results"][0]
        self.assertEqual(data["name"], "Renamed")
        self.assertEqual([t["name"] for t in data["tags"]], ["noc"])

    def test_tenant_isolation(self):
        self._board(tenant=self.other, name="Theirs", slug="theirs")
        r = self.client.get("/api/planning/boards/")
        self.assertEqual(r.json()["count"], 0)


class TaskApiTests(Base):
    def test_create_move_and_board_status_consistency(self):
        board = self._board()
        todo = board.statuses.get(name="To do")
        done = board.statuses.get(name="Done")
        r = self.client.post(
            "/api/planning/tasks/",
            {"board": str(board.id), "status": str(todo.id),
             "title": "Replace core switch"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        task_id = r.json()["id"]
        # Drag = one PATCH {status, weight}.
        r = self.client.patch(
            f"/api/planning/tasks/{task_id}/",
            {"status": str(done.id), "weight": 150}, format="json",
        )
        self.assertEqual(r.status_code, 200)
        # A status from another board is rejected.
        other_board = self._board(name="Two", slug="two")
        foreign = other_board.statuses.first()
        r = self.client.patch(
            f"/api/planning/tasks/{task_id}/",
            {"status": str(foreign.id)}, format="json",
        )
        self.assertEqual(r.status_code, 400)

    def test_status_with_tasks_is_protected(self):
        board = self._board()
        st = board.statuses.get(name="To do")
        Task.objects.create(
            tenant=self.tenant, board=board, status=st, title="t"
        )
        r = self.client.delete(f"/api/planning/statuses/{st.id}/")
        self.assertEqual(r.status_code, 400)
        self.assertTrue(TaskStatus.objects.filter(id=st.id).exists())


class AssignableUsersTests(Base):
    """Assignment must work for someone who can edit tasks but is not a user
    administrator — /api/users/ requires `user.view`, which made the assignee
    picker silently empty (and assignment impossible) for exactly the people
    who do the work."""

    def _tenant_member(self, username, tenant=None, actions=("view", "change")):
        from auth_api.models import ObjectPermission, UserProfile

        user = User.objects.create_user(username, f"{username}@x.com", "x")
        profile, _ = UserProfile.objects.get_or_create(user=user)
        profile.tenants.add(tenant or self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"tasks-{username}", enabled=True,
            object_types=["task"], actions=list(actions),
        )
        perm.users.add(user)
        perm.tenants.add(tenant or self.tenant)
        return user

    def _as(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_task_editor_without_user_view_can_list_assignees(self):
        noc = self._tenant_member("noc1")
        self._as(noc)
        # The old path, for contrast: listing users is denied.
        self.assertEqual(self.client.get("/api/users/").status_code, 403)
        r = self.client.get("/api/planning/assignable-users/")
        self.assertEqual(r.status_code, 200, r.content)
        names = {u["username"] for u in r.json()["results"]}
        self.assertIn("noc1", names)

    def test_email_withheld_without_user_view(self):
        noc = self._tenant_member("noc2")
        self._as(noc)
        rows = self.client.get("/api/planning/assignable-users/").json()["results"]
        self.assertTrue(all(u["email"] == "" for u in rows))
        # A superuser (who may read users) still gets addresses.
        self.client.force_login(self.admin)
        rows = self.client.get("/api/planning/assignable-users/").json()["results"]
        self.assertTrue(any(u["email"] for u in rows))

    def test_other_tenants_users_are_not_listed(self):
        self._tenant_member("theirs", tenant=self.other)
        noc = self._tenant_member("mine")
        self._as(noc)
        rows = self.client.get("/api/planning/assignable-users/").json()["results"]
        self.assertNotIn("theirs", {u["username"] for u in rows})

    def test_without_task_rights_denied(self):
        from auth_api.models import ObjectPermission, UserProfile

        outsider = User.objects.create_user("nobody", "n@x.com", "x")
        profile, _ = UserProfile.objects.get_or_create(user=outsider)
        profile.tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="boards-only", enabled=True,
            object_types=["board"], actions=["view"],
        )
        perm.users.add(outsider)
        perm.tenants.add(self.tenant)
        self._as(outsider)
        self.assertEqual(
            self.client.get("/api/planning/assignable-users/").status_code, 403
        )

    def test_search_filters(self):
        self._tenant_member("alice")
        r = self.client.get("/api/planning/assignable-users/?search=alic")
        self.assertEqual({u["username"] for u in r.json()["results"]}, {"alice"})


class MilestoneApiTests(Base):
    def test_milestone_lifecycle_and_task_rollup(self):
        board = self._board()
        r = self.client.post(
            "/api/planning/milestones/",
            {"board": str(board.id), "name": "Rack A cutover",
             "due_date": "2026-09-01"}, format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        ms_id = r.json()["id"]

        task = Task.objects.create(
            tenant=self.tenant, board=board,
            status=board.statuses.get(name="To do"), title="t",
            milestone_id=ms_id,
        )
        listing = self.client.get(f"/api/planning/milestones/?board={board.id}")
        self.assertEqual(listing.json()["results"][0]["task_count"], 1)
        detail = self.client.get(f"/api/planning/tasks/{task.id}/").json()
        self.assertEqual(detail["milestone_name"], "Rack A cutover")
        self.assertEqual(detail["milestone_due"], "2026-09-01")

        # Deleting the milestone keeps the task (SET_NULL), unlike a status.
        self.assertEqual(
            self.client.delete(f"/api/planning/milestones/{ms_id}/").status_code,
            204,
        )
        task.refresh_from_db()
        self.assertIsNone(task.milestone_id)

    def test_milestone_from_another_board_rejected(self):
        board = self._board()
        other = self._board(name="Second", slug="second")
        ms = Milestone.objects.create(
            tenant=self.tenant, board=other, name="Elsewhere"
        )
        r = self.client.post(
            "/api/planning/tasks/",
            {"board": str(board.id),
             "status": str(board.statuses.get(name="To do").id),
             "title": "t", "milestone": str(ms.id)}, format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_milestone_tenant_isolation(self):
        foreign = self._board(tenant=self.other, name="Theirs", slug="theirs")
        Milestone.objects.create(
            tenant=self.other, board=foreign, name="Not mine"
        )
        r = self.client.get("/api/planning/milestones/")
        self.assertEqual(r.json()["count"], 0)


class TaskLinkApiTests(Base):
    def _task(self, board=None):
        board = board or self._board()
        return Task.objects.create(
            tenant=self.tenant, board=board,
            status=board.statuses.get(name="To do"), title="t",
        )

    def test_link_and_reverse_lookup(self):
        task = self._task()
        dev = self._device()
        r = self.client.post(
            "/api/planning/links/",
            {"task": str(task.id), "object_type": "device",
             "object_id": str(dev.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["object_type"], "api.device")  # normalised
        rev = self.client.get(
            f"/api/planning/links/?object_type=device&object_id={dev.id}"
        ).json()
        self.assertEqual(rev["count"], 1)

    def test_unknown_object_type_rejected(self):
        task = self._task()
        r = self.client.post(
            "/api/planning/links/",
            {"task": str(task.id), "object_type": "nope",
             "object_id": str(task.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 400)

    def test_cross_tenant_target_fails_closed(self):
        task = self._task()
        foreign_dev = self._device(tenant=self.other, name="theirs")
        # Non-superuser scoped to self.tenant cannot view the other tenant's
        # device → link creation must be rejected.
        reader = User.objects.create_user("reader", "r@x.com", "x")
        from auth_api.models import ObjectPermission

        perm = ObjectPermission.objects.create(
            name="planning-full", enabled=True,
            object_types=["*"],
            actions=["view", "add", "change", "delete"],
        )
        perm.users.add(reader)
        perm.tenants.add(self.tenant)
        self.client.force_login(reader)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        r = self.client.post(
            "/api/planning/links/",
            {"task": str(task.id), "object_type": "device",
             "object_id": str(foreign_dev.id)},
            format="json",
        )
        self.assertIn(r.status_code, (400, 403))
        self.assertFalse(TaskLink.objects.filter(task=task).exists())

    def test_retargeting_rejected(self):
        task = self._task()
        dev = self._device()
        link = TaskLink.objects.create(
            tenant=self.tenant, task=task,
            object_type="api.device", object_id=dev.id,
        )
        other_dev = self._device(name="dev2")
        r = self.client.patch(
            f"/api/planning/links/{link.id}/",
            {"object_id": str(other_dev.id)}, format="json",
        )
        self.assertEqual(r.status_code, 400)

    def test_duplicate_link_rejected(self):
        task = self._task()
        dev = self._device()
        payload = {"task": str(task.id), "object_type": "device",
                   "object_id": str(dev.id)}
        self.client.post("/api/planning/links/", payload, format="json")
        r = self.client.post("/api/planning/links/", payload, format="json")
        self.assertEqual(r.status_code, 400)
