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
sits in each of their drawn models' cabled ports: the ``port:`` anchors of
the chassis and of each installed module (api.model_anchors), resolved to
the device's interface, console port, power port… (api.anchor_names), the
ones in use - a cable ends on it, or an interface or patch port is marked
connected - among those the reader may view. A port takes the accessory
type whose ``fits`` names its type (``choose``); none, and the port shows
nothing beyond its hidden cover (api.port_covers). Each plug carries its
cable's colour when the reader may view the cable.

Danbyte has no per-interface transceiver record, so among several parts
that fit a cage the cable's medium decides: a DAC cable takes a DAC head, a
fibre cable an optical transceiver, a twisted-pair cable an RJ45 part. A
known medium no fitting part has shows nothing rather than a wrong part.

Query cost: nothing when no device's model names a port; otherwise one
query for the tenant's accessory types and, when there are any, one
(UNION ALL over the port kinds in play) for the ports in use.
"""
from __future__ import annotations

import posixpath
import re

from django.core.exceptions import ValidationError

#: Where a pack keeps its accessory YAML.
ACCESSORY_DIR = "accessory-types/"
KINDS = ("plug", "transceiver", "cord")
#: The export spec's budget for one accessory (§13).
ACCESSORY_TRIANGLES = 2_000
NAME_MAX = 100
MAX_FITS = 64

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
    if _FIBRE_CONNECTOR.match(c):
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
    return {"vendor": vendor_of(path)[:100], "name": name, "kind": kind,
            "connector": connector, "fits": fits, "file": rel}, notes


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
    if tri > ACCESSORY_TRIANGLES:
        notes.append(f"model: over the {ACCESSORY_TRIANGLES}-triangle budget for a part; "
                     "imported, but many in a room cost frames.")
    obj = AccessoryType.objects.filter(tenant=tenant, vendor=fields["vendor"],
                                       name=name).first()
    action = "matched" if obj is not None else "created"
    if obj is None:
        obj = AccessoryType(tenant=tenant, vendor=fields["vendor"], name=name)
    obj.kind, obj.connector, obj.fits = fields["kind"], fields["connector"], fields["fits"]
    obj.pack_import = {"pack": {"name": pack_name, "version": pack_version}}
    notes.append(f"{fields['kind']}, fits {', '.join(fields['fits'])}.")
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
                .only("id", "vendor", "name", "kind", "connector", "fits", "model_3d"))


def in_use(wanted: dict, user, tenant) -> dict:
    """``{(device id, kind, component name): (type, cable type, colour)}``
    for the ports of ``wanted`` (``{device id: _wanted rows}``) in use and
    viewable by the reader. The cable's type and colour only when the
    reader may view the cable. One query (UNION ALL over the kinds)."""
    from django.apps import apps
    from django.db.models import CharField, Exists, OuterRef, Q, Subquery, Value

    from auth_api import rbac

    from .models import Cable, CableTermination

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
    parts = []
    for kind, dev_ids in sorted(kinds.items()):
        model_name, slug, fk, marks = PORT_KINDS[kind]
        model = apps.get_model("api", model_name)
        qs = model.objects.filter(device__tenant=tenant, device_id__in=list(dev_ids))
        if not superuser:
            qs = rbac.restrict_queryset(qs, user, tenant, slug, "view")
        terms = CableTermination.objects.filter(**{fk: OuterRef("pk")})
        used = Q(Exists(terms))
        if marks:
            used |= Q(mark_connected=True)
        seen = terms.filter(cable__in=cables).order_by("cable_id")
        parts.append(
            qs.filter(used).order_by()
            .annotate(_kind=Value(kind, output_field=CharField()),
                      _ctype=Subquery(seen.values("cable__type")[:1],
                                      output_field=CharField()),
                      _color=Subquery(seen.values("cable__color")[:1],
                                      output_field=CharField()))
            .values_list("device_id", "_kind", "name", "type", "_ctype", "_color"))
    rows = parts[0].union(*parts[1:], all=True) if len(parts) > 1 else parts[0]
    return {(str(d), k, n): (t or "", ct or "", col or "")
            for d, k, n, t, ct, col in rows}


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


def plugs(devices, owners: dict, user, tenant, accessories=None) -> dict[str, list]:
    """``{device id: [{port, bay, name, url, color}]}`` - the plugs to seat
    in each device's drawn model, by its port anchor as drawn (``port``,
    with ``bay`` the module's bay or null); ``name`` is the device's port
    (interface, console port, power inlet…) it stands for. ``owners`` maps a device's id to
    its model's owner (api.model_3d.effective_owner); the devices'
    ``_installed_parts`` are loaded first (api.model_3d.installed_parts).
    ``color`` is the cable's ``#rrggbb`` or null (the viewer's grey).
    Devices with nothing to seat are left out."""
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
    picks: dict = {}
    out: dict[str, list] = {}
    for d in devices:
        key = str(d.id)
        rows = []
        for bay, drawn, kind, comp in wanted[key]:
            hit = used.get((key, kind, comp))
            if hit is None:
                continue
            ptype, ctype, color = hit
            k = (ptype, cable_medium(ctype))
            if k not in picks:
                picks[k] = choose(accessories, ptype, ctype)
            acc = picks[k]
            if acc is None:
                continue
            rows.append({"port": drawn, "bay": bay, "name": comp,
                         "url": accessory_url(acc, d, shared),
                         "color": color.lower() if _HEX.match(color) else None})
        if rows:
            out[key] = sorted(rows, key=lambda r: (r["bay"] or "", r["port"]))
    return out
