"""Move notification channel credentials out of the plain ``config`` column.

The webhook URL of a Slack, Teams, Discord or webhook channel and the
PagerDuty routing key used to sit in ``config``, which the API returns. They
now live in the Fernet-encrypted ``secrets`` column next to the Telegram bot
token. Idempotent: a row without those keys in ``config`` is left alone.
"""
from django.db import migrations

KEYS = ("url", "routing_key")


def seal(apps, schema_editor):
    Channel = apps.get_model("monitoring", "NotificationChannel")
    for ch in Channel.objects.all().iterator():
        config = ch.config if isinstance(ch.config, dict) else {}
        found = [k for k in KEYS if k in config]
        if not found:
            continue
        config = dict(config)
        secrets = dict(ch.secrets or {})
        for key in found:
            value = config.pop(key)
            if isinstance(value, str):
                value = value.strip()
            if value:
                secrets[key] = value
        Channel.objects.filter(pk=ch.pk).update(config=config, secrets=secrets)


def unseal(apps, schema_editor):
    Channel = apps.get_model("monitoring", "NotificationChannel")
    for ch in Channel.objects.all().iterator():
        secrets = dict(ch.secrets or {})
        moved = {k: secrets.pop(k) for k in KEYS if secrets.get(k)}
        if not moved:
            continue
        Channel.objects.filter(pk=ch.pk).update(
            config={**(ch.config or {}), **moved}, secrets=secrets
        )


class Migration(migrations.Migration):

    dependencies = [
        ("monitoring", "0114_sla_templates"),
    ]

    operations = [
        migrations.RunPython(seal, unseal),
    ]
