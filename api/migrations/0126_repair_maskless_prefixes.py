# Prefixes saved without a mask (issue #47: cidr was an unvalidated
# CharField) are invisible in the tree, which parses CIDRs - but still count
# on the dashboard, so they can't even be found to delete. Repair them to the
# only defensible reading of a bare address: a host prefix (/32, /128).
# Unparseable garbage is left alone rather than guessed at.

import ipaddress

from django.db import migrations


def _repair(apps, schema_editor):
    Prefix = apps.get_model("api", "Prefix")
    for row in Prefix.objects.exclude(cidr__contains="/"):
        try:
            addr = ipaddress.ip_address(row.cidr.strip())
        except ValueError:
            continue
        row.cidr = f"{addr}/{32 if addr.version == 4 else 128}"
        row.save(update_fields=["cidr"])


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0125_text_hyphens"),
    ]

    operations = [
        migrations.RunPython(_repair, migrations.RunPython.noop),
    ]
