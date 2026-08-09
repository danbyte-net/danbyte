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
