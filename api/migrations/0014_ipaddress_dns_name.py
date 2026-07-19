from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0013_ipaddress_mac_address'),
    ]

    operations = [
        migrations.AddField(
            model_name='ipaddress',
            name='dns_name',
            field=models.CharField(
                blank=True,
                default='',
                help_text=(
                    'Hostname / DNS name for this address (its PTR record). '
                    'Auto-filled by reverse-DNS monitoring when enabled.'
                ),
                max_length=255,
            ),
        ),
    ]
