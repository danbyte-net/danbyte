# A PostgreSQL ICU collation with NUMERIC ordering ("kn"): "disk2" sorts
# before "disk10". Applied via Collate(...) in list orderings so component
# names read in human order everywhere.
from django.contrib.postgres.operations import CreateCollation
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0098_seed_inventoryitem_statuses"),
    ]

    operations = [
        CreateCollation(
            "natural_sort",
            provider="icu",
            locale="und-u-kn-true",
        ),
    ]
