"""Planning's contribution to the daily email digest.

The digest is the tenant's morning glance, and "what work is due" belongs on it
next to what's down and what's expiring. Open-ness is the status row's semantic
group, so renamed columns still count correctly.
"""
from __future__ import annotations

from datetime import timedelta

from .models import Task

#: Enough rows to act on, few enough to stay a glance.
_MAX_ROWS = 8


def task_summary(tenant, now) -> dict:
    """Counts + the most urgent open tasks for one tenant."""
    today = now.date()
    week = today + timedelta(days=7)

    open_tasks = (
        Task.objects.filter(tenant=tenant)
        .exclude(status__semantic_group__in=["completed", "cancelled"])
        .select_related("board", "status")
        .prefetch_related("assignees")
    )
    dated = open_tasks.exclude(due_date__isnull=True)

    overdue = dated.filter(due_date__lt=today).count()
    due_today = dated.filter(due_date=today).count()
    due_week = dated.filter(due_date__gt=today, due_date__lte=week).count()

    rows = []
    for task in dated.filter(due_date__lte=week).order_by("due_date")[:_MAX_ROWS]:
        rows.append(
            {
                "title": task.title,
                "board": task.board.name,
                "due": task.due_date,
                "overdue": task.due_date < today,
                "assignees": ", ".join(
                    u.username for u in task.assignees.all()
                ) or "unassigned",
            }
        )

    return {
        "overdue": overdue,
        "due_today": due_today,
        "due_week": due_week,
        "rows": rows,
    }
