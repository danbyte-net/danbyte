# Encrypt Webhook.secret and AutomationTarget.token at rest.
#
# Both were plaintext CharFields — unlike every other credential in the app
# (SMTP, SNMP, check secrets), which uses the Fernet-backed EncryptedJSONField.
# Three steps because ciphertext is longer than the old varchar limits:
#   1. widen the columns to text (no semantic change),
#   2. encrypt existing values in place with the same backend the field uses,
#   3. switch the field to EncryptedJSONField (decrypts transparently on read).
from django.db import migrations, models

import monitoring.secrets
from monitoring.secrets import get_secrets_backend


def _encrypt_column(apps, model_name, column):
    import json

    Model = apps.get_model("integrations", model_name)
    backend = get_secrets_backend()
    for pk, raw in Model.objects.exclude(**{column: ""}).values_list("pk", column):
        if not raw:
            continue
        token = backend.encrypt(json.dumps(raw).encode()).decode()
        Model.objects.filter(pk=pk).update(**{column: token})


def encrypt_existing(apps, schema_editor):
    _encrypt_column(apps, "Webhook", "secret")
    _encrypt_column(apps, "AutomationTarget", "token")


class Migration(migrations.Migration):
    dependencies = [
        ("integrations", "0005_deployrun_attempt_deployrun_finished_at_and_more"),
    ]

    operations = [
        migrations.AlterField(
            model_name="webhook",
            name="secret",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.AlterField(
            model_name="automationtarget",
            name="token",
            field=models.TextField(blank=True, default=""),
        ),
        # Existing plaintext values → ciphertext, in place. Irreversible by
        # design (we don't decrypt back to plaintext on rollback).
        migrations.RunPython(encrypt_existing, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="webhook",
            name="secret",
            field=monitoring.secrets.EncryptedJSONField(
                blank=True,
                default="",
                help_text=(
                    "When set, payloads are signed: the hex HMAC-SHA512 of the "
                    "body is sent in the X-Danbyte-Signature header."
                ),
            ),
        ),
        migrations.AlterField(
            model_name="automationtarget",
            name="token",
            field=monitoring.secrets.EncryptedJSONField(
                blank=True,
                default="",
                help_text="AWX bearer token / webhook signing secret. Write-only.",
            ),
        ),
    ]
