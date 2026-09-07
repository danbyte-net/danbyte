from django.db import migrations


def _human(text):
    text = (text or "").strip()
    if not text.isdigit():
        return None
    mbps = int(text) / 1000
    if mbps <= 0:
        return None
    return f"{mbps / 1000:g}G" if mbps >= 1000 else f"{mbps:g}M"


def normalize(apps, schema_editor):
    """Speeds written as bare kbps numbers (scrapers, imports) become the
    dropdown's form - the same rewrite the models now apply on save."""
    for label in ("Interface", "VMInterface"):
        model = apps.get_model("api", label)
        for row in model.objects.exclude(speed="").only("id", "speed").iterator():
            human = _human(row.speed)
            if human and human != row.speed:
                model.objects.filter(pk=row.pk).update(speed=human)


class Migration(migrations.Migration):
    dependencies = [("api", "0153_interface_lag_protocol")]
    operations = [migrations.RunPython(normalize, migrations.RunPython.noop)]
