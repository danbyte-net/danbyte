# Rows created before slugs were generated stored "" - and a second row in
# the same scope then collided with the unique constraint (#104). Give every
# blank slug a real one so those rows stop blocking new ones.

from django.db import migrations
from django.utils.text import slugify

# (app_label, model, scope fields that the uniqueness is measured within)
TARGETS = [
    ("api", "Location", ["tenant_id", "site_id"]),
    ("api", "Region", ["tenant_id"]),
    ("api", "VLANGroup", ["tenant_id"]),
    ("api", "ContactGroup", ["tenant_id"]),
    ("api", "ContactRole", ["tenant_id"]),
    ("api", "Provider", ["tenant_id"]),
    ("api", "CircuitType", ["tenant_id"]),
    ("api", "RIR", ["tenant_id"]),
    ("api", "WirelessLANGroup", ["tenant_id"]),
    ("api", "TunnelGroup", ["tenant_id"]),
    ("api", "L2VPN", ["tenant_id"]),
    ("api", "FloorTileType", ["tenant_id"]),
]


def backfill(apps, schema_editor):
    for app_label, model_name, scope in TARGETS:
        try:
            model = apps.get_model(app_label, model_name)
        except LookupError:
            continue
        fields = {f.name for f in model._meta.concrete_fields}
        scope = [s for s in scope if s.removesuffix("_id") in fields]
        for row in model.objects.filter(slug="").iterator():
            base = slugify(getattr(row, "name", "") or "")[:100] or "item"
            taken = model.objects.filter(
                **{s: getattr(row, s) for s in scope}
            ).exclude(pk=row.pk).values_list("slug", flat=True)
            used = set(taken)
            candidate, n = base, 1
            while candidate in used:
                n += 1
                candidate = f"{base[:96]}-{n}"
            row.slug = candidate
            row.save(update_fields=["slug"])


class Migration(migrations.Migration):
    dependencies = [("api", "0137_port_reservation_site")]
    operations = [migrations.RunPython(backfill, migrations.RunPython.noop)]
