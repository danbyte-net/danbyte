import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0163_status_monitoring_state"),
        ("zabbix", "0012_adoption"),
    ]

    operations = [
        migrations.AddField(
            model_name="zabbixconnection",
            name="read_inventory",
            field=models.BooleanField(default=False),
        ),
        migrations.CreateModel(
            name="ZabbixHostFacts",
            fields=[
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("data", models.JSONField(blank=True, default=dict)),
                ("interfaces", models.JSONField(blank=True, default=list)),
                ("polled_at", models.DateTimeField(blank=True, null=True)),
                ("reachable", models.BooleanField(blank=True, null=True)),
                (
                    "connection",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="facts",
                        to="zabbix.zabbixconnection",
                    ),
                ),
                (
                    "device",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="zabbix_facts",
                        to="api.device",
                    ),
                ),
                (
                    "tenant",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="zabbix_facts",
                        to="core.tenant",
                    ),
                ),
            ],
            options={
                "ordering": ["-polled_at"],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("connection", "device"),
                        name="uniq_zbx_facts_conn_device",
                    )
                ],
            },
        ),
    ]
