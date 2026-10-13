"""Object pages: the Tasks tab lookup and the per-assignee overdue warning."""
from __future__ import annotations

import datetime
from unittest import mock

from django.contrib.auth.models import Group, User
from django.utils import timezone

from .models import Task, TaskLink, TaskOverdueDismissal, TaskStatus
from .tests import Base


class ObjectTasksBase(Base):
    def setUp(self):
        super().setUp()
        self.board = self._board()
        self.todo = TaskStatus.objects.get(board=self.board, name="To do")
        self.done = TaskStatus.objects.get(board=self.board, name="Done")
        self.device = self._device()
        self.yesterday = timezone.localdate() - datetime.timedelta(days=1)

    def _task(self, title, status=None, due=None, due_time=None, link=True,
              assignees=(), group=None, board=None, tenant=None, obj=None):
        board = board or self.board
        task = Task.objects.create(
            tenant=tenant or self.tenant, board=board,
            status=status or self.todo, title=title,
            due_date=due, due_time=due_time, assigned_group=group,
        )
        task.assignees.set(assignees)
        if link:
            obj = obj or self.device
            TaskLink.objects.create(
                tenant=task.tenant, task=task, object_type="api.device",
                object_id=obj.pk,
            )
        return task

    def _member(self, username):
        from auth_api.models import ObjectPermission, UserProfile

        user = User.objects.create_user(username, f"{username}@x.com", "x")
        profile, _ = UserProfile.objects.get_or_create(user=user)
        profile.tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"tasks-{username}", enabled=True,
            object_types=["task"], actions=["view"],
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        return user

    def _as(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _for_device(self, extra=""):
        return f"object_type=device&object_id={self.device.pk}{extra}"


class ObjectTaskListTests(ObjectTasksBase):
    def test_lists_only_tasks_linked_to_the_object(self):
        mine = self._task("Swap PSU")
        other = self._device(name="dev2")
        self._task("Elsewhere", obj=other)
        self._task("Unlinked", link=False)
        r = self.client.get(f"/api/planning/tasks/?{self._for_device()}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([t["id"] for t in r.json()["results"]], [str(mine.pk)])

    def test_open_excludes_done_and_cancelled(self):
        self._task("Open one")
        self._task("Finished", status=self.done)
        cancelled = TaskStatus.objects.create(
            tenant=self.tenant, board=self.board, name="Dropped",
            semantic_group="cancelled",
        )
        self._task("Dropped", status=cancelled)
        r = self.client.get(f"/api/planning/tasks/?{self._for_device('&open=1')}")
        self.assertEqual([t["title"] for t in r.json()["results"]], ["Open one"])
        r = self.client.get(f"/api/planning/tasks/?{self._for_device()}")
        self.assertEqual(len(r.json()["results"]), 3)

    def test_rows_carry_status_colour_and_group(self):
        self._task("Swap PSU")
        row = self.client.get(
            f"/api/planning/tasks/?{self._for_device()}"
        ).json()["results"][0]
        self.assertEqual(row["status_color"], self.todo.color)
        self.assertEqual(row["status_group"], "unstarted")

    def test_other_tenants_tasks_on_the_same_id_stay_hidden(self):
        theirs = self._board(tenant=self.other, name="Theirs", slug="theirs")
        st = TaskStatus.objects.get(board=theirs, name="To do")
        # A foreign task pointing at this object id - the lookup must still
        # answer only from the active tenant.
        self._task("Foreign", board=theirs, status=st, tenant=self.other)
        r = self.client.get(f"/api/planning/tasks/?{self._for_device()}")
        self.assertEqual(r.json()["results"], [])

    def test_malformed_or_unknown_target_is_empty_not_everything(self):
        self._task("Swap PSU")
        for q in (
            "object_type=device&object_id=nope",
            "object_type=nosuchtype&object_id=" + str(self.device.pk),
            "object_type=device",
            "object_id=" + str(self.device.pk),
        ):
            r = self.client.get(f"/api/planning/tasks/?{q}")
            self.assertEqual(r.status_code, 200, q)
            self.assertEqual(r.json()["results"], [], q)

    def test_without_task_view_denied(self):
        from auth_api.models import ObjectPermission, UserProfile

        outsider = User.objects.create_user("nobody", "n@x.com", "x")
        profile, _ = UserProfile.objects.get_or_create(user=outsider)
        profile.tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="devices-only", enabled=True,
            object_types=["device"], actions=["view"],
        )
        perm.users.add(outsider)
        perm.tenants.add(self.tenant)
        self._as(outsider)
        self.assertEqual(
            self.client.get(f"/api/planning/tasks/?{self._for_device()}").status_code,
            403,
        )
        self.assertEqual(
            self.client.get(
                f"/api/planning/tasks/overdue/?{self._for_device()}"
            ).status_code,
            403,
        )


class OverdueWarningTests(ObjectTasksBase):
    def setUp(self):
        super().setUp()
        self.alice = self._member("alice")
        self.bob = self._member("bob")

    def _overdue(self):
        r = self.client.get(f"/api/planning/tasks/overdue/?{self._for_device()}")
        self.assertEqual(r.status_code, 200, r.content)
        return [t["title"] for t in r.json()]

    def test_assignee_sees_overdue_task(self):
        self._task("Late", due=self.yesterday, assignees=[self.alice])
        self._as(self.alice)
        self.assertEqual(self._overdue(), ["Late"])

    def test_non_assignee_sees_nothing(self):
        self._task("Late", due=self.yesterday, assignees=[self.alice])
        self._as(self.bob)
        self.assertEqual(self._overdue(), [])

    def test_superuser_who_is_not_assigned_sees_nothing(self):
        self._task("Late", due=self.yesterday, assignees=[self.alice])
        self.assertEqual(self._overdue(), [])

    def test_done_task_is_not_overdue(self):
        self._task("Finished", status=self.done, due=self.yesterday,
                   assignees=[self.alice])
        self._as(self.alice)
        self.assertEqual(self._overdue(), [])

    def test_due_today_without_time_is_not_yet_overdue(self):
        self._task("Today", due=timezone.localdate(), assignees=[self.alice])
        self._task("Undated", assignees=[self.alice])
        self._as(self.alice)
        self.assertEqual(self._overdue(), [])

    def test_due_time_today_that_has_passed_is_overdue(self):
        now = timezone.localtime().replace(hour=15, minute=0, second=0)
        self._task("Morning", due=now.date(), due_time=datetime.time(9, 0),
                   assignees=[self.alice])
        self._task("Evening", due=now.date(), due_time=datetime.time(20, 0),
                   assignees=[self.alice])
        self._as(self.alice)
        with mock.patch("planning.viewsets._local_now", return_value=now):
            self.assertEqual(self._overdue(), ["Morning"])

    def test_only_tasks_linked_to_this_object(self):
        other = self._device(name="dev2")
        self._task("Other box", due=self.yesterday, assignees=[self.alice],
                   obj=other)
        self._as(self.alice)
        self.assertEqual(self._overdue(), [])

    def test_unclaimed_group_queue_counts_claimed_does_not(self):
        team = Group.objects.create(name="noc")
        self.bob.groups.add(team)
        self._task("Queued", due=self.yesterday, group=team)
        self._task("Claimed", due=self.yesterday, group=team,
                   assignees=[self.alice])
        self._as(self.bob)
        self.assertEqual(self._overdue(), ["Queued"])

    def test_dismissal_persists_and_is_per_user(self):
        carol = self._member("carol")
        task = self._task("Late", due=self.yesterday,
                          assignees=[self.alice, carol])
        self._as(self.alice)
        r = self.client.post(f"/api/planning/tasks/{task.pk}/dismiss-overdue/")
        self.assertEqual(r.status_code, 204, r.content)
        self.assertEqual(self._overdue(), [])
        # A second session (another device) still sees it dismissed.
        self.client.logout()
        self._as(self.alice)
        self.assertEqual(self._overdue(), [])
        # Carol never dismissed it.
        self._as(carol)
        self.assertEqual(self._overdue(), ["Late"])

    def test_moving_the_due_date_re_arms_the_warning(self):
        task = self._task("Late", due=self.yesterday, assignees=[self.alice])
        self._as(self.alice)
        self.client.post(f"/api/planning/tasks/{task.pk}/dismiss-overdue/")
        self.assertEqual(self._overdue(), [])
        task.due_date = self.yesterday - datetime.timedelta(days=1)
        task.save(update_fields=["due_date"])
        self.assertEqual(self._overdue(), ["Late"])
        # Adding a time is a new due moment too.
        self.client.post(f"/api/planning/tasks/{task.pk}/dismiss-overdue/")
        task.due_time = datetime.time(8, 0)
        task.save(update_fields=["due_time"])
        self.assertEqual(self._overdue(), ["Late"])

    def test_non_assignee_cannot_dismiss(self):
        task = self._task("Late", due=self.yesterday, assignees=[self.alice])
        self._as(self.bob)
        r = self.client.post(f"/api/planning/tasks/{task.pk}/dismiss-overdue/")
        self.assertEqual(r.status_code, 403)
        self.assertFalse(TaskOverdueDismissal.objects.exists())

    def test_cannot_dismiss_another_tenants_task(self):
        theirs = self._board(tenant=self.other, name="Theirs", slug="theirs")
        st = TaskStatus.objects.get(board=theirs, name="To do")
        task = self._task("Foreign", board=theirs, status=st, tenant=self.other,
                          due=self.yesterday, assignees=[self.alice])
        self._as(self.alice)
        r = self.client.post(f"/api/planning/tasks/{task.pk}/dismiss-overdue/")
        self.assertEqual(r.status_code, 404)
        self.assertFalse(TaskOverdueDismissal.objects.exists())

    def test_other_tenants_overdue_tasks_never_surface(self):
        theirs = self._board(tenant=self.other, name="Theirs", slug="theirs")
        st = TaskStatus.objects.get(board=theirs, name="To do")
        self._task("Foreign", board=theirs, status=st, tenant=self.other,
                   due=self.yesterday, assignees=[self.alice])
        self._as(self.alice)
        self.assertEqual(self._overdue(), [])

    def test_dismissing_an_undated_task_is_rejected(self):
        task = self._task("Undated", assignees=[self.alice])
        self._as(self.alice)
        r = self.client.post(f"/api/planning/tasks/{task.pk}/dismiss-overdue/")
        self.assertEqual(r.status_code, 400)
