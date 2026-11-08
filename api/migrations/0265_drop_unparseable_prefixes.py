# Prefixes saved before CIDR validation (#47) can hold text that is not an
# address at all ("banana"); 0126 repaired bare addresses and left the rest.
# The prefix containment index (0262, #484) casts every cidr to inet, so one
# such row would fail the index build and roll the whole upgrade back. Those
# rows already broke prefix search and filters, which cast the same way.
#
# This runs before 0262 (run_before) and deletes them, logging each one to
# the upgrade log. Validity is Postgres's own inet parser, through a
# temporary function so it works on PostgreSQL 15 (no pg_input_is_valid).

import logging

from django.db import migrations

log = logging.getLogger("danbyte.migrations")

_IS_INET = """
CREATE OR REPLACE FUNCTION pg_temp.danbyte_is_inet(t text) RETURNS boolean AS $$
BEGIN
    PERFORM t::inet;
    RETURN true;
EXCEPTION WHEN others THEN
    RETURN false;
END
$$ LANGUAGE plpgsql
"""


def unparseable_prefix_ids(connection) -> list:
    with connection.cursor() as cur:
        cur.execute(_IS_INET)
        cur.execute(
            "SELECT id FROM api_prefix WHERE NOT pg_temp.danbyte_is_inet(cidr)"
        )
        return [row[0] for row in cur.fetchall()]


def drop_unparseable(apps, schema_editor):
    Prefix = apps.get_model("api", "Prefix")
    ids = unparseable_prefix_ids(schema_editor.connection)
    if not ids:
        return
    for p in Prefix.objects.filter(pk__in=ids).order_by("tenant_id", "cidr"):
        log.warning(
            "deleting prefix %s with unparseable cidr %r (tenant %s)",
            p.pk, p.cidr, p.tenant_id,
        )
    Prefix.objects.filter(pk__in=ids).delete()
    log.warning("deleted %d prefix(es) whose cidr is not an address", len(ids))


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0261_sbom_package_ids"),
    ]

    run_before = [
        ("api", "0262_natural_name_and_inet_indexes"),
    ]

    operations = [
        migrations.RunPython(drop_unparseable, migrations.RunPython.noop),
    ]
