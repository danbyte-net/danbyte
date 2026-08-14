"""Personal task emails — assignment, team queue, comments, @mentions.

One module owns who hears about a task event and how the mail reads, so the
viewset and journal hooks stay one-liners. Delivery is enqueued on the low RQ
queue (falling back to inline when Redis is down) and every recipient passes
an allowlist: active user, an email address on file, membership of the task's
tenant, and the matching notification preference left on (auth_api.user_prefs
``notify_task_*`` keys — each user can switch any of these off).

These are *personal* mails — one message per recipient, never a shared To:
line — distinct from the deployment-wide daily digest.
"""
from __future__ import annotations

import logging
import re

log = logging.getLogger(__name__)

#: @username — usernames may carry dots, dashes, +, @ (email-style logins).
#: The trailing strip below keeps "thanks @rene." from eating the period.
MENTION_RE = re.compile(r"@([A-Za-z0-9_.@+-]+)")


def parse_mentions(text: str, tenant):
    """The tenant's active users actually @named in ``text`` (case-insensitive,
    matched against real usernames — "@everyone" or a typo matches nobody)."""
    from django.contrib.auth import get_user_model

    names = {m.rstrip(".,:;!?").lower() for m in MENTION_RE.findall(text or "")}
    names.discard("")
    if not names:
        return []
    User = get_user_model()
    qs = User.objects.filter(is_active=True, profile__tenants=tenant)
    return [u for u in qs if u.username.lower() in names]


def _wants(user, task, pref_key: str) -> bool:
    """Fail-closed recipient gate: this mail goes to ``user`` only if they can
    see the task's tenant at all and haven't switched the preference off."""
    from auth_api import user_prefs

    if not user.is_active or not (user.email or "").strip():
        return False
    if not user.is_superuser:
        profile = getattr(user, "profile", None)
        if profile is None or not profile.tenants.filter(pk=task.tenant_id).exists():
            return False
    try:
        return bool(user_prefs.get(user, pref_key))
    except KeyError:
        return False


def _task_context(task):
    from core.models import DeploymentSettings

    dep = DeploymentSettings.load()
    base = (dep.public_base_url or "").rstrip("/")
    url = f"{base}/planning/{task.board_id}/tasks/{task.id}" if base else ""
    return dep, url


def _send(task, users, subject: str, body_html: str, text_lines: list[str], url: str):
    """One personal mail per recipient — addresses are never shared."""
    from core import email as ek

    dep, _ = _task_context(task)
    if url:
        # Rebind, never mutate — callers reuse the same body/lines for the
        # mention mail and the comment fan-out.
        body_html = body_html + ek.email_button(url, "Open the task")
        text_lines = [*text_lines, "", url]
    html = ek.render_layout(
        subject, body_html,
        deployment_name=dep.deployment_name or "Danbyte",
        kicker="Planning", preheader=task.title,
    )
    text = "\n".join(text_lines)
    for user in users:
        ek.send_html_email(
            subject, [user.email], html_body=html, text_body=text,
            tenant=task.tenant,
        )


def _task_facts_html(task):
    from core import email as ek

    rows = [("Board", task.board.name), ("Status", task.status.name)]
    if task.due_date:
        rows.append(("Due", task.due_date.isoformat()))
    if task.assigned_group_id:
        rows.append(("Team", task.assigned_group.name))
    return ek.kv_table(rows)


# ─── The events (run in a worker — ids in, fresh reads inside) ─────────────

def send_assigned(task_id, user_ids, actor_id):
    """You were put on a task."""
    from django.contrib.auth import get_user_model

    from core import email as ek

    from .models import Task

    task = Task.objects.filter(pk=task_id).select_related(
        "board", "status", "assigned_group", "tenant"
    ).first()
    if task is None:
        return
    User = get_user_model()
    actor = User.objects.filter(pk=actor_id).first()
    recipients = [
        u for u in User.objects.filter(pk__in=user_ids)
        if u.pk != actor_id and _wants(u, task, "notify_task_assigned")
    ]
    if not recipients:
        return
    who = actor.get_username() if actor else "someone"
    _, url = _task_context(task)
    body = ek.paragraph(f"{who} assigned you: {task.title}") + _task_facts_html(task)
    _send(
        task, recipients, f"Assigned to you: {task.title}", body,
        [f"{who} assigned you: {task.title}",
         f"Board: {task.board.name} · Status: {task.status.name}"
         + (f" · Due {task.due_date}" if task.due_date else "")],
        url,
    )


def send_queued(task_id, group_id, actor_id):
    """A task landed in your team's queue (and nobody owns it yet)."""
    from django.contrib.auth.models import Group

    from core import email as ek

    from .models import Task

    task = Task.objects.filter(pk=task_id).select_related(
        "board", "status", "assigned_group", "tenant"
    ).first()
    group = Group.objects.filter(pk=group_id).first()
    if task is None or group is None:
        return
    already = set(task.assignees.values_list("pk", flat=True))
    recipients = [
        u for u in group.user_set.all()
        if u.pk != actor_id and u.pk not in already
        and _wants(u, task, "notify_task_queue")
    ]
    if not recipients:
        return
    _, url = _task_context(task)
    body = ek.paragraph(
        f"{task.title} was queued on {group.name}."
        + ("" if already else " Nobody has picked it up yet.")
    ) + _task_facts_html(task)
    _send(
        task, recipients, f"New in {group.name}: {task.title}", body,
        [f"Queued on {group.name}: {task.title}",
         f"Board: {task.board.name} · Status: {task.status.name}"],
        url,
    )


def send_commented(task_id, entry_id, actor_id, mentioned_ids):
    """A comment landed on a task you're involved in — or you were @named."""
    from django.contrib.auth import get_user_model

    from audit.models import JournalEntry
    from core import email as ek

    from .models import Task

    task = Task.objects.filter(pk=task_id).select_related(
        "board", "status", "assigned_group", "tenant"
    ).first()
    entry = JournalEntry.objects.filter(pk=entry_id).first()
    if task is None or entry is None:
        return
    User = get_user_model()
    who = entry.author_name or "someone"
    excerpt = (entry.comments or "").strip()
    if len(excerpt) > 400:
        excerpt = excerpt[:400] + "…"
    _, url = _task_context(task)

    mentioned = set(mentioned_ids or [])
    body_base = ek.paragraph(f"{who} on {task.title}:") + ek.callout(
        excerpt, "info", label="Comment"
    )
    text_base = [f"{who} commented on: {task.title}", "", excerpt]

    # @mentions get their own, stronger mail; they are then excluded from the
    # plain comment fan-out so nobody is told twice.
    mention_users = [
        u for u in User.objects.filter(pk__in=mentioned)
        if u.pk != actor_id and _wants(u, task, "notify_task_mentions")
    ]
    if mention_users:
        _send(task, mention_users,
              f"{who} mentioned you: {task.title}", body_base, text_base, url)

    involved = set(task.assignees.values_list("pk", flat=True))
    if task.created_by_id:
        involved.add(task.created_by_id)
    involved |= set(
        JournalEntry.objects.filter(
            object_type="planning.task", object_id=str(task.pk)
        ).values_list("created_by_id", flat=True)
    )
    involved -= {None, actor_id}
    involved -= mentioned
    comment_users = [
        u for u in User.objects.filter(pk__in=involved)
        if _wants(u, task, "notify_task_comments")
    ]
    if comment_users:
        _send(task, comment_users,
              f"New comment on: {task.title}", body_base, text_base, url)


def send_due_reminders(today=None) -> int:
    """The daily personal "your work" mail — overdue, due today, due this week.

    One email per user, and only when there is something to say. "Your work"
    is the same definition the dashboard widget uses: tasks you're assigned,
    plus unclaimed tasks sitting in one of your teams' queues. Returns the
    number of emails sent (the command logs it)."""
    from datetime import timedelta

    from django.contrib.auth import get_user_model
    from django.db.models import Q
    from django.utils import timezone

    from auth_api import user_prefs
    from core import email as ek
    from core.models import DeploymentSettings

    from .models import Task

    today = today or timezone.localdate()
    horizon = today + timedelta(days=7)
    dep = DeploymentSettings.load()
    base = (dep.public_base_url or "").rstrip("/")
    User = get_user_model()
    sent = 0

    for user in User.objects.filter(is_active=True).exclude(email=""):
        if not user_prefs.get(user, "notify_task_due"):
            continue
        tenant_ids = None
        if not user.is_superuser:
            profile = getattr(user, "profile", None)
            if profile is None:
                continue
            tenant_ids = list(profile.tenants.values_list("pk", flat=True))
            if not tenant_ids:
                continue
        qs = (
            Task.objects.filter(due_date__isnull=False, due_date__lte=horizon)
            .exclude(status__semantic_group__in=["completed", "cancelled"])
            .filter(
                Q(assignees=user)
                | Q(assigned_group__in=user.groups.all(), assignees__isnull=True)
            )
            .select_related("board", "status")
            .order_by("due_date")
        )
        if tenant_ids is not None:
            qs = qs.filter(tenant_id__in=tenant_ids)
        tasks = list(qs.distinct()[:50])
        if not tasks:
            continue

        overdue = [t for t in tasks if t.due_date < today]
        due_today = [t for t in tasks if t.due_date == today]
        this_week = [t for t in tasks if t.due_date > today]
        counts = []
        if overdue:
            counts.append(f"{len(overdue)} overdue")
        if due_today:
            counts.append(f"{len(due_today)} due today")
        if this_week:
            counts.append(f"{len(this_week)} due this week")
        subject = "Your work: " + ", ".join(counts)

        body = ek.stat_grid([
            (str(len(overdue)), "Overdue", "#ef4444") if overdue
            else (str(len(overdue)), "Overdue"),
            (str(len(due_today)), "Due today"),
            (str(len(this_week)), "This week"),
        ]) + ek.data_table(
            ["Task", "Board", "Due", "Status"],
            [(t.title, t.board.name, t.due_date.isoformat(), t.status.name)
             for t in tasks],
        )
        if base:
            body += ek.email_button(f"{base}/planning", "Open planning")
        html = ek.render_layout(
            subject, body,
            deployment_name=dep.deployment_name or "Danbyte",
            kicker="Your tasks", preheader=subject,
        )
        text = "\n".join(
            [subject, ""]
            + [f"- {t.due_date} · {t.title} ({t.board.name}, {t.status.name})"
               for t in tasks]
        )
        if ek.send_html_email(subject, [user.email], html_body=html, text_body=text):
            sent += 1
    return sent


def enqueue(func, *args) -> None:
    """Run ``func`` on the low RQ queue; inline when Redis is unreachable.

    Notification delivery must never fail the write that caused it, so the
    inline fallback is also wrapped. Under the test runner everything runs
    inline — a test must never park work on the developer's live queue."""
    import sys

    if "test" in sys.argv:
        try:
            func(*args)
        except Exception:
            log.exception("task notification failed inline: %s", func.__name__)
        return
    try:
        import django_rq

        django_rq.get_queue("low").enqueue(func, *args)
    except Exception:  # noqa: BLE001 — queue down ≠ task save fails
        try:
            func(*args)
        except Exception:
            log.exception("task notification failed inline: %s", func.__name__)
