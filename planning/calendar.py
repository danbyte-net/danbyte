"""One window onto everything that is scheduled.

A board answers "what is the team working on". The calendar answers a different
question — *when is work happening across the organisation* — so it reads across
boards by default and returns the three dated things planning knows about:

- **tasks**, which occupy a span (``start_date`` → ``due_date``) or a single day,
- **milestones**, which are a single dated target a board rolls up to,
- **planned changes**, whose ``effective_date`` is the day an object is meant to
  change — the entries an operator most wants to see before agreeing to work,
- **maintenance & outage events** (issue #20) — provider windows and live
  outages. These are *not* board-scoped: a carrier's window matters to whoever
  is scheduling work no matter which board they look at, so the board filter
  deliberately leaves them in place.

Everything is read through the same querysets the list endpoints use, so tenant
scoping and RBAC row constraints apply unchanged: the calendar can only ever
show you what the board would have.
"""
from __future__ import annotations

from datetime import date, timedelta

from django.db.models import Q
from rest_framework import permissions
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from api.views import _get_active_tenant
from auth_api import rbac

from .models import Milestone, PlannedChangeState, Task

#: A calendar year view asks for 12 months at once; anything beyond two years is
#: a mistake or a scrape, and the answer would be unusable either way.
MAX_SPAN_DAYS = 800


def _parse(value: str | None, field: str) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise ValidationError({field: "Expected YYYY-MM-DD."}) from None


def _window(params) -> tuple[date, date]:
    """The requested range, defaulting to the current month."""
    start = _parse(params.get("start"), "start")
    end = _parse(params.get("end"), "end")
    if start is None or end is None:
        raise ValidationError(
            {"start": "Both start and end are required (YYYY-MM-DD)."}
        )
    if end < start:
        raise ValidationError({"end": "End is before start."})
    if (end - start).days > MAX_SPAN_DAYS:
        raise ValidationError(
            {"end": f"Range is longer than {MAX_SPAN_DAYS} days."}
        )
    return start, end


@api_view(["GET"])
@permission_classes([permissions.IsAuthenticated])
def calendar(request):
    """``?start=&end=[&board=]`` — everything scheduled inside a date window."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")
    if not rbac.has_action(request.user, tenant, "task", "view"):
        raise PermissionDenied("task:view required.")

    start, end = _window(request.query_params)
    board = request.query_params.get("board")
    return Response(calendar_payload(request, start, end, board))


def calendar_payload(request, start: date, end: date, board=None) -> dict:
    """The calendar's data for one window — shared by the JSON view and the
    iCal feed, so both see exactly the same scoped rows."""
    # Reuse the list viewsets' own querysets so row constraints, site scoping
    # and tenant filtering are applied exactly once, in one place.
    from .viewsets import MilestoneViewSet, PlannedChangeViewSet, TaskViewSet

    def scoped(viewset_cls):
        viewset = viewset_cls()
        viewset.request = request
        viewset.format_kwarg = None
        viewset.action = "list"
        return viewset.get_queryset()

    tasks = scoped(TaskViewSet).filter(
        # A task is in the window when its span overlaps it. A task dated on one
        # end only is a point in time, which the same test covers.
        Q(start_date__lte=end, due_date__gte=start)
        | Q(start_date__isnull=True, due_date__range=(start, end))
        | Q(due_date__isnull=True, start_date__range=(start, end))
    )
    milestones = scoped(MilestoneViewSet).filter(due_date__range=(start, end))
    changes = (
        scoped(PlannedChangeViewSet)
        .filter(state=PlannedChangeState.PLANNED)
        .select_related("task")
    )
    if board:
        tasks = tasks.filter(board_id=board)
        milestones = milestones.filter(board_id=board)
        changes = changes.filter(task__board_id=board)

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "tasks": [_task_entry(t) for t in tasks.distinct()],
        "milestones": [_milestone_entry(m) for m in milestones],
        "changes": _change_entries(changes, start, end),
        "events": _event_entries(request, start, end),
    }


def _task_entry(task: Task) -> dict:
    return {
        "id": str(task.id),
        "board": str(task.board_id),
        "board_name": task.board.name,
        "title": task.title,
        "status_name": task.status.name if task.status_id else "",
        "status_color": task.status.color if task.status_id else "",
        "semantic_group": task.status.semantic_group if task.status_id else "",
        "priority": task.priority,
        "start_date": task.start_date.isoformat() if task.start_date else None,
        "due_date": task.due_date.isoformat() if task.due_date else None,
        "milestone": str(task.milestone_id) if task.milestone_id else None,
        "assignees": [u.username for u in task.assignees.all()],
    }


def _milestone_entry(milestone: Milestone) -> dict:
    return {
        "id": str(milestone.id),
        "board": str(milestone.board_id),
        "board_name": milestone.board.name,
        "name": milestone.name,
        "color": milestone.color,
        "due_date": milestone.due_date.isoformat() if milestone.due_date else None,
    }


def _change_entries(queryset, start: date, end: date) -> list[dict]:
    """Planned changes land on their effective date, which is the change's own
    ``planned_for`` or — when it has none — the task's due date. That fallback
    is a Python property rather than a column, so the window is applied here on
    a deliberately narrow pre-filter."""
    horizon = (start - timedelta(days=1), end + timedelta(days=1))
    candidates = queryset.filter(
        Q(planned_for__range=horizon) | Q(task__due_date__range=horizon)
    )
    out = []
    for change in candidates:
        effective = change.effective_date
        if effective is None or not (start <= effective <= end):
            continue
        out.append(
            {
                "id": str(change.id),
                "task": str(change.task_id),
                "task_title": change.task.title,
                "board": str(change.task.board_id),
                "kind": change.kind,
                "object_type": change.object_type,
                "object_id": str(change.object_id) if change.object_id else None,
                "fields": [d.get("label") or d.get("field") for d in change.display or []],
                "effective_date": effective.isoformat(),
            }
        )
    return out


def _event_entries(request, start: date, end: date) -> list[dict]:
    """Maintenance/outage windows overlapping the window — read through the
    maintenance viewset's queryset so its tenant scoping applies unchanged."""
    from monitoring.maintenance_api import MaintenanceEventViewSet

    viewset = MaintenanceEventViewSet()
    viewset.request = request
    viewset.format_kwarg = None
    viewset.action = "list"
    events = viewset.get_queryset().filter(
        Q(starts_at__date__lte=end)
        & (Q(ends_at__date__gte=start) | Q(ends_at__isnull=True))
    )
    out = []
    for e in events:
        out.append(
            {
                "id": str(e.id),
                "kind": e.kind,
                "status_name": e.status.name,
                "status_color": e.status.color,
                "name": e.name,
                "provider_name": e.provider.name if e.provider_id else "",
                "starts_at": e.starts_at.isoformat(),
                "ends_at": e.ends_at.isoformat() if e.ends_at else None,
                "etr": e.etr.isoformat() if e.etr else None,
                "is_open": e.is_open,
                "impact_count": e.impacts.count(),
            }
        )
    return out
