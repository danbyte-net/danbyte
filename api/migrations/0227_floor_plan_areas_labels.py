"""Floor plans P2: rooms, areas and labels drawn on a floor, and free layout.

Adds ``FloorPlanArea`` and ``FloorPlanLabel``, ``FloorPlan.layout_mode``
(every plan stays "grid"), widens tile geometry to floats (a lossless type
change) and lets a tile linked to an object go without a tile type.
"""

import django.core.validators
import django.db.models.deletion
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0226_floor_plan_stacks'),
    ]

    operations = [
        migrations.CreateModel(
            name='FloorPlanArea',
            fields=[
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('shape', models.CharField(choices=[('rect', 'Rectangle'), ('polygon', 'Polygon')], default='rect', max_length=8)),
                ('x', models.FloatField(default=0)),
                ('y', models.FloatField(default=0)),
                ('width', models.FloatField(default=1)),
                ('height', models.FloatField(default=1)),
                ('rotation', models.FloatField(default=0, help_text='Degrees about the centre (rectangles only).')),
                ('points', models.JSONField(blank=True, default=list)),
                ('label', models.CharField(blank=True, default='', help_text="Shown in place of the linked room's or location's name.", max_length=64)),
                ('color', models.CharField(blank=True, default='', max_length=7)),
                ('fill_opacity', models.PositiveSmallIntegerField(default=15, help_text='Percent.', validators=[django.core.validators.MaxValueValidator(100)])),
                ('border', models.CharField(choices=[('solid', 'Solid'), ('dashed', 'Dashed'), ('none', 'None')], default='solid', max_length=8)),
                ('show_name', models.BooleanField(default=True)),
                ('z', models.SmallIntegerField(default=0, help_text='Draw order among areas.')),
                ('locked', models.BooleanField(default=False)),
            ],
            options={
                'ordering': ['z', 'created_at'],
            },
        ),
        migrations.CreateModel(
            name='FloorPlanLabel',
            fields=[
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('text', models.TextField()),
                ('x', models.FloatField(default=0)),
                ('y', models.FloatField(default=0)),
                ('width', models.FloatField(blank=True, null=True)),
                ('height', models.FloatField(blank=True, null=True)),
                ('rotation', models.FloatField(default=0)),
                ('font_mm', models.PositiveSmallIntegerField(default=300, help_text='Text height on the floor, in millimetres.', validators=[django.core.validators.MinValueValidator(20), django.core.validators.MaxValueValidator(5000)])),
                ('weight', models.CharField(choices=[('normal', 'Normal'), ('bold', 'Bold')], default='normal', max_length=8)),
                ('align', models.CharField(choices=[('left', 'Left'), ('center', 'Center'), ('right', 'Right')], default='left', max_length=8)),
                ('color', models.CharField(blank=True, choices=[('', 'Default'), ('muted', 'Muted'), ('red', 'Red'), ('amber', 'Amber'), ('green', 'Green'), ('blue', 'Blue'), ('violet', 'Violet')], default='', max_length=16)),
                ('plate', models.BooleanField(default=False)),
                ('z', models.SmallIntegerField(default=0)),
                ('locked', models.BooleanField(default=False)),
            ],
            options={
                'ordering': ['z', 'created_at'],
            },
        ),
        migrations.RemoveConstraint(
            model_name='floorplantile',
            name='floorplantile_exactly_one_type',
        ),
        migrations.AddField(
            model_name='floorplan',
            name='layout_mode',
            field=models.CharField(choices=[('grid', 'Grid'), ('free', 'Free')], db_default='grid', default='grid', max_length=8),
        ),
        migrations.AlterField(
            model_name='floorplantile',
            name='height',
            field=models.FloatField(default=1, validators=[django.core.validators.MinValueValidator(0.01), django.core.validators.MaxValueValidator(512)]),
        ),
        migrations.AlterField(
            model_name='floorplantile',
            name='orientation',
            field=models.PositiveSmallIntegerField(default=0, validators=[django.core.validators.MaxValueValidator(359)]),
        ),
        migrations.AlterField(
            model_name='floorplantile',
            name='width',
            field=models.FloatField(default=1, validators=[django.core.validators.MinValueValidator(0.01), django.core.validators.MaxValueValidator(512)]),
        ),
        migrations.AlterField(
            model_name='floorplantile',
            name='x',
            field=models.FloatField(validators=[django.core.validators.MinValueValidator(0)]),
        ),
        migrations.AlterField(
            model_name='floorplantile',
            name='y',
            field=models.FloatField(validators=[django.core.validators.MinValueValidator(0)]),
        ),
        migrations.AddConstraint(
            model_name='floorplantile',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('role_type__isnull', True), ('tile_type__isnull', False)), models.Q(('role_type__isnull', False), ('tile_type__isnull', True)), models.Q(models.Q(('role_type__isnull', True), ('tile_type__isnull', True)), models.Q(('rack__isnull', False), ('cabinet__isnull', False), ('device__isnull', False), ('power_panel__isnull', False), ('power_feed__isnull', False), ('cooling_source__isnull', False), ('linked_floor_plan__isnull', False), _connector='OR')), _connector='OR'), name='floorplantile_type_or_link'),
        ),
        migrations.AddField(
            model_name='floorplanarea',
            name='floor_plan',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='areas', to='api.floorplan'),
        ),
        migrations.AddField(
            model_name='floorplanarea',
            name='location',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='floor_plan_areas', to='api.location'),
        ),
        migrations.AddField(
            model_name='floorplanarea',
            name='room',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='floor_plan_areas', to='api.room'),
        ),
        migrations.AddField(
            model_name='floorplanlabel',
            name='floor_plan',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='labels', to='api.floorplan'),
        ),
        migrations.AddIndex(
            model_name='floorplanarea',
            index=models.Index(fields=['floor_plan'], name='api_floorpl_floor_p_9a740d_idx'),
        ),
        migrations.AddConstraint(
            model_name='floorplanarea',
            constraint=models.CheckConstraint(condition=models.Q(('room__isnull', True), ('location__isnull', True), _connector='OR'), name='floorplanarea_room_or_location'),
        ),
        migrations.AddIndex(
            model_name='floorplanlabel',
            index=models.Index(fields=['floor_plan'], name='api_floorpl_floor_p_7d1b8c_idx'),
        ),
    ]
