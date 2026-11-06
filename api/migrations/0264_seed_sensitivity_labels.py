"""Seed the starter sensitivity labels for tenants that already exist.

New tenants get them from ``TenantViewSet.perform_create`` and ``bootstrap``
(``api.sensitivity.seed_sensitivity_labels``). Once per tenant: the tenant's
settings row records it, so a later run (or bootstrap) never brings back a
label the tenant deleted, and a row already under a seed's slug is left as it
is. Reverse is a no-op - the rows are the tenant's catalog by then.
"""
from django.db import migrations

# Mirrors api.sensitivity.STARTER_LABELS; inlined so the migration stays
# stable if that module changes.
STARTER = [
    ("public", "Public", "#16a34a", "globe", 10, "May be shared outside the organisation."),
    ("internal", "Internal", "#2563eb", "building-2", 20, "For people inside the organisation."),
    ("confidential", "Confidential", "#d97706", "shield", 30,
     "For the people who need it; not to be passed on."),
    ("restricted", "Restricted", "#dc2626", "shield-alert", 40, "For named people only."),
]


def seed(apps, schema_editor):
    Tenant = apps.get_model("core", "Tenant")
    TenantSettings = apps.get_model("core", "TenantSettings")
    SensitivityLabel = apps.get_model("api", "SensitivityLabel")
    for tenant in Tenant.objects.all():
        settings, _ = TenantSettings.objects.get_or_create(tenant=tenant)
        if settings.sensitivity_labels_seeded:
            continue
        have = set(SensitivityLabel.objects.filter(tenant=tenant).values_list("slug", flat=True))
        for slug, name, color, icon, weight, description in STARTER:
            if slug not in have:
                SensitivityLabel.objects.create(
                    tenant=tenant, slug=slug, name=name, color=color, icon=icon,
                    weight=weight, description=description,
                )
        TenantSettings.objects.filter(pk=settings.pk).update(sensitivity_labels_seeded=True)


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0263_sensitivity_labels"),
    ]

    operations = [migrations.RunPython(seed, migrations.RunPython.noop)]
