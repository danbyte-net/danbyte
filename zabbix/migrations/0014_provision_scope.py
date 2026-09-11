from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("zabbix", "0013_host_facts"),
    ]

    operations = [
        migrations.AddField(
            model_name="zabbixconnection",
            name="provision_scope",
            field=models.CharField(
                choices=[
                    ("checks", "Devices with a Zabbix check"),
                    ("rules", "Every device the rules match"),
                ],
                default="checks",
                max_length=8,
            ),
        ),
    ]
