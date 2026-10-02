"""DIN rails on a cabinet's mounting plate (#277).

A rail is placed by its left end (``x_mm``) and its centreline (``y_mm``),
both measured from the plate's top-left corner, and by its length; its
profile sets the height of the band it takes on the plate. Tenths of a
millimetre.

Rails have no endpoint of their own: they are written as a whole set through
their cabinet (``rails``) or cabinet type (``rail_templates``), checked here
as a set, and recorded on the parent's change log.
"""
from __future__ import annotations

from decimal import Decimal

from rest_framework.exceptions import ValidationError

#: The band a rail of each profile takes on the plate, in mm.
PROFILE_HEIGHT_MM = {"ts35": Decimal(35), "ts15": Decimal(15), "g32": Decimal(32)}
PROFILE_LABELS = {"ts35": "TS 35", "ts15": "TS 15", "g32": "G 32"}
RAIL_FIELDS = ("label", "profile", "x_mm", "y_mm", "length_mm")


def mm(value) -> str:
    """A length as people write it: 90, 17.5 - no trailing zeros."""
    text = f"{Decimal(str(value)):f}"
    return text.rstrip("0").rstrip(".") if "." in text else text


def band(rail: dict) -> tuple[Decimal, Decimal]:
    """Top and bottom of the rail's band on the plate."""
    half = PROFILE_HEIGHT_MM[rail["profile"]] / 2
    return rail["y_mm"] - half, rail["y_mm"] + half


def span(rail: dict) -> tuple[Decimal, Decimal]:
    """Left and right end of the rail."""
    return rail["x_mm"], rail["x_mm"] + rail["length_mm"]


def _overlaps(a: tuple, b: tuple) -> bool:
    """Open intervals: rails that only touch do not overlap."""
    return a[0] < b[1] and b[0] < a[1]


def rail_errors(rails: list[dict], width, height) -> list[dict]:
    """Field errors per rail (``{}`` for a rail that is fine), in input order.

    Every rail lies on the plate, labels are unique, and no two rails' bands
    overlap where the rails run side by side."""
    width, height = Decimal(width), Decimal(height)
    errors: list[dict] = [{} for _ in rails]
    seen: set[str] = set()
    for i, r in enumerate(rails):
        err = errors[i]
        if r["label"] in seen:
            err.setdefault("label", []).append("Another rail has this label.")
        seen.add(r["label"])
        if span(r)[1] > width:
            err.setdefault("length_mm", []).append(
                f"Runs past the plate's right edge ({mm(width)} mm)."
            )
        top, bottom = band(r)
        if top < 0:
            err.setdefault("y_mm", []).append("Sticks out above the plate.")
        elif bottom > height:
            err.setdefault("y_mm", []).append(
                f"Sticks out below the plate ({mm(height)} mm)."
            )
        for o in rails[:i]:
            if _overlaps(span(r), span(o)) and _overlaps(band(r), band(o)):
                err.setdefault("y_mm", []).append(f"Overlaps rail {o['label']}.")
                break
    return errors


def as_dict(rail) -> dict:
    return {f: getattr(rail, f) for f in RAIL_FIELDS}


def summary(rail: dict) -> str:
    """One rail as one line of the change log."""
    return (f"{rail['label']}: {PROFILE_LABELS[rail['profile']]} at "
            f"{mm(rail['x_mm'])}, {mm(rail['y_mm'])} mm, {mm(rail['length_mm'])} mm long")


def summaries(rails) -> list[str]:
    return sorted(summary(r if isinstance(r, dict) else as_dict(r)) for r in rails)


def check_fit(rails: list[dict], width, height, *, field_for_axis: dict | None = None):
    """Refuse a set of rails that does not fit, as field errors.

    Rails the caller sent get their errors under ``rails`` (one entry per
    rail, as DRF reports a list). Rails already stored, or copied from a type,
    are not the caller's to fix: their errors land on the plate size that no
    longer fits them (``field_for_axis``: ``{"x": ..., "y": ...}``)."""
    errors = rail_errors(rails, width, height)
    if not any(errors):
        return
    if field_for_axis is None:
        raise ValidationError({"rails": errors})
    out: dict[str, list[str]] = {}
    for rail, err in zip(rails, errors, strict=True):
        for field, messages in err.items():
            key = field_for_axis["x" if field == "length_mm" else "y"]
            out.setdefault(key, []).extend(f"Rail {rail['label']}: {m}" for m in messages)
    raise ValidationError(out)


def save_rails(rails_manager, items: list[dict]) -> None:
    """Make the parent's rails exactly ``items``: an item with the id of one
    of them updates it, any other item is a new rail, and the rest go."""
    existing = {r.id: r for r in rails_manager.all()}
    keep = {item["id"] for item in items if item.get("id") in existing}
    rails_manager.exclude(pk__in=keep).delete()
    updates = []
    for item in items:
        rail = existing.get(item.get("id"))
        values = {f: item[f] for f in RAIL_FIELDS}
        if rail is not None and any(getattr(rail, f) != v for f, v in values.items()):
            updates.append((rail, values))
    # A relabelled rail steps aside first, so two rails can swap labels.
    for rail, values in updates:
        if rail.label != values["label"]:
            rail.label = f"~{rail.id.hex[:31]}"
            rail.save(update_fields=["label"])
    for rail, values in updates:
        for f, v in values.items():
            setattr(rail, f, v)
        rail.save()
    for item in items:
        if item.get("id") not in existing:
            rails_manager.create(**{f: item[f] for f in RAIL_FIELDS})
    # The parent may hold its rails prefetched; they are stale now.
    cache = getattr(rails_manager.instance, "_prefetched_objects_cache", None)
    if cache:
        cache.pop(rails_manager.field.remote_field.get_accessor_name(), None)


# ── a cabinet against its type ───────────────────────────────────────────────

def diff_cabinet_from_type(cabinet) -> dict:
    """How a cabinet differs from its type, right now.

    * ``sizes`` - ``{field: {"cabinet": v, "type": v}}`` for each size that
      differs. Sizes are copied once and then edited, so drift is legitimate;
      this only reports it.
    * ``rails`` - ``{"add": [...], "update": [...], "blocked": [...],
      "extra": [...]}`` by label: *add* = template rails the cabinet lacks;
      *update* = a rail with a template's label that sits elsewhere or has
      another profile; *blocked* = such an update its devices would not
      survive, with the reason; *extra* = the cabinet's rails no template
      names. A sync never removes an extra and skips a blocked update.

    Empty when the cabinet has no type."""
    from .models import CABINET_SIZE_FIELDS

    ct = cabinet.cabinet_type
    if ct is None:
        return {}
    sizes = {
        f: {"cabinet": getattr(cabinet, f), "type": getattr(ct, f)}
        for f in CABINET_SIZE_FIELDS if getattr(cabinet, f) != getattr(ct, f)
    }
    have = {r.label: r for r in cabinet.rails.all()}
    want = {t.label: t for t in ct.rail_templates.all()}
    add = sorted(set(want) - set(have))
    update, blocked = [], []
    for label in sorted(set(want) & set(have)):
        changes = {
            f: {"cabinet": getattr(have[label], f), "type": getattr(want[label], f)}
            for f in RAIL_FIELDS[1:]
            if getattr(have[label], f) != getattr(want[label], f)
        }
        if not changes:
            continue
        try:
            check_rail_devices([{"id": have[label].id, **as_dict(want[label])}],
                               [have[label]])
        except ValidationError as exc:
            reasons = [m for err in exc.detail["rails"] for ms in err.values() for m in ms]
            blocked.append({"label": label, "changes": changes, "reason": " ".join(reasons)})
        else:
            update.append({"label": label, "changes": changes})
    extra = sorted(set(have) - set(want))
    out: dict = {}
    if sizes:
        out["sizes"] = sizes
    if add or update or blocked or extra:
        out["rails"] = {"add": add, "update": update, "blocked": blocked, "extra": extra}
    return out


def sync_cabinet_from_type(cabinet, *, sizes: bool = True, rails: bool = True) -> None:
    """Copy the type's sizes and add or move the rails its templates name.
    Never removes a rail. Refused as a whole when the result would not fit;
    the caller holds the transaction."""
    from audit.bulk import log_rail_change

    from .models import CABINET_SIZE_FIELDS

    ct = cabinet.cabinet_type
    if sizes:
        for f in CABINET_SIZE_FIELDS:
            setattr(cabinet, f, getattr(ct, f))
    current = [{"id": r.id, **as_dict(r)} for r in cabinet.rails.all()]
    result = [dict(r) for r in current]
    if rails:
        blocked = {
            b["label"] for b in diff_cabinet_from_type(cabinet).get("rails", {}).get("blocked", [])
        }
        by_label = {r["label"]: r for r in result}
        for t in ct.rail_templates.all():
            if t.label in blocked:
                continue
            values = as_dict(t)
            if t.label in by_label:
                by_label[t.label].update(values)
            else:
                result.append(values)
    try:
        check_fit(result, cabinet.inner_width_mm, cabinet.inner_height_mm)
    except ValidationError as exc:
        problems = [
            f"{rail['label']}: {message}"
            for rail, err in zip(result, exc.detail["rails"], strict=True)
            for messages in err.values() for message in messages
        ]
        raise ValidationError({"detail": "The type's rails do not fit this cabinet - "
                                         + "; ".join(problems)}) from None
    if sizes:
        cabinet.save()
    if rails:
        old = summaries(current)
        save_rails(cabinet.rails, result)
        log_rail_change(cabinet, old, summaries(cabinet.rails.all()))


# ── devices on rails ─────────────────────────────────────────────────────────
# A device sits on a rail at an offset from the rail's left end and takes its
# type's width; devices on one rail may touch but not overlap. Moving a rail
# moves its devices with it.

def _width(device) -> Decimal:
    dt = device.device_type
    return (dt.width_mm if dt is not None else None) or Decimal(0)


def spans(rail, *, exclude=None) -> list[tuple]:
    """``(device, start, end)`` for the devices on a rail, left to right."""
    qs = rail.devices.select_related("device_type").order_by("din_offset_mm")
    if exclude is not None:
        qs = qs.exclude(pk=exclude)
    return [(d, d.din_offset_mm, d.din_offset_mm + _width(d)) for d in qs]


def free_gaps(length, taken) -> list[tuple]:
    """The free stretches of a rail ``length`` mm long around ``taken`` spans."""
    gaps, at = [], Decimal(0)
    for start, end in sorted(taken):
        if start > at:
            gaps.append((at, start))
        at = max(at, end)
    if at < length:
        gaps.append((at, Decimal(length)))
    return gaps


def _lock(rail) -> None:
    """Placements on one rail queue up: two can't both take the same gap."""
    from django.db import connection

    if connection.in_atomic_block:
        type(rail).objects.select_for_update().filter(pk=rail.pk).exists()


def place(rail, device_type, offset, *, exclude=None) -> Decimal:
    """The offset a device of ``device_type`` takes on ``rail``: ``offset``
    when it fits there, refused when it does not; with no offset, the left
    end of the first gap it fits in."""
    profiles = (device_type.din_profiles or []) if device_type is not None else []
    if not profiles or device_type.width_mm is None:
        raise ValidationError({"din_rail_id": "Give the device a type that mounts on DIN rails."})
    if rail.profile not in profiles:
        raise ValidationError({"din_rail_id": f"{device_type.name} does not mount on a "
                                              f"{PROFILE_LABELS[rail.profile]} rail."})
    _lock(rail)
    width = device_type.width_mm
    taken = spans(rail, exclude=exclude)
    if offset is None:
        for start, end in free_gaps(rail.length_mm, [(s, e) for _, s, e in taken]):
            if end - start >= width:
                return start
        raise ValidationError({"din_rail_id": f"No gap on {rail.label} is {mm(width)} mm wide."})
    if offset + width > rail.length_mm:
        raise ValidationError({"din_offset_mm": f"Runs past the rail's end ({mm(rail.length_mm)} mm)."})
    for d, start, end in taken:
        if _overlaps((offset, offset + width), (start, end)):
            raise ValidationError({"din_offset_mm": f"Overlaps {d.name} at {mm(start)}-{mm(end)} mm."})
    return offset


def _names(devices) -> str:
    names = sorted(d.name for d in devices)
    return ", ".join(names[:3]) + (f" and {len(names) - 3} more" if len(names) > 3 else "")


def check_rail_devices(items: list[dict], stored) -> None:
    """Refuse a new set of a cabinet's rails that strands devices: a rail left
    out that still carries devices, or one kept but too short for them or of
    a profile they do not mount on."""
    by_id = {r.id: r for r in stored}
    kept = {item.get("id") for item in items}
    gone = []
    for r in stored:
        devices = list(r.devices.all()) if r.id not in kept else []
        if devices:
            n = len(devices)
            gone.append(f"{r.label} carries {n} device{'s' if n != 1 else ''} "
                        f"({_names(devices)}) - move them first.")
    if gone:
        raise ValidationError({"rails": gone})
    errors = [{} for _ in items]
    for i, item in enumerate(items):
        rail = by_id.get(item.get("id"))
        taken = spans(rail) if rail is not None else []
        if not taken:
            continue
        need = max(end for _, _, end in taken)
        if item["length_mm"] < need:
            errors[i]["length_mm"] = [f"Too short for its devices (needs {mm(need)} mm)."]
        misfit = [d for d, _, _ in taken
                  if item["profile"] not in (d.device_type.din_profiles or [])]
        if misfit:
            errors[i]["profile"] = [f"{_names(misfit)} cannot mount on a "
                                    f"{PROFILE_LABELS[item['profile']]} rail."]
    if any(errors):
        raise ValidationError({"rails": errors})


def check_type_change(device_type, width, profiles) -> None:
    """Refuse a change to a type's width or rail profiles that its devices
    on rails would not survive."""
    from .models import Device

    mounted = list(
        Device.objects.filter(device_type=device_type, din_rail__isnull=False)
        .select_related("din_rail__cabinet")
    )
    if not mounted:
        return
    wrong = [d for d in mounted if d.din_rail.profile not in (profiles or [])]
    if wrong:
        raise ValidationError({"din_profiles": [
            f"{_names(wrong)} {'is' if len(wrong) == 1 else 'are'} on rails of "
            f"another profile."
        ]})
    if width is None:
        raise ValidationError({"width_mm": ["Devices of this type are on rails."]})
    for d in mounted:
        rail, start = d.din_rail, d.din_offset_mm
        where = f"{rail.cabinet.name} {rail.label}"
        if start + width > rail.length_mm:
            raise ValidationError({"width_mm": [f"{d.name} would run past the end of {where}."]})
        for other, o_start, o_end in spans(rail, exclude=d.pk):
            o_end = o_start + width if other.device_type_id == device_type.pk else o_end
            if _overlaps((start, start + width), (o_start, o_end)):
                raise ValidationError({"width_mm": [
                    f"{d.name} would overlap {other.name} on {where}."
                ]})


# ── arranging a cabinet: many moves checked as one ──────────────────────────

MAX_PLACEMENTS = 500


def arrange(cabinet, placements) -> list:
    """Move devices already in ``cabinet`` onto its rails at once.

    ``placements`` is ``[{device_id, din_rail_id, din_offset_mm}]``; a null
    rail takes the device off its rail and leaves it in the cabinet. The
    arrangement is checked as a whole - every rail's devices, moved or not,
    fit and do not overlap - so devices can swap places in one save. All or
    nothing; the caller holds the transaction. Returns the moved devices."""
    import uuid

    from .models import Device

    def ident(value):
        try:
            return uuid.UUID(str(value))
        except (TypeError, ValueError):
            return None

    if not isinstance(placements, list) or not placements:
        raise ValidationError({"placements": ["A list of devices to place."]})
    if len(placements) > MAX_PLACEMENTS:
        raise ValidationError({"placements": [f"At most {MAX_PLACEMENTS} at a time."]})
    errors = [{} for _ in placements]
    rails = {r.id: r for r in cabinet.rails.select_for_update()}
    wanted, seen = [], set()
    for i, p in enumerate(placements):
        p = p if isinstance(p, dict) else {}
        device_id, rail_id = ident(p.get("device_id")), p.get("din_rail_id")
        if device_id is None:
            errors[i]["device_id"] = ["Not an id."]
        elif device_id in seen:
            errors[i]["device_id"] = ["This device is listed twice."]
        seen.add(device_id)
        rail = None
        if rail_id is not None:
            rail = rails.get(ident(rail_id))
            if rail is None:
                errors[i]["din_rail_id"] = ["Not one of this cabinet's rails."]
        offset = p.get("din_offset_mm")
        if rail is not None or rail_id is not None:
            try:
                offset = Decimal(str(offset)).quantize(Decimal("0.1"))
            except Exception:  # noqa: BLE001 - anything that is not a number
                offset = None
            if offset is None or not offset.is_finite() or offset < 0:
                errors[i]["din_offset_mm"] = ["A distance in mm from the rail's left end."]
        wanted.append((device_id, rail, offset))
    if any(errors):
        raise ValidationError({"placements": errors})

    devices = {
        d.pk: d for d in Device.objects.select_related("device_type")
        .filter(cabinet=cabinet, pk__in=[w[0] for w in wanted])
    }
    for i, (device_id, _rail, _offset) in enumerate(wanted):
        if device_id not in devices:
            errors[i]["device_id"] = ["Not a device in this cabinet."]
    if any(errors):
        raise ValidationError({"placements": errors})

    # The final arrangement: every device on the cabinet's rails, as moved.
    index = {device_id: i for i, (device_id, _r, _o) in enumerate(wanted)}
    final = {
        d.pk: (d, d.din_rail_id, d.din_offset_mm)
        for d in Device.objects.select_related("device_type")
        .filter(din_rail__cabinet=cabinet).exclude(pk__in=devices)
    }
    for device_id, rail, offset in wanted:
        final[device_id] = (devices[device_id], rail.pk if rail else None, offset)
    for rail in rails.values():
        on = sorted(
            ((d, offset) for d, rail_id, offset in final.values() if rail_id == rail.pk),
            key=lambda x: (x[1], str(x[0].pk)),
        )
        prev = None
        for d, offset in on:
            i = index.get(d.pk)
            dt = d.device_type
            if dt is None or not dt.din_profiles or dt.width_mm is None:
                if i is not None:
                    errors[i]["din_rail_id"] = ["Give the device a type that mounts on DIN rails."]
                continue
            if rail.profile not in dt.din_profiles:
                if i is not None:
                    errors[i]["din_rail_id"] = [f"{dt.name} does not mount on a "
                                                f"{PROFILE_LABELS[rail.profile]} rail."]
                continue
            end = offset + dt.width_mm
            if end > rail.length_mm and i is not None:
                errors[i]["din_offset_mm"] = [f"Runs past the rail's end ({mm(rail.length_mm)} mm)."]
            if prev is not None and offset < prev[2]:
                # The later of the two takes the error, else the moved one.
                blame = i if i is not None else index.get(prev[0].pk)
                other = prev[0] if blame == i else d
                start, stop = (prev[1], prev[2]) if blame == i else (offset, end)
                if blame is not None:
                    errors[blame].setdefault("din_offset_mm", []).append(
                        f"Overlaps {other.name} at {mm(start)}-{mm(stop)} mm.")
            if prev is None or end > prev[2]:
                prev = (d, offset, end)
    if any(errors):
        raise ValidationError({"placements": errors})

    moved = []
    for device_id, rail, offset in wanted:
        d = devices[device_id]
        if d.din_rail_id == (rail.pk if rail else None) and d.din_offset_mm == offset:
            continue
        d.din_rail, d.din_offset_mm = rail, (offset if rail else None)
        d.save(update_fields=["din_rail", "din_offset_mm", "updated_at"])
        moved.append(d)
    return moved
