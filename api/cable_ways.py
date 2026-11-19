"""Cable ways through racks: reading a cable's ends, proposing, recording
and measuring (docs/dcim/racks.md → Cable ways).

The engine (``cable_way_engine``) is pure; this module feeds it from the
database and keeps ``CableWay`` rows:

- :func:`rack_ends` - the cable's ends that are in racks, per rack, with
  the unit, face and side of each port (its photo marker when it has one,
  else a guess from the port's kind, noted as such);
- :func:`exit_prefs` - where a stored floor-plan route meets each rack:
  a tray above half the rack's height means out of the roof, below it out
  of the floor;
- :func:`cable_doc` - every rack the cable is in, with its stored way and
  the live proposal and alternatives;
- :func:`record` / :func:`refresh` - write ways (pinning every hop's
  pathway to a real ``RackPathway`` row), idempotently, never over a
  manual way;
- :func:`length_estimate` - the cable's length from its ways and its room
  route, by the tenant's length rules.

A tenant's ``cable_ways_mode`` says whether a proposal waits to be
accepted (``propose``) or is recorded when the cable's ends are set
(``record``).
"""
from __future__ import annotations

import threading

from django.db import transaction

from . import cable_way_engine as eng
from . import rack_pathways as rp

#: The rack face a port is on when its photo does not say: what most
#: devices have there. A guess, noted ``face-guessed``.
DEFAULT_DEVICE_FACE = {
    "interface": "front", "front_port": "front", "console_port": "front",
    "console_server_port": "front", "aux_port": "front",
    "rear_port": "rear", "power_port": "rear", "power_outlet": "rear",
}
POWER_KINDS = ("power_port", "power_outlet")
_FLIP = {"front": "rear", "rear": "front"}


def _kind(term) -> str:
    from .models import CableTermination

    for f in CableTermination.POINT_FIELDS:
        if getattr(term, f"{f}_id") is not None:
            return f
    return ""


def geo_of(rack) -> eng.Geo:
    fr = rp.Frame.of_rack(rack)
    return eng.Geo(start=fr.start or 1, units=fr.units or 42,
                   width_mm=float(fr.width_mm or eng.DEFAULT_W_MM),
                   depth_mm=float(fr.depth_mm or eng.DEFAULT_D_MM))


def _marker(device, kind: str, name: str):
    """``(photo side, share across)`` of the port's photo marker, or None."""
    from .face_ports import effective_image_ports, render_marker_name

    layout = effective_image_ports(device)
    if not isinstance(layout, dict):
        return None
    mk = kind.replace("_", "-")
    want = name.strip().lower()
    for side in ("front", "rear"):
        for m in layout.get(side) or []:
            if not isinstance(m, dict) or m.get("kind", "interface") != mk:
                continue
            got = render_marker_name(str(m.get("name") or ""), device.vc_position)
            if got.strip().lower() == want:
                try:
                    return side, float(m.get("x", 0)) + float(m.get("w", 0)) / 2
                except (TypeError, ValueError):
                    return None
    return None


def _channel_key(device, items) -> tuple[str, bool]:
    """The key of the 0U channel a side-mounted device sits in, and whether
    it is a guess (the device names none; the rack's first on its rail and
    face is taken)."""
    if device.mount_pathway_id:
        it = next((i for i in items if i["id"] == str(device.mount_pathway_id)), None)
        if it is not None:
            return it["key"], False
    side = device.mount.removeprefix("side_")
    for i in items:
        if i["kind"] == "channel" and not i["hidden"] and i["side"] == side and \
                (not device.face or i["face"] == device.face):
            return i["key"], True
    return "", False


def end_of(term, kind, port, device, rack, items, geo) -> eng.End | None:
    """The engine's view of one termination on a racked device, or None
    when its device has no place in the rack."""
    power = kind in POWER_KINDS
    name = str(getattr(port, "name", "") or "")
    if device.mount in ("side_left", "side_right"):
        key, guessed = _channel_key(device, items)
        ch = next((i for i in items if i["key"] == key), None)
        u = ((ch["u_from"] + ch["u_to"]) // 2) if ch and ch["u_from"] else \
            geo.start + geo.units // 2
        side = device.mount.removeprefix("side_")
        return eng.End(end=term.end, port=name, u=u, face=device.face or "rear", side=side,
                       power=power, channel=key,
                       guesses=["side-" + side] + (["face-guessed"] if guessed else []))
    if device.position is None:
        return None
    h = (device.device_type.u_height if device.device_type_id else 1) or 1
    u = int(device.position + max(0, int(float(h)) - 1) // 2)
    front = device.face or "front"
    guesses: list[str] = []
    m = _marker(device, kind, name)
    if m is not None:
        photo_side, share = m
        face = front if photo_side == "front" else _FLIP[front]
        seen = share if face == "front" else 1 - share
        if device.rack_side in ("left", "right"):
            seen = seen / 2 + (0 if device.rack_side == "left" else 0.5)
        x = (seen - 0.5) * eng.FACEPLATE_MM
        side = "left" if x < 0 else "right"
    else:
        dev_face = DEFAULT_DEVICE_FACE.get(kind, "front")
        face = front if dev_face == "front" else _FLIP[front]
        guesses.append("face-guessed")
        x = None
        side = device.rack_side if device.rack_side in ("left", "right") else ""
    return eng.End(end=term.end, port=name, u=u, face=face, side=side, x_mm=x, power=power,
                   guesses=guesses)


class RackCtx:
    """One rack a cable is in: its resolved pathways, frame and the ends."""

    def __init__(self, rack):
        self.rack = rack
        self.items = rp.resolve_rack(rack)
        self.geo = geo_of(rack)
        self.ends: dict[str, list[eng.End]] = {"A": [], "B": []}

    @property
    def end(self) -> str:
        if self.ends["A"] and self.ends["B"]:
            return "AB"
        return "A" if self.ends["A"] else "B"

    def engine_ends(self) -> list[eng.End]:
        if self.end == "AB":
            return [self.ends["A"][0], self.ends["B"][0]]
        return [self.ends[self.end][0]]

    def item(self, pathway_id=None, key=None):
        for i in self.items:
            if pathway_id and i["id"] == str(pathway_id):
                return i
        for i in self.items:
            if key and i["key"] == key:
                return i
        return None


def rack_ends(cable) -> dict:
    """``{rack_id: RackCtx}`` for every rack the cable has an end in."""
    from .models import CableTermination

    terms = CableTermination.objects.filter(cable=cable).select_related(
        *CableTermination.POINT_FIELDS)
    out: dict = {}
    racks: dict = {}
    pending = []
    for t in terms.order_by("end", "created_at", "pk"):
        kind = _kind(t)
        port = t.point
        dev_id = getattr(port, "device_id", None)
        if dev_id is None:
            continue
        pending.append((t, kind, port, dev_id))
    if not pending:
        return out
    from .models import Device, Rack

    devices = {d.pk: d for d in Device.objects.filter(
        pk__in={p[3] for p in pending}, rack__isnull=False).select_related("device_type")}
    for r in Rack.objects.filter(pk__in={d.rack_id for d in devices.values()}).select_related(
            "rack_type__kit", "kit"):
        racks[r.pk] = r
    for t, kind, port, dev_id in pending:
        d = devices.get(dev_id)
        if d is None or d.rack_id not in racks:
            continue
        ctx = out.get(d.rack_id)
        if ctx is None:
            ctx = out[d.rack_id] = RackCtx(racks[d.rack_id])
        e = end_of(t, kind, port, d, ctx.rack, ctx.items, ctx.geo)
        if e is not None:
            ctx.ends[t.end].append(e)
    return {k: v for k, v in out.items() if v.ends["A"] or v.ends["B"]}


def exit_prefs(cable, ctxs: dict) -> dict:
    """``{rack_id: (exit, tray elevation mm, tray id)}`` from the cable's stored
    floor-plan routes: where its first or last tray is, above or below half
    the rack's height."""
    from .models import FloorPlanCablePath, FloorPlanTile

    paths = list(FloorPlanCablePath.objects.filter(cable=cable).order_by("created_at"))
    if not paths:
        return {}
    tile_ids = set()
    for p in paths:
        for leg in p.legs or []:
            for s in ("from", "to"):
                tid = (leg.get(s) or {}).get("tile")
                if tid:
                    tile_ids.add(tid)
    rack_of = dict(FloorPlanTile.objects.filter(pk__in=tile_ids, rack__isnull=False)
                   .values_list("pk", "rack_id"))
    rack_of = {str(k): v for k, v in rack_of.items()}
    out: dict = {}
    for p in paths:
        for leg in p.legs or []:
            trays = leg.get("trays") or []
            for s, idx in (("from", 0), ("to", -1)):
                rack_id = rack_of.get(str((leg.get(s) or {}).get("tile")))
                if rack_id is None or rack_id not in ctxs or rack_id in out:
                    continue
                elev = trays[idx].get("elevation_mm") if trays else leg.get("elevation_mm")
                if elev is None:
                    continue
                top = ctxs[rack_id].geo.top_z
                out[rack_id] = ("top" if float(elev) >= top / 2 else "bottom", float(elev),
                                trays[idx].get("id") if trays else None)
    return out


def _is_uuid(v) -> bool:
    import uuid

    try:
        uuid.UUID(str(v))
    except (TypeError, ValueError):
        return False
    return bool(v)


def propose_for(ctx: RackCtx, pref: str = "") -> dict | None:
    return eng.propose(ctx.items, ctx.geo, ctx.engine_ends(), exit_pref=pref)


# ── stored ways ─────────────────────────────────────────────────────────────

def _hop_docs(ctx: RackCtx | None, hops) -> tuple[list[dict], bool]:
    """The stored hops with their labels now; and whether one no longer
    resolves (its pathway gone or hidden)."""
    out, stale = [], False
    for h in hops or []:
        it = ctx.item(h.get("pathway"), h.get("key")) if ctx else None
        if ctx is not None and (it is None or it["hidden"]):
            stale = True
        label = it["label"] if it else rp.label({**rp._blank_item(), **_key_item(h)})
        out.append({**h, "label": label, "missing": ctx is not None and it is None,
                    "hidden": bool(it and it["hidden"])})
    return out, stale


def _key_item(h) -> dict:
    """What a hop's key says of its pathway, for a label without the rack."""
    key = str(h.get("key") or "")
    parts = key.split(":")
    item = {"key": key, "kind": h.get("kind") or ""}
    if key.startswith("path:vertical:") and len(parts) == 4:
        item.update(side=parts[2], face=parts[3])
    elif key.startswith("channel:0u:") and len(parts) == 4:
        item.update(side=parts[2], face=parts[3])
    elif key.startswith("entry:") and len(parts) == 3:
        item.update(surface=parts[1])
    return item


def way_doc(way, ctx: RackCtx | None, *, gone: bool = False) -> dict:
    """A stored way as the API gives it. ``stale``: a hop no longer
    resolves, or the cable's ends in the rack changed (``gone``: it has
    none there now); None when ``ctx`` was not read (a list)."""
    hops, stale = _hop_docs(ctx, way.hops)
    if gone:
        stale = True
    elif ctx is None:
        stale = None
    elif ctx.end != way.end:
        stale = True
    return {"id": str(way.pk), "cable_id": str(way.cable_id),
            "rack": {"id": str(way.rack_id), "name": way.rack.name}, "end": way.end,
            "state": way.state, "source": way.source, "exit": way.exit, "hops": hops,
            "points": way.points, "length_mm": way.length_mm, "reasons": way.reasons,
            "stale": stale, "updated_at": way.updated_at}


def cable_doc(cable, *, ctxs=None) -> dict:
    """Every rack ``cable`` is in: the stored way (if any), the proposal and
    its alternatives, with the cable's length estimate."""
    from core.effective_settings import cable_ways_mode

    from .models import CableWay

    ctxs = rack_ends(cable) if ctxs is None else ctxs
    prefs = exit_prefs(cable, ctxs)
    stored = {w.rack_id: w for w in CableWay.objects.filter(cable=cable).select_related("rack")}
    from .models import FloorPlanTray

    tray_ids = [p[2] for p in prefs.values() if _is_uuid(p[2])]
    trays = {str(k): v for k, v in FloorPlanTray.objects.filter(
        pk__in=tray_ids, floor_plan__tenant_id=cable.tenant_id).values_list("pk", "name")} \
        if tray_ids else {}
    racks = []
    for rack_id, ctx in sorted(ctxs.items(), key=lambda kv: (kv[1].end, kv[1].rack.name)):
        pref = prefs.get(rack_id, ("", None, None))
        prop = propose_for(ctx, pref[0])
        w = stored.get(rack_id)
        racks.append({
            "rack": {"id": str(rack_id), "name": ctx.rack.name}, "end": ctx.end,
            "ports": [e.port for e in ctx.engine_ends()],
            "route": {"exit": pref[0], "elevation_mm": pref[1],
                      "tray": trays.get(str(pref[2])) if pref[2] else None}
            if pref[0] else None,
            "proposal": prop, "way": way_doc(w, ctx) if w else None,
        })
    others = [way_doc(w, None, gone=True) for rid, w in stored.items() if rid not in ctxs]
    return {"cable_id": str(cable.pk), "mode": cable_ways_mode(cable.tenant_id),
            "racks": racks, "orphans": others, "length": length_estimate(cable)}


def _pin_hops(ctx: RackCtx, hops, tenant) -> list[dict]:
    out = []
    for h in hops:
        row = rp.pin(ctx.rack, h["key"], tenant=tenant)
        if row is None:
            raise ValueError(f"{h.get('label') or h['key']}: not a pathway of this rack.")
        out.append({"pathway": str(row.pk), "key": h["key"], "kind": h["kind"],
                    "enter_u": h.get("enter_u"), "leave_u": h.get("leave_u")})
    return out


def save_way(cable, ctx: RackCtx, doc: dict, *, state: str, source: str, way=None):
    """Write ``doc`` (a proposal or a measured way) as the cable's way in
    the rack. Returns ``(way, changed)``; nothing is written when the row
    already says exactly this."""
    from .models import CableWay

    hops = _pin_hops(ctx, doc.get("hops") or [], cable.tenant) if state != "dismissed" else []
    shown = state != "dismissed"
    values = {
        "end": ctx.end, "state": state, "source": source,
        "exit": doc.get("exit", "") if shown else "",
        "hops": hops, "points": (doc.get("points") or []) if shown else [],
        "length_mm": doc.get("length_mm") if shown else None,
        "reasons": doc.get("reasons") or [],
    }
    if way is None:
        way = CableWay.objects.filter(cable=cable, rack=ctx.rack).first()
    if way is None:
        way = CableWay.objects.create(tenant=cable.tenant, cable=cable, rack=ctx.rack, **values)
        return way, True
    if all(getattr(way, k) == v for k, v in values.items()):
        return way, False
    for k, v in values.items():
        setattr(way, k, v)
    way.save()
    return way, True


def refresh(cable, *, state: str | None = None) -> list[tuple[str, str, str]]:
    """Bring the cable's automatic ways up to date with its ends.

    ``state`` None: by the tenant's mode - *record* records a way in every
    rack with a proposal; *propose* only updates the proposed (and
    accepted-automatic) rows already stored, as an accepted way whose
    proposal changed goes back to proposed. ``state`` ``recorded`` or
    ``proposed``: write that for every rack with a proposal (the
    management command). Manual and dismissed ways are never touched while
    their rack still has the cable; an automatic way of a rack the cable
    left is removed. Returns ``[(rack name, what, chain)]``."""
    from core.effective_settings import cable_ways_mode

    from .models import CableWay

    mode = cable_ways_mode(cable.tenant_id)
    ctxs = rack_ends(cable)
    prefs = exit_prefs(cable, ctxs)
    stored = {w.rack_id: w for w in CableWay.objects.filter(cable=cable).select_related("rack")}
    log = []
    for rack_id, w in stored.items():
        if rack_id not in ctxs and w.source == "auto":
            log.append((w.rack.name, "removed", ""))
            w.delete()
    for rack_id, ctx in ctxs.items():
        w = stored.get(rack_id)
        if w is not None and (w.source == "manual" or w.state == "dismissed"):
            log.append((ctx.rack.name, "kept", w.source))
            continue
        prop = propose_for(ctx, prefs.get(rack_id, ("",))[0])
        if prop is None:
            if w is not None:
                log.append((ctx.rack.name, "removed", ""))
                w.delete()
            continue
        target = state
        if target is None:
            if mode == "record":
                target = "recorded"
            elif w is not None:
                # An accepted automatic way whose proposal changed waits to
                # be accepted again.
                target = w.state if _same(w, prop) else "proposed"
            else:
                continue
        _, changed = save_way(cable, ctx, prop, state=target, source="auto", way=w)
        if changed:
            log.append((ctx.rack.name, target, chain_text(prop)))
    if log:
        remeasure_paths(cable)
    return log


def _same(way, prop) -> bool:
    return [(h["key"], h.get("enter_u"), h.get("leave_u")) for h in way.hops] == \
        [(h["key"], h.get("enter_u"), h.get("leave_u")) for h in prop["hops"]] and \
        way.exit == prop["exit"]


def chain_text(doc, port: str = "") -> str:
    parts = [port] if port else []
    parts += [h.get("label") or h["key"] for h in doc.get("hops") or []]
    if doc.get("exit") == "port":
        parts.append("far port")
    return " → ".join(parts)


# ── after a cable's ends change ─────────────────────────────────────────────

_pending = threading.local()


def schedule(cable_id) -> None:
    """Refresh the cable's automatic ways once the transaction commits
    (once per cable, however many terminations changed)."""
    ids = getattr(_pending, "ids", None)
    if ids is None:
        ids = _pending.ids = set()
    if cable_id in ids:
        return
    ids.add(cable_id)

    def run():
        ids.discard(cable_id)
        _run_refresh(cable_id)

    transaction.on_commit(run)


def _run_refresh(cable_id) -> None:
    from core.effective_settings import cable_ways_mode

    from .models import Cable, CableWay

    cable = Cable.objects.filter(pk=cable_id).select_related("tenant").first()
    if cable is None:
        return
    if cable_ways_mode(cable.tenant_id) != "record" and not CableWay.objects.filter(
            cable=cable, source="auto").exists():
        return
    with transaction.atomic():
        refresh(cable)


def _term_changed(sender, instance, **kwargs):
    schedule(instance.cable_id)


def connect_signals() -> None:
    from django.db.models.signals import post_delete, post_save

    from .models import CableTermination

    post_save.connect(_term_changed, sender=CableTermination,
                      dispatch_uid="cable_ways_term_saved")
    post_delete.connect(_term_changed, sender=CableTermination,
                        dispatch_uid="cable_ways_term_deleted")


# ── lengths ────────────────────────────────────────────────────────────────

def length_estimate(cable) -> dict | None:
    """The cable's length from its recorded ways and its room route:
    ``{length_mm, ways: [{rack, end, length_mm}], route, run_mm,
    drop_a_mm, drop_b_mm, extra_mm, slack_mm}`` - the route's drops are
    from each rack's entry when that end has a way, else from the port
    (the floor plan's own). None when there is nothing to go on."""
    from core.effective_settings import cable_length_rules

    from .cable_routing import PlanRouter, length_total
    from .models import CableWay, FloorPlanCablePath

    ways = list(CableWay.objects.filter(cable=cable, state="recorded").select_related("rack"))
    way_docs = [{"rack": {"id": str(w.rack_id), "name": w.rack.name}, "end": w.end,
                 "length_mm": w.length_mm or 0} for w in ways]
    path = FloorPlanCablePath.objects.filter(cable=cable, riser__isnull=True).select_related(
        "floor_plan").order_by("created_at").first()
    if path is not None:
        m = PlanRouter(path.floor_plan).remeasure(cable, path)
        if m is not None:
            return {**m, "ways": way_docs, "route": path.floor_plan.name}
    same = next((w for w in ways if w.end == "AB" and w.length_mm), None)
    if same is not None:
        rules = cable_length_rules(cable.tenant_id)
        loops, slack, total = length_total(same.length_mm, rules)
        return {"length_mm": total, "ways": way_docs, "route": None, "run_mm": 0,
                "drop_a_mm": 0, "drop_b_mm": 0, "extra_mm": loops, "slack_mm": slack}
    if ways:
        return {"length_mm": None, "ways": way_docs, "route": None}
    return None


def remeasure_paths(cable) -> None:
    """Re-measure the cable's stored floor-plan routes (their drops now
    start at the racks' entries), and its length when a route computed it."""
    from .cable_routing import PlanRouter, write_length
    from .models import FloorPlanCablePath

    for path in FloorPlanCablePath.objects.filter(cable=cable, riser__isnull=True).select_related(
            "floor_plan"):
        m = PlanRouter(path.floor_plan).remeasure(cable, path)
        if m is None:
            continue
        fields = ["run_mm", "drop_a_mm", "drop_b_mm", "extra_mm", "slack_mm", "length_mm"]
        if all(getattr(path, f) == m[f] for f in fields):
            continue
        for f in fields:
            setattr(path, f, m[f])
        path.save(update_fields=[*fields, "updated_at"])
        if cable.length_source == "computed":
            write_length(cable, m["length_mm"])


def counts_by_pathway(rack, cable_ids=None) -> dict[str, int]:
    """``{pathway id: recorded ways through it}`` in ``rack`` (of the
    cables ``cable_ids`` when given: the ones the reader may view)."""
    from .models import CableWay

    qs = CableWay.objects.filter(rack=rack, state="recorded")
    if cable_ids is not None:
        qs = qs.filter(cable_id__in=cable_ids)
    out: dict[str, int] = {}
    for hops in qs.values_list("hops", flat=True):
        for pid in {h.get("pathway") for h in hops or [] if h.get("pathway")}:
            out[pid] = out.get(pid, 0) + 1
    return out
