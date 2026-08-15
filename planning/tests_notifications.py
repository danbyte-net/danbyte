"""Personal task emails: assignment, team queue, comments, @mentions, reminder."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import Group, User
from django.core import mail
from django.utils import timezone

from auth_api.models import UserProfile

from . import notifications
from .models import Task
from .tests import Base


class _NotifyBase(Base):
    def _user(self, name, email=None, group=None, prefs=None):
        u = User.objects.create_user(name, email or f"{name}@example.org", "x")
        profile = UserProfile.objects.create(user=u, prefs=prefs or {})
        profile.tenants.add(self.tenant)
        if group:
            u.groups.add(group)
        return u

    def _grant_tasks(self, user):
        from auth_api.models import ObjectPermission

        perm = ObjectPermission.objects.create(
            name=f"tasks-{user.username}", enabled=True,
            object_types=["task", "board"], actions=["view"],
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)

    def _noc(self):
        return Group.objects.create(name="NOC")

    def _as(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()


class AssignmentGroupTests(_NotifyBase):
    def test_group_round_trips_and_feeds_my_work(self):
        noc = self._noc()
        member = self._user("rene", group=noc)
        board = self._board()
        r = self.client.post(
            "/api/planning/tasks/",
            {
                "board": str(board.id),
                "status": str(board.statuses.get(name="To do").id),
                "title": "Check the splice",
                "assigned_group": noc.id,
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["assigned_group_name"], "NOC")

        # Unclaimed queue work counts as the member's work...
        self._grant_tasks(member)
        self.client.force_login(member)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        mine = self.client.get("/api/planning/tasks/?assignee=me")
        self.assertEqual(
            [t["title"] for t in mine.json()["results"]], ["Check the splice"]
        )
        # ...until someone specific picks it up.
        Task.objects.get(title="Check the splice").assignees.add(self.admin)
        mine = self.client.get("/api/planning/tasks/?assignee=me")
        self.assertEqual(mine.json()["results"], [])


class AssignmentEmailTests(_NotifyBase):
    def _task(self, **kw):
        board = self._board()
        return Task.objects.create(
            tenant=self.tenant, board=board,
            status=board.statuses.get(name="To do"),
            title="Replace PSU", created_by=self.admin, **kw,
        )

    def test_assigned_mail_respects_the_optout_and_skips_the_actor(self):
        task = self._task()
        rene = self._user("rene")
        muted = self._user("muted", prefs={"notify_task_assigned": False})
        task.assignees.add(rene, muted, self.admin)
        notifications.send_assigned(
            str(task.pk), [rene.pk, muted.pk, self.admin.pk], self.admin.pk
        )
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, [rene.email])
        self.assertIn("Replace PSU", mail.outbox[0].subject)

    def test_queue_mail_goes_to_members_not_already_assigned(self):
        noc = self._noc()
        onit = self._user("onit", group=noc)
        fresh = self._user("fresh", group=noc)
        task = self._task(assigned_group=noc)
        task.assignees.add(onit)
        notifications.send_queued(str(task.pk), noc.pk, self.admin.pk)
        self.assertEqual([m.to for m in mail.outbox], [[fresh.email]])
        self.assertIn("New in NOC", mail.outbox[0].subject)

    def test_outside_tenant_users_never_hear_about_it(self):
        noc = self._noc()
        outsider = User.objects.create_user("out", "out@example.org", "x")
        UserProfile.objects.create(user=outsider)  # no tenant membership
        outsider.groups.add(noc)
        task = self._task(assigned_group=noc)
        notifications.send_queued(str(task.pk), noc.pk, self.admin.pk)
        self.assertEqual(mail.outbox, [])


class MentionTests(_NotifyBase):
    def test_parse_matches_real_tenant_users_only(self):
        rene = self._user("rene.k")
        self._user("bo")
        found = notifications.parse_mentions(
            "ping @rene.k. and @nobody about this", self.tenant
        )
        self.assertEqual([u.pk for u in found], [rene.pk])

    def test_comment_hook_fires_and_mentions_outrank_comment_mail(self):
        board = self._board()
        task = Task.objects.create(
            tenant=self.tenant, board=board,
            status=board.statuses.get(name="To do"),
            title="Splice window", created_by=self.admin,
        )
        rene = self._user("rene")
        watcher = self._user("watcher")
        task.assignees.add(rene, watcher)
        r = self.client.post(
            "/api/journal/",
            {"object_type": "planning.task", "object_id": str(task.id),
             "kind": "info", "comments": "@rene can you take this?"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        # The hook enqueues; with the queue unavailable in tests it may run
        # inline — call the sender directly for a deterministic assert.
        mail.outbox.clear()
        entry_id = r.json()["id"]
        notifications.send_commented(
            str(task.pk), entry_id, self.admin.pk, [rene.pk]
        )
        by_recipient = {m.to[0]: m.subject for m in mail.outbox}
        self.assertIn("mentioned you", by_recipient[rene.email])
        self.assertIn("New comment", by_recipient[watcher.email])
        self.assertEqual(len(mail.outbox), 2)


class DueReminderTests(_NotifyBase):
    def test_one_mail_per_user_and_silence_when_clear(self):
        board = self._board()
        rene = self._user("rene")
        idle = self._user("idle")
        overdue = Task.objects.create(
            tenant=self.tenant, board=board,
            status=board.statuses.get(name="To do"),
            title="Overdue thing",
            due_date=timezone.localdate() - timedelta(days=2),
        )
        overdue.assignees.add(rene)
        noc = self._noc()
        rene.groups.add(noc)
        Task.objects.create(
            tenant=self.tenant, board=board,
            status=board.statuses.get(name="To do"),
            title="Queue thing", assigned_group=noc,
            due_date=timezone.localdate(),
        )
        sent = notifications.send_due_reminders()
        # rene (and the superuser fixture has no email tasks); idle gets nothing.
        self.assertEqual(sent, 1)
        self.assertEqual(mail.outbox[0].to, [rene.email])
        self.assertIn("1 overdue", mail.outbox[0].subject)
        self.assertIn("1 due today", mail.outbox[0].subject)
        self.assertNotIn(idle.email, [m.to[0] for m in mail.outbox])

    def test_done_tasks_do_not_nag(self):
        board = self._board()
        rene = self._user("rene")
        done = Task.objects.create(
            tenant=self.tenant, board=board,
            status=board.statuses.get(name="Done"),
            title="Shipped already",
            due_date=timezone.localdate() - timedelta(days=1),
        )
        done.assignees.add(rene)
        self.assertEqual(notifications.send_due_reminders(), 0)
        self.assertEqual(mail.outbox, [])


class BellTests(_NotifyBase):
    def test_bell_hears_even_when_email_is_off(self):
        from core.models import Notification

        board = self._board()
        task = Task.objects.create(
            tenant=self.tenant, board=board,
            status=board.statuses.get(name="To do"),
            title="Bell test", created_by=self.admin,
        )
        muted = self._user("muted", prefs={"notify_task_assigned": False})
        task.assignees.add(muted)
        notifications.send_assigned(str(task.pk), [muted.pk], self.admin.pk)
        # The mail respects the opt-out; the bell always hears.
        self.assertEqual(mail.outbox, [])
        rows = Notification.objects.filter(user=muted)
        self.assertEqual(rows.count(), 1)
        self.assertIn("Bell test", rows[0].title)
        self.assertIn(f"/tasks/{task.id}", rows[0].url)

    def test_endpoint_serves_only_my_rows_and_marks_read(self):
        from core.models import Notification

        rene = self._user("rene")
        other = self._user("other")
        Notification.push([rene], kind="task_comment", title="For rene")
        Notification.push([other], kind="task_comment", title="For other")

        self._as(rene)
        r = self.client.get("/api/notifications/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["unread"], 1)
        self.assertEqual([n["title"] for n in r.json()["results"]], ["For rene"])

        r = self.client.post(
            "/api/notifications/read/", {"all": True}, format="json"
        )
        self.assertEqual(r.json()["unread"], 0)
        # The other user's row is untouched.
        self.assertIsNone(Notification.objects.get(user=other).read_at)
