"""Record which installed module created an interface (#333).

Interfaces a module stamped were only matched by rendered name, so removing
a module could delete a device interface that shared the name, and sync,
bay delete and type change lost track of them. ``Interface.module`` now
records ownership.

The backfill marks an existing interface as owned by a module only when the
match is unambiguous. All must hold:

* its name is one the module's interface templates render to on that
  device (``{module}`` -> bay position, then ``{position}`` -> stack member);
* exactly one installed module on the device renders that name;
* the device type does not produce that name itself - no interface
  template and no faceplate or photo marker of the type (or the device's
  own photo markers) renders to it;
* the interface was created no earlier than the module (install stamps
  interfaces right after the module row is saved, so an older interface
  with that name predates the module and is the device's own).

Anything else stays unowned. Unowned interfaces are never removed with a
module, so the worst case of a missed match is an interface left behind
for the operator to delete - never deleted data.
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


def _marker_interface_names(*docs):
    out = set()
    for doc in docs:
        for side in ("front", "rear"):
            for item in (doc or {}).get(side, []) or []:
                if not isinstance(item, dict):
                    continue
                entries = item.get("slots") if "slots" in item else [item]
                for entry in entries or []:
                    if not isinstance(entry, dict):
                        continue
                    if "slots" in item and entry.get("t") != "port":
                        continue
                    name = entry.get("name")
                    if entry.get("kind", "interface") == "interface" and name:
                        if isinstance(name, str):
                            out.add(name)
    return out


def backfill_module_ownership(apps, schema_editor):
    Module = apps.get_model("api", "Module")
    Interface = apps.get_model("api", "Interface")
    InterfaceTemplate = apps.get_model("api", "InterfaceTemplate")
    ModuleInterfaceTemplate = apps.get_model("api", "ModuleInterfaceTemplate")

    by_device = {}
    for module in Module.objects.select_related(
        "device", "device__device_type", "module_bay"
    ).order_by("device_id"):
        by_device.setdefault(module.device_id, []).append(module)

    for modules in by_device.values():
        device = modules[0].device
        pos = device.vc_position
        dt = device.device_type
        native = set()
        if dt is not None:
            native.update(
                _render_position(n, pos)
                for n in InterfaceTemplate.objects.filter(
                    device_type=dt
                ).values_list("name", flat=True)
            )
            markers = _marker_interface_names(
                dt.faceplate, dt.image_ports, device.image_ports
            )
            native.update(_render_position(n, pos) for n in markers)

        claims = {}
        for module in modules:
            raw = ModuleInterfaceTemplate.objects.filter(
                module_type_id=module.module_type_id
            ).values_list("name", flat=True)
            rendered = {
                _render_position(_render_module(n, module.module_bay.position), pos)
                for n in raw
            }
            for name in rendered:
                claims.setdefault(name, []).append(module)

        for name, owners in claims.items():
            if len(owners) != 1 or name in native:
                continue
            module = owners[0]
            Interface.objects.filter(
                device_id=device.pk, name=name, module__isnull=True,
                created_at__gte=module.created_at,
            ).update(module=module)


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0197_repair_duplicate_status_defaults"),
    ]

    operations = [
        migrations.AddField(
            model_name="interface",
            name="module",
            field=models.ForeignKey(
                blank=True,
                help_text="Installed module that created this interface; null for "
                "the device's own interfaces.",
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="interfaces",
                to="api.module",
            ),
        ),
        migrations.RunPython(
            backfill_module_ownership, migrations.RunPython.noop
        ),
    ]
