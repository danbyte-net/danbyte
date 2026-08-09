"""Planning API — boards, statuses, labels, tasks, links.

Everything is tenant-scoped + RBAC-gated through :class:`TenantScopedViewSet`.
TaskLink writes are additionally gated on *view access to the target object*
(the Document rule): a link is attacker-set ``object_type``+``object_id`` until
proven otherwise, so creation runs the exact row through the caller's RBAC and
retargeting is rejected outright.
"""
from __future__ import annotations

from django.db.models import Count, ProtectedError, Q
from rest_framework.exceptions import PermissionDenied, ValidationError

from api.viewsets import TenantScopedViewSet

from .models import (
    Board,
    Milestone,
    Task,
    TaskLabel,
    TaskLink,
    TaskStatus,
    seed_default_statuses,
)
from .serializers import (
    BoardSerializer,
    MilestoneSerializer,
    TaskLabelSerializer,
    TaskLinkSerializer,
    TaskSerializer,
    TaskStatusSerializer,
)


class BoardViewSet(TenantScopedViewSet):
    queryset = Board.objects.all().order_by("name")
    serializer_class = BoardSerializer

    def get_queryset(self):
        return super().get_queryset().annotate(task_count=Count("tasks"))

    def perform_create(self, serializer):
        super().perform_create(serializer)
        board = serializer.instance
        board.created_by = self.request.user
        board.save(update_fields=["created_by"])
        # Required bootstrap: four deterministic, fully-editable statuses so a
        # fresh board is immediately usable. Never demo data.
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
        Task.objects.select_related("board", "status", "milestone")
        .prefetch_related("assignees", "labels", "links")
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
            qs = qs.filter(assignees__id=p["assignee"])
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
