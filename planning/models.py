"""Planning - kanban boards, tasks, and generic links into the inventory.

The board model follows the "status as a row, not an enum" design: each board
owns editable :class:`TaskStatus` rows whose ``semantic_group`` (backlog /
unstarted / started / completed / cancelled) carries the meaning code keys off,
while the row itself (name, colour, order) stays user-editable. Creating a
board seeds four deterministic, fully-editable statuses - required bootstrap,
never demo data.

Tasks attach any Danbyte object through :class:`TaskLink`, which copies the
``Document`` generic-reference pattern (``object_type`` label + ``object_id`` +
denormalised ``object_site_id``) so RBAC and site separation apply the same way
everywhere. Comments reuse ``audit.JournalEntry`` - a task is just another
registered object type.
"""
from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models

from core.models import Tenant, TimestampedModel, TaggableMixin


class Board(TaggableMixin, TimestampedModel):
    """A named kanban surface - e.g. "DC migration" or "Daily ops"."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="planning_boards"
    )
    name = models.CharField(max_length=120)
    slug = models.SlugField(max_length=120)
    description = models.TextField(blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_board_slug_per_tenant"
            ),
        ]

    def __str__(self) -> str:
        return self.name


class SemanticGroup(models.TextChoices):
    BACKLOG = "backlog", "Backlog"
    UNSTARTED = "unstarted", "Unstarted"
    STARTED = "started", "Started"
    COMPLETED = "completed", "Completed"
    CANCELLED = "cancelled", "Cancelled"


# The deterministic bootstrap statuses every new board starts with. Editable
# and deletable afterwards - the seed exists so a fresh board is usable, not to
# impose a workflow.
DEFAULT_STATUSES = [
    ("Backlog", SemanticGroup.BACKLOG, "#a1a1aa", 100),
    ("To do", SemanticGroup.UNSTARTED, "#3b82f6", 200),
    ("In progress", SemanticGroup.STARTED, "#f59e0b", 300),
    ("Done", SemanticGroup.COMPLETED, "#10b981", 400),
]


class TaskStatus(TimestampedModel):
    """A board column. ``semantic_group`` carries the immutable meaning (is it
    "done"?); everything visible is user-editable."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="planning_statuses"
    )
    board = models.ForeignKey(
        Board, on_delete=models.CASCADE, related_name="statuses"
    )
    name = models.CharField(max_length=64)
    semantic_group = models.CharField(
        max_length=12, choices=SemanticGroup.choices,
        default=SemanticGroup.UNSTARTED,
    )
    color = models.CharField(max_length=7, blank=True, default="")
    weight = models.PositiveIntegerField(
        default=100, help_text="Lower weights order columns left to right."
    )
    is_default = models.BooleanField(
        default=False,
        help_text="Copy this column onto newly created boards (instead of the "
        "built-in four). Deduplicated by name across boards.",
    )

    class Meta:
        ordering = ["weight", "name"]
        verbose_name_plural = "task statuses"
        constraints = [
            models.UniqueConstraint(
                fields=["board", "name"], name="uniq_status_name_per_board"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.board_id})"


class TaskLabel(TimestampedModel):
    """A tenant-wide coloured label, shared across boards."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="planning_labels"
    )
    name = models.CharField(max_length=64)
    color = models.CharField(max_length=7, blank=True, default="")
    weight = models.PositiveIntegerField(default=100)

    class Meta:
        ordering = ["weight", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_label_name_per_tenant"
            ),
        ]

    def __str__(self) -> str:
        return self.name


class Milestone(TimestampedModel):
    """A named target on a board - "Rack A cutover", "Q3 audit" - that tasks
    roll up to. Optional due date; surfaces on cards and (phase 2) on the
    planning calendar."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="planning_milestones"
    )
    board = models.ForeignKey(
        Board, on_delete=models.CASCADE, related_name="milestones"
    )
    name = models.CharField(max_length=120)
    due_date = models.DateField(null=True, blank=True)
    color = models.CharField(max_length=7, blank=True, default="")
    weight = models.PositiveIntegerField(default=100)

    class Meta:
        ordering = ["weight", "due_date", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["board", "name"], name="uniq_milestone_name_per_board"
            ),
        ]

    def __str__(self) -> str:
        return self.name


class TaskPriority(models.TextChoices):
    NONE = "none", "None"
    LOW = "low", "Low"
    MEDIUM = "medium", "Medium"
    HIGH = "high", "High"
    URGENT = "urgent", "Urgent"


class Task(TimestampedModel):
    """A card on a board. Dates are optional - a dated task also appears on the
    planning calendar (phase 2)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="planning_tasks"
    )
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name="tasks")
    status = models.ForeignKey(
        TaskStatus, on_delete=models.PROTECT, related_name="tasks"
    )
    title = models.CharField(max_length=255)
    description = models.TextField(
        blank=True, default="",
        help_text="Markdown subset (headings, lists, code, links).",
    )
    priority = models.CharField(
        max_length=8, choices=TaskPriority.choices, default=TaskPriority.NONE
    )
    assignees = models.ManyToManyField(
        settings.AUTH_USER_MODEL, blank=True, related_name="planning_tasks"
    )
    #: The owning team queue (ITSM "assignment group"): the box the work sits
    #: in, while ``assignees`` are the individuals actually doing it. Members
    #: get a heads-up when a task lands in their queue.
    assigned_group = models.ForeignKey(
        "auth.Group", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="planning_tasks",
    )
    labels = models.ManyToManyField(TaskLabel, blank=True, related_name="tasks")
    milestone = models.ForeignKey(
        Milestone, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="tasks",
    )
    start_date = models.DateField(null=True, blank=True)
    #: Optional refinements: a task stays date-scheduled (reminders, digest,
    #: month view all reason in days); a time only sharpens where the hour
    #: grid draws it. Meaningless without the matching date.
    start_time = models.TimeField(null=True, blank=True)
    due_date = models.DateField(null=True, blank=True)
    due_time = models.TimeField(null=True, blank=True)
    weight = models.PositiveIntegerField(
        default=100, help_text="Ordering within the status column."
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="created_planning_tasks",
    )

    class Meta:
        ordering = ["weight", "created_at"]
        indexes = [
            models.Index(fields=["board", "status", "weight"]),
            models.Index(fields=["tenant", "due_date"]),
        ]

    def __str__(self) -> str:
        return self.title


class TaskLink(TimestampedModel):
    """A generic reference from a task to any registered Danbyte object -
    the Document pattern: label + id + denormalised site for separation."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="planning_task_links"
    )
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="links")
    object_type = models.CharField(
        max_length=64, help_text="Model label, e.g. api.device."
    )
    object_id = models.UUIDField()
    object_site_id = models.UUIDField(null=True, blank=True, db_index=True)
    note = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["task", "object_type", "object_id"],
                name="uniq_link_per_task_object",
            ),
        ]
        indexes = [models.Index(fields=["object_type", "object_id"])]

    def __str__(self) -> str:
        return f"{self.task_id} → {self.object_type}:{self.object_id}"


class PlannedChangeState(models.TextChoices):
    PLANNED = "planned", "Planned"
    APPLIED = "applied", "Applied"
    CANCELLED = "cancelled", "Cancelled"


class PlannedChangeKind(models.TextChoices):
    UPDATE = "update", "Edit an object"
    CREATE = "create", "Create an object"


class PlannedChange(TimestampedModel):
    """A change a task says it will make to the inventory - one saved edit.

    Planning *is* editing: the operator opens the object's own edit form, changes
    whatever they want, and saves. Nothing is written; the fields that actually
    differ land here as a change set. "Create" works the same way through the
    object's create form. When the work is done an operator **applies** it and
    Danbyte writes the values through the target's normal serializer.

    Applying updates *Danbyte's* record - pushing configuration to hardware is
    the separate automation/deploy path. Nothing applies itself: a plan is
    documentation until a human confirms the work happened, so there is no
    scheduler here.

    ``payload`` is write-shaped (the same keys the API accepts) and, for an
    update, holds **only the keys that differ** - the server diffs the submitted
    form against the live object so no diff logic is duplicated per form.
    ``before`` snapshots just those keys, which drives both the displayed diff
    and the staleness check at apply time. ``display`` is rendered at plan time
    so the task still reads "Status: Active → Decommissioning" after the
    referenced Status row is renamed or deleted - the same denormalisation
    rationale as ``object_site_id``.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="planning_planned_changes"
    )
    task = models.ForeignKey(
        Task, on_delete=models.CASCADE, related_name="planned_changes"
    )

    kind = models.CharField(
        max_length=6, choices=PlannedChangeKind.choices,
        default=PlannedChangeKind.UPDATE,
    )
    # Generic reference - the Document/TaskLink triple. For a create this names
    # the model to create and object_id is empty until it is applied.
    object_type = models.CharField(
        max_length=64, help_text="Model label, e.g. api.interface."
    )
    object_id = models.UUIDField(null=True, blank=True)
    object_site_id = models.UUIDField(null=True, blank=True, db_index=True)

    payload = models.JSONField(
        default=dict,
        help_text="Write-shaped fields. For an edit, only what differs.",
    )
    before = models.JSONField(
        default=dict, blank=True,
        help_text="The live values of payload's keys when this was planned.",
    )
    display = models.JSONField(
        default=list, blank=True,
        help_text="[{field, label, from, to}] rendered at plan time.",
    )
    # Stamped when a create is applied, so the plan points at what it made.
    created_object_id = models.UUIDField(null=True, blank=True)

    # Optional per-change implementation date. One task often changes several
    # things on different days ("Friday disable the port, Monday decommission
    # the device"), and the target's badge needs *that* object's date. Null
    # falls back to the task's due date - see `effective_date`.
    planned_for = models.DateField(null=True, blank=True)

    state = models.CharField(
        max_length=9, choices=PlannedChangeState.choices,
        default=PlannedChangeState.PLANNED,
    )
    note = models.CharField(max_length=255, blank=True, default="")

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True,
        blank=True, related_name="+",
    )
    applied_at = models.DateTimeField(null=True, blank=True)
    applied_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True,
        blank=True, related_name="+",
    )

    class Meta:
        ordering = ["planned_for", "created_at"]
        # No uniqueness: a task may legitimately stage several edits to one
        # object (and two tasks may propose the same change - the badge's count
        # says more about that than a 400 would).
        indexes = [
            # The badge's reverse lookup only ever asks about open plans.
            models.Index(
                fields=["object_type", "object_id"],
                condition=models.Q(state="planned"),
                name="idx_pchange_open_target",
            ),
            models.Index(fields=["object_type", "object_id"],
                         name="idx_pchange_target"),
            models.Index(fields=["tenant", "state"],
                         name="idx_pchange_tenant_state"),
            models.Index(fields=["task", "state"], name="idx_pchange_task_state"),
        ]

    def __str__(self) -> str:
        what = ", ".join(str(d.get("label") or d.get("field")) for d in self.display)
        if self.kind == PlannedChangeKind.CREATE:
            return f"new {self.object_type}: {what}"
        return f"{self.object_type}:{self.object_id} {what}"

    @property
    def effective_date(self):
        """When this change is expected to land: its own date, else the task's
        due date. What the target's badge counts down to."""
        return self.planned_for or self.task.due_date


def seed_default_statuses(board: Board) -> None:
    """Create the four bootstrap statuses for a new board. Deterministic and
    idempotent - safe to call twice; existing names are left alone."""
    for name, group, color, weight in DEFAULT_STATUSES:
        TaskStatus.objects.get_or_create(
            board=board, name=name,
            defaults={
                "tenant": board.tenant, "semantic_group": group,
                "color": color, "weight": weight,
            },
        )
