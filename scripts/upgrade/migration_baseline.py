"""Record the migration state of a release, the baseline the db_default upgrade
gate (api/tests_upgrade_db_defaults.py) compares the current schema with.

    python scripts/upgrade/migration_baseline.py v0.18.0

Run it after tagging a final release, on the branch for the next one, and
commit the file it writes (scripts/upgrade/migration_baseline.json). For every
app it records the newest migration the tag shipped (read from
``git ls-tree <tag>``), so the gate then requires a ``db_default`` on every NOT
NULL column added to an existing table since that release: during an upgrade,
the previous release's processes still insert rows without naming it.

Run from the repository root with the Django settings importable.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

BASELINE = Path(__file__).resolve().parent / "migration_baseline.json"


def leaves(loader, shipped: set[tuple[str, str]]) -> dict[str, str]:
    """``{app: newest migration}`` among ``shipped`` (the graph's own leaves
    when restricted to those nodes). Plugins are left out: they are optional
    and installed per deployment (the test settings add the example one)."""
    from django.apps import apps
    from django.conf import settings

    plugins = set(getattr(settings, "PLUGINS", []))

    def is_plugin(label):
        try:
            return apps.get_app_config(label).name in plugins
        except LookupError:
            return False

    nodes = {
        n for n in loader.graph.nodes if (n[0], n[1]) in shipped and not is_plugin(n[0])
    }
    out = {}
    for node in sorted(nodes):
        children = loader.graph.node_map[node].children
        if not any(child.key in nodes and child.key[0] == node[0] for child in children):
            out[node[0]] = node[1]
    return out


def leaves_at(tag: str, loader) -> dict[str, str]:
    """The baseline ``leaves`` for ``tag``, read from git."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        from rehearse_migrations import shipped
    finally:
        sys.path.pop(0)
    return leaves(loader, shipped(tag))


def main() -> int:
    if len(sys.argv) != 2 or not sys.argv[1].startswith("v"):
        print(__doc__)
        return 2
    tag = sys.argv[1]
    sys.path.insert(0, os.getcwd())
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "danbyte.settings")
    import django

    django.setup()
    from django.db.migrations.loader import MigrationLoader

    found = leaves_at(tag, MigrationLoader(None, ignore_no_migrations=True))
    BASELINE.write_text(
        json.dumps({"release": tag.removeprefix("v"), "leaves": found}, indent=2,
                   sort_keys=True) + "\n"
    )
    print(f"{BASELINE.name}: {tag}, {len(found)} app(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
