"""Scrub PRTG API keys out of stored error text (#459).

An error page that repeated the request URL put the classic API's
``?apitoken=<key>`` into ``last_error`` and the other messages PRTG errors
end up in, and from there into the change log. The client redacts what it
raises now; this masks what was already stored: each connection's own key
wherever it appears, and any ``apitoken=`` value. The logic is frozen here,
not imported, so later changes to the helper don't change this migration.
"""
import re

from django.db import migrations

_REDACTED = "REDACTED"
_APITOKEN = re.compile(r"(?i)(?<![a-z0-9_])(apitoken)=[^&\s'\"<>]+")


def _clean(value, keys):
    """``(value, changed)`` with every key and ``apitoken=`` value masked in
    every string of a JSON-shaped value."""
    if isinstance(value, str):
        out = value
        for key in keys:
            out = out.replace(key, _REDACTED)
        out = _APITOKEN.sub(lambda m: f"{m.group(1)}={_REDACTED}", out)
        return out, out != value
    if isinstance(value, list):
        pairs = [_clean(v, keys) for v in value]
        return [v for v, _ in pairs], any(c for _, c in pairs)
    if isinstance(value, dict):
        pairs = {k: _clean(v, keys) for k, v in value.items()}
        return {k: v for k, (v, _) in pairs.items()}, any(c for _, c in pairs.values())
    return value, False


def _key_of(conn) -> str:
    try:
        key = str((conn.credentials or {}).get("api_key") or "")
    except Exception:  # noqa: BLE001 - an unreadable secret: the regex still runs
        return ""
    return key if len(key) >= 4 else ""


def _scrub_row(obj, fields, keys) -> None:
    dirty = []
    for name in fields:
        value, changed = _clean(getattr(obj, name), keys)
        if changed:
            setattr(obj, name, value)
            dirty.append(name)
    if dirty:
        obj.save(update_fields=dirty)


def scrub(apps, schema_editor):
    Connection = apps.get_model("prtg", "PrtgConnection")
    Change = apps.get_model("prtg", "PrtgChange")
    Entry = apps.get_model("audit", "ChangeLogEntry")

    all_keys = set()
    conn_fields = ("last_error", "write_detail", "last_status_summary",
                   "last_plan_summary", "last_apply_summary")
    for conn in Connection.objects.all().iterator():
        key = _key_of(conn)
        keys = [key] if key else []
        all_keys.update(keys)
        _scrub_row(conn, conn_fields, keys)
        for change in Change.objects.filter(connection_id=conn.pk).iterator():
            _scrub_row(change, ("detail",), keys)

    keys = sorted(all_keys)
    for entry in Entry.objects.filter(object_type__startswith="prtg.").iterator():
        _scrub_row(entry, ("changes", "pre_change", "post_change"), keys)


class Migration(migrations.Migration):
    dependencies = [
        ("audit", "0014_changelogentry_cause"),
        ("prtg", "0017_retire_rules"),
    ]

    operations = [migrations.RunPython(scrub, migrations.RunPython.noop)]
