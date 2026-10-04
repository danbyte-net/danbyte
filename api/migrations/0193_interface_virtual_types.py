"""Flag every interface of a virtual type as virtual.

``Interface.save()`` used to set ``virtual`` for the "lag" type only, and the
device-type and module installs bypassed it altogether, so "virtual" and
"bridge" interfaces - and aggregates stamped from a template - kept
``virtual=False`` and counted as physical ports. ``save()``, bulk edit and the
installs now set it for all three virtual types; this fixes the rows written
before they did.

One set-based UPDATE that only touches the rows it changes, so running it
again changes nothing.
"""

from django.db import migrations

# api.dcim_choices.VIRTUAL_INTERFACE_TYPES, frozen as of this migration.
VIRTUAL_TYPES = ("virtual", "bridge", "lag")


def flag_virtual_types(apps, schema_editor):
    Interface = apps.get_model("api", "Interface")
    Interface.objects.filter(type__in=VIRTUAL_TYPES, virtual=False).update(virtual=True)


def noop(apps, schema_editor):
    """Nothing to undo - the prior state was inconsistent, not meaningful."""


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0192_tunnel_capacity"),
    ]

    operations = [
        migrations.RunPython(flag_virtual_types, noop),
    ]
