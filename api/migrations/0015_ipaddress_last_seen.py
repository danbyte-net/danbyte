from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0014_ipaddress_dns_name'),
    ]

    operations = [
        migrations.AddField(
            model_name='ipaddress',
            name='last_seen',
            field=models.DateTimeField(
                blank=True,
                null=True,
                help_text=(
                    'Last time monitoring observed this IP reachable (up or '
                    'degraded). Set by the check engine; read-only in the UI.'
                ),
            ),
        ),
    ]
