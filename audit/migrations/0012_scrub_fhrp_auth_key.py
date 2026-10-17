"""Scrub FHRP authentication keys from old change-log rows (#383).

``api.fhrpgroup.auth_key`` was a plain column, so every create and edit
logged the key in the diff and both snapshots. The key now lives in the
secret store and the column is gone; this masks what the trail kept, the way
0006 did for webhook headers. Set keys read "•••", empty ones None.
"""
from django.db import migrations

_MASK = "•••"
_FIELD = "auth_key"


def _mask(v):
    return _MASK if v else None


def _redact(data) -> bool:
    if not isinstance(data, dict) or _FIELD not in data:
        return False
    v = data[_FIELD]
    if isinstance(v, dict) and set(v) == {"old", "new"}:
        data[_FIELD] = {"old": _mask(v.get("old")), "new": _mask(v.get("new"))}
    else:
        data[_FIELD] = _mask(v)
    return True


def scrub(apps, schema_editor):
    Entry = apps.get_model("audit", "ChangeLogEntry")
    for e in Entry.objects.filter(object_type="api.fhrpgroup").iterator():
        dirty = _redact(e.changes)
        for attr in ("pre_change", "post_change"):
            if _redact(getattr(e, attr)):
                dirty = True
        if dirty:
            e.save(update_fields=["changes", "pre_change", "post_change"])


class Migration(migrations.Migration):
    dependencies = [
        ("audit", "0011_alter_changelogentry_via"),
    ]

    operations = [migrations.RunPython(scrub, migrations.RunPython.noop)]
