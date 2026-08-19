"""Planning serializers - boards, statuses, labels, tasks and generic links."""
from __future__ import annotations

from rest_framework import serializers

from api.serializers import (
    TagSerializer,
    TaggableSerializerMixin,
    TenantScopedPrimaryKeyRelatedField,
)
from core.models import Tag
from .models import (
    Board,
    Milestone,
    PlannedChange,
    PlannedChangeState,
    Task,
    TaskLabel,
    TaskLink,
    TaskStatus,
)


class BoardSerializer(TaggableSerializerMixin, serializers.ModelSerializer):
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )
    task_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Board
        fields = [
            "id", "name", "slug", "description", "task_count",
            "tags", "tag_ids",
            "created_at", "updated_at",
        ]
        read_only_fields = ["created_at", "updated_at"]


class TaskStatusSerializer(serializers.ModelSerializer):
    class Meta:
        model = TaskStatus
        fields = [
            "id", "board", "name", "semantic_group", "color", "weight",
            "is_default", "created_at", "updated_at",
        ]
        read_only_fields = ["created_at", "updated_at"]


class TaskLabelSerializer(serializers.ModelSerializer):
    class Meta:
        model = TaskLabel
        fields = ["id", "name", "color", "weight", "created_at", "updated_at"]
        read_only_fields = ["created_at", "updated_at"]


class MilestoneSerializer(serializers.ModelSerializer):
    task_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Milestone
        fields = [
            "id", "board", "name", "due_date", "color", "weight", "task_count",
            "created_at", "updated_at",
        ]
        read_only_fields = ["created_at", "updated_at"]


class TaskAssigneeSerializer(serializers.Serializer):
    """Read-shape for an assignee: enough for an avatar chip."""

    id = serializers.IntegerField()
    username = serializers.CharField()
    email = serializers.EmailField(allow_blank=True)


class TaskLinkSerializer(serializers.ModelSerializer):
    class Meta:
        model = TaskLink
        fields = [
            "id", "task", "object_type", "object_id", "note",
            "created_at", "updated_at",
        ]
        read_only_fields = ["created_at", "updated_at"]

    def validate_object_type(self, value):
        # Normalise to the "app.model" label the view-permission gate expects;
        # reject anything not in the RBAC registry (same rule as Document).
        from auth_api.object_types import label_for

        label = label_for(value)
        if label is None:
            raise serializers.ValidationError("Unknown object type.")
        return label

    def validate(self, attrs):
        # A link's target is immutable - replace the link, don't retarget it.
        if self.instance is not None:
            for field in ("object_type", "object_id", "task"):
                if field in attrs and attrs[field] != getattr(self.instance, field):
                    raise serializers.ValidationError(
                        {field: "Links cannot be retargeted; delete and re-add."}
                    )
        return attrs


class PlannedChangeSerializer(serializers.ModelSerializer):
    """A staged change set. ``payload`` arrives as the *complete* form payload;
    the viewset diffs it against the live object and stores only what differs, so
    ``before``/``display`` are server-computed and never client-asserted."""

    effective_date = serializers.DateField(read_only=True)
    stale = serializers.SerializerMethodField()
    applied_by_username = serializers.CharField(
        source="applied_by.username", read_only=True, default=None
    )
    created_by_username = serializers.CharField(
        source="created_by.username", read_only=True, default=None
    )

    class Meta:
        model = PlannedChange
        fields = [
            "id", "task", "kind", "object_type", "object_id",
            "payload", "before", "display", "created_object_id",
            "planned_for", "effective_date", "state", "note", "stale",
            "created_by", "created_by_username",
            "applied_at", "applied_by", "applied_by_username",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "before", "display", "created_object_id", "state", "created_by",
            "applied_at", "applied_by", "created_at", "updated_at",
        ]

    def get_stale(self, obj) -> bool:
        from .planned_changes import is_stale

        return is_stale(obj)

    def validate_object_type(self, value):
        from auth_api.object_types import label_for

        label = label_for(value)
        if label is None:
            raise serializers.ValidationError("Unknown object type.")
        return label

    def validate(self, attrs):
        # The target and the kind are immutable: retargeting would move the plan
        # onto an object the caller was never checked against, and an
        # applied/cancelled row is history. Editing a staged change means
        # re-opening the form, which replaces the row.
        if self.instance is not None:
            if self.instance.state != PlannedChangeState.PLANNED:
                raise serializers.ValidationError(
                    "This change is no longer open; it can't be edited."
                )
            for field in ("task", "kind", "object_type", "object_id", "payload"):
                if field in attrs and attrs[field] != getattr(self.instance, field):
                    raise serializers.ValidationError({
                        field: "A planned change can't be retargeted or "
                               "rewritten; delete it and plan again.",
                    })
        return attrs


class TaskSerializer(serializers.ModelSerializer):
    status_name = serializers.CharField(source="status.name", read_only=True)
    board_name = serializers.CharField(source="board.name", read_only=True)
    milestone_name = serializers.CharField(
        source="milestone.name", read_only=True, default=None
    )
    milestone_due = serializers.DateField(
        source="milestone.due_date", read_only=True, default=None
    )
    assignee_detail = TaskAssigneeSerializer(
        source="assignees", many=True, read_only=True
    )
    assigned_group_name = serializers.CharField(
        source="assigned_group.name", read_only=True, default=None
    )
    label_detail = TaskLabelSerializer(source="labels", many=True, read_only=True)
    links = TaskLinkSerializer(many=True, read_only=True)
    planned_changes = PlannedChangeSerializer(many=True, read_only=True)

    class Meta:
        model = Task
        fields = [
            "id", "board", "board_name", "status", "status_name", "title",
            "description", "priority", "assignees", "assignee_detail",
            "assigned_group", "assigned_group_name",
            "labels", "label_detail", "milestone", "milestone_name",
            "milestone_due", "start_date", "start_time",
            "due_date", "due_time", "weight",
            "links", "planned_changes",
            "created_by", "created_at", "updated_at",
        ]
        read_only_fields = ["created_by", "created_at", "updated_at"]

    def validate(self, attrs):
        # The status must belong to the task's board - both on create and when
        # either side changes.
        board = attrs.get("board", getattr(self.instance, "board", None))
        status = attrs.get("status", getattr(self.instance, "status", None))
        if board is not None and status is not None and status.board_id != board.id:
            raise serializers.ValidationError(
                {"status": "Status belongs to a different board."}
            )
        milestone = attrs.get("milestone", getattr(self.instance, "milestone", None))
        if (
            board is not None
            and milestone is not None
            and milestone.board_id != board.id
        ):
            raise serializers.ValidationError(
                {"milestone": "Milestone belongs to a different board."}
            )
        start = attrs.get("start_date", getattr(self.instance, "start_date", None))
        due = attrs.get("due_date", getattr(self.instance, "due_date", None))
        if start and due and due < start:
            raise serializers.ValidationError(
                {"due_date": "Due date is before the start date."}
            )
        for tfield, dval in (("start_time", start), ("due_time", due)):
            tval = attrs.get(tfield, getattr(self.instance, tfield, None))
            if tval and not dval:
                raise serializers.ValidationError(
                    {tfield: "A time needs its date."}
                )
        return attrs
