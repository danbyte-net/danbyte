"""Add IPRole.icon — Lucide-style icon name rendered inside the role chip."""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0005_reserved_status_and_note"),
    ]

    operations = [
        migrations.AddField(
            model_name="iprole",
            name="icon",
            field=models.CharField(
                blank=True,
                default="",
                max_length=64,
                help_text=("Lucide-style icon name shown inside the role chip. "
                           "Pick from the registry (crown, router, shield-check, …); "
                           "unknown names are silently ignored."),
            ),
        ),
    ]
