"""User-authored scripts and their runs (#65).

A :class:`Script` is code plus who may see it, how it is parameterised and
when it runs. A :class:`ScriptRun` is one execution: its log, its exit
code and any files it produced (:class:`ScriptOutput`).

The app is called ``scripting`` rather than ``scripts`` because the repo
root already has a ``scripts/`` directory, which Python resolves as a
namespace package - an app of that name would shadow it.
"""
from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone

from core.models import TimestampedModel

LANGUAGES = [("python", "Python")]

# Who may see a script. Anything beyond `owner` still needs the viewer's
# RBAC `script:view`; sharing only ever narrows further.
VISIBILITY = [
    ("owner", "Only me"),
    ("users", "Chosen users"),
    ("groups", "Chosen groups"),
    ("global", "Everyone in the tenant"),
]

RUN_AS = [
    ("caller", "The person who runs it"),
    ("owner", "The script's owner"),
]

TOKEN_SCOPES = [("full", "Read and write"), ("read", "Read only")]

RUN_STATUS = [
    ("queued", "Queued"),
    ("running", "Running"),
    ("success", "Success"),
    ("failed", "Failed"),
    ("timeout", "Timed out"),
    ("canceled", "Canceled"),
]

ACTIVE_STATUSES = ("queued", "running")
DEFAULT_TIMEOUT = 300
MAX_TIMEOUT = 3600


class Script(TimestampedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey("core.Tenant", on_delete=models.CASCADE, related_name="scripts")
    name = models.CharField(max_length=120)
    slug = models.SlugField(max_length=140, blank=True, default="")
    description = models.TextField(blank=True, default="")
    language = models.CharField(max_length=16, choices=LANGUAGES, default="python")
    source = models.TextField(blank=True, default="")
    # [{"name","label","type","required","default","choices","help"}] - the Run
    # dialog is rendered from this, and the values land in run.params.
    params_schema = models.JSONField(default=list, blank=True)

    # ─── how it runs ────────────────────────────────────────────────────
    token_scope = models.CharField(max_length=8, choices=TOKEN_SCOPES, default="full")
    timeout_seconds = models.PositiveIntegerField(default=DEFAULT_TIMEOUT)
    # Trusted scripts get the ORM instead of only the API. Only a holder of
    # the `trust` verb may set this; see scripting/api_views.py.
    trusted = models.BooleanField(default=False)
    run_as = models.CharField(max_length=8, choices=RUN_AS, default="caller")

    # ─── who sees it ────────────────────────────────────────────────────
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="owned_scripts",
    )
    visibility = models.CharField(max_length=8, choices=VISIBILITY, default="owner")
    shared_users = models.ManyToManyField(
        settings.AUTH_USER_MODEL, blank=True, related_name="shared_scripts"
    )
    shared_groups = models.ManyToManyField("auth.Group", blank=True, related_name="shared_scripts")

    # ─── schedule ───────────────────────────────────────────────────────
    schedule_enabled = models.BooleanField(default=False)
    cadence = models.JSONField(default=dict, blank=True)
    retention = models.JSONField(default=dict, blank=True)
    schedule_params = models.JSONField(default=dict, blank=True)
    last_run_at = models.DateTimeField(null=True, blank=True)

    enabled = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(fields=["tenant", "name"], name="uniq_script_tenant_name"),
        ]
        indexes = [models.Index(fields=["tenant", "visibility"])]

    def __str__(self) -> str:
        return self.name

    @property
    def effective_timeout(self) -> int:
        return max(5, min(int(self.timeout_seconds or DEFAULT_TIMEOUT), MAX_TIMEOUT))


class ScriptRun(TimestampedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    script = models.ForeignKey(Script, on_delete=models.CASCADE, related_name="runs")
    status = models.CharField(max_length=10, choices=RUN_STATUS, default="queued")
    params = models.JSONField(default=dict, blank=True)
    log = models.TextField(blank=True, default="")
    truncated = models.BooleanField(default=False)
    exit_code = models.IntegerField(null=True, blank=True)
    error = models.TextField(blank=True, default="")
    scheduled = models.BooleanField(default=False)
    # Snapshots: what the run actually did, even if the script changes later.
    trusted = models.BooleanField(default=False)
    source = models.TextField(blank=True, default="")
    started_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    run_as_user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    # Set by the worker so the Jobs page can line a run up with its RQ job.
    rq_job_id = models.CharField(max_length=64, blank=True, default="")
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["script", "-created_at"]),
            models.Index(fields=["status", "-created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.script_id} run {self.id}"

    @property
    def duration_seconds(self) -> float | None:
        if not self.started_at:
            return None
        end = self.finished_at or timezone.now()
        return round((end - self.started_at).total_seconds(), 2)

    @property
    def active(self) -> bool:
        return self.status in ACTIVE_STATUSES


def output_path(instance: ScriptOutput, filename: str) -> str:
    return f"script-outputs/{instance.run_id}/{filename}"


class ScriptOutput(TimestampedModel):
    """A file a run produced, downloadable from the run page."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    run = models.ForeignKey(ScriptRun, on_delete=models.CASCADE, related_name="outputs")
    name = models.CharField(max_length=255)
    file = models.FileField(upload_to=output_path)
    content_type = models.CharField(max_length=100, blank=True, default="")
    size = models.BigIntegerField(default=0)

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name
