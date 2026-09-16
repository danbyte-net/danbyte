import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0163_status_monitoring_state"),
        ("zabbix", "0011_two_way"),
    ]

    operations = [
        migrations.AddField(
            model_name="zabbixconnection",
            name="adopt_hosts",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="zabbixconnection",
            name="adopt_site",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to="api.site",
            ),
        ),
        migrations.AddField(
            model_name="zabbixconnection",
            name="adopt_role",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to="api.devicerole",
            ),
        ),
        migrations.AddField(
            model_name="zabbixconnection",
            name="adopt_device_type",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to="api.devicetype",
            ),
        ),
        migrations.AlterField(
            model_name="zabbixchange",
            name="kind",
            field=models.CharField(
                choices=[
                    ("create_host", "Create host"),
                    ("update_host", "Update host"),
                    ("link_template", "Link templates"),
                    ("ambiguous", "Needs a decision"),
                    ("prune_host", "Remove host"),
                    ("adopt_host", "Adopt host"),
                ],
                max_length=16,
            ),
        ),
    ]
