"""The cable way proposal engine (docs/dcim/racks.md → Cable ways).

Pure: no Django. Given a rack's resolved pathways (``rack_pathways.
resolve_rack``), its frame and the cable's end(s) in it, :func:`propose`
works out the way a cable most likely takes through the rack:

    port → [horizontal manager next to the port's U] → [vertical manager
    on the port's side and face, from the port's U to the far port's U or
    to the rack's top / bottom] → [roof / floor entry] → out

and, for both ends in one rack, back down to the far port. A power cord
to a 0U PDU goes to the PDU's channel instead. Only shown (not hidden)
pathways take part; a rack with none gives no proposal.

Every candidate way is scored (penalties for a guess or a compromise, then
its length, then its pathway keys), so the answer is deterministic. The
best is the proposal; the next distinct ones are its alternatives. Each
carries short reason codes (``REASONS``) saying why.

Geometry is the rack's own, in millimetres: ``x`` right of the rack's
centre seen from the front, ``y`` behind its front, ``z`` above the floor
(a unit's centre at plinth + (u - first + ½) × pitch, the floor plan's
``pathfinding`` constants). Cables run square, so a way's length is the
sum of its points' x, y and z steps.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .pathfinding import RACK_PLINTH_MM, U_PITCH_MM

#: The 19-inch faceplate a port's place on its photo is a share of.
FACEPLATE_MM = 482.6
#: How far in front of / behind a face a port's cable leaves its device.
FACE_INSET_MM = 40.0
#: A rack's width and depth when neither it nor its type records one.
DEFAULT_W_MM, DEFAULT_D_MM = 600.0, 1000.0
#: Alternatives a proposal carries at most.
ALTERNATIVES_MAX = 3
#: A horizontal manager this many units from a port's units still serves it.
HM_REACH_U = 1

#: Penalties (lower wins), then length.
P_OTHER_SIDE = 4
P_FULL_DEPTH = 1
P_CROSS_DEPTH = 3
P_EXIT_AGAINST = 6
P_SIDE_ENTRY = 2
P_NO_VERTICAL = 5

REASONS = {
    "side-left": "The port is on the left half of its face.",
    "side-right": "The port is on the right half of its face.",
    "side-guessed": "The port's place on its face is unknown.",
    "face-guessed": "Which face the port is on is a guess from its kind.",
    "other-side": "No manager on the port's side; the other side's is used.",
    "full-depth": "A full-depth manager serves both faces.",
    "crosses-depth": "The cable crosses from one face to the other.",
    "horizontal-manager": "Through the horizontal manager next to the port.",
    "pdu-channel": "A power cord to the PDU in its 0U channel.",
    "exit-overhead": "Out of the roof, to the overhead route.",
    "exit-underfloor": "Out of the floor, to the underfloor route.",
    "exit-default": "No room route; out of the first entry there is.",
    "exit-against-route": "No entry on the route's side.",
    "no-vertical": "No vertical manager reaches the port.",
    "no-entry": "The frame has no entries; out of the top or bottom.",
    "same-rack": "Both ends are in this rack.",
}


@dataclass
class Geo:
    """A rack's frame: its first unit, units, width and depth (mm)."""

    start: int = 1
    units: int = 42
    width_mm: float = DEFAULT_W_MM
    depth_mm: float = DEFAULT_D_MM

    @property
    def top_unit(self) -> int:
        return self.start + self.units - 1

    @property
    def top_z(self) -> float:
        return RACK_PLINTH_MM + self.units * U_PITCH_MM

    def z(self, u: float) -> float:
        """The height of unit ``u``'s centre (``u`` may be fractional)."""
        return RACK_PLINTH_MM + (u - self.start + 0.5) * U_PITCH_MM


@dataclass
class End:
    """One cable end in a rack.

    ``u`` is the unit the port is at (its device's middle unit, rounded
    down), ``face`` the rack face it is on (front / rear), ``side`` the half
    of the faceplate (left / right seen from the front, blank unknown),
    ``x_mm`` its place right of centre when known. ``power``: a power cord.
    ``channel``: the key of the 0U channel the port's device sits in (a
    PDU). ``guesses``: reason codes for what was guessed."""

    end: str
    port: str
    u: int
    face: str
    side: str = ""
    x_mm: float | None = None
    power: bool = False
    channel: str = ""
    guesses: list[str] = field(default_factory=list)


def _shown(items, kind):
    return [i for i in items if i["kind"] == kind and not i["hidden"] and not i.get("orphan")]


def _faces_meet(path_face: str, face: str) -> bool:
    return not path_face or path_face == "full" or path_face == face


def _covers(it, u) -> bool:
    lo, hi = it.get("u_from"), it.get("u_to")
    return lo is not None and hi is not None and lo <= u <= hi


def _sign(side: str) -> float:
    return -1.0 if side == "left" else 1.0


class _Place:
    """Where pathways and ports sit in the rack (mm)."""

    def __init__(self, geo: Geo):
        self.geo = geo

    def face_y(self, face: str) -> float:
        return FACE_INSET_MM if face != "rear" else self.geo.depth_mm - FACE_INSET_MM

    def port(self, e: End) -> tuple[float, float, float]:
        x = e.x_mm
        if x is None:
            x = _sign(e.side) * FACEPLATE_MM / 4 if e.side else 0.0
        return (x, self.face_y(e.face), self.geo.z(e.u))

    def vertical_x(self, it) -> float:
        w = float(it.get("inner_w_mm") or 50)
        return _sign(it["side"]) * (self.geo.width_mm / 2 - w / 2 - 10)

    def vertical_y(self, it, face: str) -> float:
        # A full-depth manager is met at the face the cable is on.
        return self.face_y(face if it.get("face") in ("full", "", None) else it["face"])

    def channel_xy(self, it) -> tuple[float, float]:
        x = _sign(it["side"]) * (self.geo.width_mm / 2 - 30)
        y = it.get("depth_mm")
        return x, float(y) if y is not None else self.face_y(it.get("face") or "rear")

    def hm_y(self, it, face: str) -> float:
        f = it.get("face") if it.get("face") in ("front", "rear") else face
        return FACE_INSET_MM / 2 if f != "rear" else self.geo.depth_mm - FACE_INSET_MM / 2

    def hm_z(self, it) -> float:
        return self.geo.z(((it["u_from"] or 0) + (it["u_to"] or it["u_from"] or 0)) / 2)

    def entry(self, it) -> tuple[float, float, float]:
        x = float(it.get("x_mm") or 0)
        y = float(it.get("y_mm") if it.get("y_mm") is not None else self.geo.depth_mm / 2)
        surface = it.get("surface")
        if surface == "bottom":
            return (x, y, 0.0)
        if surface == "side":
            return (_sign(it.get("side") or "left") * self.geo.width_mm / 2, y, self.geo.top_z / 2)
        return (x, y, self.geo.top_z)


def _length(points) -> float:
    return sum(abs(b[0] - a[0]) + abs(b[1] - a[1]) + abs(b[2] - a[2])
               for a, b in zip(points, points[1:], strict=False))


def _hop(it, enter_u=None, leave_u=None) -> dict:
    return {"pathway": it.get("id"), "key": it["key"], "kind": it["kind"],
            "label": it.get("label") or it["key"], "enter_u": enter_u, "leave_u": leave_u}


@dataclass
class _Cand:
    hops: list
    points: list
    exit: str
    reasons: list
    penalty: float

    def sort_key(self):
        return (self.penalty, round(_length(self.points)), tuple(h["key"] for h in self.hops),
                self.exit)

    def doc(self) -> dict:
        reasons = list(dict.fromkeys(self.reasons))
        return {"hops": self.hops, "exit": self.exit,
                "points": [[round(v) for v in p] for p in self.points],
                "length_mm": round(_length(self.points)), "reasons": reasons}


def _side_reasons(e: End) -> list[str]:
    out = list(e.guesses)
    if e.side:
        out.append(f"side-{e.side}")
    elif "side-guessed" not in out:
        out.append("side-guessed")
    return out


def _nearest_hm(hms, e: End):
    """The horizontal manager at or next to the port's unit on its face:
    the nearest, a tie to the one above."""
    best = None
    for it in hms:
        if it.get("u_from") is None or not _faces_meet(it.get("face"), e.face):
            continue
        lo, hi = it["u_from"], it.get("u_to") or it["u_from"]
        gap = 0 if lo <= e.u <= hi else (lo - e.u if lo > e.u else e.u - hi)
        if gap > HM_REACH_U:
            continue
        rank = (gap, 0 if lo >= e.u else 1, it["key"])
        if best is None or rank < best[0]:
            best = (rank, it)
    return best[1] if best else None


def _to_path(pl: _Place, e: End, hm, x_to: float, y_to: float, z_to: float | None = None):
    """Points and hops from the port to (x_to, y_to) at the port's height,
    through ``hm`` when there is one."""
    p = pl.port(e)
    pts = [p]
    hops = []
    if hm is not None:
        y, z = pl.hm_y(hm, e.face), pl.hm_z(hm)
        pts += [(p[0], y, z), (x_to, y, z)]
        hops.append(_hop(hm))
    z = pts[-1][2] if z_to is None else z_to
    pts.append((x_to, y_to, z))
    return pts, hops


def _exit_cands(pl: _Place, entries, exit_pref: str):
    """``[(entry or None, surface, penalty, reasons)]``: the ways out."""
    if not entries:
        # An open frame: out of the top (or the bottom) of the manager.
        want = exit_pref or "top"
        return [(None, s, 0 if s == want else P_EXIT_AGAINST, ["no-entry"])
                for s in ("top", "bottom")]
    out = []
    for it in entries:
        surface = it.get("surface") or "top"
        pen, why = 0.0, []
        if surface == "side":
            pen += P_SIDE_ENTRY
        if exit_pref and surface != exit_pref:
            pen += P_EXIT_AGAINST
            why.append("exit-against-route")
        out.append((it, surface, pen, why))
    return out


def _exit_reason(exit_pref: str) -> str:
    return {"top": "exit-overhead", "bottom": "exit-underfloor"}.get(exit_pref, "exit-default")


def _out_cands(pl: _Place, items, e: End, exit_pref: str) -> list[_Cand]:
    """The ways from one end out of the rack."""
    geo = pl.geo
    verticals = _shown(items, "vertical")
    hms = _shown(items, "horizontal")
    entries = _shown(items, "entry")
    channels = {i["key"]: i for i in _shown(items, "channel")}
    hm = _nearest_hm(hms, e)
    base = _side_reasons(e) + ([] if hm is None else ["horizontal-manager"])
    cands: list[_Cand] = []
    exits = _exit_cands(pl, entries, exit_pref)
    first = _exit_reason(exit_pref)

    def leave(x, y, surface, entry):
        z = geo.top_z if surface != "bottom" else 0.0
        if entry is None:
            return [(x, y, z)]
        ex = pl.entry(entry)
        return [(x, y, ex[2]), ex]

    ch = channels.get(e.channel)
    if ch is not None:
        # A PDU's own cord runs along its channel to the way out.
        x, y = pl.channel_xy(ch)
        for entry, surface, pen, why in exits:
            u_out = geo.top_unit if surface != "bottom" else geo.start
            pts = [pl.port(e), (x, y, geo.z(e.u))]
            pts += [(x, y, geo.z(u_out))] + leave(x, y, surface, entry)
            hops = [_hop(ch, e.u, u_out)] + ([_hop(entry)] if entry else [])
            cands.append(_Cand(hops, pts, surface, ["pdu-channel", first, *why], pen))
        return cands

    fits = [v for v in verticals if _faces_meet(v.get("face"), e.face) and _covers(v, e.u)]
    for v in fits:
        pen, why = 0.0, list(base)
        if e.side and v["side"] != e.side:
            pen += P_OTHER_SIDE
            why.append("other-side")
        if v.get("face") == "full":
            pen += P_FULL_DEPTH
            why.append("full-depth")
        vx, vy = pl.vertical_x(v), pl.vertical_y(v, e.face)
        lead, lead_hops = _to_path(pl, e, hm, vx, vy)
        for entry, surface, epen, ewhy in exits:
            u_out = v["u_to"] if surface != "bottom" else v["u_from"]
            pts = list(lead) + [(vx, vy, geo.z(u_out))] + leave(vx, vy, surface, entry)
            hops = lead_hops + [_hop(v, e.u, u_out)] + ([_hop(entry)] if entry else [])
            cands.append(_Cand(hops, pts, surface, [*why, first, *ewhy], pen + epen))
    if not fits and (entries or hm is not None):
        # No manager reaches the port: straight to the way out.
        for entry, surface, epen, ewhy in exits:
            if entry is None and hm is None:
                continue
            p = pl.port(e)
            target = pl.entry(entry) if entry else (p[0], p[1], geo.top_z)
            lead, lead_hops = _to_path(pl, e, hm, target[0], target[1])
            pts = lead + [target]
            hops = lead_hops + ([_hop(entry)] if entry else [])
            cands.append(_Cand(hops, pts, surface, [*base, "no-vertical", first, *ewhy],
                               P_NO_VERTICAL + epen))
    return cands


def _same_rack_cands(pl: _Place, items, a: End, b: End) -> list[_Cand]:
    """The ways between two ports in one rack."""
    verticals = _shown(items, "vertical")
    hms = _shown(items, "horizontal")
    channels = {i["key"]: i for i in _shown(items, "channel")}
    cands: list[_Cand] = []
    # A power cord to a PDU in its channel: across to the channel.
    for near, far in ((a, b), (b, a)):
        ch = channels.get(far.channel)
        if ch is None or not (near.power or far.power):
            continue
        hm = _nearest_hm(hms, near)
        x, y = pl.channel_xy(ch)
        pts, hops = _to_path(pl, near, hm, x, y)
        hops.append(_hop(ch, near.u, near.u))
        why = _side_reasons(near) + ["same-rack", "pdu-channel"]
        if hm is not None:
            why.append("horizontal-manager")
        pen = 0
        if near.side and near.side != ch["side"]:
            pen = P_OTHER_SIDE
            why.append("other-side")
        if near is b:
            # The way runs from A, the PDU's outlet in its channel.
            hops, pts = list(reversed(hops)), list(reversed(pts))
        cands.append(_Cand(hops, pts, "port", why, pen))
    if cands:
        return cands
    hm_a, hm_b = _nearest_hm(hms, a), _nearest_hm(hms, b)
    pa, pb = pl.port(a), pl.port(b)
    # Next to each other, through one horizontal manager.
    if hm_a is not None and hm_a is hm_b and a.face == b.face:
        y, z = pl.hm_y(hm_a, a.face), pl.hm_z(hm_a)
        pts = [pa, (pa[0], y, z), (pb[0], y, z), pb]
        cands.append(_Cand([_hop(hm_a)], pts, "port",
                           _side_reasons(a) + ["same-rack", "horizontal-manager"], 0))
    lo, hi = min(a.u, b.u), max(a.u, b.u)
    for v in verticals:
        if not (_faces_meet(v.get("face"), a.face) and _covers(v, lo) and _covers(v, hi)):
            continue
        pen, why = 0.0, _side_reasons(a) + ["same-rack"]
        for e in (a, b):
            if e.side and v["side"] != e.side:
                pen += P_OTHER_SIDE / 2
                if "other-side" not in why:
                    why.append("other-side")
        if v.get("face") == "full":
            if a.face != b.face:
                why.append("full-depth")
            else:
                pen += P_FULL_DEPTH
        elif a.face != b.face:
            pen += P_CROSS_DEPTH
            why.append("crosses-depth")
        vx = pl.vertical_x(v)
        lead, lead_hops = _to_path(pl, a, hm_a, vx, pl.vertical_y(v, a.face))
        tail, tail_hops = _to_path(pl, b, hm_b if hm_b is not hm_a else None, vx,
                                   pl.vertical_y(v, b.face))
        if hm_a is not None:
            why.append("horizontal-manager")
        pts = lead + [(vx, lead[-1][1], tail[-1][2])] + list(reversed(tail))
        hops = lead_hops + [_hop(v, a.u, b.u)] + list(reversed(tail_hops))
        cands.append(_Cand(hops, pts, "port", why, pen))
    return cands


def propose(items: list[dict], geo: Geo, ends: list[End], *, exit_pref: str = "") -> dict | None:
    """The way through one rack: ``{hops, exit, points, length_mm, reasons,
    alternatives}``, or None when no pathway of the rack serves it.

    ``ends``: the cable's one end in this rack (it leaves the rack), or its
    A and B ends (both here). ``exit_pref``: ``top`` / ``bottom`` - where
    the room route meets the rack (overhead, underfloor) - or blank."""
    pl = _Place(geo)
    if len(ends) >= 2:
        cands = _same_rack_cands(pl, items, ends[0], ends[1])
    else:
        cands = _out_cands(pl, items, ends[0], exit_pref)
    if not cands:
        return None
    cands.sort(key=_Cand.sort_key)
    best = cands[0].doc()
    seen = {_chain(best)}
    alts = []
    for c in cands[1:]:
        d = c.doc()
        if _chain(d) in seen:
            continue
        seen.add(_chain(d))
        alts.append(d)
        if len(alts) >= ALTERNATIVES_MAX:
            break
    best["alternatives"] = alts
    return best


def _chain(doc) -> tuple:
    return (tuple((h["key"], h["enter_u"], h["leave_u"]) for h in doc["hops"]), doc["exit"])


def measure(items: list[dict], geo: Geo, ends: list[End], hops: list[dict],
            exit_: str) -> dict:
    """The points and length of a way someone set: ``hops`` (``{key,
    enter_u, leave_u}`` of shown pathways, in order) from the port to the
    far port (``exit_`` port) or out of the rack. Raises ``ValueError``
    with the reason when the hops do not make a way."""
    pl = _Place(geo)
    by_key = {i["key"]: i for i in items}
    e = ends[0]
    pts = [pl.port(e)]
    out: list[dict] = []
    face = e.face
    for i, h in enumerate(hops):
        it = by_key.get(h.get("key"))
        if it is None or it.get("orphan"):
            raise ValueError(f"Hop {i + 1}: not a pathway of this rack.")
        if it["hidden"]:
            raise ValueError(f"Hop {i + 1}: {it['label']} is hidden.")
        enter_u, leave_u = h.get("enter_u"), h.get("leave_u")
        x, y, z = pts[-1]
        kind = it["kind"]
        if kind in ("vertical", "channel"):
            if enter_u is None:
                enter_u = _unit_of(geo, z)
            if leave_u is None:
                leave_u = enter_u
            for u in (enter_u, leave_u):
                if not _covers(it, u):
                    raise ValueError(f"Hop {i + 1}: {it['label']} does not reach U{u}.")
            if kind == "vertical":
                vx, vy = pl.vertical_x(it), pl.vertical_y(it, face)
            else:
                vx, vy = pl.channel_xy(it)
            pts += [(vx, vy, geo.z(enter_u)), (vx, vy, geo.z(leave_u))]
            if it.get("face") in ("front", "rear"):
                face = it["face"]
        elif kind == "horizontal":
            if it.get("u_from") is None:
                raise ValueError(f"Hop {i + 1}: {it['label']} has no unit.")
            enter_u = leave_u = None
            hz, hy = pl.hm_z(it), pl.hm_y(it, face)
            pts += [(x, hy, hz)]
        elif kind == "entry":
            if i != len(hops) - 1:
                raise ValueError(f"Hop {i + 1}: an entry is the last hop.")
            if exit_ == "port":
                raise ValueError("A way between two ports in one rack leaves by no entry.")
            enter_u = leave_u = None
            ex = pl.entry(it)
            pts += [(x, y, ex[2]), ex]
        out.append({**_hop(it, enter_u, leave_u)})
    if exit_ == "port":
        if len(ends) < 2:
            raise ValueError("This end leaves the rack; give its way out.")
        pb = pl.port(ends[1])
        x, y, z = pts[-1]
        pts += [(x, y, pb[2]), pb]
    elif not out or out[-1]["kind"] != "entry":
        z = geo.top_z if exit_ != "bottom" else 0.0
        x, y, _ = pts[-1]
        pts.append((x, y, z))
    return {"hops": out, "exit": exit_, "points": [[round(v) for v in p] for p in pts],
            "length_mm": round(_length(pts))}


def _unit_of(geo: Geo, z: float) -> int:
    u = round((z - RACK_PLINTH_MM) / U_PITCH_MM - 0.5 + geo.start)
    return max(geo.start, min(geo.top_unit, u))
