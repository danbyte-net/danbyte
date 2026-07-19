from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0009_deploymentsettings_device_field_visibility"),
    ]

    operations = [
        migrations.AddField(
            model_name="deploymentsettings",
            name="human_ids_enabled",
            field=models.BooleanField(
                default=True,
                help_text="When on, objects expose a short per-tenant sequential number "
                "(numid) alongside their UUID — e.g. so a cable physically tagged '27' "
                "maps to cable #27. Numbers are namespaced per tenant, so each tenant "
                "counts from 1 independently.",
            ),
        ),
    ]
