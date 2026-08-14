"""Send each user their personal "your work" email.

Run daily by a systemd timer (services/danbyte-task-reminders.timer) or the
container scheduler. One mail per user with overdue / due-today / due-this-week
tasks — assigned to them, or unclaimed in one of their teams' queues — and no
mail at all when there is nothing to say. Users opt out with the
``notify_task_due`` preference.

    manage.py send_task_reminders
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run


class Command(BaseCommand):
    help = "Email each user their overdue and upcoming tasks (daily reminder)."

    def handle(self, *args, **opts):
        with record_run("task_reminders", "Task reminders") as run:
            from planning.notifications import send_due_reminders

            sent = send_due_reminders()
            if sent:
                run.note(f"sent {sent} reminder(s)", count=sent)
            else:
                run.skip("nobody has overdue or upcoming tasks")
            self.stdout.write(f"sent {sent} reminder(s)")
