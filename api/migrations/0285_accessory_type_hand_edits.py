from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0284_accessory_type_cable'),
    ]

    operations = [
        migrations.AddField(
            model_name='accessorytype',
            name='reach_m',
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='accessorytype',
            name='hand_edited',
            field=models.JSONField(blank=True, db_default=models.Value([], models.JSONField()), default=list),
        ),
    ]
