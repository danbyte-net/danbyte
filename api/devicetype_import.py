"""Import device types from NetBox's community devicetype-library.

https://github.com/netbox-community/devicetype-library — public-domain YAML
definitions (one file per hardware model) that NetBox and its ecosystem share.
Danbyte's component templates use the same taxonomy slugs, so the mapping is
nearly 1:1:

    manufacturer            → Manufacturer (get_or_create by name)
    model / part_number     → DeviceType.name / .model + .part_number
    u_height                → DeviceType.u_height (ceil — we don't do 0.5U)
    interfaces              → InterfaceTemplate (type, mgmt_only, enabled)
    console-ports           → ConsolePortTemplate
    console-server-ports    → ConsoleServerPortTemplate
    power-ports             → PowerPortTemplate (maximum/allocated draw)
    power-outlets           → PowerOutletTemplate (feeds via power_port name)
    rear-ports              → RearPortTemplate (positions)
    front-ports             → FrontPortTemplate (rear_port name + position)

Module-type files (``module-types/<Manufacturer>/*.yaml`` — line cards whose
port names carry ``{module}``) are auto-detected (no ``u_height``/``slug``)
and import as :class:`ModuleType` + interface templates. Everything Danbyte
doesn't model (device-bays, inventory-items) is *skipped and reported*, never
silently dropped.

The library's names are concrete (``GigabitEthernet1/0/1``) because NetBox has
no stack-position token. The optional ``stack_positions`` flag rewrites the
leading slot digit to Danbyte's ``{position}`` token (``1/…`` → ``{position}/…``,
Juniper-style ``0/…`` → ``{position:0}/…``) so one imported type serves every
member of a virtual chassis.
"""
from __future__ import annotations

import re

import yaml
from django.utils.text import slugify

from .models import (
    AuxPortTemplate,  # noqa: F401 — future: library has no aux ports (yet)
    ConsolePortTemplate,
    ConsoleServerPortTemplate,
    DeviceBayTemplate,
    DeviceType,
    InventoryItemTemplate,
    FrontPortTemplate,
    InterfaceTemplate,
    Manufacturer,
    ModuleBayTemplate,
    ModuleInterfaceTemplate,
    ModuleType,
    PowerOutletTemplate,
    PowerPortTemplate,
    RearPortTemplate,
)

# Fields in the YAML we deliberately don't map — reported per import.
# Device-type YAML keys we deliberately don't map — reported per import.
# ("modules" isn't part of the schema; kept defensively.)
UNSUPPORTED_KEYS = ["modules"]

VALID_AIRFLOW = {
    "front-to-rear", "rear-to-front", "left-to-right", "right-to-left",
    "passive", "mixed",
}
VALID_WEIGHT_UNITS = {"kg", "g", "lb", "oz"}

# The library keeps elevation images beside the YAML:
#   elevation-images/<Manufacturer>/<slug>.front.png|jpg
_IMAGE_BASE = (
    "https://raw.githubusercontent.com/netbox-community/devicetype-library/"
    "master/elevation-images"
)

# github.com blob URLs → raw file URLs, so users can paste straight from the
# browser address bar.
_GITHUB_BLOB_RE = re.compile(
    r"^https://github\.com/([^/]+)/([^/]+)/blob/(.+)$"
)

# Leading slot digit of a slash-numbered component name. Only 0 or 1 qualify —
# they're what standalone hardware ships as (Cisco counts from 1, Juniper 0).
_SLOT_RE = re.compile(r"^([A-Za-z\-]*)([01])(/)")


def to_raw_url(url: str) -> str:
    m = _GITHUB_BLOB_RE.match(url.strip())
    if m:
        return (
            f"https://raw.githubusercontent.com/{m.group(1)}/{m.group(2)}/"
            f"{m.group(3)}"
        )
    return url.strip()


def positionize(name: str) -> str:
    """``GigabitEthernet1/0/1`` → ``GigabitEthernet{position}/0/1``;
    ``xe-0/0/0`` → ``xe-{position:0}/0/0``. Names without a leading slot
    segment come back unchanged."""

    def _sub(m: re.Match) -> str:
        token = "{position}" if m.group(2) == "1" else "{position:0}"
        return f"{m.group(1)}{token}{m.group(3)}"

    return _SLOT_RE.sub(_sub, name, count=1)


def _get_or_create_manufacturer(tenant, name: str, owning_site=None):
    m = Manufacturer.objects.filter(tenant=tenant, name__iexact=name).first()
    if m is not None:
        return m
    base = slugify(name) or "manufacturer"
    slug, i = base, 2
    while Manufacturer.objects.filter(tenant=tenant, slug=slug).exists():
        slug, i = f"{base}-{i}", i + 1
    return Manufacturer.objects.create(
        tenant=tenant, name=name, slug=slug, owning_site=owning_site
    )


def import_devicetype_yaml(
    tenant, text: str, *, stack_positions: bool = False, owning_site=None
) -> dict:
    """Create a DeviceType (+ templates) from one devicetype-library YAML doc.

    Returns ``{"ok", "name", "created", "skipped", "error"}`` — ``created`` is
    a per-kind count dict, ``skipped`` a list of human-readable notes. Never
    raises for content problems; the caller shows the report.
    """
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        return _err(f"Not valid YAML: {exc}")
    if not isinstance(data, dict):
        return _err("Expected a YAML mapping (one devicetype-library file).")

    manufacturer_name = str(data.get("manufacturer") or "").strip()
    model = str(data.get("model") or "").strip()
    if not manufacturer_name or not model:
        return _err("The file needs at least `manufacturer` and `model`.")

    if DeviceType.objects.filter(tenant=tenant, name=model).exists():
        return _err(f"Device type “{model}” already exists.", name=model)

    manufacturer = _get_or_create_manufacturer(
        tenant, manufacturer_name, owning_site=owning_site
    )

    # NetBox allows 0 / 0.5 / 1.5 U; Danbyte stores whole units.
    skipped: list[str] = []
    try:
        raw_u = float(data.get("u_height", 1) or 0)
    except (TypeError, ValueError):
        raw_u = 1
    u_height = max(0, int(-(-raw_u // 1)))  # ceil
    if raw_u != u_height:
        skipped.append(f"u_height {raw_u} rounded up to {u_height}U")

    part_number = str(data.get("part_number") or "").strip()
    airflow = str(data.get("airflow") or "").strip()
    if airflow and airflow not in VALID_AIRFLOW:
        skipped.append(f"airflow {airflow!r} not recognised — dropped")
        airflow = ""
    weight = data.get("weight")
    weight_unit = str(data.get("weight_unit") or "").strip()
    if weight is not None and weight_unit not in VALID_WEIGHT_UNITS:
        skipped.append(f"weight_unit {weight_unit!r} not recognised — weight dropped")
        weight, weight_unit = None, ""
    subdevice_role = str(data.get("subdevice_role") or "").strip()
    if subdevice_role and subdevice_role not in ("parent", "child"):
        skipped.append(f"subdevice_role {subdevice_role!r} not recognised — dropped")
        subdevice_role = ""
    dt = DeviceType.objects.create(
        tenant=tenant,
        owning_site=owning_site,
        name=model,
        manufacturer=manufacturer,
        model=part_number or model,
        part_number=part_number,
        u_height=u_height,
        is_full_depth=bool(data.get("is_full_depth", True)),
        airflow=airflow,
        weight=weight,
        weight_unit=weight_unit if weight is not None else "",
        subdevice_role=subdevice_role,
        exclude_from_utilization=bool(data.get("exclude_from_utilization", False)),
        description=str(data.get("comments") or "").strip(),
    )

    # Best-effort elevation images — the library stores them per manufacturer
    # + slug. Fetch failures degrade to a report note, never an error.
    slug = str(data.get("slug") or "").strip()
    for face in ("front", "rear"):
        if not data.get(f"{face}_image") or not slug:
            continue
        if _fetch_elevation_image(dt, manufacturer_name, slug, face):
            skipped.append(f"{face}_image: downloaded from devicetype-library")
        else:
            skipped.append(f"{face}_image: not found in devicetype-library")

    maybe_pos = positionize if stack_positions else (lambda n: n)
    created: dict[str, int] = {}

    def rows(key: str) -> list[dict]:
        val = data.get(key)
        return [r for r in val if isinstance(r, dict)] if isinstance(val, list) else []

    def name_of(row: dict) -> str:
        return maybe_pos(str(row.get("name") or "").strip())

    made = [
        InterfaceTemplate(
            device_type=dt, name=name_of(r),
            type=str(r.get("type") or ""),
            poe_mode=str(r.get("poe_mode") or ""),
            poe_type=str(r.get("poe_type") or ""),
            enabled=bool(r.get("enabled", True)),
            mgmt_only=bool(r.get("mgmt_only", False)),
        )
        for r in rows("interfaces") if r.get("name")
    ]
    InterfaceTemplate.objects.bulk_create(made)
    created["interfaces"] = len(made)

    for key, model_cls in (
        ("console-ports", ConsolePortTemplate),
        ("console-server-ports", ConsoleServerPortTemplate),
    ):
        made = [
            model_cls(
                device_type=dt, name=name_of(r),
                type=str(r.get("type") or ""),
            )
            for r in rows(key) if r.get("name")
        ]
        model_cls.objects.bulk_create(made)
        created[key.replace("-", "_")] = len(made)

    made = [
        PowerPortTemplate(
            device_type=dt, name=name_of(r),
            type=str(r.get("type") or ""),
            maximum_draw=r.get("maximum_draw"),
            allocated_draw=r.get("allocated_draw"),
        )
        for r in rows("power-ports") if r.get("name")
    ]
    PowerPortTemplate.objects.bulk_create(made)
    created["power_ports"] = len(made)

    # Outlets reference their feeding inlet by (transformed) name.
    inlets = {p.name: p for p in dt.power_port_templates.all()}
    made = [
        PowerOutletTemplate(
            device_type=dt, name=name_of(r),
            type=str(r.get("type") or ""),
            power_port_template=inlets.get(maybe_pos(str(r.get("power_port") or ""))),
            feed_leg=str(r.get("feed_leg") or ""),
        )
        for r in rows("power-outlets") if r.get("name")
    ]
    PowerOutletTemplate.objects.bulk_create(made)
    created["power_outlets"] = len(made)

    made = [
        RearPortTemplate(
            device_type=dt, name=name_of(r),
            type=str(r.get("type") or ""),
            positions=int(r.get("positions") or 1),
            is_splitter=bool(r.get("is_splitter")),
        )
        for r in rows("rear-ports") if r.get("name")
    ]
    RearPortTemplate.objects.bulk_create(made)
    created["rear_ports"] = len(made)

    rears = {p.name: p for p in dt.rear_port_templates.all()}
    fronts = []
    for r in rows("front-ports"):
        if not r.get("name"):
            continue
        rear = rears.get(maybe_pos(str(r.get("rear_port") or "")))
        if rear is None:
            skipped.append(
                f"front port {r.get('name')}: unknown rear port "
                f"{r.get('rear_port')!r}"
            )
            continue
        fronts.append(FrontPortTemplate(
            device_type=dt, name=name_of(r),
            type=str(r.get("type") or ""),
            rear_port_template=rear,
            rear_port_position=int(r.get("rear_port_position") or 1),
        ))
    FrontPortTemplate.objects.bulk_create(fronts)
    created["front_ports"] = len(fronts)

    made = [
        ModuleBayTemplate(
            device_type=dt, name=name_of(r),
            position=str(r.get("position") or "").strip(),
        )
        for r in rows("module-bays") if r.get("name")
    ]
    ModuleBayTemplate.objects.bulk_create(made)
    created["module_bays"] = len(made)

    made = [
        DeviceBayTemplate(device_type=dt, name=name_of(r))
        for r in rows("device-bays") if r.get("name")
    ]
    DeviceBayTemplate.objects.bulk_create(made)
    created["device_bays"] = len(made)

    made = [
        InventoryItemTemplate(
            device_type=dt, name=name_of(r),
            manufacturer=(
                _get_or_create_manufacturer(tenant, str(r["manufacturer"]).strip())
                if r.get("manufacturer") else None
            ),
            part_id=str(r.get("part_id") or "").strip(),
        )
        for r in rows("inventory-items") if r.get("name")
    ]
    InventoryItemTemplate.objects.bulk_create(made)
    created["inventory_items"] = len(made)

    for key in UNSUPPORTED_KEYS:
        val = data.get(key)
        if val in (None, "", [], {}, False):
            continue
        n = len(val) if isinstance(val, list) else None
        skipped.append(
            f"{key}: {'%d entries ' % n if n else ''}not modelled in Danbyte — skipped"
        )

    return {
        "ok": True,
        "name": dt.name,
        "id": str(dt.id),
        "created": created,
        "skipped": skipped,
        "error": None,
    }


def import_yaml_auto(
    tenant, text: str, *, stack_positions: bool = False, owning_site=None
) -> dict:
    """Import one library YAML doc, auto-detecting its kind: device-type
    files carry ``u_height``/``slug``; module-type files don't. The result
    gains ``"kind"`` so the UI can label the report row."""
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        return {**_err(f"Not valid YAML: {exc}"), "kind": "device-type"}
    if isinstance(data, dict) and "u_height" not in data and "slug" not in data:
        return {
            **import_moduletype_yaml(tenant, text, owning_site=owning_site),
            "kind": "module-type",
        }
    return {
        **import_devicetype_yaml(
            tenant, text, stack_positions=stack_positions, owning_site=owning_site
        ),
        "kind": "device-type",
    }


def import_moduletype_yaml(tenant, text: str, *, owning_site=None) -> dict:
    """Create a ModuleType (+ interface templates) from a module-types YAML
    doc. Port names keep their ``{module}`` token — it resolves to the bay
    position at install time. Same report shape as the device-type importer."""
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        return _err(f"Not valid YAML: {exc}")
    if not isinstance(data, dict):
        return _err("Expected a YAML mapping (one module-types file).")

    manufacturer_name = str(data.get("manufacturer") or "").strip()
    model = str(data.get("model") or "").strip()
    if not manufacturer_name or not model:
        return _err("The file needs at least `manufacturer` and `model`.")
    if ModuleType.objects.filter(tenant=tenant, name=model).exists():
        return _err(f"Module type “{model}” already exists.", name=model)

    manufacturer = _get_or_create_manufacturer(
        tenant, manufacturer_name, owning_site=owning_site
    )

    mt = ModuleType.objects.create(
        tenant=tenant,
        name=model,
        manufacturer=manufacturer,
        part_number=str(data.get("part_number") or "").strip(),
        description=str(data.get("comments") or "").strip(),
    )

    ifaces = data.get("interfaces")
    ifaces = [r for r in ifaces if isinstance(r, dict)] if isinstance(ifaces, list) else []
    made = [
        ModuleInterfaceTemplate(
            module_type=mt,
            name=str(r.get("name") or "").strip(),
            type=str(r.get("type") or ""),
            enabled=bool(r.get("enabled", True)),
            mgmt_only=bool(r.get("mgmt_only", False)),
        )
        for r in ifaces if r.get("name")
    ]
    ModuleInterfaceTemplate.objects.bulk_create(made)

    # M1: module types carry interfaces only — report the rest.
    skipped = [
        f"{key}: not modelled on module types (M1) — skipped"
        for key in ("console-ports", "console-server-ports", "power-ports",
                    "power-outlets", "front-ports", "rear-ports",
                    "module-bays")
        if data.get(key)
    ]
    return {
        "ok": True,
        "name": mt.name,
        "id": str(mt.id),
        "created": {"interfaces": len(made)},
        "skipped": skipped,
        "error": None,
    }


def _fetch_elevation_image(dt, manufacturer: str, slug: str, face: str) -> bool:
    """Try to download <slug>.<face>.png|jpg from the devicetype-library and
    attach it to the DeviceType. Returns True on success."""
    from urllib.parse import quote

    from django.core.files.base import ContentFile

    from core.ssrf import safe_get

    for ext in ("png", "jpg"):
        # Manufacturer dirs can contain spaces ("Palo Alto") — quote segments.
        url = f"{_IMAGE_BASE}/{quote(manufacturer)}/{quote(slug)}.{face}.{ext}"
        try:
            resp = safe_get(url, timeout=5)
        except Exception:  # noqa: BLE001 — network is best-effort here
            return False
        if resp.status_code == 200 and resp.content:
            field = dt.front_image if face == "front" else dt.rear_image
            field.save(f"{slug}.{face}.{ext}", ContentFile(resp.content), save=True)
            return True
    return False


def _err(message: str, name: str = "") -> dict:
    return {
        "ok": False, "name": name, "id": None,
        "created": {}, "skipped": [], "error": message,
    }
