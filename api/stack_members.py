"""Stack-member types on a pack import (docs/dcim/model-packs.md → Stack
members).

Pack and library YAML name a switch's ports as stack member 1
(``GigabitEthernet1/0/1``). Danbyte decides which types are stack members
(:func:`stackable`) and gives those the stack-member token, as the manual
import's ``stack_positions`` does: ``GigabitEthernet{position}/0/1``. Then
every device of the type that sits in a stack is re-rendered for its
member number (:func:`restack`) - same rows, so cables, IPs and history
stay; a name another port holds is never taken.

A type is stackable when its YAML ``meta.stackable`` is true, or - unless
it is false - when the type or its YAML has a stacking port (an interface
of a stack type or marked ``stack``, a StackPower port), or a module bay
whose listed module types carry a stacking interface (a stack-kit bay).

Only interface and power-port templates take the token, and only on their
leading member number in the type's own spelling (the token most of its
interfaces would take): ``GigabitEthernet0/0`` under ``{position}`` stays,
and module bays keep their names, so the models' ``bay:`` anchors still
match. Installed modules' ports follow the host's member number as they
are stamped (api.models.render_module_component).
"""
from __future__ import annotations

#: (pack section, template relation, device relation, marker kind)
KINDS = (
    ("interfaces", "interface_templates", "interfaces", "interface"),
    ("power-ports", "power_port_templates", "power_ports", "power-port"),
)


def _rows(data, key: str) -> list[dict]:
    val = data.get(key) if isinstance(data, dict) else None
    return [r for r in val if isinstance(r, dict)] if isinstance(val, list) else []


def meta_stackable(data) -> bool | None:
    """The YAML's ``meta.stackable`` when it is a yes or no, else None."""
    meta = data.get("meta") if isinstance(data, dict) else None
    flag = meta.get("stackable") if isinstance(meta, dict) else None
    return flag if isinstance(flag, bool) else None


def stackable(dt, data) -> bool:
    """Whether ``dt`` (with its pack YAML ``data``) is a stack member type:
    see the module docstring."""
    from django.db.models import Q

    from .dcim_choices import STACK_INTERFACE_TYPES, STACK_POWER_PORT_TYPES
    from .models import ModuleInterfaceTemplate

    flag = meta_stackable(data)
    if flag is not None:
        return flag
    for r in _rows(data, "interfaces"):
        if str(r.get("type") or "").strip().lower() in STACK_INTERFACE_TYPES \
                or r.get("stack") is True:
            return True
    if any(str(r.get("type") or "").strip().lower() in STACK_POWER_PORT_TYPES
           for r in _rows(data, "power-ports")):
        return True
    if dt.interface_templates.filter(
            Q(type__in=STACK_INTERFACE_TYPES) | Q(stack_port=True)).exists():
        return True
    if dt.power_port_templates.filter(type__in=STACK_POWER_PORT_TYPES).exists():
        return True
    parts = {str(p).strip().lower()
             for b in dt.module_bay_templates.all() for p in b.suggested_modules or []}
    for r in _rows(data, "module-bays"):
        mods = r.get("modules")
        if isinstance(mods, list):
            parts |= {str(p).strip().lower() for p in mods}
    parts.discard("")
    if not parts:
        return False
    kits = ModuleInterfaceTemplate.objects.filter(
        module_type__tenant_id=dt.tenant_id, type__in=STACK_INTERFACE_TYPES,
    ).values_list("module_type__part_number", flat=True).distinct()
    return any((pn or "").strip().lower() in parts for pn in kits)


def take_token(dt) -> tuple[str | None, dict[str, dict[str, str]]]:
    """Give ``dt``'s interface and power-port templates the stack-member
    token, as ``stack_positions`` names them on import. ``(token, {pack
    section: {old name: new name}})``; nothing when the type already uses
    the token or names no member number. Each template is saved (audited);
    the type's photo markers and faceplate slots follow in one save."""
    from .devicetype_import import positionize
    from .models import (
        _ComponentTemplate,
        member_token,
        positionize_member,
        rename_marker_refs_many,
    )

    if dt.interface_templates.filter(name__contains="{position").exists():
        return None, {}
    token = member_token(positionize(n) for n in
                         dt.interface_templates.values_list("name", flat=True))
    if token is None:
        return None, {}
    renamed: dict[str, dict[str, str]] = {}
    for key, rel, _dev_rel, marker in KINDS:
        tmpls = list(getattr(dt, rel).all())
        have = {t.name for t in tmpls}
        done: dict[str, str] = {}
        for t in tmpls:
            new = positionize_member(t.name, token)
            if new == t.name or new in have or len(new) > 64:
                continue
            have.discard(t.name)
            have.add(new)
            done[t.name] = new
            t.name = new
            # Not _ComponentTemplate.save: its per-rename marker follow-up
            # runs once for the lot below, and the devices' marker keys
            # follow their own renames (restack).
            super(_ComponentTemplate, t).save(update_fields=["name", "updated_at"])
        if done:
            rename_marker_refs_many(dt, marker, done, marker_keys=False)
            renamed[key] = done
    return token, renamed


def rename_state(state, renamed: dict[str, dict[str, str]]) -> None:
    """The type's pack record (``pack_state``) under the new names, in
    place: the snapshot a re-import compares against, the names the packs
    ever made, an outlet's power port."""
    if not isinstance(state, dict) or not renamed:
        return
    for section in ("templates", "pack_names"):
        src = state.get(section)
        if not isinstance(src, dict):
            continue
        for key, mapping in renamed.items():
            rows = src.get(key)
            if isinstance(rows, dict):
                src[key] = {mapping.get(n, n): v for n, v in rows.items()}
            elif isinstance(rows, list):
                src[key] = [mapping.get(n, n) for n in rows]
        pp = renamed.get("power-ports") or {}
        outlets = src.get("power-outlets") if section == "templates" else None
        if pp and isinstance(outlets, dict):
            for v in outlets.values():
                if isinstance(v, dict) and v.get("power_port") in pp:
                    v["power_port"] = pp[v["power_port"]]


def restack(dt) -> dict:
    """Re-render every stacked device of ``dt`` for its member number: a
    port still carrying member 1's name (stamped before the type took the
    token, or before the device joined) takes its own - its type's
    ``{position}`` templates, and its installed modules' ports. Same rows;
    a name another port holds is skipped. Idempotent. ``{"devices",
    "interfaces", "power_ports", "skipped": ["device: name", …]}``."""
    from .models import (
        POSITION_TOKEN_RE,
        Device,
        Interface,
        PowerPort,
        _module_kinds,
        member_token,
        rename_components,
        render_component_name,
        render_module_component,
    )

    out = {"devices": 0, "interfaces": 0, "power_ports": 0, "skipped": []}
    names = list(dt.interface_templates.values_list("name", flat=True))
    token = member_token(names)
    if token is None:
        return out
    chassis = {
        Interface: [n for n in names if POSITION_TOKEN_RE.search(n)],
        PowerPort: [n for n in dt.power_port_templates.values_list("name", flat=True)
                    if POSITION_TOKEN_RE.search(n)],
    }
    key = {Interface: "interfaces", PowerPort: "power_ports"}
    devices = Device.objects.filter(tenant_id=dt.tenant_id, device_type=dt,
                                    virtual_chassis__isnull=False,
                                    vc_position__isnull=False).order_by("name")
    for d in devices:
        pos = d.vc_position
        rows = {m: [(None, render_component_name(n, None), render_component_name(n, pos))
                    for n in tmpl] for m, tmpl in chassis.items()}
        for module in d.modules.select_related("module_bay", "module_type"):
            bay = module.module_bay.position
            for kind in _module_kinds():
                for t in getattr(module.module_type, kind.templates).all():
                    rows[kind.model].append((
                        module.pk, render_module_component(t.name, bay, pos),
                        render_module_component(t.name, bay, pos, token)))
        touched = False
        for model, r in rows.items():
            done, skipped = rename_components(d, model, r)
            out[key[model]] += done
            out["skipped"] += [f"{d.name}: {n}" for n in skipped]
            touched = touched or bool(done)
        out["devices"] += touched
    return out


def _n(count: int, noun: str) -> str:
    return f"{count} {noun}{'s' if count != 1 else ''}"


def bring_in_line(dt, data, state) -> list[str]:
    """The pack import's step for a device type, before its templates are
    compared with the YAML: a stackable type takes the stack-member token
    (its pack record renamed with it), then its stacked devices are
    re-rendered. The import notes."""
    from .model_pack_update import NAME_LIST_CAP

    renamed: dict = {}
    notes = []
    meta = data.get("meta") if isinstance(data, dict) else None
    if isinstance(meta, dict) and "stackable" in meta and meta_stackable(data) is None:
        notes.append("meta.stackable: not true or false - ignored.")
    if stackable(dt, data):
        _token, renamed = take_token(dt)
        rename_state(state, renamed)
    moved = restack(dt)
    parts = []
    n = sum(len(v) for v in renamed.values())
    if n:
        parts.append(f"{_n(n, 'template')} take{'s' if n == 1 else ''} the stack-member token")
    ports = [_n(moved[k], noun) for k, noun in (("interfaces", "interface"),
                                                 ("power_ports", "power port")) if moved[k]]
    if ports:
        parts.append(f"{' and '.join(ports)} renamed on {_n(moved['devices'], 'stack member')}")
    if parts:
        notes.append(f"stack members: {'; '.join(parts)}.")
    if moved["skipped"]:
        names = moved["skipped"]
        shown = ", ".join(names[:NAME_LIST_CAP])
        if len(names) > NAME_LIST_CAP:
            shown += f" … and {len(names) - NAME_LIST_CAP} more"
        notes.append(f"stack members: kept {_n(len(names), 'port')} under member 1's "
                     f"name, the member's own name is taken: {shown}")
    return notes
