"""Model anchor names against component template names.

A 3D model names its ports as concrete interfaces (``port:GigabitEthernet1/0/1``
- the device library's spelling), while a tenant's type may name them with
Danbyte's stack-member token (``GigabitEthernet{position}/0/1``). The
convention that joins them: **a model is authored as the first stack member**
- the type's standalone rendering, ``{position}`` as 1 and ``{position:N}``
as N. A model may also spell the token itself (``port:Gi{position}/0/1``).

Only a ``{position}`` token that is the name's leading number counts (its
prefix carries no digit: ``Gi{position}/0/1``, ``ge-{position:0}/0/0``,
``{position}/1/1``) - the member segment, the one ``positionize`` writes on
import. Matching, for one anchor over a set of names:

1. the same string, which always wins;
2. else the names whose authored spelling equals the anchor's. One is a
   match; several are ambiguous and match nothing.

``NameMatcher`` is the matcher; frontend/src/lib/anchor-names.ts is its twin
(``anchor-names.cases.json`` holds cases both test suites run).
``interface_name`` turns an anchor into the interface a device really has:
the matched template rendered with ``{module}`` → the bay's position, then
``{position}`` → the device's stack member, as the interfaces were stamped.
A ``port:`` anchor may also name another port-like template - a console
port (``port:con 0``), a PSU's power inlet (``port:PSU{module}``), an aux
port: ``chassis_port`` / ``module_port`` answer which kind the anchor is,
with the name rendered the same way.
"""
from __future__ import annotations

import re

LEADING_POSITION_RE = re.compile(r"^([^\d{}]*)\{position(?::(\d+))?\}")


def authored(name: str) -> str:
    """``name`` as a model authored as the first stack member spells it: a
    leading ``{position}`` at its standalone value, the rest untouched."""
    m = LEADING_POSITION_RE.match(name)
    if m is None:
        return name
    first = m.group(2) if m.group(2) is not None else "1"
    return f"{m.group(1)}{first}{name[m.end():]}"


class NameMatcher:
    """Anchor name → one of ``names`` (template or interface names).

    ``aliases`` adds spellings that stand for a name (``{spelling: name}``),
    matched as the names' own authored spellings are - how a stack member's
    concrete interfaces (``Gi2/0/1``) answer to a model authored as member 1.
    """

    __slots__ = ("names", "_exact", "_forms")

    def __init__(self, names, aliases: dict | None = None):
        self.names = list(dict.fromkeys(str(n) for n in names))
        self._exact = set(self.names)
        forms: dict[str, list[str]] = {}
        for n in self.names:
            forms.setdefault(authored(n), []).append(n)
        for spelling, n in (aliases or {}).items():
            row = forms.setdefault(authored(spelling), [])
            if n not in row:
                row.append(n)
        self._forms = forms

    def candidates(self, anchor: str) -> list[str]:
        """The names ``anchor`` matches: itself when it is one of them, else
        every name of the same authored spelling."""
        if anchor in self._exact:
            return [anchor]
        return list(self._forms.get(authored(anchor), ()))

    def resolve(self, anchor: str) -> str | None:
        """The one name ``anchor`` matches, or None (none, or ambiguous)."""
        found = self.candidates(anchor)
        return found[0] if len(found) == 1 else None


# ── the device's own names ──────────────────────────────────────────────────

def interface_name(anchor: str, matcher: NameMatcher | None, vc_position,
                   module_position: str | None = None) -> str:
    """The interface ``anchor`` stands for on a device at stack member
    ``vc_position`` (None standalone): the template it matches (else the
    anchor itself) with ``{module}`` → ``module_position``, then
    ``{position}`` → the member. Member 2's ``port:Gi1/0/1`` over the
    template ``Gi{position}/0/1`` is ``Gi2/0/1``."""
    from .models import render_component_name, render_module_name

    name = (matcher.resolve(anchor) if matcher is not None else None) or anchor
    if module_position is not None:
        name = render_module_name(name, module_position)
    return render_component_name(name, vc_position)


def prime(devices) -> None:
    """Load the interface template names the anchors of ``devices`` resolve
    against (and photo markers authored the same way), in two queries for the
    lot: stored on each as ``_anchor_matchers`` - ``{("dt" | "mt", type
    id): NameMatcher}``. Module types come from the devices'
    ``_installed_parts`` (api.model_3d.installed_parts calls this).

    Only a stack member needs them. Standalone, a template renders to its
    authored spelling, so the anchor (with any token of its own rendered) is
    already the interface's name. Every device gets its types' other
    port-like template names (``_anchor_kinds``), in two more queries."""
    from .models import InterfaceTemplate, ModuleInterfaceTemplate

    _prime_kinds(devices)
    wanted = []
    for d in devices:
        if hasattr(d, "_anchor_matchers"):
            continue
        d._anchor_matchers = {}
        if d.vc_position is not None:
            wanted.append(d)
    if not wanted:
        return
    dt_ids = {d.device_type_id for d in wanted if d.device_type_id}
    mt_ids = {r["type"].id for d in wanted for r in getattr(d, "_installed_parts", ())
              if r.get("type") is not None}
    names: dict = {}
    for key, rows in (
        ("dt", InterfaceTemplate.objects.filter(device_type_id__in=dt_ids)
         .values_list("device_type_id", "name") if dt_ids else ()),
        ("mt", ModuleInterfaceTemplate.objects.filter(module_type_id__in=mt_ids)
         .values_list("module_type_id", "name") if mt_ids else ()),
    ):
        for type_id, name in rows:
            names.setdefault((key, type_id), []).append(name)
    matchers = {k: NameMatcher(v) for k, v in names.items()}
    for d in wanted:
        if d.device_type_id:
            d._anchor_matchers[("dt", d.device_type_id)] = matchers.get(
                ("dt", d.device_type_id)) or NameMatcher(())
        for r in getattr(d, "_installed_parts", ()):
            mt = r.get("type")
            if mt is not None:
                d._anchor_matchers[("mt", mt.id)] = matchers.get(
                    ("mt", mt.id)) or NameMatcher(())


#: The port-like template kinds besides interfaces a ``port:`` anchor may
#: name, in the order they are tried, with each owner's relation: a device
#: type's (``"dt"``) and a module type's (``"mt"``; it carries power ports
#: only). The marker kinds api.face_ports resolves.
OTHER_PORT_KINDS = (
    ("power-port", "power_port_templates", "power_port_templates"),
    ("console-port", "console_port_templates", None),
    ("console-server-port", "console_server_port_templates", None),
    ("aux-port", "aux_port_templates", None),
    ("power-outlet", "power_outlet_templates", None),
    ("front-port", "front_port_templates", None),
    ("rear-port", "rear_port_templates", None),
)


def _relations(key: str) -> list[tuple[str, str]]:
    return [(kind, dt if key == "dt" else mt) for kind, dt, mt in OTHER_PORT_KINDS
            if (dt if key == "dt" else mt)]


def other_port_names(type_obj, key: str) -> dict[str, list[str]]:
    """``{kind: [template names]}`` of a device type's (``"dt"``) or module
    type's (``"mt"``) port-like templates other than interfaces."""
    return {kind: list(getattr(type_obj, rel).values_list("name", flat=True))
            for kind, rel in _relations(key)}


def _prime_kinds(devices) -> None:
    """``_anchor_kinds`` on each device: ``{("dt" | "mt", type id): [(kind,
    NameMatcher)]}`` over its type's and installed modules' port-like
    templates other than interfaces, one query per owner kind for the lot."""
    from django.db.models import CharField, Value

    from .models import DeviceType, ModuleType

    wanted = [d for d in devices if not hasattr(d, "_anchor_kinds")]
    if not wanted:
        return
    ids = {
        "dt": {d.device_type_id for d in wanted if d.device_type_id},
        "mt": {r["type"].id for d in wanted for r in getattr(d, "_installed_parts", ())
               if r.get("type") is not None},
    }
    owner_model = {"dt": DeviceType, "mt": ModuleType}
    names: dict = {}
    for key, type_ids in ids.items():
        if not type_ids:
            continue
        # Every kind in one query (UNION ALL), as the interface names are.
        parts = []
        for kind, rel in _relations(key):
            field = owner_model[key]._meta.get_field(rel)
            fk = field.field.name + "_id"
            parts.append(
                field.related_model.objects.filter(**{f"{fk}__in": type_ids}).order_by()
                .annotate(kind=Value(kind, output_field=CharField()))
                .values_list(fk, "kind", "name"))
        rows = parts[0].union(*parts[1:], all=True) if len(parts) > 1 else parts[0]
        for type_id, kind, name in rows:
            names.setdefault((key, type_id), {}).setdefault(kind, []).append(name)
    for d in wanted:
        own = {}
        keys = [("dt", d.device_type_id)] if d.device_type_id else []
        keys += [("mt", r["type"].id) for r in getattr(d, "_installed_parts", ())
                 if r.get("type") is not None]
        for k in keys:
            by_kind = names.get(k, {})
            own[k] = [(kind, NameMatcher(by_kind[kind]))
                      for kind, _rel in _relations(k[0]) if by_kind.get(kind)]
        d._anchor_kinds = own


def _kinds(device, key: str, type_obj) -> list:
    cache = device.__dict__.setdefault("_anchor_kinds", {})
    k = (key, type_obj.id)
    if k not in cache:
        cache[k] = [(kind, NameMatcher(n))
                    for kind, n in other_port_names(type_obj, key).items() if n]
    return cache[k]


def _kind_of(device, key: str, type_obj, anchor: str):
    """``(kind, matcher)`` for ``anchor``: an interface when it matches an
    interface template (or nothing at all), else the first other port-like
    template kind it matches - a console port, a power inlet, …"""
    iface = _matcher(device, key, type_obj)
    if type_obj is None or (iface is not None and iface.resolve(anchor) is not None):
        return "interface", iface
    for kind, m in _kinds(device, key, type_obj):
        if m.resolve(anchor) is not None:
            return kind, m
    return "interface", iface


def chassis_port(device, anchor: str) -> tuple[str, str]:
    """``(kind, name)`` of the device's component a chassis ``port:``
    anchor stands for: an interface, or a console port, power inlet or
    other port-like component its type has a template of."""
    kind, m = _kind_of(device, "dt", device.device_type, anchor)
    return kind, interface_name(anchor, m, device.vc_position)


def module_port(device, module_type, anchor: str, bay_position: str) -> tuple[str, str]:
    """``(kind, name)`` for an installed module's ``port:`` anchor - a
    PSU's ``port:PSU{module}`` is its power port ``PSU1`` in bay "1"."""
    kind, m = _kind_of(device, "mt", module_type, anchor)
    return kind, interface_name(anchor, m, device.vc_position, bay_position)


def _matcher(device, key: str, type_obj) -> NameMatcher | None:
    if device.vc_position is None or type_obj is None:
        return None
    cache = device.__dict__.setdefault("_anchor_matchers", {})
    k = (key, type_obj.id)
    if k not in cache:
        cache[k] = NameMatcher(type_obj.interface_templates.values_list("name", flat=True))
    return cache[k]


def chassis_interface(device, anchor: str) -> str:
    """The device's interface for a chassis ``port:`` anchor (its type's
    templates; a device with its own model was stamped from them too)."""
    return interface_name(anchor, _matcher(device, "dt", device.device_type),
                          device.vc_position)


def module_interface(device, module_type, anchor: str, bay_position: str) -> str:
    """The device's interface for an installed module's ``port:`` anchor
    (``{module}`` kept, as authored) in the bay at ``bay_position``."""
    return interface_name(anchor, _matcher(device, "mt", module_type),
                          device.vc_position, bay_position)
