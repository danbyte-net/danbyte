# Scrub credential values that leaked into existing change-log rows.
#
# audit.signals used to snapshot every concrete field verbatim — for
# EncryptedJSONField columns that meant the *decrypted* value landed in
# ChangeLogEntry.changes (and, briefly, pre/post_change). The signals now
# redact secrets at capture time; this migration cleans up what was already
# recorded, replacing secret values with "•••" (set) / None (empty) while
# keeping the entry itself intact.
from django.db import migrations

_SECRET_NAMES = {
    "secret", "secrets", "secret_params", "token", "password",
    "api_key", "private_key",
}
_MODEL_EXTRA = {"monitoring.notificationchannel": {"config"}}
# The audited models that carry credential fields.
_AFFECTED_TYPES = [
    "core.deploymentsettings",
    "monitoring.checktemplate",
    "monitoring.notificationchannel",
    "integrations.webhook",
    "integrations.automationtarget",
    "auth_api.publicsharelink",
]


def _mask(v):
    return "•••" if v else None


def _redact(data, names) -> bool:
    changed = False
    for key in list(data or {}):
        if key not in names:
            continue
        v = data[key]
        if isinstance(v, dict) and set(v) == {"old", "new"}:
            # The changes-diff shape keeps its old/new structure, masked.
            data[key] = {"old": _mask(v.get("old")), "new": _mask(v.get("new"))}
        else:
            data[key] = _mask(v)
        changed = True
    return changed


def scrub(apps, schema_editor):
    Entry = apps.get_model("audit", "ChangeLogEntry")
    qs = Entry.objects.filter(object_type__in=_AFFECTED_TYPES)
    for e in qs.iterator():
        names = _SECRET_NAMES | _MODEL_EXTRA.get(e.object_type, set())
        dirty = _redact(e.changes, names)
        for attr in ("pre_change", "post_change"):
            snapshot = getattr(e, attr)
            if snapshot and _redact(snapshot, names):
                dirty = True
        if dirty:
            e.save(update_fields=["changes", "pre_change", "post_change"])


class Migration(migrations.Migration):
    dependencies = [
        ("audit", "0003_changelogentry_post_change_changelogentry_pre_change"),
    ]

    operations = [migrations.RunPython(scrub, migrations.RunPython.noop)]
