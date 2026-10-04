"""Put a database at the schema an older release left it in, so the upgrade
migration can be rehearsed on it (CI's upgrade migration rehearsal).

    python scripts/upgrade/rehearse_migrations.py v0.16.13
    python manage.py upgrade_migrate && python manage.py upgrade_verify

For every app, migrates to the newest migration that release shipped (read
from ``git ls-tree <tag>``). Apps the release did not have are left for the
upgrade. Run from the repository root with the database settings in the
environment; the database should be empty.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys


def shipped(tag: str) -> set[tuple[str, str]]:
    out = subprocess.run(["git", "ls-tree", "-r", "--name-only", tag],
                         capture_output=True, text=True, check=True).stdout
    found = set()
    for path in out.splitlines():
        m = re.fullmatch(r"(?:.*/)?([A-Za-z0-9_]+)/migrations/(\d{4}_[A-Za-z0-9_]+)\.py", path)
        if m:
            found.add((m.group(1), m.group(2)))
    return found


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    sys.path.insert(0, os.getcwd())
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "danbyte.settings")
    import django

    django.setup()
    from django.core.management import call_command
    from django.db.migrations.loader import MigrationLoader

    old = shipped(sys.argv[1])
    loader = MigrationLoader(None, ignore_no_migrations=True)
    labels = {node[0] for node in loader.graph.nodes}
    # The migrations directory is named after the app's module, the label
    # can differ; map by the migration names both sides know.
    nodes = {n for n in loader.graph.nodes if (n[0], n[1]) in old}
    missing = sorted(f"{a}.{n}" for a, n in old if a in labels and (a, n) not in nodes)
    if missing:
        print(f"note: {len(missing)} migration(s) of {sys.argv[1]} no longer ship, e.g. "
              f"{missing[0]}")
    # Apps whose migrations live outside the repository (Django's own,
    # taggit, ...) were fully migrated on the release too.
    in_repo = {a for a, _ in old}
    for app in sorted(labels - in_repo):
        cfg_path = django.apps.apps.get_app_config(app).path
        if not os.path.realpath(cfg_path).startswith(os.path.realpath(os.getcwd()) + os.sep) \
                or "site-packages" in cfg_path:
            call_command("migrate", app, interactive=False, verbosity=0)
    targets = []
    for node in sorted(nodes):
        children = loader.graph.node_map[node].children
        if not any(child.key in nodes and child.key[0] == node[0] for child in children):
            targets.append(node)
    for app, name in targets:
        print(f"migrate {app} {name}", flush=True)
        call_command("migrate", app, name, interactive=False, verbosity=0)
    print(f"at {sys.argv[1]}: {len(targets)} app(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
