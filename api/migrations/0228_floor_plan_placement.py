"""Floor plans P3: how a device or rack tile draws (its icon or its photo)
and a stacking order for tiles on a free plan. Every existing tile stays an
icon at z 0."""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0227_floor_plan_areas_labels'),
    ]

    operations = [
        migrations.AddField(
            model_name='floorplantile',
            name='display',
            field=models.CharField(choices=[('icon', 'Icon'), ('photo', 'Photo')], db_default='icon', default='icon', max_length=8),
        ),
        migrations.AddField(
            model_name='floorplantile',
            name='z',
            field=models.SmallIntegerField(db_default=0, default=0),
        ),
    ]
