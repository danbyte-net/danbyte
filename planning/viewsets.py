"""Planning API — boards, statuses, labels, tasks, links.

Everything is tenant-scoped + RBAC-gated through :class:`TenantScopedViewSet`.
TaskLink writes are additionally gated on *view access to the target object*
(the Document rule): a link is attacker-set ``object_type``+``object_id`` until
proven otherwise, so creation runs the exact row through the caller's RBAC and
retargeting is rejected outright.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db.models import Count, ProtectedError, Q
from rest_framework import permissions
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from api.views import _get_active_tenant
from api.viewsets import TenantScopedViewSet
from auth_api import rbac
from auth_api.permissions import can_manage_deployment

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
