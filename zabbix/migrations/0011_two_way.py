import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("monitoring", "0089_checkstate_last_detail"),
        ("zabbix", "0010_provision_rule_site_proxy"),
    ]

    operations = [
        migrations.AddField(
            model_name="zabbixconnection",
            name="sync_maintenance",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="zabbixconnection",
            name="last_maintenance_sync_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="zabbixconnection",
            name="write_acknowledgements",
            field=models.BooleanField(default=False),
        ),
        migrations.CreateModel(
            name="ZabbixMaintenance",
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
                ("maintenanceid", models.CharField(max_length=32)),
                ("name", models.CharField(max_length=128)),
                ("starts_at", models.DateTimeField()),
                ("ends_at", models.DateTimeField()),
                ("hostids", models.JSONField(blank=True, default=list)),
                ("synced_at", models.DateTimeField(blank=True, null=True)),
                ("last_error", models.TextField(blank=True, default="")),
                (
                    "connection",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="maintenances",
                        to="zabbix.zabbixconnection",
                    ),
                ),
                (
                    "event",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="zabbix_maintenances",
                        to="monitoring.maintenanceevent",
                    ),
                ),
                (
                    "tenant",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="zabbix_maintenances",
                        to="core.tenant",
                    ),
                ),
            ],
            options={
                "ordering": ["-starts_at"],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("connection", "event"),
                        name="uniq_zbx_maintenance_conn_event",
                    )
                ],
            },
        ),
    ]
