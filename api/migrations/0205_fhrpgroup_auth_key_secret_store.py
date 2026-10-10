# An FHRP group's authentication key moves out of the row into the secret
# store (#383), the arrangement SSID, IPsec and keychain PSKs use.
#
# Three steps: add the reference columns, move each key, drop the plaintext
# column. A key goes to the configured store. With no store configured, or
# one that cannot take it right now, it goes to the local store's encrypted
# table (StoredSecret, Fernet under MONITORING_SECRET_KEY) instead of staying
# in the clear: the reveal stays fail-closed until an administrator enables a
# store, and enabling the local one makes those keys readable again. The
# upgrade never fails over a key.
#
# Reversible: going back reads each key into the column again and removes
# the local copy.
import logging

from django.db import migrations, models, transaction

log = logging.getLogger("danbyte.migrations")

PREFIX = "fhrp-groups"


def _provider(apps) -> str:
    DS = apps.get_model("core", "DeploymentSettings")
    return (DS.objects.values_list("secrets_provider", flat=True).first() or "").strip()


def _external_store(provider):
    """The configured store when it is not the local table, else None. Any
    failure to build it (a half-configured Vault, a removed plugin) is None:
    the key then goes to the local table."""
    if not provider or provider == "local":
        return None
    try:
        with transaction.atomic():
            from monitoring.secret_store import active_secret_store

            return active_secret_store()
    except Exception:  # noqa: BLE001 - an upgrade never fails over a key
        log.warning("secret store %r unavailable; FHRP keys go to the local store", provider)
        return None


def move_keys(apps, schema_editor):
    FHRPGroup = apps.get_model("api", "FHRPGroup")
    StoredSecret = apps.get_model("monitoring", "StoredSecret")
    rows = FHRPGroup.objects.exclude(auth_key="")
    if not rows.exists():
        return
    provider = _provider(apps)
    external = _external_store(provider)
    for g in rows.iterator():
        path = f"{PREFIX}/{g.pk}"
        stamped = ""
        if external is not None:
            try:
                with transaction.atomic():
                    external.put(g.tenant_id, path, {"psk": g.auth_key})
                stamped = provider
            except Exception:  # noqa: BLE001 - fall back to the local table
                log.warning("FHRP group %s: key kept in the local store", g.pk)
        if not stamped:
            StoredSecret.objects.update_or_create(
                tenant_id=g.tenant_id, ref=path, defaults={"value": {"psk": g.auth_key}}
            )
            stamped = "local"
        FHRPGroup.objects.filter(pk=g.pk).update(
            psk_secret_path=path, psk_secret_provider=stamped, auth_key=""
        )


def restore_keys(apps, schema_editor):
    FHRPGroup = apps.get_model("api", "FHRPGroup")
    StoredSecret = apps.get_model("monitoring", "StoredSecret")
    rows = FHRPGroup.objects.exclude(psk_secret_path="")
    if not rows.exists():
        return
    external = _external_store(_provider(apps))
    for g in rows.iterator():
        # The derived path, never the row's: #315.
        path = f"{PREFIX}/{g.pk}"
        value = None
        if g.psk_secret_provider != "local" and external is not None:
            try:
                with transaction.atomic():
                    value = external.get(g.tenant_id, path)
            except Exception:  # noqa: BLE001
                value = None
        if value is None:
            row = StoredSecret.objects.filter(tenant_id=g.tenant_id, ref=path).first()
            value = row.value if row is not None else None
        StoredSecret.objects.filter(tenant_id=g.tenant_id, ref=path).delete()
        key = str((value or {}).get("psk") or "")[:255]
        FHRPGroup.objects.filter(pk=g.pk).update(
            auth_key=key, psk_secret_path="", psk_secret_provider=""
        )


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0204_normalise_aggregate_prefixes'),
        ('core', '0048_deploymentsettings_secrets_provider_registry'),
        ('monitoring', '0051_storedsecret'),
    ]

    operations = [
        migrations.AddField(
            model_name='fhrpgroup',
            name='psk_secret_path',
            field=models.CharField(blank=True, db_default='', default='', help_text='Reference to the PSK inside that store. Empty: no PSK set.', max_length=255),
        ),
        migrations.AddField(
            model_name='fhrpgroup',
            name='psk_secret_provider',
            field=models.CharField(blank=True, db_default='', default='', help_text='Which secret store holds the PSK, stamped at write-time.', max_length=8),
        ),
        migrations.RunPython(move_keys, restore_keys),
        migrations.RemoveField(
            model_name='fhrpgroup',
            name='auth_key',
        ),
    ]
