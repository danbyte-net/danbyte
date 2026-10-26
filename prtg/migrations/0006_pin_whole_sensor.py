from django.db import migrations, models


class Migration(migrations.Migration):
    """A blank channel pins the whole sensor to the Overview."""

    dependencies = [
        ("prtg", "0005_two_way"),
    ]

    operations = [
        migrations.AlterField(
            model_name="prtgsensorpin",
            name="channel_id",
            field=models.CharField(blank=True, db_default="", default="", max_length=16),
        ),
    ]
