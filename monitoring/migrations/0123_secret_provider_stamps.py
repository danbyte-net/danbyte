from django.db import migrations, models


class Migration(migrations.Migration):
    """Stamp CSR and ACME account keys with the store that holds them (#511).
    Existing rows stay blank: where they were written is not known, so they
    are read from the active store first, then any other configured one."""

    dependencies = [
        ("monitoring", "0122_issuer_ca_certificate"),
    ]

    operations = [
        migrations.AddField(
            model_name="certificaterequest",
            name="key_provider",
            field=models.CharField(blank=True, db_default="", default="", max_length=32),
        ),
        migrations.AddField(
            model_name="issuer",
            name="account_provider",
            field=models.CharField(blank=True, db_default="", default="", max_length=32),
        ),
    ]
