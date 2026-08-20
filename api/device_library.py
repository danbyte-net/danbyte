"""Portable device-type bundles - the shareable half of the device library.

Teaching Danbyte a piece of hardware is real work: stamp the component
templates, draw the faceplate, place the photo-port markers on the rear image,
find the vendor OID that reports drive health. All of it is knowledge about the
*model*, identical for everyone who owns that box. A bundle is that work in one
file, so the next person imports it instead of redoing it.

Design rules, in order of importance:

1. **No credentials, ever.** A bundle carries OIDs and value maps; sensors poll
   with the *importing* deployment's own SNMP profile. There is nothing secret
   to strip because nothing secret is referenced.
2. **Names, not ids.** UUIDs are per-deployment. Manufacturers, device types and
   inter-component references (an outlet's inlet, a front port's rear port) all
   travel as names and are re-resolved on the far side.
3. **The type's name is its identity.** Re-importing updates in place; nothing
   duplicates. (Sensors inside a bundle key off their own slug.)
4. **An imported sensor observes, it does not write.** ``apply_mode`` is forced
   to ``drift`` on import - see :func:`import_bundle`.
"""
from __future__ import annotations

from typing import Any

BUNDLE_VERSION = 1
BUNDLE_KEY = "danbyte_device_type"

# The physical spec of the type itself. Deliberately excludes ids, tenant,
# owning_site, timestamps and device_count - all local facts.
# `name` is the identity (DeviceType has no slug); `model` is a separate
# free-text field the catalog also carries.
TYPE_FIELDS = (
    "name", "model", "part_number", "u_height", "rack_width", "is_full_depth",
    "airflow", "weight", "weight_unit", "subdevice_role",
    "exclude_from_utilization", "description",
)

# Component templates: bundle key → (device-type relation, exported fields).
# Order matters on import - rear ports before front ports, power ports before
# outlets - because the second of each pair references the first BY NAME.
COMPONENT_SPECS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("interfaces", "interface_templates",
     ("name", "description", "type", "enabled", "poe_mode", "poe_type",
      "mgmt_only")),
    ("console_ports", "console_port_templates", ("name", "description", "type")),
    ("console_server_ports", "console_server_port_templates",
     ("name", "description", "type")),
    ("aux_ports", "aux_port_templates", ("name", "description", "type")),
    ("power_ports", "power_port_templates",
     ("name", "description", "type", "maximum_draw", "allocated_draw")),
    ("power_outlets", "power_outlet_templates",
     ("name", "description", "type", "feed_leg")),
    ("rear_ports", "rear_port_templates",
     ("name", "description", "type", "positions", "is_splitter")),
    ("front_ports", "front_port_templates",
     ("name", "description", "type", "rear_port_position", "positions")),
    ("module_bays", "module_bay_templates",
     ("name", "description", "position")),
    ("device_bays", "device_bay_templates", ("name", "description")),
    ("inventory_items", "inventory_item_templates",
     ("name", "description", "part_id", "kind", "media", "capacity_bytes",
      "speed")),
)

# Sensor definition fields - the same set the sensor pack exports, so the two
# formats stay interchangeable.
SENSOR_FIELDS = (
    "name", "slug", "description", "oid", "walk", "item_kind", "name_template",
    "value_map", "absent_status", "enabled",
)


def export_bundle(device_type) -> dict[str, Any]:
    """Assemble a portable bundle for one configured device type."""
    from monitoring.models import SnmpSensor

    out: dict[str, Any] = {
        BUNDLE_KEY: BUNDLE_VERSION,
        "manufacturer": (
            device_type.manufacturer.name if device_type.manufacturer_id else None
        ),
    }
    for f in TYPE_FIELDS:
        out[f] = getattr(device_type, f, None)

    components: dict[str, list[dict]] = {}
    for key, relation, fields in COMPONENT_SPECS:
        rows = []
        for c in getattr(device_type, relation).all():
            row = {f: getattr(c, f) for f in fields}
            # Cross-references by name: the far side has different ids.
            if key == "power_outlets":
                row["power_port"] = (
                    c.power_port_template.name if c.power_port_template_id else None
                )
            elif key == "front_ports":
                row["rear_port"] = c.rear_port_template.name
            elif key == "inventory_items":
                row["manufacturer"] = (
                    c.manufacturer.name if c.manufacturer_id else None
                )
            rows.append(row)
        if rows:
            components[key] = rows
    out["components"] = components

    # The Danbyte-specific layers - the whole point of the format.
    out["faceplate"] = device_type.faceplate
    out["image_ports"] = device_type.image_ports
    out["sensors"] = [
        {f: getattr(s, f) for f in SENSOR_FIELDS}
        for s in SnmpSensor.objects.filter(device_type=device_type).order_by("name")
    ]
    # Images are referenced, not embedded: a bundle stays a text file you can
    # read and diff. The importer says which are missing so the user can upload
    # them - the marker coordinates are useless without the photo they were
    # placed on.
    out["images"] = {
        "front": bool(device_type.front_image),
        "rear": bool(device_type.rear_image),
    }
    return out


class BundleError(ValueError):
    """The payload isn't a bundle this build can read."""


def _check_envelope(payload: Any) -> None:
    if not isinstance(payload, dict):
        raise BundleError("Expected a bundle object.")
    version = payload.get(BUNDLE_KEY)
    if version is None:
        raise BundleError(
            f"Not a device bundle - the '{BUNDLE_KEY}' key is missing."
        )
    if version != BUNDLE_VERSION:
        raise BundleError(
            f"Bundle version {version} isn't supported (this build reads "
            f"{BUNDLE_VERSION})."
        )
    if not str(payload.get("name") or "").strip():
        raise BundleError("A bundle needs a device-type name.")


def import_bundle(
    payload: Any, tenant, *, replace: bool = False, dry_run: bool = False,
    owning_site=None,
) -> dict[str, Any]:
    """Create or update a device type and everything the bundle carries.

    ``dry_run`` reports exactly what would happen and writes nothing - the
    default for the UI's first pass, because "import this stranger's file" should
    never be a blind action.

    ``replace`` is required to touch a device type that already exists here;
    without it an existing name is reported and skipped, so an import can't
    quietly rewrite a type someone tuned.

    Returns a report: what was created, what was skipped, and what couldn't be
    resolved. Nothing is silently dropped.
    """
    from django.db import transaction

    from monitoring.models import SnmpSensor

    from .models import DeviceType, Manufacturer

    _check_envelope(payload)
    name = str(payload["name"]).strip()
    report: dict[str, Any] = {
        "dry_run": dry_run,
        "device_type": name,
        "action": "create",
        "components": {},
        "sensors": {"created": 0, "updated": 0, "skipped": 0},
        "faceplate": bool(payload.get("faceplate")),
        "image_ports": bool(payload.get("image_ports")),
        "missing_images": [],
        "warnings": [],
    }

    existing = DeviceType.objects.filter(tenant=tenant, name=name).first()
    if existing and not replace:
        report["action"] = "skipped"
        report["warnings"].append(
            f"A device type named {name!r} already exists here. Re-run with "
            "replace to update it."
        )
        return report
    report["action"] = "update" if existing else "create"

    # The bundle says whether it was built against a front/rear photo. Marker
    # coordinates are meaningless without one, so say so rather than importing
    # markers that can't be seen.
    imgs = payload.get("images") or {}
    for side in ("front", "rear"):
        if imgs.get(side) and not (
            existing and getattr(existing, f"{side}_image", None)
        ):
            report["missing_images"].append(side)
    if report["missing_images"] and payload.get("image_ports"):
        report["warnings"].append(
            "Photo-port markers reference a "
            + "/".join(report["missing_images"])
            + " image this deployment doesn't have - upload it on the device "
            "type and the markers will line up."
        )

    comps = payload.get("components") or {}
    if not isinstance(comps, dict):
        raise BundleError("`components` must be an object.")
    for key, _relation, _fields in COMPONENT_SPECS:
        rows = comps.get(key) or []
        if not isinstance(rows, list):
            raise BundleError(f"`components.{key}` must be a list.")
        if rows:
            report["components"][key] = len(rows)
    sensors = payload.get("sensors") or []
    if not isinstance(sensors, list):
        raise BundleError("`sensors` must be a list.")

    if dry_run:
        report["sensors"]["created"] = len(sensors)
        return report

    with transaction.atomic():
        manufacturer = None
        mname = (payload.get("manufacturer") or "").strip()
        if mname:
            # Not a bare get_or_create: Manufacturer is unique on
            # (tenant, slug), so two new vendors would both claim the empty
            # slug and the second import would 500 (issue #56).
            from .devicetype_import import _get_or_create_manufacturer

            manufacturer = _get_or_create_manufacturer(
                tenant, mname, owning_site=owning_site
            )
        fields = {
            f: payload.get(f)
            for f in TYPE_FIELDS
            if f != "name" and payload.get(f) is not None
        }
        fields["manufacturer"] = manufacturer
        if payload.get("faceplate"):
            fields["faceplate"] = payload["faceplate"]
        if payload.get("image_ports"):
            fields["image_ports"] = payload["image_ports"]
        if existing:
            for k, v in fields.items():
                setattr(existing, k, v)
            existing.save()
            dt = existing
        else:
            if owning_site is not None:
                fields["owning_site"] = owning_site
            dt = DeviceType.objects.create(tenant=tenant, name=name, **fields)

        _import_components(dt, comps, report)
        _import_sensors(dt, tenant, sensors, report, replace=replace)
    return report


def _import_components(dt, comps: dict, report: dict) -> None:
    """Create the template rows, in COMPONENT_SPECS order so a row that
    references another (front→rear, outlet→inlet) finds it already made."""
    from .models import Manufacturer

    made: dict[str, dict[str, Any]] = {}
    for key, relation, fields in COMPONENT_SPECS:
        rows = comps.get(key) or []
        model = getattr(dt, relation).model
        have = set(getattr(dt, relation).values_list("name", flat=True))
        created = 0
        for row in rows:
            if not isinstance(row, dict) or not str(row.get("name") or "").strip():
                report["warnings"].append(f"{key}: a row without a name was skipped.")
                continue
            if row["name"] in have:
                continue
            kwargs = {
                f: row[f] for f in fields if f in row and row[f] is not None
            }
            if key == "power_outlets" and row.get("power_port"):
                inlet = made.get("power_ports", {}).get(row["power_port"]) or (
                    dt.power_port_templates.filter(name=row["power_port"]).first()
                )
                if inlet is None:
                    report["warnings"].append(
                        f"power_outlets: {row['name']} names inlet "
                        f"{row['power_port']!r}, which isn't in the bundle."
                    )
                kwargs["power_port_template"] = inlet
            elif key == "front_ports":
                rear = made.get("rear_ports", {}).get(row.get("rear_port")) or (
                    dt.rear_port_templates.filter(name=row.get("rear_port")).first()
                )
                if rear is None:
                    # A front port cannot exist without its rear port (non-null
                    # FK), so this row is dropped loudly rather than crashing.
                    report["warnings"].append(
                        f"front_ports: {row['name']} names rear port "
                        f"{row.get('rear_port')!r}, which isn't in the bundle - "
                        "skipped."
                    )
                    continue
                kwargs["rear_port_template"] = rear
            elif key == "inventory_items" and row.get("manufacturer"):
                from .devicetype_import import _get_or_create_manufacturer

                kwargs["manufacturer"] = _get_or_create_manufacturer(
                    dt.tenant, row["manufacturer"]
                )
            obj = model.objects.create(device_type=dt, **kwargs)
            made.setdefault(key, {})[obj.name] = obj
            created += 1
        if created:
            report["components"][key] = created
        elif key in report["components"]:
            report["components"][key] = 0
    return None


def _import_sensors(dt, tenant, sensors: list, report: dict, *, replace: bool) -> None:
    """Bind the bundle's sensors to this type.

    Forced to ``apply_mode=drift``: a bundle from someone else must never arrive
    with permission to overwrite a status a human here set. Danbyte is a source
    of truth with drift visualisation; the importer opts into ``auto`` locally if
    they want it.
    """
    from monitoring.models import SnmpSensor

    for row in sensors:
        if not isinstance(row, dict):
            report["warnings"].append("sensors: a non-object row was skipped.")
            continue
        slug = str(row.get("slug") or "").strip()
        if not slug:
            report["warnings"].append(
                f"sensors: {row.get('name')!r} has no slug - skipped."
            )
            continue
        fields = {f: row[f] for f in SENSOR_FIELDS if f in row and f != "slug"}
        fields["apply_mode"] = SnmpSensor.APPLY_DRIFT
        fields["device_type"] = dt
        existing = SnmpSensor.objects.filter(tenant=tenant, slug=slug).first()
        if existing and not replace:
            report["sensors"]["skipped"] += 1
            continue
        if existing:
            for k, v in fields.items():
                setattr(existing, k, v)
            existing.save()
            report["sensors"]["updated"] += 1
        else:
            SnmpSensor.objects.create(tenant=tenant, slug=slug, **fields)
            report["sensors"]["created"] += 1
