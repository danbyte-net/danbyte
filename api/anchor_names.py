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
    already the interface's name."""
    from .models import InterfaceTemplate, ModuleInterfaceTemplate

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
