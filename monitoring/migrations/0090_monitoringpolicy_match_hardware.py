from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("monitoring", "0089_checkstate_last_detail"),
    ]

    operations = [
        migrations.AddField(
            model_name="monitoringpolicy",
            name="match_hardware",
            field=models.CharField(
                blank=True,
                default="",
                help_text=(
                    "Glob at least one of the device's inventory items or "
                    "installed modules must match, by name or part number, "
                    "e.g. '*PSU*'. Empty = any."
                ),
                max_length=200,
            ),
        ),
    ]
