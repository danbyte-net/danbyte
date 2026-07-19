"""RouteTarget model + VRF import/export M2Ms."""
import uuid

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0007_seed_ha_roles"),
        ("core", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="RouteTarget",
            fields=[
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("name", models.CharField(max_length=21,
                    help_text="ASN:value, e.g. 65000:100 or 192.0.2.1:42.")),
                ("description", models.TextField(blank=True)),
                ("tenant", models.ForeignKey(on_delete=models.CASCADE,
                                             related_name="route_targets",
                                             to="core.tenant")),
            ],
            options={"ordering": ["name"]},
        ),
        migrations.AddConstraint(
            model_name="RouteTarget",
            constraint=models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_rt_tenant_name"
            ),
        ),
        migrations.AddField(
            model_name="vrf",
            name="import_targets",
            field=models.ManyToManyField(
                blank=True, related_name="importing_vrfs", to="api.routetarget",
                help_text=("Route targets this VRF accepts routes from. "
                           "In a hub-and-spoke VPN the hub imports each spoke's RT."),
            ),
        ),
        migrations.AddField(
            model_name="vrf",
            name="export_targets",
            field=models.ManyToManyField(
                blank=True, related_name="exporting_vrfs", to="api.routetarget",
                help_text=("Route targets this VRF tags its own routes with. "
                           "Other VRFs importing this RT will receive those routes."),
            ),
        ),
    ]
