"""Device side of the model — Manufacturer + DeviceType FK + IP/device link.

  * Manufacturer model — tenant-scoped maker (Dell, Cisco, Juniper, …).
  * DeviceType.manufacturer flips from a free-text CharField to a FK to
    Manufacturer. The data migration creates a Manufacturer row per
    distinct value already in use per tenant.
  * DeviceType gains ``part_number`` and ``u_height`` for rack accounting.
  * Device gains ``status`` (active/planned/staged/offline/inventory/
    decommissioning), ``asset_tag``, and a ``primary_ip`` FK.
  * IPAddress.assigned_device — the reverse side. Set this and the IP
    appears on the device detail page.
"""
import uuid

from django.db import migrations, models
from django.utils.text import slugify


def migrate_manufacturer_strings(apps, schema_editor):
    Tenant = apps.get_model("core", "Tenant")
    Manufacturer = apps.get_model("api", "Manufacturer")
    DeviceType = apps.get_model("api", "DeviceType")
    for tenant in Tenant.objects.all():
        # Distinct non-empty maker strings per tenant.
        used = (DeviceType.objects.filter(tenant=tenant)
                .exclude(manufacturer="")
                .values_list("manufacturer", flat=True).distinct())
        mfr_map = {}
        for raw in used:
            name = raw.strip()
            if not name:
                continue
            slug = slugify(name)
            mfr, _ = Manufacturer.objects.get_or_create(
                tenant=tenant, slug=slug,
                defaults={"id": uuid.uuid4(), "name": name},
            )
            mfr_map[raw] = mfr
        # Point each device type at the new Manufacturer row.
        for dt in DeviceType.objects.filter(tenant=tenant):
            if dt.manufacturer and dt.manufacturer in mfr_map:
                dt.manufacturer_new = mfr_map[dt.manufacturer]
                dt.save(update_fields=["manufacturer_new"])


def reverse_noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0008_route_targets"),
        ("core", "0001_initial"),
    ]

    operations = [
        # ─── Manufacturer ───
        migrations.CreateModel(
            name="Manufacturer",
            fields=[
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("name", models.CharField(max_length=128)),
                ("slug", models.SlugField(max_length=128)),
                ("url", models.URLField(blank=True, default="")),
                ("description", models.TextField(blank=True)),
                ("tenant", models.ForeignKey(on_delete=models.CASCADE,
                                             related_name="manufacturers",
                                             to="core.tenant")),
            ],
            options={"ordering": ["name"]},
        ),
        migrations.AddConstraint(
            model_name="Manufacturer",
            constraint=models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_mfr_tenant_slug"
            ),
        ),
        # ─── Temp FK + data migration on DeviceType ───
        migrations.AddField(
            model_name="devicetype",
            name="manufacturer_new",
            field=models.ForeignKey(
                blank=True, null=True, on_delete=models.PROTECT,
                related_name="device_types_pending", to="api.manufacturer",
            ),
        ),
        migrations.RunPython(migrate_manufacturer_strings, reverse_noop),
        migrations.RemoveField(model_name="devicetype", name="manufacturer"),
        migrations.RenameField(model_name="devicetype",
                               old_name="manufacturer_new", new_name="manufacturer"),
        migrations.AlterField(
            model_name="devicetype",
            name="manufacturer",
            field=models.ForeignKey(
                blank=True, null=True, on_delete=models.PROTECT,
                related_name="device_types", to="api.manufacturer",
            ),
        ),
        # ─── DeviceType additions (model already exists in 0001_initial) ───
        migrations.AlterField(
            model_name="devicetype",
            name="model",
            field=models.CharField(blank=True, max_length=255,
                help_text="Vendor part / model identifier."),
        ),
        migrations.AddField(
            model_name="devicetype",
            name="part_number",
            field=models.CharField(blank=True, max_length=128),
        ),
        migrations.AddField(
            model_name="devicetype",
            name="u_height",
            field=models.PositiveSmallIntegerField(
                default=1,
                help_text="Height in rack units. 0 for non-rack devices.",
            ),
        ),
        # ─── Device additions ───
        migrations.AddField(
            model_name="device",
            name="status",
            field=models.CharField(
                choices=[
                    ("active", "Active"), ("planned", "Planned"),
                    ("staged", "Staged"), ("offline", "Offline"),
                    ("inventory", "Inventory"),
                    ("decommissioning", "Decommissioning"),
                ],
                default="active",
                max_length=20,
            ),
        ),
        migrations.AddField(
            model_name="device",
            name="asset_tag",
            field=models.CharField(blank=True, max_length=128),
        ),
        # ─── IP ↔ device link ───
        migrations.AddField(
            model_name="ipaddress",
            name="assigned_device",
            field=models.ForeignKey(
                blank=True, null=True, on_delete=models.SET_NULL,
                related_name="ip_addresses", to="api.device",
                help_text=("Device this IP lives on. Setting it makes the IP "
                           "show up on the device detail page and lets the "
                           "device pick this IP as its primary management "
                           "address."),
            ),
        ),
        migrations.AddField(
            model_name="device",
            name="primary_ip",
            field=models.ForeignKey(
                blank=True, null=True, on_delete=models.SET_NULL,
                related_name="primary_for", to="api.ipaddress",
                help_text=("The IP used to reach this device for management. "
                           "Pick from IPs already assigned to this device."),
            ),
        ),
    ]
