"""Seed the editable Connect-protocol catalog for tenants that already exist.

New tenants get these from ``TenantViewSet.perform_create`` /
``seed_builtin_connect_protocols``; this backfills the ones created before the
feature. Idempotent (keyed on ``(tenant, name)``) and reversible as a no-op —
the rows are user-editable catalog data, not something to tear down on rollback.
"""
from django.db import migrations

# Mirrors monitoring.connect_protocol_seeds.BUILTIN_CONNECT_PROTOCOLS; inlined so
# the migration stays stable if that module later changes.
BUILTIN = [
    ("SSH", "ssh://{username}@{host}", "terminal", 22, 10),
    ("Telnet", "telnet://{host}", "terminal", 23, 20),
    ("RDP", "rdp://{host}", "monitor", 3389, 30),
    ("HTTPS", "https://{host}", "globe", 443, 40),
    ("HTTP", "http://{host}", "globe", 80, 50),
]


def seed(apps, schema_editor):
    Tenant = apps.get_model("core", "Tenant")
    ConnectProtocol = apps.get_model("monitoring", "ConnectProtocol")
    for tenant in Tenant.objects.all():
        for name, template, icon, port, weight in BUILTIN:
            ConnectProtocol.objects.get_or_create(
                tenant=tenant,
                name=name,
                defaults={
                    "url_template": template,
                    "icon": icon,
                    "default_port": port,
                    "weight": weight,
                },
            )


def unseed(apps, schema_editor):
    # Catalog data is user-editable; leave it in place on reverse.
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("monitoring", "0058_connectprotocol"),
    ]

    operations = [migrations.RunPython(seed, unseed)]
