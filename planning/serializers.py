"""Planning serializers — boards, statuses, labels, tasks and generic links."""
from __future__ import annotations

from rest_framework import serializers

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


class BoardSerializer(serializers.ModelSerializer):
    task_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Board
        fields = [
            "id", "name", "slug", "description", "task_count",
            "created_at", "updated_at",
        ]
        read_only_fields = ["created_at", "updated_at"]


class TaskStatusSerializer(serializers.ModelSerializer):
    class Meta:
        model = TaskStatus
        fields = [
            "id", "board", "name", "semantic_group", "color", "weight",
            "created_at", "updated_at",
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
        # A link's target is immutable — replace the link, don't retarget it.
        if self.instance is not None:
            for field in ("object_type", "object_id", "task"):
                if field in attrs and attrs[field] != getattr(self.instance, field):
                    raise serializers.ValidationError(
                        {field: "Links cannot be retargeted; delete and re-add."}
                    )
        return attrs


class PlannedChangeSerializer(serializers.ModelSerializer):
    """A planned field change. ``current_*`` and ``*_display`` are captured
    server-side at plan time — a client may not assert what the old value was."""

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
            "id", "task", "object_type", "object_id", "field",
            "new_value", "new_display", "current_value", "current_display",
            "planned_for", "effective_date", "state", "note", "stale",
            "created_by", "created_by_username",
            "applied_at", "applied_by", "applied_by_username",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "new_display", "current_value", "current_display", "state",
            "created_by", "applied_at", "applied_by", "created_at", "updated_at",
        ]
        # DRF derives a UniqueTogetherValidator from the model's partial unique
        # constraint, which then demands `state` in the payload — but `state` is
        # read-only, so every write 500'd with KeyError. The viewset checks for
        # an existing open plan explicitly (clearer message), and the DB
        # constraint remains the backstop.
        validators = []

    def get_stale(self, obj) -> bool:
        """Has the target's live value moved since this was planned?

        Computed, never stored: a column would need a writer, and the only
        honest writer is a hook on every save of every audited model. Apply
        re-checks this synchronously and refuses with a 409, which is stronger
        than a flag that can go out of date."""
        if obj.state != PlannedChangeState.PLANNED:
            return False
        from .planned_changes import _MISSING, live_value_for

        live = live_value_for(obj)
        return live is not _MISSING and live != obj.current_value

    def validate_object_type(self, value):
        from auth_api.object_types import label_for

        label = label_for(value)
        if label is None:
            raise serializers.ValidationError("Unknown object type.")
        return label

    def validate(self, attrs):
        # The target and the field are immutable: retargeting would move the
        # plan onto an object the caller was never checked against, and an
        # applied/cancelled row is history.
        if self.instance is not None:
            if self.instance.state != PlannedChangeState.PLANNED:
                raise serializers.ValidationError(
                    "This change is no longer open; it can't be edited."
                )
            for field in ("task", "object_type", "object_id", "field"):
                if field in attrs and attrs[field] != getattr(self.instance, field):
                    raise serializers.ValidationError({
                        field: "A planned change can't be retargeted; "
                               "delete it and plan a new one.",
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
    label_detail = TaskLabelSerializer(source="labels", many=True, read_only=True)
    links = TaskLinkSerializer(many=True, read_only=True)
    planned_changes = PlannedChangeSerializer(many=True, read_only=True)

    class Meta:
        model = Task
        fields = [
            "id", "board", "board_name", "status", "status_name", "title",
            "description", "priority", "assignees", "assignee_detail",
            "labels", "label_detail", "milestone", "milestone_name",
            "milestone_due", "start_date", "due_date", "weight",
            "links", "planned_changes",
            "created_by", "created_at", "updated_at",
        ]
        read_only_fields = ["created_by", "created_at", "updated_at"]

    def validate(self, attrs):
        # The status must belong to the task's board — both on create and when
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
        return attrs
