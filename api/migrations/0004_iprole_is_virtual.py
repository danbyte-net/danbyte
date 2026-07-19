"""Add IPRole.is_virtual for HSRP/VRRP/VIP / shared-address roles."""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0003_iprole_ipstatus"),
    ]

    operations = [
        migrations.AddField(
            model_name="iprole",
            name="is_virtual",
            field=models.BooleanField(
                default=False,
                help_text=("Flag this role as a virtual / shared address "
                           "(HSRP / VRRP VIP, anycast). UI hints distinguish "
                           "virtual VIPs from physical interface IPs."),
            ),
        ),
    ]
