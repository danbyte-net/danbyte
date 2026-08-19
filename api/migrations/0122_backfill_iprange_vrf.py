"""Give every IPRange the VRF of the prefix it carves out of.

``IPRange.vrf`` is denormalised from its prefix, but until now only
``IPRangeSerializer.validate`` applied that rule — so ranges created straight
through the ORM kept whatever VRF they were given. The DHCP sync creates
exclusion ranges that way, leaving them in the Global VRF under a prefix that
had been moved into a real one. ``IPRange.save()`` now enforces it; this fixes
the rows written before it did.

Safe to run repeatedly: IPRange has no unique constraint (only indexes), so a
corrected row cannot collide with an existing one.
"""
from django.db import migrations


def fill_vrf_from_prefix(apps, schema_editor):
    schema_editor.execute(
        """
        UPDATE api_iprange r
           SET vrf_id = p.vrf_id
          FROM api_prefix p
         WHERE r.prefix_id = p.id
           AND r.vrf_id IS DISTINCT FROM p.vrf_id
        """
    )


def noop(apps, schema_editor):
    """Nothing to undo — the prior state was inconsistent, not meaningful."""


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0121_cluster_apply_site_to_vms"),
    ]

    operations = [
        migrations.RunPython(fill_vrf_from_prefix, noop),
    ]
