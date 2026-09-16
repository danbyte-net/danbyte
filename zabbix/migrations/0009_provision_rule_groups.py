"""Rename the rule and give it host groups.

Hand-written: the autodetector proposed dropping the table and creating a new
one, which would take every rule an install already has with it.
"""
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0001_initial"),
        ("zabbix", "0008_link_existing_engines"),
    ]

    operations = [
        migrations.RenameModel(
            old_name="ZabbixTemplateRule", new_name="ZabbixProvisionRule"
        ),
        migrations.AlterField(
            model_name="zabbixprovisionrule",
            name="connection",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="provision_rules",
                to="zabbix.zabbixconnection",
            ),
        ),
        migrations.AlterField(
            model_name="zabbixprovisionrule",
            name="tenant",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="zabbix_provision_rules",
                to="core.tenant",
            ),
        ),
        migrations.AddField(
            model_name="zabbixprovisionrule",
            name="groups",
            field=models.JSONField(blank=True, default=list),
        ),
    ]
