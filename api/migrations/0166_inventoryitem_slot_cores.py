from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0165_l2vpn_vrf_vni"),
    ]

    operations = [
        migrations.AddField(
            model_name="inventoryitem",
            name="slot",
            field=models.CharField(
                blank=True, default="", max_length=32,
                help_text='Where it sits: "Socket 1", "DIMM A1", "Bay 3".',
            ),
        ),
        migrations.AddField(
            model_name="inventoryitem",
            name="cores",
            field=models.PositiveSmallIntegerField(
                blank=True, null=True, help_text="CPU cores (kind=cpu)."
            ),
        ),
    ]
