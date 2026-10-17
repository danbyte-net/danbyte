"""Columns added to existing tables carry a database default (#363).

During an upgrade a web worker, RQ worker or replica still running the
previous release inserts rows without naming the columns the new release
added. A NOT NULL column with no database default fails that insert, so every
such column gets a db_default.

``ReleaseBaselineTests`` is the permanent gate: it compares the migration
graph with the state the last release shipped, recorded per release in
``scripts/upgrade/migration_baseline.json``. The classes after it pin the
0.16 -> 0.17 columns that #363 was about.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path

from django.conf import settings
from django.db import connection, models
from django.db.migrations.loader import MigrationLoader
from django.db.migrations.state import ModelState, ProjectState
from django.db.models.fields import NOT_PROVIDED
from django.test import SimpleTestCase, TestCase
from packaging.version import Version

import danbyte
from api.models import Device, Interface
from core.models import Organization, Tenant

UPGRADE_DIR = Path(settings.BASE_DIR) / "scripts" / "upgrade"


def _baseline_module():
    spec = importlib.util.spec_from_file_location(
        "migration_baseline", UPGRADE_DIR / "migration_baseline.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def missing_db_defaults(old: ProjectState, new: ProjectState, apps) -> list[str]:
    """``app.model.field`` for every NOT NULL column ``new`` has on a table
    ``old`` already had, where the column is new (or was nullable) and carries
    no db_default. Tables ``old`` lacks are skipped: old code never inserts
    into them."""
    missing = []
    for key, model_state in new.models.items():
        if key[0] not in apps or key not in old.models:
            continue
        old_fields = old.models[key].fields
        for name, field in model_state.fields.items():
            if field.many_to_many or field.null or field.generated:
                continue
            if name in old_fields and not old_fields[name].null:
                continue
            if field.db_default is NOT_PROVIDED:
                missing.append(f"{key[0]}.{key[1]}.{name}")
    return sorted(missing)


class ReleaseBaselineTests(SimpleTestCase):
    """Every NOT NULL column added since the last release has a db_default.

    The baseline is the per-app newest migration of the last final release,
    written by ``scripts/upgrade/migration_baseline.py vX.Y.Z`` after tagging
    and committed for the next release's branch."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.baseline = json.loads((UPGRADE_DIR / "migration_baseline.json").read_text())
        cls.loader = MigrationLoader(None, ignore_no_migrations=True)

    def test_every_column_added_since_the_last_release_has_a_db_default(self):
        graph = self.loader.graph
        leaves = self.baseline["leaves"]
        old = graph.make_state(nodes=list(leaves.items()), at_end=True)
        new = graph.make_state(nodes=graph.leaf_nodes(), at_end=True)
        self.assertEqual(
            missing_db_defaults(old, new, set(leaves)), [],
            f"NOT NULL columns added since {self.baseline['release']} need a db_default",
        )

    def test_baseline_names_migrations_that_exist(self):
        nodes = set(self.loader.graph.nodes)
        gone = [f"{a}.{n}" for a, n in self.baseline["leaves"].items() if (a, n) not in nodes]
        self.assertEqual(gone, [])

    def test_baseline_is_a_release_not_ahead_of_the_code(self):
        release = Version(self.baseline["release"])
        self.assertFalse(release.is_prerelease, "the baseline is a final release")
        self.assertLessEqual(release, Version(danbyte.__version__))

    def test_baseline_matches_its_tag(self):
        """Regenerated from git when the tag is there (a full clone)."""
        tag = f"v{self.baseline['release']}"
        try:
            found = subprocess.run(
                ["git", "rev-parse", "--verify", "-q", f"refs/tags/{tag}"],
                cwd=settings.BASE_DIR, capture_output=True,
            ).returncode == 0
        except OSError:
            found = False
        if not found:
            self.skipTest(f"tag {tag} is not in this checkout")
        self.assertEqual(
            _baseline_module().leaves_at(tag, self.loader), self.baseline["leaves"]
        )


class MissingDbDefaultTests(SimpleTestCase):
    """The comparison the release gate runs, on hand-built states."""

    def _state(self, **fields):
        state = ProjectState()
        state.add_model(ModelState("api", "widget", [
            ("id", models.UUIDField(primary_key=True)), *fields.items(),
        ]))
        return state

    def test_new_not_null_column_without_db_default_is_named(self):
        old = self._state()
        new = self._state(flag=models.BooleanField(default=False))
        self.assertEqual(missing_db_defaults(old, new, {"api"}), ["api.widget.flag"])

    def test_db_default_nullable_and_unchanged_columns_pass(self):
        old = self._state(kept=models.CharField(max_length=5))
        new = self._state(
            kept=models.CharField(max_length=5),
            flag=models.BooleanField(default=False, db_default=False),
            note=models.TextField(null=True),
        )
        self.assertEqual(missing_db_defaults(old, new, {"api"}), [])

    def test_a_nullable_column_made_not_null_is_named(self):
        old = self._state(note=models.TextField(null=True))
        new = self._state(note=models.TextField(default=""))
        self.assertEqual(missing_db_defaults(old, new, {"api"}), ["api.widget.note"])

    def test_new_tables_and_other_apps_are_skipped(self):
        new = self._state(flag=models.BooleanField(default=False))
        self.assertEqual(missing_db_defaults(ProjectState(), new, {"api"}), [])
        self.assertEqual(missing_db_defaults(self._state(), new, {"core"}), [])

# The last migration of each app in v0.16.0, the oldest release an install can
# upgrade to 0.17 from.
V0_16_0_LEAVES = {
    "agents": "0001_initial",
    "api": "0165_l2vpn_vrf_vni",
    "assistant": "0001_initial",
    "audit": "0011_alter_changelogentry_via",
    "auth_api": "0023_ldapgroupmapping_grants_superuser",
    "backups": "0001_initial",
    "compliance": "0002_compliancerule_remediation",
    "core": "0052_sitecertificate",
    "customization": "0006_customfield_hidden",
    "integrations": "0042_integrationsettings_zabbix_enabled",
    "monitoring": "0093_fast_lane",
    "planning": "0008_task_due_time_task_start_time",
    "plugins": "0001_initial",
    "routing": "0009_bgp_knobs",
    "scripting": "0001_initial",
    "zabbix": "0017_host_status",
}

# The migrations that set the defaults; the state after them is what an
# upgraded 0.17.2 database looks like.
FIX_NODES = [
    ("api", "0196_upgrade_db_defaults"),
    ("core", "0059_upgrade_db_defaults"),
    ("integrations", "0045_upgrade_db_defaults"),
    ("monitoring", "0109_upgrade_db_defaults"),
    ("routing", "0014_upgrade_db_defaults"),
]

# table -> columns 0.16.1..0.17.1 added NOT NULL to a table 0.16.0 had.
ADDED_COLUMNS = {
    "api_device": ["port_labels"],
    "api_exporttemplate": ["target_path"],
    "api_fhrpgroup": ["nd_ra"],
    "api_interface": ["evpn_mh_uplink", "hide_label", "label_color"],
    "api_inventoryitem": ["slot"],
    "api_vminterface": ["snmp_name"],
    "api_wirelesslan": ["pmf"],
    "core_deploymentsettings": [
        "faceplate_port_label_color", "faceplate_port_labels", "log_retention_days",
        "topology_card_role_overrides", "upgrade_backups_keep",
    ],
    "core_tenantsettings": ["override_topology_card", "topology_card_role_overrides"],
    "integrations_integrationsettings": ["virt_vcloud_enabled"],
    "integrations_virtguest": ["ext_id"],
    "integrations_virtualizationsource": [
        "api_version", "api_version_used", "sync_nat", "sync_templates", "sync_vm_groups",
    ],
    "monitoring_monitoringsettings": ["availability_frame", "spike_factor", "spike_floor_ms"],
    "routing_bgpaddressfamily": ["advertise_ipv4_unicast", "advertise_ipv6_unicast"],
    "routing_bgpinstance": [
        "bestpath_multipath_relax", "vpn_export", "vpn_import", "vpn_label_export",
        "vpn_nexthop_export",
    ],
    "routing_isisinstance": [
        "default_originate_ipv4", "default_originate_ipv6", "log_adjacency_changes",
    ],
    "routing_redistribution": ["family", "level"],
}


class MigrationStateTests(SimpleTestCase):
    def test_every_column_added_since_0_16_0_has_a_db_default(self):
        """Read off the migration graph, so a column missing from
        ADDED_COLUMNS (or a default dropped later) fails here."""
        graph = MigrationLoader(None, ignore_no_migrations=True).graph
        old = graph.make_state(nodes=list(V0_16_0_LEAVES.items()), at_end=True)
        new = graph.make_state(nodes=FIX_NODES, at_end=True)
        missing = []
        for key, model_state in new.models.items():
            if key not in old.models:
                continue  # a new table: old code never inserts into it
            old_fields = old.models[key].fields
            for name, field in model_state.fields.items():
                if field.many_to_many or field.null:
                    continue
                if name in old_fields and not old_fields[name].null:
                    continue
                if field.db_default is NOT_PROVIDED:
                    missing.append(f"{key[0]}.{key[1]}.{name}")
        self.assertEqual(missing, [])


class DatabaseDefaultTests(TestCase):
    def test_columns_have_a_default_in_the_catalog(self):
        with connection.cursor() as cur:
            cur.execute(
                "SELECT table_name, column_name FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND column_default IS NOT NULL"
            )
            have = set(cur.fetchall())
        missing = [
            f"{t}.{c}" for t, cols in ADDED_COLUMNS.items() for c in cols if (t, c) not in have
        ]
        self.assertEqual(missing, [])

    def _insert_like_0_16(self, model, src_pk, name):
        """INSERT a copy of ``src_pk`` naming only the columns 0.16 knew."""
        table = model._meta.db_table
        skip = {"id", "name", *ADDED_COLUMNS[table]}
        with connection.cursor() as cur:
            cur.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND table_name = %s",
                [table],
            )
            cols = [c for (c,) in cur.fetchall() if c not in skip]
            qn = connection.ops.quote_name
            col_sql = ", ".join(qn(c) for c in cols)
            cur.execute(
                f"INSERT INTO {qn(table)} (id, name, {col_sql}) "
                f"SELECT gen_random_uuid(), %s, {col_sql} FROM {qn(table)} WHERE id = %s "
                "RETURNING id",
                [name, src_pk],
            )
            return cur.fetchone()[0]

    def test_old_code_can_insert_devices_and_interfaces(self):
        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        device = Device.objects.create(tenant=tenant, name="r1")
        iface = Interface.objects.create(device=device, name="eth0")

        new_dev = Device.objects.get(pk=self._insert_like_0_16(Device, device.pk, "r2"))
        self.assertEqual(new_dev.port_labels, "")
        new_if = Interface.objects.get(pk=self._insert_like_0_16(Interface, iface.pk, "eth1"))
        self.assertFalse(new_if.hide_label)
        self.assertFalse(new_if.evpn_mh_uplink)
        self.assertEqual(new_if.label_color, "")
