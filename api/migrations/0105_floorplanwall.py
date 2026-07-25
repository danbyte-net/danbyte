# Hand-written (the makemigrations gate verifies parity with the model).

import django.core.validators
import django.db.models.deletion
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0104_floorplan_raised_floor_areas'),
    ]

    operations = [
        migrations.CreateModel(
            name='FloorPlanWall',
            fields=[
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('label', models.CharField(blank=True, default='', max_length=64)),
                ('points', models.JSONField(default=list)),
                ('height_mm', models.PositiveSmallIntegerField(blank=True, help_text="Blank = full height (the plan's ceiling).", null=True, validators=[django.core.validators.MinValueValidator(200), django.core.validators.MaxValueValidator(20000)])),
                ('color', models.CharField(blank=True, default='', max_length=7)),
                ('openings', models.JSONField(blank=True, default=list)),
                ('floor_plan', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='walls', to='api.floorplan')),
            ],
            options={
                'ordering': ['label'],
                'indexes': [models.Index(fields=['floor_plan'], name='api_floorpl_floor_p_9f31cd_idx')],
            },
        ),
    ]
