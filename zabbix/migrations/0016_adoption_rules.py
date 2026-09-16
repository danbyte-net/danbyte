import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0163_status_monitoring_state"),
        ("zabbix", "0015_change_kind_labels"),
    ]

    operations = [
        migrations.CreateModel(
            name="ZabbixAdoptionRule",
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
                (
                    "scope",
                    models.CharField(
                        choices=[
                            ("name", "Host name"),
                            ("group", "Host group"),
                            ("ip", "Address"),
                        ],
                        default="name",
                        max_length=8,
                    ),
                ),
                (
                    "pattern",
                    models.CharField(
                        help_text=(
                            "Glob such as kbh-* or *-core?. Prefix with regex: for a "
                            "regular expression. An address rule may be a CIDR."
                        ),
                        max_length=255,
                    ),
                ),
                ("weight", models.PositiveSmallIntegerField(default=100)),
                ("enabled", models.BooleanField(default=True)),
                (
                    "connection",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="adoption_rules",
                        to="zabbix.zabbixconnection",
                    ),
                ),
                (
                    "device_type",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="api.devicetype",
                    ),
                ),
                (
                    "role",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="api.devicerole",
                    ),
                ),
                (
                    "site",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="zabbix_adoption_rules",
                        to="api.site",
                    ),
                ),
                (
                    "tenant",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="zabbix_adoption_rules",
                        to="core.tenant",
                    ),
                ),
            ],
            options={
                "ordering": ["weight", "pattern"],
                "indexes": [
                    models.Index(
                        fields=["connection", "enabled"],
                        name="zabbix_zabb_connect_8782a9_idx",
                    )
                ],
            },
        ),
    ]
