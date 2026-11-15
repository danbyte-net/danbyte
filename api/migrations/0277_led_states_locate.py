# Status LEDs (api.led_state): the device locate beacon, a lifecycle status
# on installed modules (their LEDs' source), and the LED bindings' validator.
# Every tenant's status catalog gains the module vocabulary; existing rows are
# merged by slug and left alone, and existing modules keep no status (their
# LEDs read their device's until one is set).

import api.led_state
import django.db.models.deletion
from django.db import migrations, models


def seed_statuses(apps, schema_editor):
    from api.status_registry import seed_builtin_statuses

    Tenant = apps.get_model("core", "Tenant")
    Status = apps.get_model("api", "Status")
    for tenant in Tenant.objects.all():
        seed_builtin_statuses(tenant, Status=Status)


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0276_device_type_studio_images'),
    ]

    operations = [
        migrations.AddField(
            model_name='device',
            name='locate_at',
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name='device',
            name='locate_by',
            field=models.CharField(blank=True, db_default='', default='', editable=False, max_length=150),
        ),
        migrations.AddField(
            model_name='device',
            name='locate_until',
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name='module',
            name='status',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name='modules', to='api.status'),
        ),
        migrations.AlterField(
            model_name='device',
            name='model_leds',
            field=models.JSONField(blank=True, default=None, editable=False, help_text="Status light bindings for the 3D model's LEDs.", null=True, validators=[api.led_state.validate_model_leds]),
        ),
        migrations.AlterField(
            model_name='devicetype',
            name='model_leds',
            field=models.JSONField(blank=True, default=None, editable=False, help_text="Status light bindings for the 3D model's LEDs.", null=True, validators=[api.led_state.validate_model_leds]),
        ),
        migrations.AlterField(
            model_name='moduletype',
            name='model_leds',
            field=models.JSONField(blank=True, default=None, editable=False, help_text="Status light bindings for the 3D model's LEDs.", null=True, validators=[api.led_state.validate_model_leds]),
        ),
        migrations.RunPython(seed_statuses, migrations.RunPython.noop),
    ]
