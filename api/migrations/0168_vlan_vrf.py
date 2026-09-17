import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("api", "0167_fhrpgroup_nd")]

    operations = [
        migrations.AddField(
            model_name="vlan",
            name="vrf",
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                related_name="vlans", to="api.vrf",
                help_text="Optional: the VRF this VLAN's SVI belongs to.",
            ),
        ),
    ]
