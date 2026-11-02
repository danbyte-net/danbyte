"""Ethernet segment membership becomes an explicit through model.

The plain many-to-many already has the table, its two foreign keys and the
(segment, interface) unique constraint, so the model is declared over that
table in state only - no row is copied or rewritten. The one real database
change is the new nullable ``df_preference`` column. The table keeps its
integer ``id`` (see ``EthernetSegmentMember``).
"""
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0247_natrule_out_interface"),
        ("routing", "0015_policy_rules_route_table"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.CreateModel(
                    name="EthernetSegmentMember",
                    fields=[
                        ("id", models.BigAutoField(primary_key=True, serialize=False)),
                        ("segment", models.ForeignKey(
                            db_column="ethernetsegment_id",
                            on_delete=django.db.models.deletion.CASCADE,
                            related_name="members", to="routing.ethernetsegment",
                        )),
                        ("interface", models.ForeignKey(
                            on_delete=django.db.models.deletion.CASCADE,
                            related_name="ethernet_segment_memberships",
                            to="api.interface",
                        )),
                    ],
                    options={
                        "db_table": "routing_ethernetsegment_interfaces",
                        "ordering": ["segment__name", "interface__device__name",
                                     "interface__name"],
                        "unique_together": {("segment", "interface")},
                    },
                ),
                migrations.AlterField(
                    model_name="ethernetsegment",
                    name="interfaces",
                    field=models.ManyToManyField(
                        blank=True, related_name="ethernet_segments",
                        through="routing.EthernetSegmentMember", to="api.interface",
                    ),
                ),
            ],
        ),
        migrations.AddField(
            model_name="ethernetsegmentmember",
            name="df_preference",
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
    ]
