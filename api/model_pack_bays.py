"""A fixed port that becomes a module bay on a re-import
(docs/dcim/model-packs.md → A port that becomes a module bay).

The trigger: the import removed a device type's interface or power port
template X (api.model_pack_update) and the type has a module bay whose
listed module types (``suggested_modules``, the tenant's module types by part
number) have a template that, installed in that bay, renders to exactly X -
a C9300L's ``StackPort1/1`` becoming a bay that takes ``C9300L-STACK-KIT``
(``StackPort{module}`` at position ``1/1``). Then, for every device of the
type:

* the device gets the bay when it has none of that name, as stamping from
  its type would make it;
* its own component X **in use** (:func:`_busy`) moves onto a module of a
  matching type installed in the bay: same row, so cables, stack links, IPs,
  history and monitoring stay. Where a field still holds what the removed
  template said, it takes the module template's value (hand edits win);
* X **not in use** stays where it is and is reported: nothing is installed
  that the device may not have, and nothing is deleted. Sync devices
  removes it, or an install adopts it.

A bay that already holds a module, or whose module would clash with another
of the device's components, is left alone and reported. Runs inside the
import's transaction (a dry run is the same work rolled back); every write
is an ordinary save, audited with the import's cause. A second import
removes no template, so it does nothing here.
"""
from __future__ import annotations

from dataclasses import dataclass, field

#: Pack template kind -> (module kind key, the fields a move may update).
KINDS = {
    "interfaces": ("interfaces",
                   ("type", "enabled", "mgmt_only", "poe_mode", "poe_type", "description")),
    "power-ports": ("power_ports", ("type", "maximum_draw", "allocated_draw", "description")),
}
NOUN = {"interfaces": "interface", "power-ports": "power port"}
#: An interface's own references that make it in use.
_IFACE_REFS = ("vlan_id", "vrf_id", "parent_id", "lag_id", "bridge_id", "macsec_keychain_id")


@dataclass
class _Bay:
    """One bay template that takes over removed templates."""

    template: object
    #: (kind key, removed template name)
    names: set = field(default_factory=set)
    #: [(module type, {(kind key, name): module template})] in the bay's order
    options: list = field(default_factory=list)


def _plans(dt, removed: dict) -> list[_Bay]:
    """The type's bays whose listed module types make a removed template's
    name, with those module types in the bay's list order."""
    from .models import ModuleType, render_module_name

    want = {(k, n) for k, rows in removed.items() if k in KINDS for n in rows}
    if not want:
        return []
    bays = [b for b in dt.module_bay_templates.all() if b.suggested_modules]
    parts = {str(p).strip().lower() for b in bays for p in b.suggested_modules}
    by_part: dict = {}
    if parts:
        for mt in ModuleType.objects.filter(tenant_id=dt.tenant_id).prefetch_related(
                "interface_templates", "power_port_templates"):
            pn = (mt.part_number or "").strip().lower()
            if pn in parts:
                by_part.setdefault(pn, []).append(mt)
    out = []
    for b in bays:
        plan = _Bay(b)
        for p in b.suggested_modules:
            hits = by_part.get(str(p).strip().lower(), [])
            if len(hits) != 1:  # none, or ambiguous: not ours to pick
                continue
            mt = hits[0]
            made = {}
            for key, (_mk, _f) in KINDS.items():
                rel = "interface_templates" if key == "interfaces" else "power_port_templates"
                for t in getattr(mt, rel).all():
                    name = render_module_name(t.name, b.position)
                    if (key, name) in want:
                        made[(key, name)] = t
            if made and all(mt.pk != o[0].pk for o in plan.options):
                plan.options.append((mt, made))
                plan.names |= set(made)
        if plan.options:
            out.append(plan)
    return out


def _busy(components: list, devices: dict) -> dict:
    """``{component pk: [reasons]}`` for the components in use. In use: a
    cable on it (recorded, auto-connected or marked connected); a stack
    member's stack port (the derived ring draws through it); any row that
    points at it (an IP, MAC, LAG/bridge/sub-interface member, transceiver,
    reservation, outlet, routing or monitoring record...); its own VLAN, VRF,
    LAG, bridge, parent or MACsec reference; tags; a label, custom field
    value or a description other than its template's."""
    from .dcim_choices import STACK_INTERFACE_TYPES, STACK_POWER_PORT_TYPES
    from .models import Interface

    out: dict = {}

    def add(pk, why):
        reasons = out.setdefault(pk, [])
        if why not in reasons:
            reasons.append(why)

    by_model: dict = {}
    for c, _old in components:
        by_model.setdefault(type(c), []).append(c)
    for model, comps in by_model.items():
        ids = [c.pk for c in comps]
        for rel in model._meta.related_objects:
            if rel.many_to_many:
                through = rel.through
                col = _fk_to(through, model)
                hits = through._default_manager.filter(**{f"{col}__in": ids}).values_list(
                    col, flat=True)
            else:
                col = rel.field.attname
                hits = rel.related_model._default_manager.filter(
                    **{f"{col}__in": ids}).values_list(col, flat=True)
            why = ("cable" if rel.related_model._meta.model_name == "cabletermination"
                   else str(rel.related_model._meta.verbose_name))
            for pk in set(hits):
                add(pk, why)
        if model is Interface:
            through = Interface.tagged_vlans.through
            col = _fk_to(through, Interface)
            for pk in set(through.objects.filter(**{f"{col}__in": ids}).values_list(
                    col, flat=True)):
                add(pk, "tagged VLANs")
        from django.contrib.contenttypes.models import ContentType

        from core.models import TaggedItem

        for pk in set(TaggedItem.objects.filter(
                content_type=ContentType.objects.get_for_model(model),
                object_id__in=ids).values_list("object_id", flat=True)):
            add(pk, "tags")
    stack_types = {"Interface": STACK_INTERFACE_TYPES, "PowerPort": STACK_POWER_PORT_TYPES}
    for c, old in components:
        d = devices[c.device_id]
        if getattr(c, "mark_connected", False):
            add(c.pk, "cable")
        stacky = c.type in stack_types[type(c).__name__] or getattr(c, "stack_port", False)
        if stacky and d.virtual_chassis_id and d.vc_position is not None:
            add(c.pk, "stack member")
        if any(getattr(c, f, None) for f in _IFACE_REFS if hasattr(c, f)):
            add(c.pk, "references")
        if (c.label if hasattr(c, "label") else "") or any(
                v not in (None, "", [], {}) for v in (c.custom_fields or {}).values()):
            add(c.pk, "edited")
        if (c.description or "") != (old.get("description") or ""):
            add(c.pk, "edited")
    return out


def _fk_to(through, model) -> str:
    """The column of a many-to-many table that points at ``model``."""
    fk = next(f for f in through._meta.fields if f.is_relation and f.related_model is model)
    return fk.attname


def _pick(options: list, busy: list) -> tuple | None:
    """The module type a device's bay takes for its components in use
    ``busy`` (``[(kind key, name, component, far type)]``): of the options
    making all of them, the first in the bay's list whose templates have the
    component's type, else its cable's far end's type, else a type of their
    stack family (``STACK_TYPE_FAMILIES``); else the first making them all."""
    from .dcim_choices import STACK_TYPE_FAMILIES

    fits = [o for o in options if all((k, n) in o[1] for k, n, _c, _f in busy)]
    if not fits:
        return None

    def family(t):
        t = (t or "").lower()
        return {t, *STACK_TYPE_FAMILIES.get(t, ())} | {
            g for g, members in STACK_TYPE_FAMILIES.items() if t in members}

    tests = (
        lambda tt, c, far: tt == c.type,
        lambda tt, c, far: bool(far) and tt == far,
        lambda tt, c, far: tt in family(c.type) | (family(far) if far else set()),
    )
    for test in tests:
        for o in fits:
            if all(test(o[1][(k, n)].type, c, far) for k, n, c, far in busy):
                return o
    return fits[0]


def _far_types(components) -> dict:
    """``{component pk: the type of the port at the cable's other end}``."""
    from .models import CableTermination

    out: dict = {}
    by_point: dict = {}
    for c, _old in components:
        point = "interface_id" if type(c).__name__ == "Interface" else "power_port_id"
        by_point.setdefault(point, []).append(c.pk)
    for point, ids in by_point.items():
        mine = list(CableTermination.objects.filter(**{f"{point}__in": ids})
                    .values_list("cable_id", point))
        if not mine:
            continue
        ends: dict = {}
        for cable, pk in mine:
            ends.setdefault(cable, set()).add(pk)
        rel = point[:-3]
        for cable, ptype, pk in (CableTermination.objects
                                 .filter(cable_id__in=list(ends), **{f"{point}__isnull": False})
                                 .values_list("cable_id", f"{rel}__type", point)):
            for here in ends[cable]:
                if here != pk:
                    out.setdefault(here, ptype or "")
    return out


def _move(module, kind_key: str, comp, t, old: dict) -> None:
    """Hand ``comp`` to ``module`` as template ``t``'s component; each field
    still holding the removed template's value ``old`` takes ``t``'s."""
    from .dcim_choices import VIRTUAL_INTERFACE_TYPES

    updates = {"module": module, "module_template": t}
    for f in KINDS[kind_key][1]:
        new = getattr(t, f, None)
        if f in old and getattr(comp, f) == old[f] and new != old[f]:
            updates[f] = new if new is not None or f != "description" else ""
    if kind_key == "interfaces" and "type" in updates:
        updates["virtual"] = updates["type"] in VIRTUAL_INTERFACE_TYPES
    for k, v in updates.items():
        setattr(comp, k, v)
    comp.save(update_fields=[*updates, "updated_at"])


def _names(names: list, cap: int) -> str:
    from .natural import natural_key

    names = sorted(names, key=natural_key)
    out = ", ".join(names[:cap])
    if len(names) > cap:
        out += f" … and {len(names) - cap} more"
    return out


def convert(dt, removed: dict, *, pack: dict) -> list[str]:
    """Carry the devices of ``dt`` over to the bays that took the removed
    templates ``removed`` (``{kind key: {name: values}}``); the notes."""
    from django.db import transaction

    from .cooling import cooling_rack, refused
    from .model_pack_update import NAME_LIST_CAP
    from .models import (
        Device,
        Interface,
        Module,
        ModuleBay,
        ModuleInstallConflict,
        PowerPort,
        install_module_report,
        render_component_name,
    )

    plans = _plans(dt, removed)
    if not plans:
        return []
    devices = {d.pk: d for d in Device.objects.filter(
        tenant_id=dt.tenant_id, device_type=dt).select_related("rack")}
    if not devices:
        return []
    models = {"interfaces": Interface, "power-ports": PowerPort}
    # Every device's own components a plan replaces, in one query per kind.
    found: dict = {}   # (device pk, kind key, template name) -> component
    for key, model in models.items():
        wanted = {n for p in plans for k, n in p.names if k == key}
        if not wanted:
            continue
        rendered = {}
        for d in devices.values():
            for n in wanted:
                rendered[(d.pk, render_component_name(n, d.vc_position))] = n
        for c in model.objects.filter(device_id__in=list(devices), module__isnull=True,
                                      name__in={r[1] for r in rendered}):
            n = rendered.get((c.device_id, c.name))
            if n is not None:
                found[(c.device_id, key, n)] = c
    comps = [(c, removed[k][n]) for (_d, k, n), c in found.items()]
    busy = _busy(comps, devices)
    far = _far_types(comps)
    existing = {(b.device_id, b.name): b for b in ModuleBay.objects.filter(
        device_id__in=list(devices)).select_related("module")}

    label = " ".join(x for x in (pack.get("name"), pack.get("version")) if x) or "pack"
    bays_added: dict = {}   # bay name -> devices
    installed: dict = {}    # module type name -> [(device name, bay name)]
    moved: dict = {}        # kind key -> count
    kept: dict = {}         # (kind key, reason) -> {"names": set, "devices": set, "n": int}

    def keep(key, reason, d, names):
        k = kept.setdefault((key, reason), {"names": set(), "devices": set(), "n": 0})
        k["names"] |= set(names)
        k["devices"].add(d.name)
        k["n"] += len(names)

    for d in sorted(devices.values(), key=lambda x: x.name):
        pos = d.vc_position
        for plan in plans:
            bt = plan.template
            bay_name = render_component_name(bt.name, pos)
            bay = existing.get((d.pk, bay_name))
            if bay is None:
                bay = ModuleBay(device=d, name=bay_name, position=bt.position,
                                description=bt.description)
                bay.save()
                existing[(d.pk, bay_name)] = bay
                bays_added.setdefault(bay_name, set()).add(d.name)
            mine = [(k, n, found[(d.pk, k, n)]) for k, n in sorted(plan.names)
                    if (d.pk, k, n) in found]
            if not mine:
                continue
            by_kind: dict = {}
            for k, _n, c in mine:
                by_kind.setdefault(k, []).append(c.name)
            if hasattr(bay, "module"):
                for k, names in by_kind.items():
                    keep(k, "the bay holds a module", d, names)
                continue
            used = [(k, n, c, far.get(c.pk)) for k, n, c in mine if c.pk in busy]
            if not used:
                for k, names in by_kind.items():
                    keep(k, "not in use", d, names)
                continue
            choice = _pick(plan.options, used)
            if choice is None:
                for k, names in by_kind.items():
                    keep(k, "no listed module makes them all", d, names)
                continue
            mt, made = choice
            rack = cooling_rack(d)
            if rack is not None and mt.cooling_method and mt.cooling_method in refused(
                    rack.cooling_capability):
                for k, names in by_kind.items():
                    keep(k, f"rack {rack.name} cannot cool {mt.name}", d, names)
                continue
            taking = [(k, n, c) for k, n, c in mine if (k, n) in made]
            try:
                with transaction.atomic():
                    names = ", ".join(c.name for _k, _n, c in taking)
                    module = Module(device=d, module_bay=bay, module_type=mt,
                                    description=f"Added by pack import {label}: holds the "
                                                f"existing {names}"[:255])
                    module.save()
                    for k, n, c in taking:
                        _move(module, k, c, made[(k, n)], removed[k][n])
                    install_module_report(module)
            except ModuleInstallConflict as exc:
                for k, names in by_kind.items():
                    keep(k, f"{mt.name} clashes ({', '.join(exc.names)})", d, names)
                continue
            bay.module = module
            installed.setdefault(mt.name, []).append((d.name, bay_name))
            for k, _n, _c in taking:
                moved[k] = moved.get(k, 0) + 1
            left = [(k, c.name) for k, n, c in mine if (k, n) not in made]
            for k, name in left:
                keep(k, "not in use", d, [name])

    cap = NAME_LIST_CAP
    notes = []
    # Bays added to the same devices read as one line.
    same: dict = {}
    for bay_name, names in bays_added.items():
        same.setdefault(frozenset(names), []).append(bay_name)
    for names, bays in sorted(same.items(), key=lambda kv: sorted(kv[1])):
        n, b = len(names), len(bays)
        notes.append(f"devices: added module bay{'s' * (b != 1)} {_names(bays, cap)} to {n} "
                     f"device{'s' * (n != 1)}: {_names(list(names), cap)}")
    for mt_name, rows in sorted(installed.items()):
        devs = sorted({r[0] for r in rows})
        bays = sorted({r[1] for r in rows})
        n = len(rows)
        notes.append(
            f"devices: installed {n} {mt_name} module{'s' * (n != 1)} in "
            f"{_names(bays, cap)} on {len(devs)} device{'s' * (len(devs) != 1)}, each "
            f"holding the existing port it replaces: {_names(devs, cap)}")
    for k, n in sorted(moved.items()):
        noun = NOUN[k] + ("s" if n != 1 else "")
        notes.append(f"devices: moved {n} {noun} onto the modules - cables, stack links "
                     "and history stay")
    for (k, reason), v in sorted(kept.items()):
        noun = NOUN[k] + ("s" if v["n"] != 1 else "")
        nd = len(v["devices"])
        tail = (" - install a module in the bay or delete them" if reason == "not in use"
                else "")
        notes.append(
            f"devices: kept {v['n']} {noun} {_names(list(v['names']), cap)} on {nd} "
            f"device{'s' * (nd != 1)}, {reason}{tail}: {_names(list(v['devices']), cap)}")
    return notes
