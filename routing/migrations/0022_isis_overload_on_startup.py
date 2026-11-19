import django.core.validators
from django.db import migrations, models

KEY = "overload_on_startup"
LOW, HIGH = 1, 86400


def _seconds(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, str) and v.strip().isdigit():
        v = int(v.strip())
    if isinstance(v, int) and LOW <= v <= HIGH:
        return v
    return None


def carry_from_extra(apps, schema_editor):
    """Move an ``extra["overload_on_startup"]`` of whole seconds into the
    field and drop the key. Only rows that carry the key are read; a value
    that is not whole seconds in range stays in ``extra`` untouched. A second
    run finds nothing to move."""
    ISISInstance = apps.get_model("routing", "ISISInstance")
    for row in ISISInstance.objects.filter(extra__has_key=KEY).iterator(chunk_size=500):
        v = _seconds((row.extra or {}).get(KEY))
        if v is None:
            continue
        if row.overload_on_startup is not None and row.overload_on_startup != v:
            continue  # the field was set by hand; leave both for the operator
        extra = dict(row.extra)
        extra.pop(KEY, None)
        row.overload_on_startup = v
        row.extra = extra
        row.save(update_fields=["overload_on_startup", "extra"])


class Migration(migrations.Migration):

    dependencies = [
        ("routing", "0021_bgp_maximum_prefix_detail"),
    ]

    operations = [
        migrations.AddField(
            model_name="isisinstance",
            name="overload_on_startup",
            field=models.PositiveIntegerField(
                blank=True, null=True,
                validators=[
                    django.core.validators.MinValueValidator(1),
                    django.core.validators.MaxValueValidator(86400),
                ],
            ),
        ),
        migrations.RunPython(carry_from_extra, migrations.RunPython.noop),
    ]
