"""Record which module interface template an interface was stamped from (#366).

A bay move or type change used to delete a module's interfaces and create
them again, losing cables, IPs and everything else attached. Re-stamping now
keeps the interfaces that still correspond, and needs each one's template
to follow it even after an operator renamed it.

The backfill links an interface its module already owns (0198) to the
template of that module's type that renders to its name on the device
(``{module}`` -> bay position, then ``{position}`` -> stack member). A
renamed interface stays unlinked; re-stamping then matches it by name or
leaves it as it is.

``Interface.module`` becomes non-editable: ownership is set by install
only, so imports cannot assign or clear it (#367).
"""
import re

import django.db.models.deletion
from django.db import migrations, models

POSITION_TOKEN_RE = re.compile(r"\{position(?::(\d+))?\}")
MODULE_TOKEN_RE = re.compile(r"\{module\}")


def _render_position(name, position):
    def _sub(m):
        default = int(m.group(1)) if m.group(1) is not None else 1
        return str(position if position is not None else default)

    return POSITION_TOKEN_RE.sub(_sub, name)


def _render_module(name, module_position):
    if not module_position:
        return name
    return MODULE_TOKEN_RE.sub(module_position, name)


def backfill_module_template(apps, schema_editor):
    Module = apps.get_model("api", "Module")
    Interface = apps.get_model("api", "Interface")
    ModuleInterfaceTemplate = apps.get_model("api", "ModuleInterfaceTemplate")

    for module in Module.objects.select_related("device", "module_bay"):
        pos = module.device.vc_position
        by_name = {
            _render_position(_render_module(t.name, module.module_bay.position), pos): t
            for t in ModuleInterfaceTemplate.objects.filter(
                module_type_id=module.module_type_id
            )
        }
        for iface in Interface.objects.filter(
            module_id=module.pk, module_template__isnull=True
        ):
            t = by_name.get(iface.name)
            if t is not None:
                Interface.objects.filter(pk=iface.pk).update(module_template=t)


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0202_powerpanel_location"),
    ]

    operations = [
        migrations.AddField(
            model_name="interface",
            name="module_template",
            field=models.ForeignKey(
                blank=True,
                editable=False,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to="api.moduleinterfacetemplate",
            ),
        ),
        migrations.AlterField(
            model_name="interface",
            name="module",
            field=models.ForeignKey(
                blank=True,
                editable=False,
                help_text="Installed module that created this interface; null for "
                "the device's own interfaces.",
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="interfaces",
                to="api.module",
            ),
        ),
        migrations.RunPython(backfill_module_template, migrations.RunPython.noop),
    ]
