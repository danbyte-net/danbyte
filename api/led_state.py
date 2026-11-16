"""Status LEDs on 3D models and their generated faces (docs/dcim/model-packs.md).

A model names its lights ``led:<id>`` (``led:port:<interface>`` for a port
LED). The type's ``model_leds`` binds each id - exactly, or by a glob such as
``port:*`` - to a source::

    {"SYS":    {"source": "device.status"},
     "BEACON": {"source": "device.locate"},
     "PSU":    {"source": "modules.status", "bays": ["PS-*"]},
     "FAIL":   {"source": "module.status", "only": ["red"]},
     "port:*": {"source": "interface.oper_status"}}

``LedStates`` turns the bindings into what each light shows now, for many
devices at once, with a constant number of queries:

* ``device.status`` - is the device up. Monitoring decides, by the rule
  root-cause alerting uses (``monitoring.root_cause.deciding_ips``: the
  primary IP's checks, else every assigned IP's): down → red, failing inside
  its fall or degraded → blinking amber, up → green, only stale checks → off.
  The lifecycle status gates it: a status that means "not built or not in
  service" (planned, or one coloured grey) is off whatever the checks say;
  an unmonitored device shows its lifecycle colour only when that is amber
  or red - green means Danbyte has seen it up.
* ``module.status`` - the module's lifecycle status colour (its device's
  when it has none).
* ``modules.status`` with ``bays`` (globs) - the worst status among the
  modules installed in matching bays: the chassis' front PSU and FAN LEDs.
* ``interface.oper_status`` on ``port:<name>`` - the interface's ifOperStatus
  from the device's last SNMP poll: up → green, testing → amber, anything
  else (down, admin down, disabled, a stale poll) → off. A device SNMP
  doesn't poll at all shows what Danbyte records instead: green for an
  enabled port that is cabled or marked connected, else off. The name is
  matched as a port anchor's is (api.anchor_names): on stack member 2 a
  model's ``port:Gi1/0/1`` is the member's ``Gi2/0/1``.
* ``device.locate`` - the locate beacon (``Device.locate_until``): blinking
  blue while it is on.
* ``none`` - a light Danbyte does not drive; always off.

A lifecycle status reads as a colour from its own swatch (the catalog's
data, never its name): green, amber or red by hue; a grey or unparseable
swatch, or a status flagged ``is_planned`` / ``excludes_capacity``, is off.

States are ``green``, ``amber``, ``red``, ``blue``, ``off`` and ``neutral``,
with ``_blink`` appended to a blinking one. ``off`` is never sent: a light
the payload doesn't name is dark. ``neutral`` (a dim white) is what a reader
gets for a source they may not see - monitoring without view on the
deciding IP addresses, a port without interface view, modules without module
view - so a light never leaks a state.
"""
from __future__ import annotations

import colorsys
import fnmatch
import re
from datetime import timedelta

SOURCES = (
    "device.status", "device.locate", "module.status", "modules.status",
    "interface.oper_status", "none",
)
#: What a light can show; each but off/neutral may blink.
COLORS = ("green", "amber", "red", "blue")
STATES = (*COLORS, "off", "neutral")
#: Rank for "worst of": red beats amber beats green beats off.
_RANK = {"red": 3, "amber": 2, "green": 1, "off": 0}
#: Bindings one model may hold, and one key's length.
MAX_BINDINGS = 512
MAX_KEY = 128
MAX_BAY_GLOBS = 16
#: How long a locate beacon stays on, by default and at most (minutes).
LOCATE_MINUTES = 30
LOCATE_MAX_MINUTES = 480
#: An SNMP poll older than this many poll intervals is stale; with
#: scheduled polling off, older than STALE_SNMP_MANUAL_MINUTES.
STALE_SNMP_INTERVALS = 3
STALE_SNMP_MANUAL_MINUTES = 60
#: Devices one request may ask about.
MAX_DEVICES = 500

_HEX = re.compile(r"^#?([0-9a-fA-F]{6})$")


# ── bindings ────────────────────────────────────────────────────────────────

def _parse_one(key, spec) -> tuple[dict | None, str | None]:
    """One ``leds:`` entry, cleaned: ``(binding, None)`` or ``(None, error)``.
    ``source`` may carry the bay globs inline: ``"modules.status: PS-*"``."""
    if not isinstance(spec, dict):
        return None, "must be a mapping with a source"
    unknown = set(spec) - {"source", "bays", "only"}
    if unknown:
        return None, f"unknown keys {', '.join(sorted(map(str, unknown)))}"
    src = spec.get("source")
    if not isinstance(src, str):
        return None, f"unknown source {src!r}"
    src = src.strip()
    bays = spec.get("bays")
    if src.startswith("modules.status:"):
        if bays is not None:
            return None, "give the bays once, in source or in bays"
        bays = src.split(":", 1)[1].strip()
        src = "modules.status"
    if src not in SOURCES:
        return None, f"unknown source {src!r}"
    out: dict = {"source": src}
    if src == "modules.status":
        if isinstance(bays, str):
            bays = [bays]
        if not (isinstance(bays, list) and bays
                and all(isinstance(b, str) and b.strip() and len(b) <= MAX_KEY for b in bays)
                and len(bays) <= MAX_BAY_GLOBS):
            return None, "modules.status needs the bays it reads, e.g. “PS-*”"
        out["bays"] = [b.strip() for b in bays]
    elif bays is not None:
        return None, "bays applies to modules.status only"
    only = spec.get("only")
    if only is not None:
        if isinstance(only, str):
            only = [only]
        if not (isinstance(only, list) and only and all(o in COLORS for o in only)):
            return None, f"only takes colours from {', '.join(COLORS)}"
        out["only"] = list(dict.fromkeys(only))
    return out, None


def _clean_key(key) -> str | None:
    if not isinstance(key, str):
        return None
    k = key.strip()
    if k.startswith("led:"):
        k = k[4:]
    return k if k and len(k) <= MAX_KEY else None


def validate_bindings(raw) -> tuple[dict, list[str]]:
    """A ``leds:`` mapping cleaned: ``(bindings, notes)``. A bad entry is
    dropped with a note naming it, so one typo doesn't lose the rest."""
    notes: list[str] = []
    if raw in (None, ""):
        return {}, notes
    if not isinstance(raw, dict):
        return {}, ["leds: not a mapping - dropped."]
    out: dict = {}
    for key, spec in raw.items():
        k = _clean_key(key)
        if k is None:
            notes.append(f"leds.{key}: not an LED id - dropped.")
            continue
        clean, err = _parse_one(k, spec)
        if err:
            notes.append(f"leds.{k}: {err} - dropped.")
            continue
        if len(out) >= MAX_BINDINGS:
            notes.append(f"leds: more than {MAX_BINDINGS} entries - the rest dropped.")
            break
        out[k] = clean
    return out, notes


def validate_model_leds(value) -> None:
    """The ``model_leds`` field's validator: every entry must be a valid,
    already-clean binding."""
    from django.core.exceptions import ValidationError

    if value is None:
        return
    clean, notes = validate_bindings(value)
    if notes:
        raise ValidationError(notes)
    if clean != value:
        raise ValidationError("model_leds must hold cleaned bindings.")


def binding_for(bindings: dict | None, led_id: str) -> dict | None:
    """The binding of ``led_id``: its own key, else the first glob that
    matches it (in the order written)."""
    if not bindings:
        return None
    if led_id in bindings:
        return bindings[led_id]
    for key, spec in bindings.items():
        if any(c in key for c in "*?[") and fnmatch.fnmatchcase(led_id, key):
            return spec
    return None


# ── colours ─────────────────────────────────────────────────────────────────

def color_led(hex_color) -> str:
    """A swatch as a hardware light: green, amber or red by hue; grey,
    near-black, near-white, blue or unparseable is off."""
    m = _HEX.match(str(hex_color or "").strip())
    if not m:
        return "off"
    v = m.group(1)
    r, g, b = (int(v[i:i + 2], 16) / 255 for i in (0, 2, 4))
    h, lum, sat = colorsys.rgb_to_hls(r, g, b)
    if sat < 0.25 or lum < 0.12 or lum > 0.92:
        return "off"
    deg = h * 360
    if deg < 15 or deg >= 330:
        return "red"
    if deg < 70:
        return "amber"
    if deg < 175:
        return "green"
    return "off"


def status_led(status) -> str | None:
    """A lifecycle status as a light; None for no status."""
    if status is None:
        return None
    if getattr(status, "is_planned", False) or getattr(status, "excludes_capacity", False):
        return "off"
    return color_led(getattr(status, "color", ""))


def worst(states) -> str:
    best = "off"
    for s in states:
        if _RANK.get(s, 0) > _RANK[best]:
            best = s
    return best


def _filtered(state: str, spec: dict) -> str:
    only = spec.get("only")
    if not only or state in ("off", "neutral"):
        return state
    return state if state.split("_", 1)[0] in only else "off"


# ── per-source verdicts ─────────────────────────────────────────────────────

HIDDEN = "hidden"


def monitoring_verdict(rows) -> str:
    """``rows`` - (status, consecutive fails) of a device's deciding checks -
    as ``unmonitored`` / ``stale`` / ``down`` / ``warn`` / ``up``."""
    live = [(s, f) for s, f in rows if s not in ("unknown", "skipped", "stale")]
    if not live:
        return "stale" if any(s == "stale" for s, _f in rows) else "unmonitored"
    bad = any(s == "down" for s, _f in live)
    good = any(s in ("up", "degraded") for s, _f in live)
    if bad and not good:
        return "down"
    if any(f > 0 for _s, f in live) or any(s in ("degraded", "down") for s, _f in live):
        return "warn"
    return "up"


def device_status_led(lifecycle: str | None, verdict: str) -> str:
    """``device.status``: the lifecycle gate, then monitoring."""
    if lifecycle == "off":
        return "off"
    if verdict == HIDDEN:
        return "neutral"
    if verdict == "down":
        return "red"
    if verdict == "warn":
        return "amber_blink"
    if verdict == "up":
        return "green"
    if verdict == "stale":
        return "off"
    return lifecycle if lifecycle in ("amber", "red") else "off"


def port_led(observed: dict | None, enabled: bool = True,
             documented: bool | None = None) -> str:
    """``interface.oper_status`` from one observed ifTable row.

    ``documented`` is used only for a device SNMP doesn't poll at all (no
    snapshot): then the port is lit green when Danbyte records it as in use -
    enabled, and cabled or marked connected. A device whose poll went stale
    is not guessed for: its ports stay off."""
    if not enabled:
        return "off"
    if observed is None and documented is not None:
        return "green" if documented else "off"
    if not observed:
        return "off"
    if str(observed.get("admin_status") or "").lower() == "down":
        return "off"
    oper = str(observed.get("oper_status") or "").lower()
    if oper == "up":
        return "green"
    if oper == "testing":
        return "amber"
    return "off"


def locate_state(device, now) -> dict | None:
    """The beacon, while it is on: ``{until, at, by}``."""
    until = getattr(device, "locate_until", None)
    if until is None or until <= now:
        return None
    at = getattr(device, "locate_at", None)
    return {"until": until.isoformat(), "at": at.isoformat() if at else None,
            "by": getattr(device, "locate_by", "") or ""}


# ── the loader ──────────────────────────────────────────────────────────────

def _led_ids(anchors) -> list[str]:
    leds = (anchors or {}).get("leds")
    return [str(k) for k in leds] if isinstance(leds, dict) else []


def _sources(bindings) -> set[str]:
    return {b.get("source") for b in (bindings or {}).values() if isinstance(b, dict)}


class LedStates:
    """What every LED of ``devices`` shows for one reader. ``devices`` are
    the reader's (already scoped to the tenant and their device view)."""

    def __init__(self, user, tenant, *, now=None):
        from django.utils import timezone

        self.user, self.tenant = user, tenant
        self.now = now or timezone.now()
        self._super = bool(getattr(user, "is_superuser", False))

    # what the reader may see

    def _may(self, slug: str) -> bool:
        from auth_api import rbac

        return self._super or rbac.has_action(self.user, self.tenant, slug, "view")

    def _monitoring(self, device_ids) -> dict:
        """``{device id (str): verdict}`` - HIDDEN where the device has
        deciding addresses the reader may view none of."""
        from auth_api import rbac
        from monitoring.models import CheckState
        from monitoring.root_cause import deciding_ips

        from .models import IPAddress

        found, owner = deciding_ips(self.tenant.id, device_ids)
        out = {d: "unmonitored" for d in found}
        if not owner:
            return out
        visible = set(map(str, rbac.restrict_queryset(
            IPAddress.objects.filter(tenant=self.tenant, pk__in=list(owner)),
            self.user, self.tenant, "ipaddress", "view",
        ).values_list("pk", flat=True)))
        rows: dict = {}
        for ip, status, fails in CheckState.objects.filter(
            tenant=self.tenant, target_ip_id__in=list(visible)
        ).values_list("target_ip_id", "status", "consecutive_fail"):
            rows.setdefault(owner[str(ip)], []).append((status, fails or 0))
        has_ips: dict = {}
        for ip, dev in owner.items():
            has_ips.setdefault(dev, [False])[0] |= ip in visible
        for dev, (seen,) in has_ips.items():
            out[dev] = monitoring_verdict(rows.get(dev, [])) if seen else HIDDEN
        return out

    def _interfaces(self, device_ids) -> dict:
        """``{device id: {interface name: (visible, enabled, observed row,
        documented)}}``. ``documented`` is None for a device with an SNMP
        snapshot, else whether the port is cabled or marked connected."""
        from django.db.models import BooleanField, Case, Value, When

        from auth_api import rbac
        from monitoring.models import DeviceSnmp, MonitoringSettings
        from monitoring.snmp_drift import _intent_by_observed_name, _match_observed

        from .models import CableTermination, Interface

        q = True if self._super else rbac.row_filter(self.user, self.tenant, "interface", "view")
        qs = Interface.objects.filter(device__tenant=self.tenant, device_id__in=device_ids)
        if q is None:
            vis = Value(False, output_field=BooleanField())
        elif q is True:
            vis = Value(True, output_field=BooleanField())
        else:
            vis = Case(When(q, then=Value(True)), default=Value(False),
                       output_field=BooleanField())
        ifaces = list(qs.annotate(_vis=vis).only(
            "id", "device_id", "name", "snmp_name", "enabled", "mark_connected").order_by())
        cabled = set(CableTermination.objects.filter(
            interface_id__in=[i.id for i in ifaces]).values_list("interface_id", flat=True))
        minutes = (MonitoringSettings.objects.filter(tenant=self.tenant)
                   .values_list("snmp_poll_interval_minutes", flat=True).first()) or 0
        limit = self.now - timedelta(minutes=minutes * STALE_SNMP_INTERVALS
                                     if minutes else STALE_SNMP_MANUAL_MINUTES)
        snaps = {
            d: (rows, at) for d, rows, at in DeviceSnmp.objects.filter(
                tenant=self.tenant, device_id__in=device_ids
            ).values_list("device_id", "interfaces", "polled_at")
        }
        per: dict = {}
        for i in ifaces:
            per.setdefault(i.device_id, []).append(i)
        out: dict = {}
        for dev_id, items in per.items():
            observed: dict = {}
            rows, at = snaps.get(dev_id, (None, None))
            if rows and at is not None and at >= limit:
                by_name = _intent_by_observed_name(items)
                for o in rows:
                    if not isinstance(o, dict):
                        continue
                    iface = _match_observed(o, by_name)
                    if iface is not None and iface.id not in observed:
                        observed[iface.id] = o
            polled = dev_id in snaps
            out[str(dev_id)] = {
                i.name: (bool(i._vis), i.enabled, observed.get(i.id),
                         None if polled else (i.id in cabled or bool(i.mark_connected)))
                for i in items
            }
        return out

    # the states

    def payload(self, devices) -> dict:
        """``{device id: {leds, bays, locate, covers, bay_covers}}`` for
        ``devices``: ``covers`` / ``bay_covers`` the port covers to hide
        (api.port_covers)."""
        from .anchor_names import chassis_interface, module_interface
        from .model_3d import effective_owner, has_bays, installed_parts
        from .models import render_module_name
        from .port_covers import has_covers, hidden_covers

        devices = list(devices)
        owners = {d.id: effective_owner(d) for d in devices}
        lit = [d for d in devices
               if owners[d.id] is not None and _led_ids(owners[d.id].model_anchors)]
        lit_ids = {d.id for d in lit}
        # Parts for the lit devices and for any whose chassis or modules may
        # carry port covers (api.port_covers) - one batch either way.
        drawn = [d for d in devices if d.id in lit_ids or has_bays(owners[d.id])
                 or has_covers(d, owners[d.id])]
        installed_parts(drawn, self.user, self.tenant)
        covers = hidden_covers([d for d in drawn if has_covers(d, owners[d.id])],
                               owners, self.user, self.tenant)

        # Which sources are in play, so a scene without port LEDs costs no
        # interface query.
        wanted: set = set()
        for d in lit:
            wanted |= _sources(owners[d.id].model_leds)
            for row in d._installed_parts:
                mt = row["type"]
                if mt is not None and _led_ids(mt.model_anchors):
                    wanted |= _sources(mt.model_leds)
        ids = [d.id for d in lit]
        mon = self._monitoring(ids) if "device.status" in wanted else {}
        ports = self._interfaces(ids) if "interface.oper_status" in wanted else {}
        may_modules = (("module.status" in wanted or "modules.status" in wanted)
                       and self._may("module"))

        out: dict = {}
        for d in devices:
            entry: dict = {"leds": {}, "bays": {}, "locate": locate_state(d, self.now),
                           "covers": [], "bay_covers": {}}
            entry.update(covers.get(str(d.id), {}))
            out[str(d.id)] = entry
            owner = owners[d.id]
            if d.id not in lit_ids:
                continue
            key = str(d.id)
            life = status_led(d.status)
            dev_iface = ports.get(key, {})
            mods = {r["name"]: r for r in d._installed_parts}

            def module_led(row, *, _life=life):
                m = row.get("module") if row else None
                if m is None:
                    return "off"
                own = status_led(m.status)
                return own if own is not None else (_life or "off")

            def state(spec, led_id, module_row=None, iface=None, *, _d=d, _key=key,
                      _life=life, _ifaces=dev_iface, _mods=mods):
                src = spec.get("source")
                if src == "device.status":
                    return device_status_led(_life, mon.get(_key, "unmonitored"))
                if src == "device.locate":
                    return "blue_blink" if locate_state(_d, self.now) else "off"
                if src == "module.status":
                    if not may_modules:
                        return "neutral"
                    return module_led(module_row)
                if src == "modules.status":
                    if not may_modules:
                        return "neutral"
                    globs = spec.get("bays") or []
                    return worst(module_led(r) for name, r in _mods.items()
                                 if any(fnmatch.fnmatchcase(name, g) for g in globs))
                if src == "interface.oper_status":
                    if iface is None:
                        return "off"
                    hit = _ifaces.get(iface)
                    if hit is None:
                        return "off"
                    visible, enabled, observed, documented = hit
                    return port_led(observed, enabled, documented) if visible else "neutral"
                return "off"

            for led_id in _led_ids(owner.model_anchors):
                spec = binding_for(owner.model_leds, led_id)
                if spec is None:
                    continue
                # A stack member's own port (api.anchor_names): the model
                # is authored as member 1.
                iface = (chassis_interface(d, led_id[5:])
                         if led_id.startswith("port:") else None)
                s = _filtered(state(spec, led_id, None, iface), spec)
                if s != "off":
                    entry["leds"][led_id] = s
            for row in d._installed_parts:
                mt = row["type"]
                if mt is None or not _led_ids(mt.model_anchors):
                    continue
                bay: dict = {}
                for raw_id in _led_ids(mt.model_anchors):
                    spec = binding_for(mt.model_leds, raw_id)
                    if spec is None:
                        continue
                    led_id = render_module_name(raw_id, row["position"])
                    iface = (module_interface(d, mt, raw_id[5:], row["position"])
                             if raw_id.startswith("port:") else None)
                    s = _filtered(state(spec, led_id, row, iface), spec)
                    if s != "off":
                        bay[led_id] = s
                if bay:
                    entry["bays"][row["name"]] = bay
        return out


# ── the locate beacon ───────────────────────────────────────────────────────

def _username(user) -> str:
    if user is None:
        return ""
    try:
        return user.get_username()[:150]
    except Exception:  # noqa: BLE001 - an identity without a username
        return str(user)[:150]


def set_locate(device, on: bool, user, *, minutes: int = LOCATE_MINUTES,
               now=None) -> dict | None:
    """Switch ``device``'s beacon on (for ``minutes``; on again renews it) or
    off, with one change-log entry naming who and until when. Returns the
    beacon as ``locate_state`` reads it. Writes the three locate columns
    only: the device's ``updated_at`` and its save signals are untouched."""
    from django.db import transaction
    from django.utils import timezone

    from audit.bulk import _entry
    from audit.context import current_request_id, current_via
    from audit.models import ChangeAction
    from audit.signals import _ser

    from .models import Device

    now = now or timezone.now()
    minutes = max(1, min(int(minutes), LOCATE_MAX_MINUTES))
    fields = ("locate_until", "locate_at", "locate_by")
    with transaction.atomic():
        locked = Device.objects.select_for_update(of=("self",)).get(pk=device.pk)
        old = {f: getattr(locked, f) for f in fields}
        if on:
            new = {"locate_until": now + timedelta(minutes=minutes), "locate_at": now,
                   "locate_by": _username(user)}
        else:
            new = {"locate_until": None, "locate_at": None, "locate_by": ""}
        changes = {k: {"old": _ser(old[k]), "new": _ser(v)}
                   for k, v in new.items() if _ser(old[k]) != _ser(v)}
        if changes:
            Device.objects.filter(pk=device.pk).update(**new)
            entry = _entry(locked, ChangeAction.UPDATE, changes,
                           user if getattr(user, "pk", None) else None,
                           current_request_id())
            if not entry.user_name:
                entry.user_name = _username(user)
            entry.via = current_via() or "system"
            entry.save()
        for k, v in new.items():
            setattr(device, k, v)
    return locate_state(device, now)
