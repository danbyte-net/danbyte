"""Scrub webhook Authorization/API-key headers that leaked into old change-log
rows.

``integrations.webhook.additional_headers`` is free-text extra request headers
that routinely carry ``Authorization`` / ``X-Api-Key`` tokens. It's now
classified as secret (core.secret_fields) so new captures redact it, and the
generic scrub (0004) covers the always-secret field names — but it did NOT list
``additional_headers`` under integrations.webhook, so any header set on a
webhook before v0.8.2 is still sitting in ChangeLogEntry in cleartext on
upgraded databases. This forward migration masks it.
"""
from django.db import migrations

_MASK = "•••"


def _mask(v):
    return _MASK if v else None


def _redact_headers(data) -> bool:
    """Mask the ``additional_headers`` key wherever it appears in a change diff
    or a full snapshot. Returns whether anything changed."""
    if not isinstance(data, dict):
        return False
    if "additional_headers" not in data:
        return False
    v = data["additional_headers"]
    if isinstance(v, dict) and set(v) == {"old", "new"}:
        data["additional_headers"] = {
            "old": _mask(v.get("old")), "new": _mask(v.get("new"))
        }
    else:
        data["additional_headers"] = _mask(v)
    return True


def scrub(apps, schema_editor):
    Entry = apps.get_model("audit", "ChangeLogEntry")
    qs = Entry.objects.filter(object_type="integrations.webhook")
    for e in qs.iterator():
        dirty = _redact_headers(e.changes)
        for attr in ("pre_change", "post_change"):
            snapshot = getattr(e, attr)
            if _redact_headers(snapshot):
                dirty = True
        if dirty:
            e.save(update_fields=["changes", "pre_change", "post_change"])


class Migration(migrations.Migration):
    dependencies = [
        ("audit", "0005_changelogentry_object_site_id_and_more"),
    ]

    operations = [migrations.RunPython(scrub, migrations.RunPython.noop)]
