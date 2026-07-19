"""drive_outposts — poll the SSH-transport Outposts.

For engines whose transport is ``ssh`` (airgapped: only Danbyte→host is allowed),
Danbyte drives the run itself. Run on a short timer, like ``dispatch_checks``.
HTTPS-pull engines drive themselves and are untouched here.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from monitoring.outpost_ssh import drive_ssh_outposts


class Command(BaseCommand):
    help = "Drive SSH-transport Outposts: claim due checks, run them over SSH, ingest."

    def handle(self, *args, **opts):
        result = drive_ssh_outposts()
        self.stdout.write(
            f"SSH Outposts: {result['engines']} engine(s), ran {result['ran']}, "
            f"ingested {result['ingested']}, errors {result['errors']}."
        )
