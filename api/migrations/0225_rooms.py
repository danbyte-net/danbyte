# Rooms (floor plans P1b): a Room under a Location, and the room a device,
# rack or cabinet stands in. Every tenant's status catalog gains the location
# vocabulary for rooms (active / planned / decommissioning / retired, active
# the default) so the picker is not empty - seed_builtin_statuses merges by
# slug and leaves what the tenant already has alone.

import django.db.models.deletion
import django.db.models.functions.comparison
import taggit.managers
import uuid
from django.db import migrations, models


def seed_statuses(apps, schema_editor):
    from api.status_registry import seed_builtin_statuses

    Tenant = apps.get_model("core", "Tenant")
    Status = apps.get_model("api", "Status")
    for tenant in Tenant.objects.all():
        seed_builtin_statuses(tenant, Status=Status)


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0223_dashboard_recent_idx'),
        ('core', '0061_tenantsettings_coverage_warning_days'),
    ]

    operations = [
        migrations.CreateModel(
            name='Room',
            fields=[
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('custom_fields', models.JSONField(blank=True, default=dict, help_text='User-defined custom fields')),
                ('numid', models.PositiveIntegerField(blank=True, db_index=True, editable=False, help_text='Per-tenant human-readable number (see NumIdSequence).', null=True)),
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('name', models.CharField(max_length=128)),
                ('slug', models.SlugField(blank=True, max_length=128)),
                ('code', models.CharField(blank=True, db_default='', default='', help_text="The room's number or code on the door (e.g. 210, B1-07).", max_length=32)),
                ('color', models.CharField(blank=True, db_default='', default='', max_length=7)),
                ('description', models.TextField(blank=True, db_default='', default='')),
                ('location', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='rooms', to='api.location')),
                ('status', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name='rooms', to='api.status')),
                ('tags', taggit.managers.TaggableManager(blank=True, help_text='A comma-separated list of tags.', through='core.TaggedItem', to='core.Tag', verbose_name='Tags')),
                ('tenant', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='rooms', to='core.tenant')),
            ],
            options={
                'ordering': [django.db.models.functions.comparison.Collate('location__name', 'natural_sort'), django.db.models.functions.comparison.Collate('name', 'natural_sort')],
            },
        ),
        migrations.AddField(
            model_name='cabinet',
            name='room',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='cabinets', to='api.room'),
        ),
        migrations.AddField(
            model_name='device',
            name='room',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='devices', to='api.room'),
        ),
        migrations.AddField(
            model_name='rack',
            name='room',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='racks', to='api.room'),
        ),
        migrations.AddConstraint(
            model_name='room',
            constraint=models.UniqueConstraint(fields=('tenant', 'location', 'slug'), name='uniq_room_tenant_location_slug'),
        ),
        migrations.AddConstraint(
            model_name='room',
            constraint=models.UniqueConstraint(fields=('tenant', 'location', 'name'), name='uniq_room_tenant_location_name'),
        ),
        migrations.RunPython(seed_statuses, migrations.RunPython.noop),
    ]
