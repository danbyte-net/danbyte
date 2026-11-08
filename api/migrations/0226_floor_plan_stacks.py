# Floors (floor plans P1a). A FloorPlanStack is a floor plan as users see it
# - a building or hall - and each FloorPlan becomes one of its floors.
#
# The existing plans are grouped one stack per (tenant, location), in the
# order the floor switcher showed them (natural name order), so the switcher
# shows the same floors in the same order as before. A stack takes the name of
# its only plan, or of its location when it holds several. Nothing is merged
# across locations, renamed or deleted. Only plans without a stack are
# touched, so a second run changes nothing.
#
# The unique (tenant, location, name) on plans becomes (stack, name) for
# stacked plans and stays for unstacked ones: names were unique per location,
# so they are unique per stack. The constraints change before the data step
# so no ALTER TABLE follows the row updates in the same transaction.

import django.db.models.deletion
import django.db.models.functions.comparison
import taggit.managers
import uuid
from django.db import migrations, models
from django.db.models.functions import Collate


def group_plans_into_stacks(apps, schema_editor):
    FloorPlan = apps.get_model("api", "FloorPlan")
    FloorPlanStack = apps.get_model("api", "FloorPlanStack")
    Location = apps.get_model("api", "Location")
    maxlen = FloorPlanStack._meta.get_field("name").max_length
    groups = (
        FloorPlan.objects.filter(stack__isnull=True)
        .values_list("tenant_id", "location_id").distinct()
    )
    for tenant_id, location_id in list(groups):
        plans = list(
            FloorPlan.objects.filter(
                tenant_id=tenant_id, location_id=location_id, stack__isnull=True
            ).order_by(Collate("name", "natural_sort"), "pk")
        )
        if len(plans) == 1:
            name = plans[0].name
        else:
            name = Location.objects.get(pk=location_id).name
        stack, _ = FloorPlanStack.objects.get_or_create(
            tenant_id=tenant_id, location_id=location_id, name=name[:maxlen]
        )
        for i, plan in enumerate(plans):
            plan.stack = stack
            plan.floor_order = 10 * i
        FloorPlan.objects.bulk_update(plans, ["stack", "floor_order"])


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0225_rooms'),
        ('core', '0061_tenantsettings_coverage_warning_days'),
    ]

    operations = [
        migrations.CreateModel(
            name='FloorPlanStack',
            fields=[
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('name', models.CharField(max_length=128)),
                ('description', models.TextField(blank=True, db_default='', default='')),
            ],
            options={
                'ordering': [django.db.models.functions.comparison.Collate('name', 'natural_sort')],
            },
        ),
        migrations.RemoveConstraint(
            model_name='floorplan',
            name='uniq_floorplan_tenant_location_name',
        ),
        migrations.AddField(
            model_name='floorplan',
            name='elevation_mm',
            field=models.IntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='floorplan',
            name='floor_order',
            field=models.SmallIntegerField(db_default=0, default=0),
        ),
        migrations.AddField(
            model_name='floorplanstack',
            name='location',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='floor_plan_stacks', to='api.location'),
        ),
        migrations.AddField(
            model_name='floorplanstack',
            name='tags',
            field=taggit.managers.TaggableManager(blank=True, help_text='A comma-separated list of tags.', through='core.TaggedItem', to='core.Tag', verbose_name='Tags'),
        ),
        migrations.AddField(
            model_name='floorplanstack',
            name='tenant',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='floor_plan_stacks', to='core.tenant'),
        ),
        migrations.AddField(
            model_name='floorplan',
            name='stack',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.RESTRICT, related_name='floors', to='api.floorplanstack'),
        ),
        migrations.AddConstraint(
            model_name='floorplan',
            constraint=models.UniqueConstraint(condition=models.Q(('stack__isnull', False)), fields=('stack', 'name'), name='uniq_floorplan_stack_name'),
        ),
        migrations.AddConstraint(
            model_name='floorplan',
            constraint=models.UniqueConstraint(condition=models.Q(('stack__isnull', True)), fields=('tenant', 'location', 'name'), name='uniq_floorplan_unstacked_location_name'),
        ),
        migrations.AddConstraint(
            model_name='floorplanstack',
            constraint=models.UniqueConstraint(fields=('tenant', 'location', 'name'), name='uniq_floorplanstack_tenant_location_name'),
        ),
        migrations.RunPython(group_plans_into_stacks, migrations.RunPython.noop),
    ]
