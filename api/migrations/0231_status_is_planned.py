# Status.is_planned: a status that means planned work, not yet built. A
# floor plan draws a cable in such a status as a planned run. Existing rows
# read False (db_default); nothing is seeded - a tenant marks its own.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0230_floor_plan_snapshots'),
    ]

    operations = [
        migrations.AddField(
            model_name='status',
            name='is_planned',
            field=models.BooleanField(db_default=False, default=False, help_text='Marks the status as planned work, not yet built - a cable in it draws as a planned run (long dash) on floor plans.'),
        ),
    ]
