"""Planning — kanban boards, tasks, and generic links into the inventory.

The board model follows the "status as a row, not an enum" design: each board
owns editable :class:`TaskStatus` rows whose ``semantic_group`` (backlog /
unstarted / started / completed / cancelled) carries the meaning code keys off,
while the row itself (name, colour, order) stays user-editable. Creating a
board seeds four deterministic, fully-editable statuses — required bootstrap,
never demo data.

Tasks attach any Danbyte object through :class:`TaskLink`, which copies the
``Document`` generic-reference pattern (``object_type`` label + ``object_id`` +
denormalised ``object_site_id``) so RBAC and site separation apply the same way
everywhere. Comments reuse ``audit.JournalEntry`` — a task is just another
registered object type.
"""
from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models

from core.models import Tenant, TimestampedModel


class Board(TimestampedModel):
    """A named kanban surface — e.g. "DC migration" or "Daily ops"."""

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
# and deletable afterwards — the seed exists so a fresh board is usable, not to
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
    """A named target on a board — "Rack A cutover", "Q3 audit" — that tasks
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
    """A card on a board. Dates are optional — a dated task also appears on the
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
    labels = models.ManyToManyField(TaskLabel, blank=True, related_name="tasks")
    milestone = models.ForeignKey(
        Milestone, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="tasks",
    )
    start_date = models.DateField(null=True, blank=True)
    due_date = models.DateField(null=True, blank=True)
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
    """A generic reference from a task to any registered Danbyte object —
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


def seed_default_statuses(board: Board) -> None:
    """Create the four bootstrap statuses for a new board. Deterministic and
    idempotent — safe to call twice; existing names are left alone."""
    for name, group, color, weight in DEFAULT_STATUSES:
        TaskStatus.objects.get_or_create(
            board=board, name=name,
            defaults={
                "tenant": board.tenant, "semantic_group": group,
                "color": color, "weight": weight,
            },
        )
