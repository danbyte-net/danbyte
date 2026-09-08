"""Print the operator steps still pending after an upgrade - the upgrade
scripts call it at the end so the journal carries them, and the host admin
script reuses it. ``--ack ID`` or ``--ack all`` marks steps done."""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.models import DeploymentSettings
from core.upgrade_notes import acknowledge, pending


class Command(BaseCommand):
    help = "Show or acknowledge the manual steps the running version needs after upgrading."

    def add_arguments(self, parser):
        parser.add_argument("--ack", metavar="ID|all", help="mark a step (or every pending one) done")

    def handle(self, *args, **opts):
        dep = DeploymentSettings.load()
        ack = opts.get("ack")
        if ack:
            added = acknowledge(dep, None if ack == "all" else [ack])
            self.stdout.write(f"marked {len(added)} step(s) done")
            return
        notes = pending(dep)
        if not notes:
            self.stdout.write("nothing to do after this upgrade")
            return
        self.stdout.write(self.style.WARNING(f"{len(notes)} step(s) to do after this upgrade:"))
        for n in notes:
            self.stdout.write(f"\n[{n.version}] {n.title}\n{n.body}")
            if n.snippet:
                self.stdout.write("\n" + n.snippet)
            if n.docs:
                self.stdout.write(f"\ndocs: /docs/{n.docs}")
            self.stdout.write(f"mark done: manage.py upgrade_notes --ack {n.id}")
