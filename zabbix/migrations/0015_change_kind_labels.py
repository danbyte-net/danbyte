from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("zabbix", "0014_provision_scope"),
    ]

    operations = [
        migrations.AlterField(
            model_name="zabbixchange",
            name="kind",
            field=models.CharField(
                choices=[
                    ("create_host", "Create in Zabbix"),
                    ("update_host", "Update in Zabbix"),
                    ("link_template", "Link in Zabbix"),
                    ("ambiguous", "Needs a decision"),
                    ("prune_host", "Remove from Zabbix"),
                    ("adopt_host", "Adopt into Danbyte"),
                ],
                max_length=16,
            ),
        ),
    ]
