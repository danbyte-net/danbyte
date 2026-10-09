"""Put back the empty lists and objects that spreadsheet re-import broke (#354).

Before 0.17.2 an export wrote an empty JSON list or object as a blank cell,
and re-importing the file stored the blank as:

* ``""`` in a JSON column that may be blank (custom field choices and
  scope rules, cable strands, business hours, ...);
* ``{}`` in a list column that may not be blank.

Any importable type could carry either, so every non-null JSON column whose
default is a list or an object, across the apps below, is repaired to its
default where it holds one of those values. Neither is a value anything
else writes: a list column never means ``{}`` and no column means ``""``.
The import is fixed in the same release; running this again changes nothing.

It lives here because the custom field registry decides which types import,
and it depends on each app's latest migration so every column is in the state.
"""

from django.db import migrations
from django.db.models import JSONField

#: The apps with JSON list or object columns, at their latest migration.
APPS = {
    "agents": "0002_mask_call_arguments",
    "api": "0198_interface_module",
    "assistant": "0001_initial",
    "audit": "0011_alter_changelogentry_via",
    "auth_api": "0027_userprofile_totp_last_used_step",
    "backups": "0002_move_docker_local_target",
    "core": "0059_upgrade_db_defaults",
    "customization": "0006_customfield_hidden",
    "integrations": "0045_upgrade_db_defaults",
    "monitoring": "0109_upgrade_db_defaults",
    "planning": "0008_task_due_time_task_start_time",
    "plugins": "0001_initial",
    "routing": "0014_upgrade_db_defaults",
    "scripting": "0001_initial",
    "zabbix": "0017_host_status",
}


def json_columns(apps):
    """``[(model, field, default)]`` for every non-null JSON column in
    :data:`APPS` whose default is a list or an object."""
    out = []
    for model in apps.get_models():
        meta = model._meta
        if meta.app_label not in APPS or meta.proxy or not meta.managed:
            continue
        for field in meta.concrete_fields:
            if not isinstance(field, JSONField) or field.null or not field.has_default():
                continue
            default = field.get_default()
            if isinstance(default, (list, dict)):
                out.append((model, field, default))
    return out


def repair(apps, schema_editor):
    for model, field, default in json_columns(apps):
        rows = model._base_manager.using(schema_editor.connection.alias)
        rows.filter(**{field.name: ""}).update(**{field.name: default})
        if isinstance(default, list) and not field.blank:
            rows.filter(**{field.name: {}}).update(**{field.name: default})


class Migration(migrations.Migration):

    dependencies = list(APPS.items())

    operations = [
        migrations.RunPython(repair, migrations.RunPython.noop),
    ]
