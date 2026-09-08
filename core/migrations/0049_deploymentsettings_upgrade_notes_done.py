from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0048_deploymentsettings_secrets_provider_registry"),
    ]

    operations = [
        migrations.AddField(
            model_name="deploymentsettings",
            name="upgrade_notes_done",
            field=models.JSONField(blank=True, default=list),
        ),
    ]
