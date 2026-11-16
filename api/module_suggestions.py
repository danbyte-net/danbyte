"""The module types suggested for a module bay.

A module bay template may name the part numbers of the module types known to
fit it (``ModuleBayTemplate.suggested_modules``, a pack's ``module-bays: -
modules: [...]``). A device's bay carries no copy: it has no link to its
template, and bays are stamped once and never refreshed, so a copy would go
stale on every device built before the list was set. The list is read through
the device's type instead - the template whose name renders to the bay's (as
``stamp_components`` named it) - so editing the type's bay reaches every
device of that type at once.

Part numbers compare trimmed and case-insensitively. Suggestions only order
the install picker and warn: installing anything else is still allowed.
"""
from __future__ import annotations

MAX_SUGGESTIONS = 100
MAX_PART_NUMBER = 128  # ModuleType.part_number


def clean(value) -> list[str]:
    """``value`` (a list of part numbers, or one comma-separated string) as
    stored: trimmed, blanks and repeats (case-insensitive) dropped, in order.
    Raises ValueError with a message for anything else."""
    if value is None:
        return []
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, (list, tuple)):
        raise ValueError("A list of part numbers.")
    out: list[str] = []
    seen: set[str] = set()
    for v in value:
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            v = str(v)
        if not isinstance(v, str):
            raise ValueError("Part numbers are text.")
        v = v.strip()
        if not v:
            continue
        if len(v) > MAX_PART_NUMBER:
            raise ValueError(f"“{v[:24]}…” is longer than {MAX_PART_NUMBER} characters.")
        if v.lower() in seen:
            continue
        seen.add(v.lower())
        out.append(v)
    if len(out) > MAX_SUGGESTIONS:
        raise ValueError(f"At most {MAX_SUGGESTIONS} part numbers.")
    return out


def for_bays(bays) -> dict:
    """``{bay id: [part numbers]}`` for ``bays`` (ModuleBay rows with their
    device loaded), one query per device type."""
    from .models import ModuleBayTemplate, render_component_name

    bays = list(bays)
    dt_ids = {b.device.device_type_id for b in bays if b.device.device_type_id}
    by_type: dict = {}
    if dt_ids:
        for dt_id, name, parts in (
            ModuleBayTemplate.objects.filter(device_type_id__in=dt_ids)
            .exclude(suggested_modules=[])
            .values_list("device_type_id", "name", "suggested_modules")
        ):
            by_type.setdefault(dt_id, []).append((name, parts))
    out = {}
    for b in bays:
        found: list[str] = []
        for name, parts in by_type.get(b.device.device_type_id, ()):
            if render_component_name(name, b.device.vc_position) == b.name:
                found = list(parts or [])
                break
        out[b.id] = found
    return out


def for_bay(bay) -> list[str]:
    return for_bays([bay]).get(bay.id, [])


def install_warning(bay, module_type) -> str | None:
    """A note when ``module_type`` is not among the bay's non-empty
    suggestions; None when it is, or when the bay suggests nothing."""
    parts = for_bay(bay)
    if not parts:
        return None
    pn = (module_type.part_number or "").strip().lower()
    if pn and pn in {p.lower() for p in parts}:
        return None
    return (f"{module_type.name} is not among the modules suggested for "
            f"{bay.name} ({', '.join(parts[:3])}{', …' if len(parts) > 3 else ''}).")
