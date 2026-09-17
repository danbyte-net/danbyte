from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("routing", "0009_bgp_knobs")]

    operations = [
        migrations.AddField(
            model_name="bgpaddressfamily",
            name="advertise_ipv4_unicast",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="bgpaddressfamily",
            name="advertise_ipv6_unicast",
            field=models.BooleanField(default=False),
        ),
    ]
