import re

from django.db import migrations

POSITION_TOKEN_RE = re.compile(r"\{position(?::(\d+))?\}")

# Marker kind (as stored in image_ports / faceplate slots) → the device type's
# template relation that defines that component.
KIND_TEMPLATES = {
    "interface": "interface_templates",
    "front-port": "front_port_templates",
    "rear-port": "rear_port_templates",
    "console-port": "console_port_templates",
    "console-server-port": "console_server_port_templates",
    "power-port": "power_port_templates",
    "power-outlet": "power_outlet_templates",
    "aux-port": "aux_port_templates",
    "antenna": "antenna_templates",
    "inventory-item": "inventory_item_templates",
    "module-bay": "module_bay_templates",
}
# Stack positions a rendered template name is matched against. Well past any
# real chassis, and a miss is simply not repaired.
POSITIONS = range(1, 17)


def _render(name, position):
    return POSITION_TOKEN_RE.sub(lambda m: str(position), name)


def _maps(device_type):
    """Per marker kind: the template names as written, and rendered → raw for
    every ``{position}`` template. A rendered name two templates share is
    dropped - an ambiguous match is left alone."""
    out = {}
    for kind, rel in KIND_TEMPLATES.items():
        manager = getattr(device_type, rel, None)
        if manager is None:
            continue
        raw = set(manager.values_list("name", flat=True))
        rendered, ambiguous = {}, set()
        for name in raw:
            if not POSITION_TOKEN_RE.search(name):
                continue
            for pos in POSITIONS:
                r = _render(name, pos)
                if r in rendered and rendered[r] != name:
                    ambiguous.add(r)
                rendered.setdefault(r, name)
        for r in ambiguous:
            rendered.pop(r, None)
        out[kind] = (raw, rendered)
    return out


def repair(apps, schema_editor):
    """Re-point photo markers and faceplate slots left behind by a bulk
    template rename.

    Both reference components by name, and until now only a *single* rename
    followed into them - a bulk find/replace (``1/0/`` → ``{position}/0/``)
    left every marker on the old literal name. The diff then read those names
    as ports the type has, so syncing a stack member stamped a second bank of
    bare "other" components beside the real ones. A marker no template
    defines, whose name is exactly what a ``{position}`` template renders to,
    is rewritten to that template's name.
    """
    DeviceType = apps.get_model("api", "DeviceType")
    qs = DeviceType.objects.exclude(image_ports=None, faceplate=None)
    for dt in qs.iterator():
        maps = _maps(dt)
        changed = []

        def fix(name, kind, maps=maps):
            raw, rendered = maps.get(kind, (set(), {}))
            if not name or name in raw:
                return None
            return rendered.get(name)

        doc = dt.image_ports
        if isinstance(doc, dict):
            hit = False
            for side in ("front", "rear"):
                for marker in doc.get(side) or []:
                    if not isinstance(marker, dict):
                        continue
                    new = fix(marker.get("name"), marker.get("kind", "interface"))
                    if new:
                        marker["name"] = new
                        hit = True
            if hit:
                dt.image_ports = doc
                changed.append("image_ports")

        fp = dt.faceplate
        if isinstance(fp, dict):
            hit = False
            for side in ("front", "rear"):
                for group in fp.get(side) or []:
                    if not isinstance(group, dict):
                        continue
                    for slot in group.get("slots") or []:
                        if not isinstance(slot, dict) or slot.get("t") != "port":
                            continue
                        new = fix(slot.get("name"), slot.get("kind", "interface"))
                        if new:
                            slot["name"] = new
                            hit = True
            if hit:
                dt.faceplate = fp
                changed.append("faceplate")

        if changed:
            dt.save(update_fields=changed)


class Migration(migrations.Migration):
    dependencies = [("api", "0154_normalize_kbps_speeds")]
    operations = [migrations.RunPython(repair, migrations.RunPython.noop)]
