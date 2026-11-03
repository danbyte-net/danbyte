from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0252_device_size_mm"),
    ]

    operations = [
        migrations.AddField(
            model_name="panellayout",
            name="callout",
            field=models.JSONField(blank=True, db_default=models.Value([], models.JSONField()), default=list),
        ),
    ]
