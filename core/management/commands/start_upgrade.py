"""Start an upgrade from the host, the way the app does.

    manage.py start_upgrade --tag vX.Y.Z   [--skip-backup] [--json]
    manage.py start_upgrade --bundle FILE  [--skip-backup] [--json]

Takes the same single-slot lock as the Updates page and the auto-upgrade
timer and launches the same unit, danbyte-upgrade.service, so an upgrade
started over SSH carries on when the session drops and nothing else can
start one beside it. It returns once the unit runs; follow it in
``.upgrade-status.json`` or ``journalctl --user -fu danbyte-upgrade``.

``--tag`` is not checked against the release repo - the operator is on the
host, and the launcher still requires the tag to exist after a fetch - which
also lets a local mirror serve as the origin. The bundle launcher deletes the
file it is given once the upgrade succeeds: pass a copy. ``--fault PHASE``
(for the upgrade tests) makes the stage fail at that phase.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Start an upgrade to a tag or from a bundle, as danbyte-upgrade.service."

    def add_arguments(self, parser):
        what = parser.add_mutually_exclusive_group(required=True)
        what.add_argument("--tag", help="release tag (git install)")
        what.add_argument("--bundle", help="offline bundle .tar.gz (bundle install)")
        parser.add_argument("--skip-backup", action="store_true",
                            help="no pre-upgrade backup (there is then no net)")
        parser.add_argument("--json", action="store_true", help="print the result as JSON")
        parser.add_argument("--fault", default="", help=argparse.SUPPRESS)

    def handle(self, *args, **opts):
        from core import upgrade
        from core.version import self_upgrade_supported

        if not self_upgrade_supported():
            raise CommandError(upgrade._CONTAINER_UPGRADE_MSG)
        if opts["tag"] and not upgrade._is_git_install():
            raise CommandError("this is a bundle install (no .git) - use --bundle")
        bundle = Path(opts["bundle"]).resolve() if opts["bundle"] else None
        if bundle is not None and not bundle.is_file():
            raise CommandError(f"no such bundle: {bundle}")
        owner = upgrade._acquire_upgrade_lock()
        if owner is None:
            reason = ("an interrupted upgrade must be recovered first: danbyte-admin upgrade "
                      "recover" if upgrade._upgrade_unfinished() else "an upgrade is already running")
            raise CommandError(reason, returncode=3)
        target = opts["tag"] or bundle.name
        try:
            upgrade._write_start_status(target, owner, trigger="admin")
            # after the seed: the stage keeps its start time
            env = upgrade._stage_env(trigger="admin", skip_backup=opts["skip_backup"],
                                     fault=opts["fault"])
            if opts["tag"]:
                via = upgrade._launch(opts["tag"], owner, env)
            else:
                via = upgrade._launch_bundle(str(bundle), owner, extra_env=env)
        except upgrade.UpgradeLaunchUncertain as exc:
            raise CommandError(str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - nothing started: free the slot
            upgrade._record_launch_failure(exc)
            upgrade._release_upgrade_lock(owner)
            raise CommandError(str(exc)) from exc
        result = {"launched": True, "via": via, "target": target,
                  "status_file": str(upgrade.STATUS_FILE), "unit": "danbyte-upgrade.service"}
        if opts["json"]:
            self.stdout.write(json.dumps(result))
        else:
            self.stdout.write(f"launched danbyte-upgrade.service for {target}")
            self.stdout.write(f"follow: {upgrade.STATUS_FILE} or journalctl --user -fu "
                              f"danbyte-upgrade (as {os.environ.get('USER') or 'the service user'})")
