"""Mask credentials at every level of the stored call arguments (#326).

Rows written before this masked only top-level argument names, so a
``create`` or ``update`` payload kept its password in the clear. This
walks every row once and rewrites only the ones that change, so it is
idempotent. Self-contained on purpose: keys are judged by name, plus the
two fields ``core.secret_fields`` classified as secret by model when this
was written. Irreversible, as masked values cannot be restored.
"""
import json

from django.db import migrations

MASK = "•••"
_WORDS = ("password", "passphrase", "secret", "token", "key", "psk", "credential")
# Secret on the type without saying so in the name.
_BY_TYPE = {"notificationchannel": {"config"}, "webhook": {"additional_headers"}}


def _slug(object_type: str) -> str:
    raw = (object_type or "").strip().lower().replace(" ", "").replace("-", "").replace("_", "")
    return raw if raw in _BY_TYPE else raw.rstrip("s")


def _mask(value, extra: set):
    if isinstance(value, dict):
        out = {}
        for key, val in value.items():
            name = str(key).lower()
            if name in extra or any(word in name for word in _WORDS):
                out[key] = MASK
            else:
                out[key] = _mask(val, extra)
        return out
    if isinstance(value, list):
        return [_mask(v, extra) for v in value]
    if isinstance(value, str) and value.lstrip()[:1] in ("{", "["):
        try:
            parsed = json.loads(value)
        except ValueError:
            return value
        if isinstance(parsed, (dict, list)):
            masked = _mask(parsed, extra)
            return masked if masked != parsed else value
    return value


def remask(apps, schema_editor) -> int:
    AgentCall = apps.get_model("agents", "AgentCall")
    changed = 0
    batch = []

    def flush():
        nonlocal changed, batch
        if batch:
            AgentCall.objects.bulk_update(batch, ["arguments"])
            changed += len(batch)
            batch = []

    rows = AgentCall.objects.only("id", "object_type", "arguments").iterator(chunk_size=500)
    for row in rows:
        masked = _mask(row.arguments or {}, _BY_TYPE.get(_slug(row.object_type), set()))
        if masked != row.arguments:
            row.arguments = masked
            batch.append(row)
        if len(batch) >= 500:
            flush()
    flush()
    return changed


class Migration(migrations.Migration):
    dependencies = [("agents", "0001_initial")]

    operations = [migrations.RunPython(remask, migrations.RunPython.noop)]
