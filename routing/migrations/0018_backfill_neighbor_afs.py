"""Turn every neighbour's ``address_families`` list into family rows.

One row per listed family, activated, every knob null - so each family
inherits exactly what the neighbour-level fields said before, and every
render stays byte-identical. Idempotent (a family that has a row is
skipped) and only adds rows, so it is safe on a fresh install and on an
upgrade. The list itself is kept as the v0.16 view of the rows.
"""
from django.db import migrations

AFI_SAFI_VALUES = {
    "ipv4-unicast", "ipv6-unicast", "vpnv4-unicast", "vpnv6-unicast",
    "l2vpn-evpn", "ipv4-labeled-unicast",
}


def backfill(apps, schema_editor):
    row = apps.get_model("routing", "BGPNeighborAF")
    for model, key in (("BGPSession", "session_id"), ("BGPPeerGroup", "peer_group_id")):
        parents = apps.get_model("routing", model).objects.exclude(address_families=[])
        for parent in parents.only("id", "address_families").iterator():
            have = set(
                row.objects.filter(**{key: parent.id}).values_list("afi_safi", flat=True)
            )
            new = []
            for afi in dict.fromkeys(parent.address_families or []):
                if afi in AFI_SAFI_VALUES and afi not in have:
                    new.append(row(afi_safi=afi, activate=True, **{key: parent.id}))
            row.objects.bulk_create(new)


class Migration(migrations.Migration):

    dependencies = [
        ("routing", "0017_bgpneighboraf"),
    ]

    operations = [
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
