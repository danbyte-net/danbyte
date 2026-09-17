from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("api", "0166_inventoryitem_slot_cores")]

    operations = [
        migrations.AddField(
            model_name="fhrpgroup",
            name="nd_ra",
            field=models.BooleanField(
                default=False,
                help_text="Send IPv6 router advertisements from the gateway SVI.",
            ),
        ),
        migrations.AddField(
            model_name="fhrpgroup",
            name="nd_ra_interval",
            field=models.PositiveSmallIntegerField(
                blank=True, null=True, help_text="Router advertisement interval, seconds."
            ),
        ),
    ]
