"""What a model-pack re-import changes on a type it matches
(docs/dcim/model-packs.md → What a re-import changes).

A matched device or module type is brought in line with its YAML: its
component templates, its bays' module lists, its lifecycle dates and its
link documents. What tells "the pack changed this" from "someone changed
this here" is the type's ``pack_state``: the snapshot of what the last
import said, by template name and field. On the next import, per field:

* the value still equals the snapshot - the pack's: it takes the YAML's;
* it differs - edited here: kept, and reported (*kept your edit*);
* the type has no snapshot (never imported with one) - everything is the
  type's own: only missing templates and empty fields are filled in, the
  rest is reported. ``overwrite`` (*Update from pack*, ``--overwrite``)
  lets the YAML's values win everywhere.

A template the YAML no longer has is removed only when the snapshot holds
it, it is unchanged since and nothing depends on it (a front port on a rear
port, an outlet on a power port, a hand-placed marker, an installed module's
port); otherwise it is kept and reported. A template the snapshot holds
that is gone from the type was removed here, and is not added back.
``overwrite`` also removes a changed one, but only one a pack once added:
a name some earlier import recorded (``pack_names``, every name a snapshot
ever held). A template no import recorded - made by hand, or by the device
library import before packs - is never removed; on a type with no snapshot
nothing is.

Bay module lists merge three ways: what the pack added since the snapshot
joins the bay's list, what it dropped leaves it, and part numbers added
here stay.

``meta:`` (the export spec §8): ``lifecycle`` fills a device type's
lifecycle fields with the same rule (a module type has none: kept in the
snapshot), ``links`` become link Documents on a device or module type (the
ones it made are tracked in the snapshot by URL),
``summary`` becomes an empty description, and the whole block is kept in
the snapshot. The Markdown links in ``comments`` (api.description_links)
join ``meta.links`` as link Documents, and a description still holding
those comments word for word becomes their plain text. Devices are not
changed, except where a removed port became a module bay
(api.model_pack_bays) and where a changed template field reaches the
components the template made (api.model_pack_components): the report counts
the devices that are out of step, which the type's Sync devices brings in
line.

Everything here writes through ordinary saves, so the change log records
it with the import's cause; a dry run is the same work rolled back.
"""
from __future__ import annotations

import calendar
import datetime
import ipaddress
import re
from dataclasses import dataclass, field
from urllib.parse import urlparse

from django.utils.text import slugify

#: Names listed in one note before "… and N more".
NAME_LIST_CAP = 10
#: Devices out of step on the quick count that get the exact check.
EXACT_CHECK_CAP = 100

_MISSING = object()


# ── reading the YAML ────────────────────────────────────────────────────────

def _text(key, cap):
    return lambda r: str(r.get(key) or "").strip()[:cap]


def _flag(key, default):
    return lambda r: bool(r.get(key, default))


def _count(key, default):
    def read(r):
        try:
            n = int(r.get(key) or default)
        except (TypeError, ValueError):
            return default
        return n if 0 < n <= 32767 else default
    return read


def _draw(key):
    from .devicetype_import import _watts

    return lambda r: _watts(r.get(key))


def _stack(r):
    return r.get("stack") is True


@dataclass
class Kind:
    """One template kind a YAML section maps to."""

    key: str            # the YAML section, e.g. "power-ports"
    rel: str            # the owner's related name
    model: str          # the template model's name in api.models
    noun: str           # "power port"
    fields: dict        # attr -> reader(row)
    refs: dict = field(default_factory=dict)   # attr -> (yaml key, kind key, model fk)
    lists: tuple = ()   # attrs merged as lists
    dev_rel: str = ""   # the device relation (markers, out-of-step count)


DEVICE_KINDS = [
    Kind("power-ports", "power_port_templates", "PowerPortTemplate", "power port",
         {"type": _text("type", 32), "maximum_draw": _draw("maximum_draw"),
          "allocated_draw": _draw("allocated_draw")}, dev_rel="power_ports"),
    Kind("rear-ports", "rear_port_templates", "RearPortTemplate", "rear port",
         {"type": _text("type", 64), "positions": _count("positions", 1),
          "is_splitter": _flag("is_splitter", False)}, dev_rel="rear_ports"),
    Kind("interfaces", "interface_templates", "InterfaceTemplate", "interface",
         {"type": _text("type", 64), "enabled": _flag("enabled", True),
          "mgmt_only": _flag("mgmt_only", False), "poe_mode": _text("poe_mode", 8),
          "poe_type": _text("poe_type", 32), "stack_port": _stack},
         dev_rel="interfaces"),
    Kind("console-ports", "console_port_templates", "ConsolePortTemplate", "console port",
         {"type": _text("type", 32)}, dev_rel="console_ports"),
    Kind("console-server-ports", "console_server_port_templates",
         "ConsoleServerPortTemplate", "console server port",
         {"type": _text("type", 32)}, dev_rel="console_server_ports"),
    Kind("power-outlets", "power_outlet_templates", "PowerOutletTemplate", "power outlet",
         {"type": _text("type", 32), "feed_leg": _text("feed_leg", 1)},
         refs={"power_port": ("power_port", "power-ports", "power_port_template")},
         dev_rel="power_outlets"),
    Kind("front-ports", "front_port_templates", "FrontPortTemplate", "front port",
         {"type": _text("type", 64), "rear_port_position": _count("rear_port_position", 1)},
         refs={"rear_port": ("rear_port", "rear-ports", "rear_port_template")},
         dev_rel="front_ports"),
    Kind("module-bays", "module_bay_templates", "ModuleBayTemplate", "module bay",
         {"position": _text("position", 32)}, lists=("suggested_modules",),
         dev_rel="module_bays"),
    Kind("device-bays", "device_bay_templates", "DeviceBayTemplate", "device bay", {},
         dev_rel="device_bays"),
]

MODULE_KINDS = [
    Kind("power-ports", "power_port_templates", "ModulePowerPortTemplate", "power port",
         {"type": _text("type", 32), "maximum_draw": _draw("maximum_draw"),
          "allocated_draw": _draw("allocated_draw")}),
    Kind("interfaces", "interface_templates", "ModuleInterfaceTemplate", "interface",
         {"type": _text("type", 64), "enabled": _flag("enabled", True),
          "mgmt_only": _flag("mgmt_only", False), "poe_mode": _text("poe_mode", 8),
          "poe_type": _text("poe_type", 32)}),
]

#: How a field reads in a note.
FIELD_LABEL = {
    "type": "type", "enabled": "enabled", "mgmt_only": "mgmt only", "poe_mode": "PoE mode",
    "poe_type": "PoE type", "stack_port": "stack port", "maximum_draw": "max draw",
    "allocated_draw": "allocated draw", "positions": "positions", "is_splitter": "splitter",
    "feed_leg": "feed leg", "power_port": "power port", "rear_port": "rear port",
    "rear_port_position": "rear position", "position": "position",
    "description": "description", "suggested_modules": "modules",
}


def _want(kind: Kind, row: dict, name_of) -> dict:
    """A YAML row as the template values it asks for."""
    want = {attr: read(row) for attr, read in kind.fields.items()}
    for attr, (key, _k, _fk) in kind.refs.items():
        ref = str(row.get(key) or "").strip()
        want[attr] = name_of(ref, _k) if ref else ""
    if "suggested_modules" in kind.lists:
        from .devicetype_import import bay_modules

        want["suggested_modules"] = bay_modules(row)
    # Optional: compared only when the YAML gives it.
    if "description" in row:
        want["description"] = str(row.get("description") or "").strip()[:255]
    return want


def _current(t, kind: Kind, attr: str):
    if attr in kind.refs:
        fk = kind.refs[attr][2]
        other = getattr(t, fk)
        return other.name if other is not None else ""
    value = getattr(t, attr)
    if attr in kind.lists:
        return list(value or [])
    return value


def _show(v) -> str:
    if v is None or v == "":
        return "none"
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, list):
        return ", ".join(map(str, v)) or "none"
    return str(v)


# ── the report ──────────────────────────────────────────────────────────────

@dataclass
class Report:
    """What an update did, grouped for the import notes."""

    added: int = 0
    updated: int = 0
    removed: int = 0
    kept: int = 0
    _groups: dict = field(default_factory=dict)
    #: The templates removed, ``{kind key: {name: values}}`` (api.model_pack_bays).
    removed_rows: dict = field(default_factory=dict)
    #: The template fields changed, ``{kind key: {name: {attr: (old, new)}}}``
    #: (api.model_pack_components).
    changed_rows: dict = field(default_factory=dict)

    def add(self, op: str, noun: str, name: str, detail: str = ""):
        """``op``: added, updated, removed, or one of the ways a thing is
        kept (edit, kept, gone, extra, used, dropped)."""
        counter = op if op in ("added", "updated", "removed") else "kept"
        setattr(self, counter, getattr(self, counter) + 1)
        self._groups.setdefault((op, noun, detail), []).append(name)

    def counts(self) -> dict:
        return {"added": self.added, "updated": self.updated, "removed": self.removed,
                "kept": self.kept}

    def has(self, op: str) -> bool:
        return any(k[0] == op for k in self._groups)

    @property
    def changed(self) -> bool:
        return bool(self.added or self.updated or self.removed)

    def notes(self) -> list[str]:
        from .natural import natural_key

        out = []
        for (op, noun, detail), names in self._groups.items():
            n = len(names)
            plural = (noun[:-1] + "ies" if noun.endswith("y") and noun[-2:-1] not in "aeiou"
                      else noun + "s")
            nouns = noun if n == 1 else plural
            names = sorted(names, key=natural_key)
            listed = ", ".join(names[:NAME_LIST_CAP])
            if n > NAME_LIST_CAP:
                listed += f" … and {n - NAME_LIST_CAP} more"
            head = {
                "added": f"added {n} {nouns}",
                "updated": f"updated {n} {nouns}",
                "removed": f"removed {n} {nouns}",
                "edit": f"kept your edit on {n} {nouns}",
                "kept": f"kept {n} {nouns}",
                "gone": f"kept your removal of {n} {nouns}",
                "extra": f"kept {n} {nouns} not in the pack",
                "used": f"kept {n} {nouns} the pack dropped, still in use",
                "dropped": f"kept {n} {nouns} the pack dropped, changed here",
            "own": f"kept {n} {nouns} not from a pack",
            }[op]
            out.append(f"{head}{', ' + detail if detail else ''}: {listed}")
        return out


# ── templates ───────────────────────────────────────────────────────────────

def _models():
    from . import models

    return models


def _stacked(owner, module: bool) -> bool:
    return not module and owner.interface_templates.filter(name__contains="{position").exists()


def _marked_names(owner, module: bool) -> dict[str, set[str]]:
    """Names a hand-placed marker or faceplate slot points at, by device
    relation: removing their template would orphan them. Port markers the
    pack's renders placed are re-placed by the import, so they don't count."""
    if module:
        return {}
    from .model_studio import PACK
    from .models import marker_referenced_names

    made = owner.images_generated if isinstance(owner.images_generated, dict) else {}
    ports = {} if made.get("image_ports") == PACK else owner.image_ports
    return marker_referenced_names(owner, image_ports=ports or {})


def _in_use(owner, kind: Kind, t, module: bool, leaving: set, marked) -> bool:
    """Whether removing template ``t`` would break something left behind."""
    m = _models()
    if module:
        comp = m.Interface if kind.key == "interfaces" else m.PowerPort
        return comp.objects.filter(module_template=t).exists()
    if t.name in marked.get(kind.dev_rel, ()):
        return True
    if kind.key == "rear-ports":
        return t.front_port_templates.exclude(pk__in=leaving).exists()
    if kind.key == "power-ports":
        return t.outlet_templates.exclude(pk__in=leaving).exists()
    return False


def _merge_list(cur: list, snap, pack: list, overwrite: bool) -> list:
    """A bay's module list after the import: what the pack added since the
    snapshot joins, what it dropped leaves, what was added here stays."""
    if overwrite:
        return list(pack)
    snap = list(snap or [])
    low = {p.lower() for p in snap}
    pack_low = {p.lower() for p in pack}
    dropped = {p.lower() for p in snap if p.lower() not in pack_low}
    out = [p for p in cur if p.lower() not in dropped]
    have = {p.lower() for p in out}
    out += [p for p in pack if p.lower() not in low and p.lower() not in have]
    return out


def pack_names(state) -> dict[str, set[str]]:
    """Every template name a pack import recorded on the type, by kind: the
    names earlier imports kept in ``pack_names`` plus the last snapshot's."""
    out: dict[str, set[str]] = {}
    if not isinstance(state, dict):
        return out
    for src in (state.get("pack_names"), state.get("templates")):
        if not isinstance(src, dict):
            continue
        for key, names in src.items():
            if isinstance(names, (dict, list)):
                out.setdefault(key, set()).update(str(n) for n in names)
    return out


def sync_templates(owner, data: dict, state, *, module: bool, overwrite: bool,
                   report: Report, ever: dict[str, set[str]] | None = None
                   ) -> tuple[dict, list[str]]:
    """Bring ``owner``'s templates in line with the YAML ``data``. Returns
    the new snapshot ``{kind key: {name: values}}`` and notes for rows the
    YAML gets wrong. ``ever`` (:func:`pack_names`) is updated in place:
    the new snapshot's names join it, removed ones leave it. Front ports
    read both library forms (api.devicetype_import.with_port_mappings): the
    snapshot holds the rear port either way, so a pack moving to
    ``port-mappings`` changes nothing."""
    from .anchor_names import NameMatcher
    from .devicetype_import import no_mapping_note, positionize, with_port_mappings

    m = _models()
    kinds = MODULE_KINDS if module else DEVICE_KINDS
    fk_name = "module_type" if module else "device_type"
    stacked = _stacked(owner, module)
    prev = state if isinstance(state, dict) else None
    notes: list[str] = []
    if not module:
        data, notes = with_port_mappings(data)
    snapshot: dict = {}
    have_by_kind: dict[str, dict] = {}

    def have_of(key):
        if key not in have_by_kind:
            kind = next(k for k in kinds if k.key == key)
            qs = getattr(owner, kind.rel).all()
            fks = [fk for (_y, _k, fk) in kind.refs.values()]
            if fks:
                qs = qs.select_related(*fks)
            have_by_kind[key] = {t.name: t for t in qs}
        return have_by_kind[key]

    matchers: dict = {}
    tokens = set()
    if stacked:
        for n in have_of("interfaces"):
            tokens |= set(re.findall(r"\{position(?::\d+)?\}", n))

    def name_of(raw: str, key: str) -> str:
        """The Danbyte name of a YAML name: the type's template it stands
        for (as written, its ``{position}`` spelling, or its family spelled
        short or long - api.anchor_names), else the name as a new template
        takes it: an interface or power port ``{position}``-named like the
        type's interfaces (api.stack_members - bays keep the models' names)."""
        raw = raw[:64]
        have = have_of(key)
        if raw in have:
            return raw
        if key not in matchers:
            matchers[key] = NameMatcher(list(have))
        hit = matchers[key].resolve(raw)
        if hit is not None:
            return hit
        if not stacked or key not in ("interfaces", "power-ports"):
            return raw
        new = positionize(raw)[:64]
        # Only the token the type's own names use: a stack of Gi{position}/0/n
        # keeps its management port Gi0/0 as written.
        found = re.findall(r"\{position(?::\d+)?\}", new)
        return new if found and found[0] in tokens else raw

    ever = ever if ever is not None else {}
    removals: list[tuple[Kind, object, dict | None]] = []
    for kind in kinds:
        rows = data.get(kind.key)
        rows = [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []
        have = have_of(kind.key)
        prev_rows = None
        if prev is not None:
            pr = prev.get(kind.key)
            prev_rows = pr if isinstance(pr, dict) else {}
        wanted: dict[str, dict] = {}
        for r in rows:
            raw = str(r.get("name") or "").strip()
            if not raw:
                continue
            name = name_of(raw, kind.key)
            if name not in wanted:
                wanted[name] = _want(kind, r, name_of)
        model = getattr(m, kind.model)
        for name, want in wanted.items():
            snap = prev_rows.get(name) if prev_rows is not None else None
            snap = snap if isinstance(snap, dict) else None
            t = have.get(name)
            if t is None:
                if snap is not None and not overwrite:
                    report.add("gone", kind.noun, name)
                    snapshot.setdefault(kind.key, {})[name] = want
                    continue
                t = model(**{fk_name: owner, "name": name})
                ok = True
                for attr, v in want.items():
                    if attr in kind.refs:
                        ok = _set_ref(t, kind, attr, v, have_of) and ok
                    else:
                        setattr(t, attr, v)
                if not ok:
                    ref = next(iter(kind.refs))
                    notes.append(no_mapping_note(name, "skipped") if not want[ref] else
                                 f"{kind.noun} {name}: unknown {FIELD_LABEL[ref]}"
                                 f" {want[ref]!r} - skipped.")
                    continue
                t.save()
                have[name] = t
                matchers.pop(kind.key, None)
                report.add("added", kind.noun, name)
                snapshot.setdefault(kind.key, {})[name] = want
                continue
            changed: list[str] = []
            for attr, v in want.items():
                cur = _current(t, kind, attr)
                if attr in kind.lists:
                    new = _merge_list(cur, (snap or {}).get(attr), v, overwrite)
                    if new != cur:
                        plus = [p for p in new if p not in cur]
                        minus = [p for p in cur if p not in new]
                        setattr(t, attr, new)
                        changed.append(attr)
                        delta = " ".join([*(f"+{p}" for p in plus), *(f"−{p}" for p in minus)])
                        report.add("updated", kind.noun, name, f"modules {delta}")
                    continue
                if cur == v:
                    continue
                s = snap.get(attr, _MISSING) if snap is not None else _MISSING
                detail = f"{FIELD_LABEL.get(attr, attr)} {_show(cur)}"
                if overwrite or cur in (None, "") or (s is not _MISSING and cur == s):
                    if attr in kind.refs:
                        if not _set_ref(t, kind, attr, v, have_of):
                            notes.append(no_mapping_note(name, "kept as it is") if not v
                                         else f"{kind.noun} {name}: unknown "
                                         f"{FIELD_LABEL[attr]} {v!r} - kept.")
                            continue
                    else:
                        setattr(t, attr, v)
                    changed.append(kind.refs[attr][2] if attr in kind.refs else attr)
                    report.add("updated", kind.noun, name, f"{detail} → {_show(v)}")
                    report.changed_rows.setdefault(kind.key, {}).setdefault(
                        name, {})[attr] = (cur, v)
                else:
                    op = "edit" if s is not _MISSING else "kept"
                    report.add(op, kind.noun, name, f"{detail} (the pack has {_show(v)})")
            if changed:
                t.save(update_fields=[*changed, "updated_at"])
            snapshot.setdefault(kind.key, {})[name] = want
        for name, t in have.items():
            if name in wanted:
                continue
            snap = prev_rows.get(name) if prev_rows is not None else None
            snap = snap if isinstance(snap, dict) else None
            removals.append((kind, t, snap))

    # Dependents first (front ports and outlets before what they sit on).
    marked = _marked_names(owner, module)
    leaving: set = set()
    candidates = []
    for kind, t, snap in removals:
        known = {*kind.fields, *kind.refs, *kind.lists, "description"}
        untouched = snap is not None and all(
            _current(t, kind, a) == v for a, v in snap.items() if a in known)
        from_pack = snap is not None or t.name in ever.get(kind.key, ())
        if untouched or (overwrite and from_pack):
            candidates.append((kind, t))
            leaving.add(t.pk)
        elif snap is not None:
            report.add("dropped", kind.noun, t.name)
        elif overwrite:
            report.add("own", kind.noun, t.name)
        else:
            report.add("extra", kind.noun, t.name)
    # Dependents before what they sit on: a front port kept in use keeps its
    # rear port, and deleting a rear port never cascades an unchecked one.
    candidates.reverse()
    for kind, t in candidates:
        if _in_use(owner, kind, t, module, leaving, marked):
            leaving.discard(t.pk)
            report.add("used", kind.noun, t.name)
    for kind, t in candidates:
        if t.pk in leaving:
            report.removed_rows.setdefault(kind.key, {})[t.name] = {
                **{a: _current(t, kind, a) for a in kind.fields},
                "description": t.description or ""}
            t.delete()
            report.add("removed", kind.noun, t.name)
            ever.get(kind.key, set()).discard(t.name)
    for key, rows in snapshot.items():
        ever.setdefault(key, set()).update(rows)
    return snapshot, notes


def _set_ref(t, kind: Kind, attr: str, name: str, have_of) -> bool:
    """Point ``t``'s reference at the owner's template ``name``; False when
    there is none (a front port must have its rear port)."""
    _y, key, fk = kind.refs[attr]
    other = have_of(key).get(name) if name else None
    if other is None and fk == "rear_port_template":
        return False
    setattr(t, fk, other)
    return True


# ── devices built from the type ─────────────────────────────────────────────

def out_of_step(dt) -> tuple[int, int]:
    """``(devices of the type, devices whose components differ by name from
    what the templates make)`` - the check Sync devices runs, in a handful
    of queries for the whole fleet."""
    from .models import (
        _SYNC_KINDS,
        Device,
        diff_device_components,
        marker_referenced_names,
        render_component_name,
    )

    devices = list(Device.objects.filter(device_type=dt).values_list("id", "vc_position"))
    if not devices:
        return 0, 0
    ids = [d for d, _ in devices]
    markers = marker_referenced_names(dt)
    differs: set = set()
    for dev_rel, tmpl_rel, positional in _SYNC_KINDS:
        raw = set(getattr(dt, tmpl_rel).values_list("name", flat=True))
        raw |= markers.get(dev_rel, set())
        rel = getattr(Device, dev_rel).rel
        model, fk = rel.related_model, rel.field.name
        names: dict = {}
        qs = model.objects.filter(**{f"{fk}_id__in": ids})
        has_module = any(f.name == "module" for f in model._meta.fields)
        for dev_id, name, mod in qs.values_list(
                f"{fk}_id", "name", "module_id" if has_module else "id"):
            if has_module and mod is not None:
                continue
            names.setdefault(dev_id, set()).add(name)
        for dev_id, pos in devices:
            if dev_id in differs:
                continue
            expected = {render_component_name(n, pos) if positional else n for n in raw}
            if expected != names.get(dev_id, set()):
                differs.add(dev_id)
    # The quick pass can't see module ports from before modules owned them;
    # a modest number of candidates gets the exact check Sync devices runs.
    if len(differs) <= EXACT_CHECK_CAP:
        differs = {d.pk for d in Device.objects.filter(pk__in=differs).select_related(
            "device_type") if diff_device_components(d)}
    return len(devices), len(differs)


def devices_notes(owner, *, module: bool, report: Report) -> list[str]:
    """What the template changes mean for what was built from the type:
    devices out of step, modules missing added or removed templates (a
    changed field reaches them: api.model_pack_components)."""
    if not report.changed:
        return []
    if module:
        if not (report.added or report.removed):
            return []
        from .models import Module

        n = Module.objects.filter(module_type=owner, device__tenant_id=owner.tenant_id).count()
        if not n:
            return []
        return [f"modules: {n} installed keep the ports they were made with - added and "
                "removed templates don't reach them."]
    total, differ = out_of_step(owner)
    if not total or not differ:
        return []
    return [f"devices: {differ} of {total} out of step - Sync devices brings them in line."]


# ── meta ────────────────────────────────────────────────────────────────────

LIFECYCLE_DATES = ("release_date", "end_of_sale", "end_of_security_updates", "end_of_support")
#: Link kinds (meta.links[].kind) -> (document category, default title).
LINK_KINDS = {
    "datasheet": ("Datasheet", "Data sheet"),
    "install-guide": ("Install guide", "Installation guide"),
    "config-guide": ("Config guide", "Configuration guide"),
    "product-page": ("Product page", "Product page"),
    "eol-notice": ("EoL notice", "End-of-life notice"),
    "eol-listing": ("EoL listing", "End-of-life notices"),
    "support": ("Support", "Support"),
    "software": ("Software", "Software"),
    "white-paper": ("White paper", "White paper"),
    "other": ("Other", "Link"),
}
MAX_LINKS = 32
_DATE = re.compile(r"^(\d{4})-(\d{2})(?:-(\d{2}))?$")


def meta_block(data) -> dict | None:
    """The YAML's ``meta:`` as JSON (dates as text), or None."""
    meta = data.get("meta") if isinstance(data, dict) else None
    if not isinstance(meta, dict):
        return None

    def plain(v):
        if isinstance(v, (datetime.date, datetime.datetime)):
            return v.isoformat()[:10]
        if isinstance(v, dict):
            return {str(k): plain(x) for k, x in v.items()}
        if isinstance(v, list):
            return [plain(x) for x in v]
        if v is None or isinstance(v, (str, int, float, bool)):
            return v
        return str(v)

    return plain(meta)


def read_date(value, *, end: bool) -> datetime.date | None:
    """A lifecycle date: ``YYYY-MM-DD``, or ``YYYY-MM`` - read as the first
    of the month for a release date, the month's last day for an end date."""
    if isinstance(value, datetime.datetime):
        return value.date()
    if isinstance(value, datetime.date):
        return value
    m = _DATE.match(str(value or "").strip())
    if not m:
        return None
    y, mo = int(m.group(1)), int(m.group(2))
    if not (1 <= mo <= 12 and 1900 <= y <= 2200):
        return None
    if m.group(3):
        try:
            return datetime.date(y, mo, int(m.group(3)))
        except ValueError:
            return None
    return datetime.date(y, mo, calendar.monthrange(y, mo)[1] if end else 1)


def link_url(value, cap: int) -> str | None:
    """An http(s) link a pack may attach: a host name, not an address in a
    private range, no credentials, at most ``cap`` long. Never resolved here;
    the document link check fetches it through the outbound guards."""
    url = str(value or "").strip()
    if not url or len(url) > cap or any(c.isspace() for c in url):
        return None
    try:
        p = urlparse(url)
        host = p.hostname or ""
        p.port  # noqa: B018 - raises on a bad port
    except ValueError:
        return None
    if p.scheme not in ("http", "https") or not host or p.username or p.password:
        return None
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        return None
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return url if "." in host else None
    return url if ip.is_global else None


def _decide(cur, want, snap, overwrite: bool) -> str:
    """``set`` / ``same`` / ``edit`` / ``kept`` for a scalar field."""
    if cur == want:
        return "same"
    if overwrite or cur in (None, "") or (snap is not _MISSING and cur == snap):
        return "set"
    return "edit" if snap is not _MISSING else "kept"


def apply_lifecycle(dt, meta: dict, prev: dict, *, overwrite: bool, report: Report,
                    notes: list[str]) -> tuple[dict, list[str]]:
    """``meta.lifecycle`` onto a device type. Absent keys leave a field
    alone. Returns the new snapshot and the fields set."""
    life = meta.get("lifecycle")
    if not isinstance(life, dict):
        return {}, []
    out, changed = {}, []
    for f in (*LIFECYCLE_DATES, "lifecycle_url"):
        key = "source" if f == "lifecycle_url" else f
        if key not in life:
            continue
        if f == "lifecycle_url":
            want = link_url(life.get("source"), 200)
            if want is None:
                notes.append("meta.lifecycle.source: not a public http(s) URL of up to "
                             "200 characters - skipped.")
                continue
            cur = dt.lifecycle_url or ""
        else:
            d = read_date(life.get(key), end=f != "release_date")
            if d is None:
                notes.append(f"meta.lifecycle.{key}: {life.get(key)!r} is not YYYY-MM-DD "
                             "or YYYY-MM - skipped.")
                continue
            want = d.isoformat()
            cur = getattr(dt, f).isoformat() if getattr(dt, f) else None
        out[f] = want
        label = "lifecycle source" if f == "lifecycle_url" else f.replace("_", " ")
        how = _decide(cur, want, prev.get(f, _MISSING), overwrite)
        if how == "same":
            continue
        if how == "set":
            setattr(dt, f, want if f == "lifecycle_url" else datetime.date.fromisoformat(want))
            changed.append(f)
            report.add("updated", "lifecycle field", label, f"{_show(cur)} → {want}")
        else:
            report.add(how, "lifecycle field", label, f"{_show(cur)} (the pack has {want})")
    return out, changed


def apply_summary(obj, meta: dict, prev, report: Report) -> tuple[str | None, list[str]]:
    """``meta.summary`` as the description while that is empty (or still the
    summary an earlier import set). Returns what the snapshot records."""
    s = meta.get("summary")
    s = str(s).strip()[:1000] if isinstance(s, (str, int, float)) else ""
    if not s:
        return None, []
    cur = obj.description or ""
    if cur == s:
        return s, []
    if cur == "" or (prev is not None and cur == prev):
        obj.description = s
        report.add("updated", "field", "description", "from the summary")
        return s, ["description"]
    return None, []


def apply_comments(obj, data: dict, report: Report) -> tuple[list[dict], list[str]]:
    """The YAML's ``comments``: its Markdown links (api.description_links) as
    extra ``apply_links`` rows, and a description that still holds those
    comments word for word (what the device library import stored) turned
    into their plain text. Returns the rows and the fields set."""
    from .description_links import link_rows, split

    raw = data.get("comments")
    raw = str(raw).strip() if isinstance(raw, (str, int, float)) else ""
    plain, links = split(raw)
    if not links:
        return [], []
    if (obj.description or "") == raw and plain != raw:
        obj.description = plain
        report.add("updated", "field", "description", "links moved to documents")
        return link_rows(links), ["description"]
    return link_rows(links), []


def _category(tenant, kind: str, made: list[str]):
    from .models import DocumentCategory

    name = LINK_KINDS.get(kind, LINK_KINDS["other"])[0]
    cat = DocumentCategory.objects.filter(tenant=tenant, name__iexact=name).first()
    if cat is None:
        cat = DocumentCategory.objects.create(tenant=tenant, name=name, slug=slugify(name))
        made.append(name)
    return cat


def apply_links(dt, meta: dict, prev: dict, *, overwrite: bool, report: Report,
                notes: list[str], extra: list[dict] | None = None) -> dict:
    """``meta.links`` as link Documents on a device or module type, one per URL.
    ``extra`` rows (the links of the YAML's ``comments``, api.description_links)
    follow them, a URL ``meta.links`` has taking precedence.
    Returns the new snapshot ``{url: {id, name, category}}``. A document a
    user added (the same URL) or edited is never touched."""
    from audit.api import _object_site_id

    from .models import Document

    raw = meta.get("links")
    if raw is None and not prev and not extra:
        return {}
    rows = [r for r in raw if isinstance(r, dict)] if isinstance(raw, list) else []
    if raw is not None and not isinstance(raw, list):
        notes.append("meta.links: not a list - ignored.")
    rows += extra or []
    label = dt._meta.label_lower
    docs = {d.pk: d for d in Document.objects.filter(
        tenant_id=dt.tenant_id, object_type=label, object_id=dt.pk)}
    by_url = {}
    for d in docs.values():
        by_url.setdefault(d.url, d)
    site_id = None
    made_cats: list[str] = []
    out: dict = {}

    def ours(d, snap) -> bool:
        return (d is not None and not d.file and d.name == snap.get("name")
                and str(d.category_id or "") == str(snap.get("category") or "")
                and not d.description)

    for r in rows[:MAX_LINKS]:
        url = link_url(r.get("url"), 2048)
        if url is None:
            notes.append(f"meta.links: {str(r.get('url'))[:80]!r} is not a public http(s) "
                         "URL - skipped.")
            continue
        if url in out:
            continue
        kind = str(r.get("kind") or "other").strip()
        if kind not in LINK_KINDS:
            kind = "other"
        title = str(r.get("title") or "").strip()[:255] or LINK_KINDS[kind][1]
        snap = prev.get(url) if isinstance(prev.get(url), dict) else None
        d = docs.get(_uuid(snap.get("id"))) if snap else None
        if snap is not None and d is None and not overwrite:
            report.add("gone", "document", title)
            out[url] = snap
            continue
        if d is None:
            if url in by_url:
                # Attached here already: the user's, left alone.
                continue
            if site_id is None:
                site_id = _object_site_id(label, str(dt.pk))
            cat = _category(dt.tenant, kind, made_cats)
            d = Document(tenant_id=dt.tenant_id, object_type=label, object_id=dt.pk,
                         object_site_id=site_id, name=title, url=url, category=cat)
            d.save()
            report.add("added", "document", title)
        elif ours(d, snap):
            cat = _category(dt.tenant, kind, made_cats)
            if d.name != title or d.category_id != cat.pk:
                d.name, d.category = title, cat
                d.save(update_fields=["name", "category", "updated_at"])
                report.add("updated", "document", title)
        else:
            report.add("edit", "document", d.name)
            out[url] = snap
            continue
        out[url] = {"id": str(d.pk), "name": d.name,
                    "category": str(d.category_id) if d.category_id else None}
    for url, snap in prev.items():
        if url in out or not isinstance(snap, dict):
            continue
        d = docs.get(_uuid(snap.get("id")))
        if d is None:
            continue
        if ours(d, snap):
            d.delete()
            report.add("removed", "document", d.name)
        else:
            report.add("dropped", "document", d.name)
    if made_cats:
        notes.append(f"document categories: created {', '.join(made_cats)}.")
    return out


def _uuid(v):
    import uuid

    try:
        return uuid.UUID(str(v))
    except (TypeError, ValueError):
        return None


# ── one type ────────────────────────────────────────────────────────────────

@dataclass
class UpdateResult:
    notes: list[str]
    changes: dict


def update_type(obj, data: dict, *, kind: str, pack: dict, overwrite: bool = False
                ) -> UpdateResult:
    """Bring a matched (or just created) device or module type in line with
    its pack YAML and record the snapshot (see the module docstring)."""
    module = kind == "module-type"
    state = obj.pack_state if isinstance(obj.pack_state, dict) else None
    report = Report()
    notes: list[str] = []
    if not module:
        # A stack member type takes the stack-member token first, so the
        # YAML's member-1 names match it (api.stack_members).
        from .stack_members import bring_in_line

        notes += bring_in_line(obj, data, state)
    ever = pack_names(state)
    templates, bad = sync_templates(obj, data, (state or {}).get("templates") if state
                                    else None, module=module, overwrite=overwrite,
                                    report=report, ever=ever)
    notes += bad
    if not module and report.removed_rows:
        # A port that became a module bay: its devices follow it.
        from .model_pack_bays import convert

        notes += convert(obj, report.removed_rows, pack=pack)
    # A changed template field reaches what the template made, unless edited.
    from .model_pack_components import carry

    built = carry(obj, report.changed_rows, module=module)
    built += devices_notes(obj, module=module, report=report)
    meta = meta_block(data) or {}
    record = {"pack": pack, "templates": templates}
    names = {k: sorted(v) for k, v in ever.items() if v}
    if names:
        record["pack_names"] = names
    if meta:
        record["meta"] = meta
    prev = state or {}
    # The comments first: a description they leave empty takes the summary.
    comment_links, changed = apply_comments(obj, data, report)
    summary, fields = apply_summary(obj, meta, prev.get("description"), report)
    changed += fields
    if summary is not None:
        record["description"] = summary
    if module:
        if meta.get("lifecycle"):
            notes.append("meta.lifecycle: module types have no lifecycle fields - kept "
                         "with the import record.")
    else:
        prev_life = prev.get("lifecycle") if isinstance(prev.get("lifecycle"), dict) else {}
        life, fields = apply_lifecycle(obj, meta, prev_life, overwrite=overwrite,
                                       report=report, notes=notes)
        changed += fields
        if life:
            record["lifecycle"] = life
    # Device and module types alike. A module type imported before it took
    # documents has its links only in ``meta``: no ``links`` record, so they
    # are created now.
    prev_links = prev.get("links") if isinstance(prev.get("links"), dict) else {}
    links = apply_links(obj, meta, prev_links, overwrite=overwrite, report=report,
                        notes=notes, extra=comment_links)
    if links:
        record["links"] = links
    obj.pack_state = record
    obj.save(update_fields=[*changed, "pack_state", "updated_at"])
    out = report.notes() + notes + built
    if state is None and report.kept and not overwrite:
        out.append("no earlier pack record: differences kept - Update from pack "
                   "(--overwrite) applies them.")
    if state is None and overwrite and report.has("own"):
        out.append("no earlier pack record: nothing removed - templates not from a "
                   "pack stay.")
    return UpdateResult(out, report.counts())


def update_rack_type(rt, data: dict, *, pack: dict) -> list[str]:
    """A rack type's ``meta``: the summary as an empty description, the
    block kept in its snapshot."""
    meta = meta_block(data) or {}
    prev = rt.pack_state if isinstance(rt.pack_state, dict) else {}
    report = Report()
    summary, fields = apply_summary(rt, meta, prev.get("description"), report)
    record = {"pack": pack}
    if meta:
        record["meta"] = meta
    if summary is not None:
        record["description"] = summary
    rt.pack_state = record
    rt.save(update_fields=[*fields, "pack_state", "updated_at"])
    notes = report.notes()
    for key, what in (("lifecycle", "lifecycle fields"), ("links", "documents")):
        if meta.get(key):
            notes.append(f"meta.{key}: rack types have no {what} - kept with the "
                         "import record.")
    return notes


def keep_meta(obj, data, noun: str) -> list[str]:
    """Accessory types and rack kits have no description, lifecycle or
    documents: their ``meta`` block is kept in ``pack_import``."""
    meta = meta_block(data)
    if not meta:
        return []
    obj.pack_import = {**(obj.pack_import or {}), "meta": meta}
    return [f"meta.{key}: {noun} have no {what} - kept with the import record."
            for key, what in (("lifecycle", "lifecycle fields"), ("links", "documents"))
            if meta.get(key)]
