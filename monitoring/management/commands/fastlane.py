"""The fast lane - the long-lived process behind sub-minute checks.

    manage.py fastlane

Run as ``danbyte-fastlane.service`` (or the ``fastlane`` compose service). It
owns every check with a fast interval, probes from an in-memory schedule,
and writes status changes at once and one aggregated row per recording
window. Stop it and the minute beat takes the checks back at their fallback
interval within a minute.
"""
from __future__ import annotations

import asyncio
import logging
import signal

from django.core.management.base import BaseCommand

from monitoring.fastlane import FastLane

log = logging.getLogger("monitoring.fastlane")


class Command(BaseCommand):
    help = "Run the fast lane: sub-minute checks from an in-memory schedule."

    def handle(self, *args, **opts):
        lane = FastLane()

        async def main():
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.add_signal_handler(sig, lambda: setattr(lane, "stopping", True))
            await lane.run()

        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
        asyncio.run(main())
        self.stdout.write("fast lane stopped")
