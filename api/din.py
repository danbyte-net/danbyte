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
                f"Runs past the plate's right edge ({width:g} mm)."
            )
        top, bottom = band(r)
        if top < 0:
            err.setdefault("y_mm", []).append("Sticks out above the plate.")
        elif bottom > height:
            err.setdefault("y_mm", []).append(
                f"Sticks out below the plate ({height:g} mm)."
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
            f"{rail['x_mm']:g}, {rail['y_mm']:g} mm, {rail['length_mm']:g} mm long")


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
    * ``rails`` - ``{"add": [...], "update": [...], "extra": [...]}`` by
      label: *add* = template rails the cabinet lacks; *update* = a rail with
      a template's label that sits elsewhere or has another profile; *extra* =
      the cabinet's rails no template names. A sync never removes an extra.

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
    update = []
    for label in sorted(set(want) & set(have)):
        changes = {
            f: {"cabinet": getattr(have[label], f), "type": getattr(want[label], f)}
            for f in RAIL_FIELDS[1:]
            if getattr(have[label], f) != getattr(want[label], f)
        }
        if changes:
            update.append({"label": label, "changes": changes})
    extra = sorted(set(have) - set(want))
    out: dict = {}
    if sizes:
        out["sizes"] = sizes
    if add or update or extra:
        out["rails"] = {"add": add, "update": update, "extra": extra}
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
    result = list(current)
    if rails:
        by_label = {r["label"]: r for r in result}
        for t in ct.rail_templates.all():
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
