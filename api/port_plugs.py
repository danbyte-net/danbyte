"""Plugs in cabled ports on 3D models (docs/dcim/model-packs.md → Accessory
types, the export spec §13).

A model pack may carry **accessory types**: small generic parts - an RJ45
plug, an SFP with its LC connector, a DAC head, an IEC cord plug - one
``accessory-types/<Vendor>/<NAME>.yaml`` and one ``.glb`` each::

    name: RJ45-PLUG
    kind: plug                 # plug | transceiver | cord
    connector: rj45
    fits: [1000base-t, 2.5gbase-t, rj-45]
    model3d:
      file: models/Generic/RJ45-PLUG.glb

``apply_accessory`` imports one into the tenant's ``AccessoryType`` rows
(matched by vendor and name; api.model_pack.import_pack calls it).

``plugs`` answers, for many devices at once and for one reader, which part
sits in each of their drawn models' ports: the ``port:`` anchors of the
chassis and of each installed module (api.model_anchors), resolved to the
device's interface, console port, power port… (api.anchor_names), the ones
in use - a cable ends on it, an interface or patch port is marked
connected, or an interface holds a transceiver record (an inventory item of
kind transceiver, ``InventoryItem.interface``) - among those the reader may
view. Each plug carries its cable's colour when the reader may view the
cable.

Each port in use draws up to two parts, stacked (export spec §13 v1.9,
``stack``): a **transceiver** in the cage, and the **cord** plugged into
it - seated at the transceiver's ``port:<connector>`` empty, or at the
port's own anchor where there is no transceiver (an RJ45 jack, an LC panel
port, a power inlet). The transceiver comes, in this order, from

1. its transceiver record's ``accessory_type``, set by hand;
2. the accessory type whose ``parts`` lists the record's part ID
   (case-insensitive, a trailing ``=`` ignored, ``part_key``);
3. for a cabled cage without either, the generic transceiver that fits it
   (``SFP-GENERIC``: no ``parts``) of the cable's medium - an SFP-T for a
   twisted-pair cable.

The cord is the one whose ``connector`` is the record's, else the
transceiver's, else the cable's medium's. A one-piece part (a DAC or AOC,
``kind: cord``) takes the port alone, only while cabled. A port with no
transceiver takes the part whose ``fits`` names its type (``choose``):
among several, the cable's medium decides, and a known medium no fitting
part has shows nothing rather than a wrong part.

A recorded transceiver shows without a cable (no cord then). The record's
facts (part ID, serial) ride along only when the reader may view inventory
items; a record they may not view counts for nothing. A cord carries its
``cable`` block - how the viewer draws the run from its ``cable`` empty.

Query cost: nothing when no device's model names a port; otherwise one
query for the tenant's accessory types and, when there are any, one
(UNION ALL over the port kinds in play, the records as subqueries) for the
ports in use.
"""
from __future__ import annotations

import posixpath
import re

from django.core.exceptions import ValidationError

#: Where a pack keeps its accessory YAML.
ACCESSORY_DIR = "accessory-types/"
KINDS = ("plug", "transceiver", "cord")
#: The export spec's budgets for one accessory (§13): a transceiver, and a
#: cord or plug.
TRANSCEIVER_TRIANGLES = 1_500
ACCESSORY_TRIANGLES = 2_000
#: A cord's run (``cable:``, §13 v1.9).
CABLE_PROFILES = ("zipcord", "round")
#: The largest jacket, pitch and bend a ``cable:`` block may give (mm).
CABLE_MM_MAX = {"jacket_mm": 50.0, "pitch_mm": 100.0, "min_bend_mm": 2_000.0}


def triangle_budget(kind: str) -> int:
    """The triangle budget for an accessory of ``kind``."""
    return TRANSCEIVER_TRIANGLES if kind == "transceiver" else ACCESSORY_TRIANGLES
NAME_MAX = 100
MAX_FITS = 64
MAX_PARTS = 64
PART_MAX = 128

#: Port kinds (api.anchor_names) → (model, rbac slug, CableTermination field,
#: whether it has ``mark_connected``).
PORT_KINDS: dict[str, tuple[str, str, str, bool]] = {
    "interface": ("Interface", "interface", "interface", True),
    "console-port": ("ConsolePort", "consoleport", "console_port", False),
    "console-server-port": ("ConsoleServerPort", "consoleserverport",
                            "console_server_port", False),
    "power-port": ("PowerPort", "powerport", "power_port", False),
    "power-outlet": ("PowerOutlet", "poweroutlet", "power_outlet", False),
    "aux-port": ("AuxPort", "auxport", "aux_port", False),
    "front-port": ("FrontPort", "frontport", "front_port", True),
    "rear-port": ("RearPort", "rearport", "rear_port", True),
}

_SLUG = re.compile(r"^[a-z0-9][a-z0-9._+-]*$")
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


# ── media ───────────────────────────────────────────────────────────────────

_FIBRE_CONNECTOR = re.compile(r"^(lc|sc|st|fc|mpo|mtp|mtrj|e2000)")
_COPPER_CONNECTOR = ("rj45", "rj-45", "8p8c", "gg45", "tera")


def connector_medium(connector: str) -> str:
    """``fibre``, ``dac``, ``copper`` or ``""`` for an accessory's
    ``connector``."""
    c = (connector or "").strip().lower()
    if not c:
        return ""
    if c.startswith(("dac", "twinax")):
        return "dac"
    if _FIBRE_CONNECTOR.match(c) or c.startswith("aoc"):
        return "fibre"
    if c.startswith(_COPPER_CONNECTOR):
        return "copper"
    return ""


def cable_medium(cable_type: str) -> str:
    """The same medium for a cable's ``type`` (``""`` unknown)."""
    t = (cable_type or "").strip().lower()
    if t.startswith("dac-"):
        return "dac"
    if t.startswith(("mmf", "smf", "aoc")):
        return "fibre"
    if t.startswith(("cat", "mrj21")):
        return "copper"
    return ""


#: A cage with no cable medium known takes the commonest part first.
_DEFAULT_ORDER = {"fibre": 0, "dac": 1, "copper": 2, "": 3}


def choose(accessories, port_type: str, cable_type: str = ""):
    """The accessory type for a port of ``port_type`` cabled with a cable of
    ``cable_type`` ("" unknown), or None. ``accessories`` are AccessoryType
    rows (or anything with ``name``, ``vendor``, ``connector``, ``fits``)."""
    t = (port_type or "").strip().lower()
    if not t:
        return None
    fit = [a for a in accessories if t in (a.fits or [])]
    if not fit:
        return None
    medium = cable_medium(cable_type)
    if medium:
        same = [a for a in fit if connector_medium(a.connector) == medium]
        fit = same or [a for a in fit if connector_medium(a.connector) == ""]
        if not fit:
            return None
    return min(fit, key=lambda a: (_DEFAULT_ORDER.get(connector_medium(a.connector), 3),
                                   a.vendor.lower(), a.name.lower()))


# ── pack import ─────────────────────────────────────────────────────────────

def vendor_of(path: str) -> str:
    """``accessory-types/<Vendor>/<NAME>.yaml`` → ``<Vendor>`` ("" when the
    file sits straight in ``accessory-types/``)."""
    parts = path.split("/")
    return parts[1] if len(parts) == 3 else ""


def read_accessory(path: str, data) -> tuple[dict | None, list[str]]:
    """The fields of an accessory YAML doc - ``{vendor, name, kind,
    connector, fits, file}`` - or None and why not. Unknown ``fits``
    slugs are kept (a pack may name types this release doesn't list)."""
    from .model_pack import _clean_path

    if not isinstance(data, dict):
        return None, ["Not a mapping."]
    name = str(data.get("name") or "").strip()
    if not name:
        stem = posixpath.splitext(posixpath.basename(path))[0]
        return None, [f"Needs a name (the file says {stem})."]
    if len(name) > NAME_MAX:
        return None, [f"The name is longer than {NAME_MAX} characters."]
    kind = str(data.get("kind") or "").strip().lower()
    if kind not in KINDS:
        return None, [f"kind: {data.get('kind')!r} is not one of {', '.join(KINDS)}."]
    raw = data.get("fits")
    if not isinstance(raw, list) or not raw:
        return None, ["fits: list the port types it plugs into."]
    notes: list[str] = []
    fits: list[str] = []
    for x in raw[:MAX_FITS]:
        s = str(x).strip().lower()
        if not _SLUG.match(s):
            notes.append(f"fits: {x!r} is not a type slug - ignored.")
        elif s not in fits:
            fits.append(s)
    if not fits:
        return None, ["fits: no usable type slug.", *notes]
    block = data.get("model3d")
    rel = _clean_path(block.get("file")) if isinstance(block, dict) else None
    if rel is None:
        return None, ["model3d.file: missing or leaves the pack."]
    connector = str(data.get("connector") or "").strip().lower()[:32]
    parts, standard, wavelength = _read_part_facts(data, notes)
    cable = read_cable(data.get("cable"), notes)
    if cable is not None and kind == "transceiver":
        notes.append("cable: a transceiver has no cable of its own; its cord does - ignored.")
        cable = None
    return {"vendor": vendor_of(path)[:100], "name": name, "kind": kind,
            "connector": connector, "fits": fits, "parts": parts,
            "standard": standard, "wavelength_nm": wavelength, "cable": cable,
            "file": rel}, notes


def _mm(block: dict, key: str, notes: list[str]) -> float | None:
    v = block.get(key)
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not (
            0 < v <= CABLE_MM_MAX[key]):
        notes.append(f"cable.{key}: {v!r} is not a size in mm up to "
                     f"{CABLE_MM_MAX[key]:g} - ignored.")
        return None
    return round(float(v), 3)


def read_cable(raw, notes: list[str]) -> dict | None:
    """A cord's ``cable:`` block - ``{profile, jacket_mm, pitch_mm,
    min_bend_mm}`` - or None when there is none or it can't be used (noted).
    ``pitch_mm`` belongs to a zip cord only; a zip cord without one, or with
    one narrower than its jacket, takes the jacket as its pitch."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        notes.append("cable: not a mapping - ignored.")
        return None
    profile = str(raw.get("profile") or "").strip().lower()
    if profile not in CABLE_PROFILES:
        notes.append(f"cable.profile: {raw.get('profile')!r} is not one of "
                     f"{', '.join(CABLE_PROFILES)} - the block is ignored.")
        return None
    jacket = _mm(raw, "jacket_mm", notes)
    if jacket is None:
        notes.append("cable.jacket_mm: needed - the block is ignored.")
        return None
    pitch = _mm(raw, "pitch_mm", notes)
    if profile == "round":
        if pitch is not None:
            notes.append("cable.pitch_mm: a round cable has no pitch - ignored.")
        pitch = None
    elif pitch is None or pitch < jacket:
        if pitch is not None:
            notes.append(f"cable.pitch_mm: {pitch:g} is narrower than the jacket; "
                         f"{jacket:g} is used.")
        pitch = jacket
    known = {"profile", "jacket_mm", "pitch_mm", "min_bend_mm"}
    for k in sorted(set(map(str, raw)) - known):
        notes.append(f"cable.{k}: not a key Danbyte reads - ignored.")
    return {"profile": profile, "jacket_mm": jacket, "pitch_mm": pitch,
            "min_bend_mm": _mm(raw, "min_bend_mm", notes)}


def _read_part_facts(data: dict, notes: list[str]):
    """A real transceiver's ``parts``, ``standard`` and ``wavelength_nm``
    (all optional; a bad value is noted and left out)."""
    parts: list[str] = []
    raw = data.get("parts")
    if raw is not None and not isinstance(raw, list):
        notes.append("parts: not a list - ignored.")
        raw = []
    seen: set[str] = set()
    for x in (raw or [])[:MAX_PARTS]:
        s = str(x).strip() if isinstance(x, (str, int)) else ""
        if not s or len(s) > PART_MAX:
            notes.append(f"parts: {x!r} is not a part number - ignored.")
            continue
        if part_key(s) not in seen:
            seen.add(part_key(s))
            parts.append(s)
    standard = data.get("standard")
    standard = str(standard).strip()[:64] if isinstance(standard, (str, int)) else ""
    wavelength = data.get("wavelength_nm")
    if wavelength is not None:
        if isinstance(wavelength, bool) or not isinstance(wavelength, int) or not (
                0 < wavelength <= 100_000):
            notes.append(f"wavelength_nm: {wavelength!r} is not a wavelength in nm - ignored.")
            wavelength = None
    return parts, standard, wavelength


def part_key(part_id: str) -> str:
    """A part number as matched: case-insensitive, a trailing ``=`` (the
    spare-part suffix) ignored."""
    return (part_id or "").strip().rstrip("=").strip().upper()


_CABLE_EMPTY = re.compile(r"^cable(\.\d+)?$")


def node_names(doc: dict) -> set[str]:
    """The names of the nodes the default scene draws."""
    from .model_anchors import _world

    nodes = doc.get("nodes") if isinstance(doc.get("nodes"), list) else []
    return {str(nodes[i].get("name") or "") for i in _world(doc)
            if isinstance(nodes[i], dict)}


def empty_warnings(doc: dict, fields: dict) -> list[str]:
    """What a part's model lacks for stacking (§13 v1.9): a transceiver
    with a connector needs a ``port:<connector>`` empty for its cord, a
    cord with a ``cable:`` block a ``cable`` empty to start the run."""
    names = node_names(doc)
    out = []
    conn = fields.get("connector") or ""
    if fields["kind"] == "transceiver" and conn and connector_medium(conn) != "dac":
        ports = sorted(n for n in names if n.startswith("port:"))
        if not ports:
            out.append(f"no port:{conn} empty; a cord in it is seated at the cage instead.")
        elif f"port:{conn}" not in names and len(ports) > 1:
            out.append(f"no port:{conn} empty, and {len(ports)} port: empties to choose from.")
    if fields["kind"] != "transceiver" and fields.get("cable") and not any(
            _CABLE_EMPTY.match(n) for n in names):
        out.append("no cable empty; the run starts at the port instead.")
    return out


def apply_accessory(tenant, path: str, data, files, *, dry_run: bool = False,
                    pack_name: str = "", pack_version: str = ""):
    """Import one accessory YAML: ``(action, name, id, notes)``, action
    ``created`` / ``matched`` / ``error``. The model is checked like any
    pack model (api.model_3d.validate_glb); with ``dry_run`` nothing is
    stored."""
    from . import model_3d
    from .model_pack_check import triangles
    from .models import AccessoryType

    fields, notes = read_accessory(path, data)
    if fields is None:
        return "error", "", "", notes
    name = fields["name"]
    try:
        glb = files.read(fields["file"], model_3d.max_bytes())
    except ValidationError as exc:
        return "error", name, "", [*notes, f"model3d.file: {' '.join(exc.messages)}"]
    if glb is None:
        return "error", name, "", [*notes, f"model3d.file: {fields['file']} is not in the pack."]
    try:
        doc = model_3d.validate_glb(glb)
    except ValidationError as exc:
        return "error", name, "", [*notes, f"model3d.file: {' '.join(exc.messages)}"]
    tri = triangles(doc)
    notes.append(f"model: {tri} triangles.")
    budget = triangle_budget(fields["kind"])
    if tri > budget:
        notes.append(f"model: over the {budget:,}-triangle budget for a {fields['kind']}; "
                     "imported, but many in a room cost frames.")
    notes.extend(f"model: {w}" for w in empty_warnings(doc, fields))
    obj = AccessoryType.objects.filter(tenant=tenant, vendor=fields["vendor"],
                                       name=name).first()
    action = "matched" if obj is not None else "created"
    if obj is None:
        obj = AccessoryType(tenant=tenant, vendor=fields["vendor"], name=name)
    obj.kind, obj.connector, obj.fits = fields["kind"], fields["connector"], fields["fits"]
    obj.parts, obj.standard = fields["parts"], fields["standard"]
    obj.wavelength_nm = fields["wavelength_nm"]
    obj.cable = fields["cable"]
    obj.pack_import = {"pack": {"name": pack_name, "version": pack_version}}
    notes.append(f"{fields['kind']}, fits {', '.join(fields['fits'])}.")
    if fields["parts"]:
        notes.append(f"parts: {', '.join(fields['parts'])}.")
    if fields["cable"]:
        c = fields["cable"]
        notes.append(f"cable: {c['profile']}, jacket {c['jacket_mm']:g} mm"
                     + (f", pitch {c['pitch_mm']:g} mm" if c["pitch_mm"] else "")
                     + (f", bend {c['min_bend_mm']:g} mm" if c["min_bend_mm"] else "") + ".")
    if dry_run:
        return action, name, "", notes
    model_3d.store(obj, glb)
    return action, name, str(obj.pk), notes


# ── which part sits where ───────────────────────────────────────────────────

def port_names(anchors) -> list[str]:
    """The ``ports`` names of a stored anchors doc (the ``port:`` empties)."""
    ports = (anchors or {}).get("ports")
    return [str(k) for k in ports] if isinstance(ports, dict) else []


def has_ports(device, owner) -> bool:
    """Whether ``device``'s drawn model (or an installed part's, once
    loaded) names a port."""
    if owner is not None and port_names(owner.model_anchors):
        return True
    return any(port_names(r["type"].model_anchors)
               for r in getattr(device, "_installed_parts", ())
               if r.get("type") is not None and r.get("module") is not None)


def _wanted(device, owner) -> list[tuple[str | None, str, str, str]]:
    """``[(bay or None, port name as drawn, kind, component name)]``."""
    from .anchor_names import chassis_port, module_port
    from .models import render_module_name

    out = []
    if owner is not None:
        for name in port_names(owner.model_anchors):
            kind, comp = chassis_port(device, name)
            out.append((None, name, kind, comp))
    for row in getattr(device, "_installed_parts", ()):
        mt = row.get("type")
        if mt is None or row.get("module") is None:
            continue
        for raw in port_names(mt.model_anchors):
            kind, comp = module_port(device, mt, raw, row["position"])
            out.append((row["name"], render_module_name(raw, row["position"]), kind, comp))
    return out


def accessories_of(tenant) -> list:
    """The tenant's accessory types with a model."""
    from .models import AccessoryType

    return list(AccessoryType.objects.filter(tenant=tenant)
                .exclude(model_3d="").exclude(model_3d__isnull=True)
                .only("id", "vendor", "name", "kind", "connector", "fits", "parts",
                      "cable", "model_3d"))


def in_use(wanted: dict, user, tenant) -> dict:
    """``{(device id, kind, component name): (type, cable type, colour,
    cabled, record)}`` for the ports of ``wanted`` (``{device id: _wanted
    rows}``) the reader may view that are in use: a cable ends on it, it is
    marked connected (``cabled`` either way), or - an interface - it holds a
    transceiver record the reader may view. ``record`` is ``(accessory type
    id, part ID, serial)`` or None. The cable's type and colour only when
    the reader may view the cable. One query (UNION ALL over the kinds)."""
    from django.apps import apps
    from django.db.models import (
        BooleanField,
        CharField,
        Exists,
        ExpressionWrapper,
        OuterRef,
        Q,
        Subquery,
        Value,
    )
    from django.db.models.functions import Cast

    from auth_api import rbac

    from .models import Cable, CableTermination, InventoryItem

    kinds: dict[str, set] = {}
    for dev_id, rows in wanted.items():
        for _bay, _drawn, kind, _comp in rows:
            if kind in PORT_KINDS:
                kinds.setdefault(kind, set()).add(dev_id)
    if not kinds:
        return {}
    superuser = getattr(user, "is_superuser", False)
    cables = Cable.objects.filter(tenant=tenant)
    if not superuser:
        cables = rbac.restrict_queryset(cables, user, tenant, "cable", "view")
    # Transceiver records count only for a reader who may view them.
    items = None
    if "interface" in kinds and (
            superuser or rbac.has_action(user, tenant, "inventoryitem", "view")):
        items = InventoryItem.objects.filter(device__tenant=tenant, kind="transceiver")
        if not superuser:
            items = rbac.restrict_queryset(items, user, tenant, "inventoryitem", "view")
    text = CharField()
    parts = []
    for kind, dev_ids in sorted(kinds.items()):
        model_name, slug, fk, marks = PORT_KINDS[kind]
        model = apps.get_model("api", model_name)
        qs = model.objects.filter(device__tenant=tenant, device_id__in=list(dev_ids))
        if not superuser:
            qs = rbac.restrict_queryset(qs, user, tenant, slug, "view")
        terms = CableTermination.objects.filter(**{fk: OuterRef("pk")})
        cabled = Q(Exists(terms))
        if marks:
            cabled |= Q(mark_connected=True)
        used = cabled
        rec = {"_xid": Value(None, output_field=text), "_xacc": Value(None, output_field=text),
               "_xpart": Value(None, output_field=text),
               "_xserial": Value(None, output_field=text),
               "_xconn": Value(None, output_field=text)}
        if kind == "interface" and items is not None:
            mine = items.filter(interface=OuterRef("pk")).order_by()
            used = used | Q(Exists(mine))
            rec = {
                "_xid": Cast(Subquery(mine.values("pk")[:1]), output_field=text),
                "_xacc": Cast(Subquery(mine.values("accessory_type_id")[:1]), output_field=text),
                "_xpart": Subquery(mine.values("part_id")[:1], output_field=text),
                "_xserial": Subquery(mine.values("serial_number")[:1], output_field=text),
                "_xconn": Subquery(mine.values("connector")[:1], output_field=text),
            }
        seen = terms.filter(cable__in=cables).order_by("cable_id")
        parts.append(
            qs.filter(used).order_by()
            .annotate(_kind=Value(kind, output_field=text),
                      _ctype=Subquery(seen.values("cable__type")[:1], output_field=text),
                      _color=Subquery(seen.values("cable__color")[:1], output_field=text),
                      _cabled=ExpressionWrapper(cabled, output_field=BooleanField()),
                      **rec)
            .values_list("device_id", "_kind", "name", "type", "_ctype", "_color",
                         "_cabled", "_xid", "_xacc", "_xpart", "_xserial", "_xconn"))
    rows = parts[0].union(*parts[1:], all=True) if len(parts) > 1 else parts[0]
    return {(str(d), k, n): (t or "", ct or "", col or "", bool(cab),
                             (acc or "", part or "", serial or "", conn or "") if xid else None)
            for d, k, n, t, ct, col, cab, xid, acc, part, serial, conn in rows}


def accessory_url(acc, device, shared: bool) -> str:
    """A part's model URL: the tenant-wide one for a reader who may view
    module types (one download for a whole room), else through the device."""
    from .model_3d import version_of

    v = version_of(acc.model_3d)
    if shared:
        return f"/api/accessory-types/{acc.pk}/model/?v={v}"
    return f"/api/devices/{device.pk}/accessory-model/{acc.pk}/?v={v}"


def may_view_types(user, tenant) -> bool:
    from auth_api import rbac

    return rbac.has_action(user, tenant, "moduletype", "view")


def cord_for(accessories, connector: str):
    """The cord or plug whose ``connector`` is ``connector`` (``lc`` →
    ``LC-DUPLEX``; ``mpo-12`` takes an ``mpo`` cord), never a transceiver,
    or None."""
    c = (connector or "").strip().lower()
    if not c:
        return None
    from .dcim_choices import PLUGGABLE_INTERFACE_TYPES

    # A part that fits a cage is a module or a one-piece head, never a cord.
    cages = PLUGGABLE_INTERFACE_TYPES - {"other"}
    cords = [a for a in accessories if a.kind != "transceiver" and a.connector
             and not any(f in cages for f in (a.fits or []))]
    exact = [a for a in cords if a.connector == c]
    near = exact or [a for a in cords
                     if a.connector.startswith(c) or c.startswith(a.connector)]
    return min(near, key=_by_name) if near else None


def _by_name(a):
    return (a.vendor.lower(), a.name.lower())


#: The connector a cable's medium ends in when nothing else says.
_MEDIUM_CONNECTOR = {"fibre": "lc", "copper": "rj45"}


def generic_transceiver(accessories, port_type: str, medium: str = ""):
    """The fallback transceiver for a cage of ``port_type`` with nothing
    recorded in it (``SFP-GENERIC``): a transceiver that fits, of the
    cable's ``medium`` when it is known (an optical one first when not),
    a generic one (no ``parts``) before a real optic. None when none fits."""
    fit = [a for a in accessories
           if a.kind == "transceiver" and port_type in (a.fits or [])]
    if medium:
        fit = [a for a in fit if connector_medium(a.connector) == medium]
    if not fit:
        return None
    return min(fit, key=lambda a: (bool(a.parts),
                                   _DEFAULT_ORDER.get(connector_medium(a.connector), 3),
                                   *_by_name(a)))


def one_piece(accessories, port_type: str, cable_type: str = ""):
    """A part that takes a port alone - a plug, a cord, a DAC head - by the
    port's type and the cable's (``choose`` without the transceivers)."""
    return choose([a for a in accessories if a.kind != "transceiver"],
                  port_type, cable_type)


def is_cage(kind: str, port_type: str) -> bool:
    """Whether a port is a transceiver cage (SFP, QSFP…)."""
    from .dcim_choices import PLUGGABLE_INTERFACE_TYPES

    return kind == "interface" and port_type in PLUGGABLE_INTERFACE_TYPES


def stack(accessories, by_id: dict, by_part: dict, kind: str, port_type: str,
          cable_type: str, cabled: bool, record) -> tuple:
    """``(transceiver, cord)`` for one port in use (either may be None;
    export spec §13 v1.9, docs/dcim/model-packs.md → Which parts a port
    shows):

    * a transceiver record's part (set by hand, else by its part ID) sits
      in the cage cabled or not; a cable adds the cord whose connector is
      the record's, else the transceiver's, else the cable's;
    * a one-piece part (``kind: cord`` or ``plug``: a DAC, an AOC) takes
      the port alone, and only while it is cabled;
    * a cabled cage with no record - or one whose part no model stands
      for - takes the generic transceiver of the cable's medium (an SFP-T
      for twisted pair) and its cord; a DAC or AOC cable, or a cage no
      transceiver fits, takes a one-piece part;
    * any other port (an RJ45 jack, an LC panel port, a power inlet)
      takes the cord or plug that fits it, while cabled."""
    medium = cable_medium(cable_type)
    acc = None
    if record is not None:
        acc = by_id.get(record[0]) or (by_part.get(part_key(record[1]))
                                       if record[1] else None)
    if acc is not None:
        if acc.kind != "transceiver":
            return (None, acc if cabled else None)
        if not cabled:
            return (acc, None)
        conn = (record[3] if record[3] not in ("", "other") else "") or acc.connector \
            or _MEDIUM_CONNECTOR.get(medium, "")
        return (acc, cord_for(accessories, conn))
    rec_medium = connector_medium(record[3]) if record is not None else ""
    if record is not None and record[3] == "aoc":
        rec_medium = "aoc"
    if is_cage(kind, port_type):
        want = rec_medium or medium
        one = want in ("dac", "aoc") or (cable_type or "").lower().startswith("aoc")
        if not one:
            t = generic_transceiver(accessories, port_type, want)
            if t is not None:
                if not cabled:
                    return (t, None)
                conn = (record[3] if record is not None and record[3] not in ("", "other")
                        else "") or t.connector or _MEDIUM_CONNECTOR.get(medium, "")
                return (t, cord_for(accessories, conn))
        if not cabled:
            return (None, None)
        heads = accessories
        if want != "aoc" and not (cable_type or "").lower().startswith("aoc"):
            # An AOC is its own cable: a plain fibre in the cage is no AOC.
            heads = [a for a in accessories if not (a.connector or "").startswith("aoc")]
        return (None, one_piece(heads, port_type, cable_type))
    if not cabled:
        return (None, None)
    return (None, one_piece(accessories, port_type, cable_type))


def _part_doc(acc, device, shared: bool, *, cable: bool = False) -> dict:
    doc = {"url": accessory_url(acc, device, shared), "kind": acc.kind,
           "connector": acc.connector or ""}
    if cable:
        doc["cable"] = acc.cable if isinstance(acc.cable, dict) else None
    return doc


def plugs(devices, owners: dict, user, tenant, accessories=None) -> dict[str, list]:
    """``{device id: [{port, bay, name, port_type, cabled, color,
    cable_type, transceiver, transceiver_part, cord_part}]}`` - the parts
    to seat in each device's drawn model, by its port anchor as drawn
    (``port``, with ``bay`` the module's bay or null); ``name`` is the
    device's port (interface, console port, power inlet…) it stands for
    and ``port_type`` its type. ``owners`` maps a device's id to its
    model's owner (api.model_3d.effective_owner); the devices'
    ``_installed_parts`` are loaded first (api.model_3d.installed_parts).

    Each port draws up to two parts (``stack``): ``transceiver_part``
    ``{url, kind, connector}`` at the port's anchor, and ``cord_part``
    ``{url, kind, connector, cable}`` at the transceiver's
    ``port:<connector>`` empty - or at the port's anchor when there is no
    transceiver. ``cable`` is the cord's run (``AccessoryType.cable``) or
    null. ``color`` is the cable's ``#rrggbb`` or null and ``cable_type``
    its type or "" (both only from a cable the reader may view);
    ``cabled`` says whether a cable is in the port; ``transceiver`` is the
    record's ``{part_id, serial}`` or null. A port with a record is listed
    even when it draws nothing, for its hover card. Devices with nothing to
    seat are left out."""
    devices = [d for d in devices if has_ports(d, owners.get(d.id))]
    if not devices:
        return {}
    if accessories is None:
        accessories = accessories_of(tenant)
    if not accessories:
        return {}
    wanted = {str(d.id): _wanted(d, owners.get(d.id)) for d in devices}
    used = in_use(wanted, user, tenant)
    if not used:
        return {}
    shared = may_view_types(user, tenant)
    by_id = {str(a.pk): a for a in accessories}
    by_part: dict = {}
    for a in sorted(accessories, key=_by_name):
        for p in a.parts or []:
            by_part.setdefault(part_key(str(p)), a)
    picks: dict = {}
    out: dict[str, list] = {}
    for d in devices:
        key = str(d.id)
        rows = []
        for bay, drawn, kind, comp in wanted[key]:
            hit = used.get((key, kind, comp))
            if hit is None:
                continue
            ptype, ctype, color, cabled, rec = hit
            if rec is None:
                k = (kind, ptype, ctype, cabled)
                if k not in picks:
                    picks[k] = stack(accessories, by_id, by_part, kind, ptype, ctype,
                                     cabled, None)
                pair = picks[k]
            else:
                pair = stack(accessories, by_id, by_part, kind, ptype, ctype, cabled, rec)
            module, cord = pair
            if module is None and cord is None and rec is None:
                continue
            rows.append({
                "port": drawn, "bay": bay, "name": comp, "port_type": ptype,
                "cabled": cabled,
                "color": color.lower() if _HEX.match(color) else None,
                "cable_type": ctype,
                "transceiver": ({"part_id": rec[1], "serial": rec[2]}
                                if rec is not None else None),
                "transceiver_part": _part_doc(module, d, shared) if module else None,
                "cord_part": _part_doc(cord, d, shared, cable=True) if cord else None,
            })
        if rows:
            out[key] = sorted(rows, key=lambda r: (r["bay"] or "", r["port"]))
    return out
