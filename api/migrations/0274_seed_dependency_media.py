"""Seed the starter dependency media for every existing tenant (#450).

The rows are inline so the migration does not change with the runtime list
(``api.dependency_media_seeds``). A tenant that already has media is left
alone; a second run changes nothing. Reverse is a no-op: the rows are the
tenant's to keep or delete.
"""
from django.db import migrations

# (slug, name, color, weight, icon, line_style)
MEDIA = [
    ("ethernet", "Ethernet", "#3b82f6", 10, "cable", "solid"),
    ("fibre", "Fibre", "#f97316", 20, "spline", "solid"),
    ("radio", "Radio", "#8b5cf6", 30, "radio-tower", "dashed"),
    ("vpn", "VPN/tunnel", "#14b8a6", 40, "lock", "dotted"),
    ("lte-5g", "LTE/5G", "#ec4899", 50, "signal", "dashed"),
    ("satellite", "Satellite", "#64748b", 60, "satellite", "dotted"),
]


def forwards(apps, schema_editor):
    Tenant = apps.get_model("core", "Tenant")
    DependencyMedium = apps.get_model("api", "DependencyMedium")
    for tenant in Tenant.objects.all():
        if DependencyMedium.objects.filter(tenant=tenant).exists():
            continue
        for slug, name, color, weight, icon, line_style in MEDIA:
            DependencyMedium.objects.get_or_create(
                tenant=tenant, slug=slug,
                defaults={"name": name, "color": color, "weight": weight,
                          "icon": icon, "line_style": line_style, "description": ""},
            )


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0273_device_dependencies"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
