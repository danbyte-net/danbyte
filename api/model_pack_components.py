"""A template field a re-import changes reaches the components made from it
(docs/dcim/model-packs.md → What a re-import changes).

When the import changes a field of a template (api.model_pack_update - an
interface's type, a power port's draw, a front port's rear position, …),
the components that template made take the new value: the type's devices'
own components (by name, ``{position}`` rendered per stack member) and the
ports of installed modules of a module type (by ``module_template``, else by
the name the module renders). Only a component still holding the old
template value follows; one that differs was edited here and is kept and
reported. Same rows, ordinary saves, so the change log records each one
with the import's cause; it runs inside the import's transaction (a dry run
is the same work rolled back) and a second import changes no template, so
it does nothing.

:func:`plan` also serves ``manage.py sync_type_components``, which catches
up components whose template an earlier import already changed: there the
old values come from the template's change log.
"""
from __future__ import annotations

from dataclasses import dataclass, field

#: Pack kind key -> (device relation, the fields that follow the template).
#: Only fields the import updates on a template and stamping copies.
DEVICE_FIELDS = {
    "power-ports": ("power_ports", ("type", "maximum_draw", "allocated_draw", "description")),
    "rear-ports": ("rear_ports", ("type", "positions", "is_splitter", "description")),
    "interfaces": ("interfaces", ("type", "enabled", "mgmt_only", "poe_mode", "poe_type",
                                  "stack_port", "description")),
    "console-ports": ("console_ports", ("type", "description")),
    "console-server-ports": ("console_server_ports", ("type", "description")),
    "power-outlets": ("power_outlets", ("type", "feed_leg", "power_port", "description")),
    "front-ports": ("front_ports", ("type", "rear_port", "rear_port_position", "description")),
    "module-bays": ("module_bays", ("position", "description")),
    "device-bays": ("device_bays", ("description",)),
}
MODULE_FIELDS = {
    "interfaces": ("interfaces", ("type", "enabled", "mgmt_only", "poe_mode", "poe_type",
                                  "description")),
    "power-ports": ("power_ports", ("type", "maximum_draw", "allocated_draw", "description")),
}
#: Template reference -> the component's: the value is the template's name.
REFS = {"power_port": "power_port", "rear_port": "rear_port"}
#: Stamping a module's interface doesn't copy PoE: an empty value there is
#: still the stamp's.
_MODULE_UNSTAMPED = ("poe_mode", "poe_type")
#: Columns Interface.save normalises from the type.
_IFACE_TYPE_COLS = ("virtual", "lag_mode", "lag_hash_policy", "lag_miimon", "lag_protocol")


@dataclass
class Plan:
    """What carrying template values to components does."""

    owners: str = "devices"
    #: component pk -> (component, {field: value})
    writes: dict = field(default_factory=dict)
    #: (kind, attr, old, new) -> {"n": int, "owners": set, "edited": [names]}
    groups: dict = field(default_factory=dict)
    #: (kind, attr, new, reason) -> [names]
    held: dict = field(default_factory=dict)
    #: (kind, attr, new) -> [names]: no earlier value known (catch-up only)
    unknown: dict = field(default_factory=dict)

    @property
    def count(self) -> int:
        return len(self.writes)


def _noun(key: str) -> str:
    from .model_pack_update import MODULE_KINDS

    return next(k.noun for k in MODULE_KINDS + _device_kinds() if k.key == key)


def _device_kinds():
    from .model_pack_update import DEVICE_KINDS

    return DEVICE_KINDS


def _components(owner, key: str, names, *, module: bool):
    """``(component, template name, owner label, render)`` for every
    component of the importing tenant that template ``names`` of kind
    ``key`` made; ``render`` turns a template name into the name it has on
    that component's device (for references)."""
    from .models import (
        Device,
        Module,
        device_member_token,
        prime_member_tokens,
        render_component_name,
        render_module_component,
    )

    if not module:
        dev_rel = DEVICE_FIELDS[key][0]
        rel = getattr(Device, dev_rel).rel
        model = rel.related_model
        devices = {d.pk: d for d in Device.objects.filter(
            tenant_id=owner.tenant_id, device_type=owner).only("id", "name", "vc_position")}
        if not devices:
            return
        wanted = {}
        for d in devices.values():
            for n in names:
                wanted[(d.pk, render_component_name(n, d.vc_position))] = n
        qs = model.objects.filter(device_id__in=list(devices),
                                  name__in={w[1] for w in wanted})
        if any(f.name == "module" for f in model._meta.fields):
            qs = qs.filter(module__isnull=True)
        refs = [r for r in REFS if any(f.name == r for f in model._meta.fields)]
        if refs:
            qs = qs.select_related(*refs)
        for c in qs:
            n = wanted.get((c.device_id, c.name))
            if n is not None:
                d = devices[c.device_id]
                yield c, n, d.name, (lambda raw, pos=d.vc_position:
                                     render_component_name(raw, pos))
        return
    dev_rel = MODULE_FIELDS[key][0]
    model = getattr(Device, dev_rel).rel.related_model
    rel = "interface_templates" if key == "interfaces" else "power_port_templates"
    tmpls = {t.pk: t for t in getattr(owner, rel).filter(name__in=list(names))}
    if not tmpls:
        return
    modules = {m.pk: m for m in Module.objects.filter(
        module_type=owner, device__tenant_id=owner.tenant_id).select_related(
        "device", "module_bay")}
    if not modules:
        return
    prime_member_tokens([m.device for m in modules.values()])
    seen = set()
    for c in model.objects.filter(module_id__in=list(modules), module_template_id__in=list(
            tmpls)):
        seen.add(c.pk)
        yield c, tmpls[c.module_template_id].name, modules[c.module_id].device.name, None
    # Ports stamped before modules recorded their template: the rendered name.
    by_name = {}
    for m in modules.values():
        token = device_member_token(m.device)
        for t in tmpls.values():
            by_name[(m.pk, render_module_component(
                t.name, m.module_bay.position, m.device.vc_position, token))] = t.name
    for c in model.objects.filter(module_id__in=list(modules), module_template__isnull=True,
                                  name__in={k[1] for k in by_name}):
        n = by_name.get((c.module_id, c.name))
        if n is not None and c.pk not in seen:
            yield c, n, modules[c.module_id].device.name, None


def _value(c, attr):
    if attr in REFS:
        other = getattr(c, REFS[attr])
        return other.name if other is not None else ""
    return getattr(c, attr)


def plan(owner, changes: dict, *, module: bool, force: bool = False) -> Plan:
    """What ``changes`` - ``{kind key: {template name: {attr: (old values,
    new)}}}`` - do to ``owner``'s components. A component holding one of
    the old values takes the new one; one holding neither was edited here.
    Old values None: none known (the catch-up's template with no change
    log) - listed, taken only with ``force``."""
    from .models import FrontPort, ModuleBay, RearPort

    fields = MODULE_FIELDS if module else DEVICE_FIELDS
    out = Plan(owners="modules" if module else "devices")
    for key in fields:  # rear ports before the front ports on them
        rows = changes.get(key) or {}
        rows = {n: {a: v for a, v in attrs.items() if a in fields[key][1]}
                for n, attrs in rows.items()}
        rows = {n: attrs for n, attrs in rows.items() if attrs}
        if not rows:
            continue
        for c, tname, who, render in _components(owner, key, rows, module=module):
            label = f"{who}: {c.name}"
            for attr, (olds, new) in rows[tname].items():
                cur = _value(c, attr)
                want = render(new) if attr in REFS and new else new
                if cur == want:
                    continue
                known = None if olds is None else [
                    render(o) if attr in REFS and o else o for o in olds]
                stamped = module and attr in _MODULE_UNSTAMPED and cur == ""
                if known is None and not stamped:
                    out.unknown.setdefault((key, attr, _show(new)), []).append(label)
                    if not force:
                        continue
                elif not stamped and cur not in known:
                    g = out.groups.setdefault((key, attr, _show(known[0] if known else ""),
                                               _show(new)),
                                              {"n": 0, "owners": set(), "edited": []})
                    g["edited"].append(label)
                    continue
                value = want
                reason = None
                if attr in REFS:
                    target = _ref_target(c, attr, want)
                    if want and target is None:
                        reason = f"the device has no {want}"
                    value = target
                elif key == "rear-ports" and attr == "positions" and isinstance(c, RearPort):
                    top = max(FrontPort.objects.filter(rear_port=c).values_list(
                        "rear_port_position", flat=True), default=0)
                    if new < top:
                        reason = f"its front ports use position {top}"
                elif key == "front-ports" and attr == "rear_port_position":
                    rear = out.writes.get(c.rear_port_id, (None, {}))[1].get("positions")
                    rear = rear or RearPort.objects.filter(pk=c.rear_port_id).values_list(
                        "positions", flat=True).first() or 1
                    if new > rear:
                        reason = f"its rear port has {rear} position{'s' * (rear != 1)}"
                elif key == "module-bays" and attr == "position" and isinstance(c, ModuleBay):
                    if hasattr(c, "module") and c.module is not None:
                        reason = "the bay holds a module"
                if reason is not None:
                    out.held.setdefault((key, attr, _show(new), reason), []).append(label)
                    continue
                if attr == "description" and value is None:
                    value = ""
                out.writes.setdefault(c.pk, (c, {}))[1][attr] = value
                g = out.groups.setdefault((key, attr, _show(cur), _show(new)),
                                          {"n": 0, "owners": set(), "edited": []})
                g["n"] += 1
                g["owners"].add(c.module_id if module else c.device_id)
    return out


def _ref_target(c, attr: str, name: str):
    """The device component a reference named ``name`` points at."""
    if not name:
        return None
    model = c._meta.get_field(REFS[attr]).related_model
    return model.objects.filter(device_id=c.device_id, name=name).first()


def apply(p: Plan) -> int:
    """Write the plan: one audited save per component."""
    from .dcim_choices import VIRTUAL_INTERFACE_TYPES
    from .models import Interface

    for c, updates in p.writes.values():
        cols = []
        for attr, v in updates.items():
            setattr(c, REFS.get(attr, attr), v)
            cols.append(REFS.get(attr, attr))
        if isinstance(c, Interface) and "type" in updates:
            c.virtual = c.type in VIRTUAL_INTERFACE_TYPES
            cols += _IFACE_TYPE_COLS
        c.save(update_fields=[*dict.fromkeys(cols), "updated_at"])
    return len(p.writes)


def _show(v) -> str:
    from .model_pack_update import _show as show

    return show(v)


def _names(names: list) -> str:
    from .model_pack_update import NAME_LIST_CAP
    from .natural import natural_key

    names = sorted(names, key=natural_key)
    out = ", ".join(names[:NAME_LIST_CAP])
    if len(names) > NAME_LIST_CAP:
        out += f" … and {len(names) - NAME_LIST_CAP} more"
    return out


def _plural(noun: str, n: int) -> str:
    return noun if n == 1 else noun + "s"


def notes(p: Plan) -> list[str]:
    """The import's lines for the plan, in the existing note style."""
    from .model_pack_update import FIELD_LABEL

    out = []
    owner = p.owners[:-1]
    for (key, attr, old, new), g in p.groups.items():
        label = FIELD_LABEL.get(attr, attr)
        noun = _noun(key)
        parts = []
        if g["n"]:
            no = len(g["owners"])
            parts.append(f"updated {label} on {g['n']} {_plural(noun, g['n'])} of {no} "
                         f"{_plural(owner, no)} ({old} → {new})")
        if g["edited"]:
            ne = len(g["edited"])
            head = (f"kept {ne} edited by hand" if parts else
                    f"kept {label} on {ne} {_plural(noun, ne)} edited by hand (the template "
                    f"has {new})")
            parts.append(f"{head}: {_names(g['edited'])}")
        out.append("devices: " + "; ".join(parts))
    for (key, attr, new, reason), names in p.held.items():
        n = len(names)
        out.append(f"devices: kept {FIELD_LABEL.get(attr, attr)} on {n} "
                   f"{_plural(_noun(key), n)} (the template has {new}), {reason}: "
                   f"{_names(names)}")
    for (key, attr, new), names in p.unknown.items():
        n = len(names)
        out.append(f"devices: {n} {_plural(_noun(key), n)} differ in "
                   f"{FIELD_LABEL.get(attr, attr)} (the template has {new}), no earlier "
                   f"value known: {_names(names)}")
    return out


def carry(owner, changed: dict, *, module: bool) -> list[str]:
    """The import's step: ``changed`` (:class:`~api.model_pack_update.Report`
    ``.changed_rows``, ``{kind key: {template name: {attr: (old, new)}}}``)
    reaches the components; the notes."""
    if not changed:
        return []
    changes = {k: {n: {a: ([old], new) for a, (old, new) in attrs.items()}
                   for n, attrs in rows.items()} for k, rows in changed.items()}
    p = plan(owner, changes, module=module)
    apply(p)
    return notes(p)


# ── catching up (manage.py sync_type_components) ────────────────────────────

def history(model_label: str, ids) -> dict:
    """``{template pk: {attr: [earlier values, newest first]}}`` from the
    change log's update entries."""
    from audit.models import ChangeLogEntry

    out: dict = {}
    for oid, changes in ChangeLogEntry.objects.filter(
            object_type=model_label, object_id__in=[str(i) for i in ids],
            action="update").order_by("-timestamp").values_list("object_id", "changes"):
        if not isinstance(changes, dict):
            continue
        for attr, d in changes.items():
            if isinstance(d, dict) and "old" in d:
                seen = out.setdefault(oid, {}).setdefault(attr, [])
                if d["old"] not in seen:
                    seen.append(d["old"])
    return out


#: Fields the catch-up leaves alone: operational state an operator sets
#: (a port shut down, a description) that no change log can tell apart.
CATCH_UP_SKIP = ("enabled", "description")


def catch_up_changes(owner, *, module: bool, only: set | None = None) -> dict:
    """The type's templates as ``changes`` for :func:`plan`: each field's
    current value, its earlier ones from the change log (None when it has
    none). References are not caught up (the log holds their ids), nor
    :data:`CATCH_UP_SKIP`; ``only`` narrows to those fields."""
    from .model_pack_update import DEVICE_KINDS, MODULE_KINDS

    kinds = MODULE_KINDS if module else DEVICE_KINDS
    fields = MODULE_FIELDS if module else DEVICE_FIELDS
    out: dict = {}
    for kind in kinds:
        if kind.key not in fields:
            continue
        attrs = [a for a in fields[kind.key][1] if a not in REFS and a not in CATCH_UP_SKIP
                 and (not only or a in only)]
        if not attrs:
            continue
        tmpls = list(getattr(owner, kind.rel).all())
        if not tmpls:
            continue
        hist = history(tmpls[0]._meta.label_lower, [t.pk for t in tmpls])
        for t in tmpls:
            h = hist.get(str(t.pk), {})
            row = {}
            for a in attrs:
                cur = getattr(t, a)
                olds = [v for v in h.get(a, []) if v != cur]
                row[a] = (olds or None, cur)
            out.setdefault(kind.key, {})[t.name] = row
    return out
