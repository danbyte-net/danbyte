"""The calendar window: what lands in it, and what must never leak into it."""
from __future__ import annotations

from datetime import date, timedelta

from .models import Milestone, PlannedChange, PlannedChangeState, Task
from .tests_planned_changes import _PlanBase

URL = "/api/planning/calendar/"


class CalendarWindowTests(_PlanBase):
    def setUp(self):
        super().setUp()
        self.board = self._board()
        self.day = date(2026, 8, 13)

    def _task(self, title, start=None, due=None, board=None):
        return Task.objects.create(
            tenant=self.tenant,
            board=board or self.board,
            status=(board or self.board).statuses.get(name="To do"),
            title=title,
            start_date=start,
            due_date=due,
        )

    def _get(self, start, end, **extra):
        params = {"start": start.isoformat(), "end": end.isoformat(), **extra}
        query = "&".join(f"{k}={v}" for k, v in params.items())
        return self.client.get(f"{URL}?{query}")

    def test_a_span_overlapping_the_window_is_included(self):
        """A task running across the window's edge is happening *during* it."""
        self._task("Migration", start=self.day - timedelta(days=5), due=self.day + timedelta(days=5))
        r = self._get(self.day, self.day + timedelta(days=1))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([t["title"] for t in r.json()["tasks"]], ["Migration"])

    def test_a_task_outside_the_window_is_not(self):
        self._task("Later", start=self.day + timedelta(days=30), due=self.day + timedelta(days=31))
        r = self._get(self.day, self.day + timedelta(days=7))
        self.assertEqual(r.json()["tasks"], [])

    def test_a_task_dated_on_one_end_only_still_lands(self):
        self._task("Due only", due=self.day)
        self._task("Start only", start=self.day)
        r = self._get(self.day, self.day)
        self.assertEqual(
            sorted(t["title"] for t in r.json()["tasks"]), ["Due only", "Start only"]
        )

    def test_an_undated_task_never_appears(self):
        self._task("Someday")
        r = self._get(self.day - timedelta(days=365), self.day + timedelta(days=365))
        self.assertEqual(r.json()["tasks"], [])

    def test_milestones_land_on_their_due_date(self):
        Milestone.objects.create(
            tenant=self.tenant, board=self.board, name="Cutover", due_date=self.day
        )
        r = self._get(self.day, self.day)
        self.assertEqual([m["name"] for m in r.json()["milestones"]], ["Cutover"])

    def test_a_planned_change_lands_on_its_own_date(self):
        task = self._task("Swap", due=self.day + timedelta(days=10))
        dev = self._device()
        iface = self._iface(dev)
        change = PlannedChange.objects.create(
            tenant=self.tenant,
            task=task,
            object_type="api.interface",
            object_id=iface.id,
            payload={"enabled": False},
            before={"enabled": True},
            display=[{"field": "enabled", "label": "Enabled", "from": "Yes", "to": "No"}],
            planned_for=self.day,
            created_by=self.admin,
        )
        r = self._get(self.day, self.day)
        entries = r.json()["changes"]
        self.assertEqual([c["id"] for c in entries], [str(change.id)])
        self.assertEqual(entries[0]["fields"], ["Enabled"])
        # ...and not on the task's due date, which is outside this window.
        self.assertEqual(
            self._get(self.day + timedelta(days=10), self.day + timedelta(days=10))
            .json()["changes"],
            [],
        )

    def test_a_change_without_its_own_date_falls_back_to_the_task(self):
        task = self._task("Swap", due=self.day)
        dev = self._device()
        PlannedChange.objects.create(
            tenant=self.tenant,
            task=task,
            object_type="api.device",
            object_id=dev.id,
            payload={"serial_number": "X"},
            before={"serial_number": ""},
            display=[],
            created_by=self.admin,
        )
        r = self._get(self.day, self.day)
        self.assertEqual(len(r.json()["changes"]), 1)

    def test_applied_changes_drop_off_the_calendar(self):
        task = self._task("Swap", due=self.day)
        dev = self._device()
        PlannedChange.objects.create(
            tenant=self.tenant,
            task=task,
            object_type="api.device",
            object_id=dev.id,
            payload={"serial_number": "X"},
            before={"serial_number": ""},
            display=[],
            state=PlannedChangeState.APPLIED,
            created_by=self.admin,
        )
        self.assertEqual(self._get(self.day, self.day).json()["changes"], [])

    def test_board_filter_narrows_all_three(self):
        other = self._board(name="Other", slug="other")
        self._task("Mine", due=self.day)
        self._task("Theirs", due=self.day, board=other)
        r = self._get(self.day, self.day, board=str(self.board.id))
        self.assertEqual([t["title"] for t in r.json()["tasks"]], ["Mine"])

    def test_a_window_is_required_and_bounded(self):
        self.assertEqual(self.client.get(URL).status_code, 400)
        self.assertEqual(
            self._get(self.day, self.day - timedelta(days=1)).status_code, 400
        )
        self.assertEqual(
            self._get(self.day, self.day + timedelta(days=900)).status_code, 400
        )
        self.assertEqual(self.client.get(f"{URL}?start=nope&end=nope").status_code, 400)


class CalendarScopeTests(_PlanBase):
    """The calendar reads through the list querysets, so it can only ever show
    what the board itself would have."""

    def test_another_tenants_work_is_invisible(self):
        theirs = self._board(tenant=self.other, name="Theirs", slug="theirs")
        Task.objects.create(
            tenant=self.other,
            board=theirs,
            status=theirs.statuses.get(name="To do"),
            title="Their cutover",
            due_date=date(2026, 8, 13),
        )
        mine = self._board()
        Task.objects.create(
            tenant=self.tenant,
            board=mine,
            status=mine.statuses.get(name="To do"),
            title="My cutover",
            due_date=date(2026, 8, 13),
        )
        r = self.client.get(f"{URL}?start=2026-08-01&end=2026-08-31")
        self.assertEqual(
            [t["title"] for t in r.json()["tasks"]], ["My cutover"], r.content
        )

    def test_view_rights_on_tasks_are_required(self):
        member = self._member("nobody", types=["board"], actions=["view"])
        self._as(member)
        r = self.client.get(f"{URL}?start=2026-08-01&end=2026-08-31")
        self.assertEqual(r.status_code, 403, r.content)


class DigestTaskSectionTests(_PlanBase):
    """Planning's section of the daily digest: the counts an operator acts on."""

    def test_task_summary_counts_and_rows(self):
        from datetime import timedelta

        from django.utils import timezone

        from planning.digest import task_summary

        board = self._board()
        today = timezone.now().date()

        def mk(title, due, status_name="To do"):
            return Task.objects.create(
                tenant=self.tenant, board=board,
                status=board.statuses.get(name=status_name),
                title=title, due_date=due,
            )

        mk("Late", today - timedelta(days=2))
        mk("Today", today)
        mk("Soon", today + timedelta(days=3))
        mk("Far", today + timedelta(days=30))
        # Closed work is not "planned work", whatever the column is named.
        mk("Done already", today, status_name="Done")
        mk("Undated", None)

        s = task_summary(self.tenant, timezone.now())
        self.assertEqual(
            (s["overdue"], s["due_today"], s["due_week"]), (1, 1, 1)
        )
        self.assertEqual([r["title"] for r in s["rows"]], ["Late", "Today", "Soon"])
        self.assertTrue(s["rows"][0]["overdue"])

    def test_digest_html_carries_the_section(self):
        from datetime import timedelta

        from django.utils import timezone

        from monitoring.digest import build_digest, render_html, render_text

        board = self._board()
        Task.objects.create(
            tenant=self.tenant, board=board,
            status=board.statuses.get(name="To do"),
            title="Replace PSU in rack A",
            due_date=timezone.now().date() - timedelta(days=1),
        )
        data = build_digest(self.tenant, timezone.now() - timedelta(days=1))
        html = render_html(data, "Danbyte")
        self.assertIn("Planned work", html)
        self.assertIn("Replace PSU in rack A", html)
        self.assertIn("Planned work", render_text(data))
