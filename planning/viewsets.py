"""Planning API — boards, statuses, labels, tasks, links.

Everything is tenant-scoped + RBAC-gated through :class:`TenantScopedViewSet`.
TaskLink writes are additionally gated on *view access to the target object*
(the Document rule): a link is attacker-set ``object_type``+``object_id`` until
proven otherwise, so creation runs the exact row through the caller's RBAC and
retargeting is rejected outright.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Count, ProtectedError, Q
from rest_framework import permissions
from rest_framework import status as drf_status
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from api.views import _get_active_tenant
from api.viewsets import TenantScopedViewSet
from auth_api import rbac
from auth_api.permissions import can_manage_deployment

from .models import (
    Board,
    Milestone,
    PlannedChange,
    PlannedChangeKind,
    PlannedChangeState,
    Task,
    TaskLabel,
    TaskLink,
    TaskStatus,
    seed_default_statuses,
)
from .serializers import (
    BoardSerializer,
    MilestoneSerializer,
    PlannedChangeSerializer,
    TaskLabelSerializer,
    TaskLinkSerializer,
    TaskSerializer,
    TaskStatusSerializer,
)


class BoardViewSet(TenantScopedViewSet):
    queryset = Board.objects.all().order_by("name")
    serializer_class = BoardSerializer

    def get_queryset(self):
        return (
            super()
            .get_queryset()
            .prefetch_related("tags")
            .annotate(task_count=Count("tasks"))
        )

    def perform_create(self, serializer):
        super().perform_create(serializer)
        board = serializer.instance
        board.created_by = self.request.user
        board.save(update_fields=["created_by"])
        # Columns the user flagged "is_default" become the template for new
        # boards (deduplicated by name, keeping the lightest). Without any,
        # fall back to the required bootstrap four so a fresh board is
        # immediately usable. Never demo data.
        templates = TaskStatus.objects.filter(
            tenant=board.tenant, is_default=True
        ).order_by("weight", "name")
        seen: set[str] = set()
        copied = False
        for t in templates:
            key = t.name.strip().lower()
            if not key or key in seen:
                continue
            seen.add(key)
            TaskStatus.objects.create(
                tenant=board.tenant, board=board, name=t.name,
                semantic_group=t.semantic_group, color=t.color,
                weight=t.weight, is_default=False,
            )
            copied = True
        if not copied:
            seed_default_statuses(board)


class TaskStatusViewSet(TenantScopedViewSet):
    queryset = TaskStatus.objects.select_related("board").order_by("weight", "name")
    serializer_class = TaskStatusSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        board = self.request.query_params.get("board")
        if board:
            qs = qs.filter(board_id=board)
        return qs

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        board = serializer.validated_data.get("board")
        if board is None or board.tenant_id != tenant.id:
            raise ValidationError({"board": "Board is not in this tenant."})
        serializer.save(tenant=tenant)

    def perform_destroy(self, instance):
        try:
            instance.delete()
        except ProtectedError:
            raise ValidationError(
                {"detail": "This status still has tasks — move them first."}
            ) from None


class MilestoneViewSet(TenantScopedViewSet):
    queryset = Milestone.objects.select_related("board").order_by(
        "weight", "due_date", "name"
    )
    serializer_class = MilestoneSerializer

    def get_queryset(self):
        qs = super().get_queryset().annotate(task_count=Count("tasks"))
        board = self.request.query_params.get("board")
        if board:
            qs = qs.filter(board_id=board)
        return qs

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        board = serializer.validated_data.get("board")
        if board is None or board.tenant_id != tenant.id:
            raise ValidationError({"board": "Board is not in this tenant."})
        serializer.save(tenant=tenant)


class TaskLabelViewSet(TenantScopedViewSet):
    queryset = TaskLabel.objects.all().order_by("weight", "name")
    serializer_class = TaskLabelSerializer


class TaskViewSet(TenantScopedViewSet):
    queryset = (
        Task.objects.select_related("board", "status", "milestone", "assigned_group")
        .prefetch_related("assignees", "labels", "links", "planned_changes")
        .order_by("weight", "created_at")
    )
    serializer_class = TaskSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("board"):
            qs = qs.filter(board_id=p["board"])
        if p.get("status"):
            qs = qs.filter(status_id=p["status"])
        if p.get("assignee"):
            # "me" so a dashboard widget needs no user id — and no user.view.
            # "My work" includes the team queue: tasks assigned to one of my
            # groups that nobody has picked up yet.
            if p["assignee"] == "me":
                qs = qs.filter(
                    Q(assignees=self.request.user)
                    | Q(
                        assigned_group__in=self.request.user.groups.all(),
                        assignees__isnull=True,
                    )
                )
            else:
                qs = qs.filter(assignees__id=p["assignee"])
        if p.get("open") == "1":
            # Open = the status row's semantics, not its name: "Completed" and
            # "Cancelled" count as closed whatever a board renamed them to.
            qs = qs.exclude(
                status__semantic_group__in=["completed", "cancelled"]
            )
        if p.get("label"):
            qs = qs.filter(labels__id=p["label"])
        if p.get("milestone"):
            qs = qs.filter(milestone_id=p["milestone"])
        if p.get("q"):
            qs = qs.filter(
                Q(title__icontains=p["q"]) | Q(description__icontains=p["q"])
            )
        return qs.distinct()

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        board = serializer.validated_data.get("board")
        if board is None or board.tenant_id != tenant.id:
            raise ValidationError({"board": "Board is not in this tenant."})
        serializer.save(tenant=tenant, created_by=self.request.user)
        self._notify_assignment_changes(serializer.instance, set(), None)

    def perform_update(self, serializer):
        before_users = set(serializer.instance.assignees.values_list("pk", flat=True))
        before_group = serializer.instance.assigned_group_id
        super().perform_update(serializer)
        self._notify_assignment_changes(
            serializer.instance, before_users, before_group
        )

    def _notify_assignment_changes(self, task, before_users, before_group):
        """Personal emails for what this write changed: users newly put on the
        task, and a team the task was newly queued on."""
        from . import notifications

        actor_id = self.request.user.pk
        added = set(task.assignees.values_list("pk", flat=True)) - before_users
        if added:
            notifications.enqueue(
                notifications.send_assigned, str(task.pk), sorted(added), actor_id
            )
        if task.assigned_group_id and task.assigned_group_id != before_group:
            notifications.enqueue(
                notifications.send_queued,
                str(task.pk), task.assigned_group_id, actor_id,
            )


class TaskLinkViewSet(TenantScopedViewSet):
    queryset = TaskLink.objects.select_related("task").order_by("created_at")
    serializer_class = TaskLinkSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("task"):
            qs = qs.filter(task_id=p["task"])
        # Reverse lookup: "which tasks reference this object?" — powers
        # related-tasks panels on inventory detail pages.
        if p.get("object_type") and p.get("object_id"):
            from auth_api.object_types import label_for

            label = label_for(p["object_type"])
            if label is None:
                return qs.none()
            qs = qs.filter(object_type=label, object_id=p["object_id"])
        return qs

    def perform_create(self, serializer):
        # Only link objects the caller can actually view (fails closed).
        from audit.api import _can_view_object, _object_site_id

        tenant = self._tenant_or_403()
        task = serializer.validated_data.get("task")
        if task is None or task.tenant_id != tenant.id:
            raise ValidationError({"task": "Task is not in this tenant."})
        otype = serializer.validated_data.get("object_type")
        oid = serializer.validated_data.get("object_id")
        if not _can_view_object(self.request, otype, str(oid)):
            raise PermissionDenied(
                "You can't link an object you can't view."
            )
        serializer.save(
            tenant=tenant, object_site_id=_object_site_id(otype, str(oid))
        )


class PlannedChangeViewSet(TenantScopedViewSet):
    """Planned field changes on inventory objects.

    Planning requires **view** on the target; applying requires **change** on
    it. An engineer describing a desired change is the workflow — they could
    already write it in the task description — so the gate that matters is the
    one on the write. Nothing here schedules or auto-applies.
    """

    queryset = PlannedChange.objects.select_related("task").order_by(
        "planned_for", "created_at"
    )
    serializer_class = PlannedChangeSerializer
    rbac_action_map = {"apply": "change", "cancel": "change", "map": "view"}

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("task"):
            qs = qs.filter(task_id=p["task"])
        if p.get("state"):
            qs = qs.filter(state=p["state"])
        # Reverse lookup: "what's planned for this object?"
        if p.get("object_type") and p.get("object_id"):
            from auth_api.object_types import label_for

            label = label_for(p["object_type"])
            if label is None:
                return qs.none()
            qs = qs.filter(object_type=label, object_id=p["object_id"])
        return qs

    def perform_create(self, serializer):
        """Stage a change set from a submitted form payload.

        The payload is the form's *complete* write body. We validate it through
        the target's own serializer — so a plan is held to the same rules a real
        write would be — then keep only the keys that actually differ.
        """
        from audit.api import _can_view_object, _object_site_id

        from .diffing import (
            describe_create,
            diff_update,
            strip_secrets,
            validate_payload,
        )
        from .planned_changes import model_for_label

        tenant = self._tenant_or_403()
        data = serializer.validated_data
        task = data.get("task")
        if task is None or task.tenant_id != tenant.id:
            raise ValidationError({"task": "Task is not in this tenant."})

        otype = data.get("object_type")
        model = model_for_label(otype)
        if model is None:
            raise ValidationError({"object_type": "Unknown object type."})
        payload = data.get("payload")
        if not isinstance(payload, dict) or not payload:
            raise ValidationError({"payload": "Provide the form's field values."})

        kind = data.get("kind") or PlannedChangeKind.UPDATE
        if kind == PlannedChangeKind.CREATE:
            validate_payload(model, payload, request=self.request)
            # Validated in full, stored without secrets — a plan is readable by
            # everyone who can see the task.
            payload = strip_secrets(model, payload)
            if not payload:
                raise ValidationError(
                    {"payload": "Nothing here can be planned."}
                )
            changed, before = payload, {}
            display = describe_create(model, payload)
            site_id = None
        else:
            oid = data.get("object_id")
            if oid is None:
                raise ValidationError(
                    {"object_id": "An edit needs the object it edits."}
                )
            # Planning requires only *view* — describing desired work is the
            # workflow; the gate that matters is on the apply.
            if not _can_view_object(self.request, otype, str(oid)):
                raise PermissionDenied(
                    "You can't plan a change on an object you can't view."
                )
            obj = model._default_manager.filter(pk=oid).first()
            if obj is None:
                raise ValidationError(
                    {"object_id": "That object no longer exists."}
                )
            validate_payload(model, payload, instance=obj,
                             request=self.request)
            payload = strip_secrets(model, payload)
            changed, before, display = diff_update(obj, payload)
            if not changed:
                raise ValidationError(
                    {"payload": "Nothing changed — no plan was recorded."}
                )
            site_id = _object_site_id(otype, str(oid))

        with transaction.atomic():
            serializer.save(
                tenant=tenant,
                created_by=self.request.user,
                object_site_id=site_id,
                payload=changed,
                before=before,
                display=display,
            )
            if kind != PlannedChangeKind.CREATE:
                # Keep the sheet's two panels honest: an object a task plans a
                # change on is, by definition, an object the task touches.
                TaskLink.objects.get_or_create(
                    task=task, object_type=otype,
                    object_id=data.get("object_id"),
                    defaults={"tenant": tenant, "object_site_id": site_id},
                )

    def perform_destroy(self, instance):
        if instance.state != PlannedChangeState.PLANNED:
            raise ValidationError(
                "Applied and cancelled changes are history — they can't be "
                "deleted."
            )
        instance.delete()

    @action(detail=True, methods=["post"], url_path="apply")
    def apply(self, request, pk=None):
        """Write the planned value into Danbyte's record.

        409 when the live value moved since the plan was written; repeat with
        ``{"force": true}`` to overwrite anyway."""
        from .planned_changes import StaleValue, apply_change

        pc = self.get_object()
        try:
            apply_change(pc, request, force=bool(request.data.get("force")))
        except StaleValue as stale:
            return Response(
                {
                    "detail": str(stale),
                    "stale": True,
                    "stale_fields": stale.keys,
                    "current_display": stale.live_display,
                },
                status=drf_status.HTTP_409_CONFLICT,
            )
        pc.refresh_from_db()
        return Response(self.get_serializer(pc).data)

    @action(detail=True, methods=["post"], url_path="cancel")
    def cancel(self, request, pk=None):
        """Decide not to do it. Writes nothing to the target."""
        pc = self.get_object()
        if pc.state != PlannedChangeState.PLANNED:
            raise ValidationError("This change is no longer open.")
        pc.state = PlannedChangeState.CANCELLED
        pc.save(update_fields=["state", "updated_at"])
        return Response(self.get_serializer(pc).data)

    @action(detail=False, methods=["get"], url_path="map")
    def map(self, request):
        """Every open plan grouped by target, for per-row badges.

        ONE request for a whole table — the indicator is affordable only because
        this never becomes an N+1. ``stale`` is deliberately absent: computing it
        means a live read per distinct model, which is the very thing this
        endpoint exists to avoid.
        """
        qs = self.get_queryset().filter(state=PlannedChangeState.PLANNED)
        qs = qs.select_related("task")
        targets: dict[str, dict] = {}
        for pc in qs:
            key = f"{pc.object_type}:{pc.object_id}"
            row = targets.setdefault(key, {
                "count": 0, "task_ids": set(), "task_id": None,
                "board_id": None, "task_title": "", "next_due": None,
                "samples": [],
            })
            row["count"] += 1
            row["task_ids"].add(str(pc.task_id))
            due = pc.effective_date
            if due is not None and (
                row["next_due"] is None or str(due) < row["next_due"]
            ):
                row["next_due"] = str(due)
            # Link to the earliest-dated task; fall back to the first seen.
            if row["task_id"] is None or (
                due is not None and str(due) == row["next_due"]
            ):
                row["task_id"] = str(pc.task_id)
                row["board_id"] = str(pc.task.board_id)
                row["task_title"] = pc.task.title
            for d in pc.display or []:
                if len(row["samples"]) >= 3:
                    break
                row["samples"].append({
                    "field": d.get("label") or d.get("field"),
                    "from": d.get("from", ""),
                    "to": d.get("to", ""),
                })
        for row in targets.values():
            row["tasks"] = len(row.pop("task_ids"))
        return Response({"targets": targets})


@api_view(["GET"])
@permission_classes([permissions.IsAuthenticated])
def assignable_users(request):
    """Who can be assigned a task in the active tenant.

    Deliberately NOT ``/api/users/``: that endpoint is gated on ``user.view``,
    so a NOC engineer with full task rights but no user-administration grant got
    a 403 and an empty assignee picker — assignment was effectively
    admin-only. Being able to *change tasks* is the right gate for "show me who
    to assign", and the payload is narrowed to match: id, username and display
    name for members of this tenant only.

    Email is included only for callers who may already read users, since it is
    personal data the task board has no need for.
    """
    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")
    if not (
        rbac.has_action(request.user, tenant, "task", "change")
        or rbac.has_action(request.user, tenant, "task", "add")
    ):
        raise PermissionDenied("task:change required.")

    User = get_user_model()
    qs = User.objects.filter(is_active=True)
    # Superusers and deployment admins operate across tenants; everyone else
    # sees only users who are members of this tenant.
    if not (request.user.is_superuser or can_manage_deployment(request.user)):
        qs = qs.filter(profile__tenants=tenant).distinct()
    search = (request.query_params.get("search") or "").strip()
    if search:
        qs = qs.filter(
            Q(username__icontains=search)
            | Q(first_name__icontains=search)
            | Q(last_name__icontains=search)
        )
    with_email = rbac.has_action(request.user, tenant, "user", "view")
    rows = []
    for u in qs.order_by("username")[:200]:
        full = f"{u.first_name} {u.last_name}".strip()
        rows.append({
            "id": u.id,
            "username": u.username,
            "display_name": full or u.username,
            "email": u.email if with_email else "",
        })
    return Response({"results": rows})


@api_view(["GET"])
@permission_classes([permissions.IsAuthenticated])
def assignable_groups(request):
    """Teams a task can be queued on — every access group with members.

    Same gate as ``assignable_users``: having task rights is what earns the
    picker, not user administration. The payload is name + member count only.
    """
    from django.contrib.auth.models import Group
    from django.db.models import Count

    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")
    if not (
        rbac.has_action(request.user, tenant, "task", "change")
        or rbac.has_action(request.user, tenant, "task", "add")
    ):
        raise PermissionDenied("task:change required.")

    rows = [
        {"id": g.id, "name": g.name, "member_count": g.n}
        for g in Group.objects.annotate(n=Count("user")).order_by("name")[:200]
    ]
    return Response({"results": rows})
