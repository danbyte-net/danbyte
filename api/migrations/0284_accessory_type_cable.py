from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0283_transceivers'),
    ]

    operations = [
        migrations.AddField(
            model_name='accessorytype',
            name='cable',
            field=models.JSONField(blank=True, default=None, null=True),
        ),
    ]
