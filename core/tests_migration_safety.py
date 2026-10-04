"""New migrations must not break the processes still running the release
before them.

An upgrade is not instant. Until every web worker, background job and timer
has restarted onto the new code, some of them still run the previous release
against the migrated database. An INSERT from that code names only the
columns it knows about, so a new NOT NULL column without a default on the
column fails every such insert (api 0183 did exactly that to IP addresses).

The baseline below is each app's leaf when this guard was added; every
migration after it is checked. A new NOT NULL column needs ``db_default``
(the Python ``default`` is not on the column) or ``null=True``; a new foreign
key has to be nullable. Tables created in the same migration are exempt:
no older code writes to them.
"""
from __future__ import annotations

from django.apps import apps
from django.conf import settings
from django.db import models
from django.db.migrations import operations as ops
from django.db.migrations.loader import MigrationLoader
from django.test import SimpleTestCase

#: Each app's leaf when the guard was added (0.17.0-dev2). Migrations after
#: these are checked; an app missing here has all of its migrations checked.
BASELINE = {
    "agents": "0001_initial",
    "api": "0184_ipaddress_db_defaults",
    "assistant": "0001_initial",
    "audit": "0011_alter_changelogentry_via",
    "auth_api": "0025_narrow_kept_access",
    "backups": "0001_initial",
    "compliance": "0002_compliancerule_remediation",
    "core": "0057_tenantsettings_default_topology_view",
    "customization": "0006_customfield_hidden",
    "integrations": "0044_config_push",
    "monitoring": "0103_sla_objectives",
    "planning": "0008_task_due_time_task_start_time",
    "plugins": "0001_initial",
    "routing": "0013_vm_owner",
    "scripting": "0001_initial",
    "zabbix": "0017_host_status",
}

HINT = ("add db_default (or null=True) so processes still on the previous "
        "release can insert")


def _local_apps() -> set[str]:
    base = str(settings.BASE_DIR)
    return {
        cfg.label for cfg in apps.get_app_configs()
        if cfg.path.startswith(base) and "/.venv/" not in cfg.path
        and "site-packages" not in cfg.path
    }


def _needs_column_default(field: models.Field) -> bool:
    if field.many_to_many or field.primary_key or field.null:
        return False
    if isinstance(field, models.GeneratedField):
        return False
    return not field.has_db_default()


def problems(loader: MigrationLoader | None = None,
             baseline: dict[str, str] | None = None,
             only_apps: set[str] | None = None) -> list[str]:
    """Every unsafe operation in a migration after the baseline."""
    loader = loader or MigrationLoader(None, ignore_no_migrations=True)
    baseline = BASELINE if baseline is None else baseline
    local = _local_apps() if only_apps is None else only_apps
    old: set[tuple[str, str]] = set()
    for app, name in baseline.items():
        if (app, name) in loader.graph.nodes:
            old.update(loader.graph.forwards_plan((app, name)))
    found = []
    for key in sorted(loader.graph.nodes):
        app, name = key
        if app not in local or key in old:
            continue
        migration = loader.graph.nodes[key]
        state = None
        created: set[str] = set()
        for op in migration.operations:
            where = f"{app}.{name}"
            if isinstance(op, ops.CreateModel):
                created.add(op.name_lower)
                continue
            if isinstance(op, ops.AddField):
                if op.model_name_lower in created:
                    continue
                field = op.field
                if field.is_relation and not field.many_to_many and not field.null:
                    found.append(
                        f"{where}: {op.model_name}.{op.name} is a NOT NULL foreign "
                        "key - make it nullable so processes still on the previous "
                        "release can insert")
                elif not field.is_relation and _needs_column_default(field):
                    found.append(f"{where}: {op.model_name}.{op.name} - {HINT}")
            elif isinstance(op, ops.AlterField):
                if op.model_name_lower in created or op.field.null:
                    continue
                if state is None:
                    parents = loader.graph.node_map[key].parents
                    state = loader.project_state([p.key for p in parents], at_end=True)
                model_state = state.models.get((app, op.model_name_lower))
                before = model_state.fields.get(op.name) if model_state else None
                if before is not None and before.null and not op.field.null:
                    if op.field.is_relation:
                        found.append(
                            f"{where}: {op.model_name}.{op.name} becomes a NOT NULL "
                            "foreign key - keep it nullable")
                    elif _needs_column_default(op.field):
                        found.append(
                            f"{where}: {op.model_name}.{op.name} becomes NOT NULL - {HINT}")
    return found


class MigrationSafetyTests(SimpleTestCase):
    def test_new_migrations_keep_older_processes_inserting(self):
        self.assertEqual(problems(), [])

    def test_the_baseline_names_real_migrations(self):
        loader = MigrationLoader(None, ignore_no_migrations=True)
        for app, name in BASELINE.items():
            with self.subTest(app=app):
                self.assertIn((app, name), loader.disk_migrations)

    def test_an_unsafe_column_is_reported(self):
        """0183 itself, with the baseline moved back before it."""
        found = problems(baseline={"api": "0182_natural_component_ordering"},
                         only_apps={"api"})
        joined = "\n".join(found)
        self.assertIn("api.0183_ip_monitoring_exclude_reset: ipaddress.monitoring_excluded ",
                      joined)
        self.assertIn("monitoring_excluded_by", joined)
        # Nullable columns are fine, and 0184 is only defaults.
        self.assertNotIn("availability_since", joined)
        self.assertNotIn("0184", joined)
