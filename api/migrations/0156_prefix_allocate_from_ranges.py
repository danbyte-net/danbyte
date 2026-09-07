from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("api", "0155_repair_position_markers")]
    operations = [
        migrations.AddField(
            model_name="prefix",
            name="allocate_from_ranges",
            field=models.BooleanField(
                default=False,
                help_text="Only the IP ranges inside this prefix are allocatable: next "
                "available, free rows, pools and utilisation come from them, and a new "
                "address outside every range is refused. For a provider handing out a "
                "slice of a subnet that isn't yours.",
            ),
        ),
    ]
