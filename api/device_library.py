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

Photos travel only when the exporter asks for them. ``images.front`` /
``images.rear`` is ``true``/``false`` (the type has that photo, not carried)
or ``{"mime", "filename", "data"}`` with the file as base64. Both shapes are
version 1: a 0.17 reader takes a carried photo for a referenced one.
"""
from __future__ import annotations

from typing import Any

BUNDLE_VERSION = 1
BUNDLE_KEY = "danbyte_device_type"

# Caps on carried photos, decoded. A whole bundle, base64 and all, has to fit
# the 10 MB request body (DATA_UPLOAD_MAX_MEMORY_SIZE); a stored photo is at
# most 2000 px on its long edge, which a JPEG or WebP fits in well under this.
PHOTO_MAX_BYTES = 3 * 1024 * 1024
BUNDLE_PHOTOS_MAX_BYTES = 6 * 1024 * 1024
# The formats a carried photo may be, as Pillow names them read from the
# bytes, with the MIME type the bundle states and the extension it is stored
# under. MPO is how Pillow reads many phone JPEGs.
PHOTO_FORMATS = {
    "JPEG": ("image/jpeg", ".jpg"),
    "MPO": ("image/jpeg", ".jpg"),
    "PNG": ("image/png", ".png"),
    "GIF": ("image/gif", ".gif"),
    "WEBP": ("image/webp", ".webp"),
}
PHOTO_SIDES = ("front", "rear")

# The physical spec of the type itself. Deliberately excludes ids, tenant,
# owning_site, timestamps and device_count - all local facts.
# `name` is the identity (DeviceType has no slug); `model` is a separate
# free-text field the catalog also carries.
TYPE_FIELDS = (
    "name", "model", "part_number", "u_height", "rack_width", "is_full_depth",
    "airflow", "weight", "weight_unit", "subdevice_role",
    "exclude_from_utilization", "width_mm", "height_mm", "depth_mm",
    "din_profiles", "din_rail_mm", "description",
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
    ("antennas", "antenna_templates",
     ("name", "description", "antenna_type", "gain_dbi", "bands",
      "polarization", "connector", "direct_mount")),
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


def _photo_format(raw: bytes) -> str | None:
    """The format Pillow reads from ``raw`` when it is a whole, decodable photo
    of an allowed kind; else None. The bytes decide, never a name or a MIME
    type, and a decompression bomb counts as no photo."""
    import warnings
    from io import BytesIO

    from PIL import Image

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(raw)) as img:
                fmt = img.format
                if fmt not in PHOTO_FORMATS:
                    return None
                img.verify()
            # verify() checks structure only; decoding proves the pixels.
            with Image.open(BytesIO(raw)) as img:
                img.load()
    except Exception:  # noqa: BLE001 - anything Pillow refuses is no photo
        return None
    return fmt


def _embed_photo(field, budget: int) -> dict[str, str] | None:
    """A stored photo as a bundle entry, or None when there is none, it can't
    be read, it isn't an allowed format, or it exceeds a cap - the side then
    stays a plain reference."""
    import base64
    import os

    if not field or not field.name:
        return None
    try:
        with field.open("rb") as fh:
            raw = fh.read(PHOTO_MAX_BYTES + 1)
    except OSError:
        return None
    if len(raw) > min(PHOTO_MAX_BYTES, budget):
        return None
    fmt = _photo_format(raw)
    if fmt is None:
        return None
    return {
        "mime": PHOTO_FORMATS[fmt][0],
        "filename": os.path.basename(field.name),
        "data": base64.b64encode(raw).decode("ascii"),
    }


def export_bundle(device_type, *, include_photos: bool = False) -> dict[str, Any]:
    """Assemble a portable bundle for one configured device type.

    ``include_photos`` carries the front and rear photos as base64 where they
    fit the caps; a photo that does not stays ``true``, a reference."""
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
    # Images are referenced unless the exporter asks for them: a bundle without
    # them stays a small text file you can read and diff. The importer says
    # which are missing so the user can upload them - the marker coordinates
    # are useless without the photo they were placed on.
    out["images"] = {
        side: bool(getattr(device_type, f"{side}_image")) for side in PHOTO_SIDES
    }
    if include_photos:
        budget = BUNDLE_PHOTOS_MAX_BYTES
        for side in PHOTO_SIDES:
            entry = _embed_photo(getattr(device_type, f"{side}_image"), budget)
            if entry:
                out["images"][side] = entry
                budget -= len(entry["data"]) * 3 // 4
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
    if payload.get("image_ports") is not None:
        # The same check the type form makes: markers, view and calibration.
        from rest_framework.exceptions import ValidationError

        from .face_ports import validate_image_ports_doc

        try:
            validate_image_ports_doc(payload["image_ports"])
        except ValidationError as exc:
            raise BundleError(
                "The bundle's photo ports: " + " ".join(str(d) for d in exc.detail)
            ) from None


def _carried_photos(payload: dict, type_name: str) -> dict[str, tuple[bytes, str]]:
    """The photos the bundle carries, decoded and checked: ``{side: (bytes,
    filename)}``. A side that is ``true``/``false`` or absent carries none. A
    carried photo that is not valid base64, exceeds a cap, is not an allowed
    image when its bytes are read, or whose bytes disagree with its stated
    MIME type refuses the bundle, naming it."""
    import base64
    import binascii
    import os

    from django.utils.text import get_valid_filename, slugify

    imgs = payload.get("images")
    if imgs is None:
        return {}
    if not isinstance(imgs, dict):
        raise BundleError("`images` must be an object.")
    photos: dict[str, tuple[bytes, str]] = {}
    total = 0
    for side in PHOTO_SIDES:
        entry = imgs.get(side)
        if entry is None or isinstance(entry, bool):
            continue
        what = f"The {side} photo"
        if not isinstance(entry, dict) or not isinstance(entry.get("data"), str):
            raise BundleError(f"{what} needs its file as base64 in `data`.")
        data = entry["data"]
        # Refuse an oversized photo before decoding it.
        if len(data) > (PHOTO_MAX_BYTES + 2) // 3 * 4 + 4:
            raise BundleError(
                f"{what} is over the {PHOTO_MAX_BYTES // (1024 * 1024)} MB a "
                "bundle photo may be."
            )
        try:
            raw = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError):
            raise BundleError(f"{what} isn't valid base64.") from None
        if len(raw) > PHOTO_MAX_BYTES:
            raise BundleError(
                f"{what} is over the {PHOTO_MAX_BYTES // (1024 * 1024)} MB a "
                "bundle photo may be."
            )
        total += len(raw)
        if total > BUNDLE_PHOTOS_MAX_BYTES:
            raise BundleError(
                f"The bundle's photos are over the "
                f"{BUNDLE_PHOTOS_MAX_BYTES // (1024 * 1024)} MB a bundle may carry."
            )
        fmt = _photo_format(raw)
        if fmt is None:
            raise BundleError(
                f"{what} isn't a JPEG, PNG, GIF or WebP image Danbyte can read."
            )
        mime, ext = PHOTO_FORMATS[fmt]
        stated = str(entry.get("mime") or "").strip().lower()
        if stated == "image/jpg":
            stated = "image/jpeg"
        if stated != mime:
            raise BundleError(
                f"{what} says {stated or 'no type'} but its data is {mime}."
            )
        stem = os.path.splitext(os.path.basename(str(entry.get("filename") or "")))[0]
        try:
            stem = get_valid_filename(stem)[:80]
        except Exception:  # noqa: BLE001 - nothing usable left of the name
            stem = ""
        stem = stem or f"{slugify(type_name)[:60] or 'device-type'}-{side}"
        photos[side] = (raw, stem + ext)
    return photos


def _check_type_fields(payload: dict, existing) -> None:
    """The bundle's device-type fields under the device type API's own rules
    (``DeviceTypeSerializer``): sizes in range, the DIN rail on the body, a
    body size for DIN-rail types, choices, the faceplate - and, replacing a
    type, that its devices on rails survive the new width (#311). A file that
    breaks one is refused with the field errors the API gives the same edit
    (a ``ValidationError``, a 400)."""
    from .serializers import DeviceTypeSerializer

    data = {f: payload[f] for f in TYPE_FIELDS if f != "name" and payload.get(f) is not None}
    if "din_profiles" in data:
        # Profiles this build doesn't know are dropped, not refused (the
        # write below keeps only the known ones).
        raw = data["din_profiles"]
        data["din_profiles"] = [
            p for p in ("ts35", "ts15", "g32") if isinstance(raw, list) and p in raw
        ]
    for f in ("faceplate", "image_ports"):
        if payload.get(f):
            data[f] = payload[f]
    serializer = DeviceTypeSerializer(instance=existing, data=data, partial=True)
    serializer.is_valid(raise_exception=True)


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
        "images": [],
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
    _check_type_fields(payload, existing)
    photos = _carried_photos(payload, name)
    report["images"] = list(photos)

    # The bundle says whether it was built against a front/rear photo. Marker
    # coordinates are meaningless without one, so say so rather than importing
    # markers that can't be seen.
    imgs = payload.get("images") or {}
    for side in PHOTO_SIDES:
        if side not in photos and imgs.get(side) and not (
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
        # Each value as its field holds it: JSON carries a width as a float,
        # which the rail checks add to Decimal offsets (#289), and a value
        # that is no number is refused rather than saved.
        for f, value in list(fields.items()):
            fields[f] = DeviceType._meta.get_field(f).to_python(value)
        fields["manufacturer"] = manufacturer
        if "din_profiles" in fields:
            # Only the profiles there are, as the type form allows.
            raw = fields["din_profiles"]
            fields["din_profiles"] = [
                p for p in ("ts35", "ts15", "g32") if isinstance(raw, list) and p in raw
            ]
        if payload.get("faceplate"):
            fields["faceplate"] = payload["faceplate"]
        if payload.get("image_ports"):
            fields["image_ports"] = payload["image_ports"]
        if existing:
            # Devices of the type already on DIN rails must survive it (#277).
            from .din import check_type_change

            check_type_change(
                existing,
                fields.get("width_mm", existing.width_mm),
                fields.get("din_profiles", existing.din_profiles),
            )
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
        if photos:
            _store_photos(dt, photos, keep_calibration=bool(payload.get("image_ports")))
    return report


def _store_photos(dt, photos: dict, *, keep_calibration: bool) -> None:
    """Store carried photos as the images endpoint stores an upload: the same
    downscale and metadata strip, animation kept. Written last, so a row the
    import refuses earlier leaves no file behind. The bundle's own photo ports
    were placed on these photos and keep their calibration; without them, a
    replaced photo's old calibration goes, as on an upload."""
    from django.core.files.base import ContentFile

    from .face_ports import drop_calibration
    from .images import downscale_image

    for side, (raw, filename) in photos.items():
        setattr(dt, f"{side}_image", downscale_image(ContentFile(raw, name=filename)))
        if not keep_calibration:
            dt.image_ports = drop_calibration(dt.image_ports, side)
    dt.save()


def _clean_row(obj, where: str, name: str) -> None:
    """A component template or sensor row under its model's field rules -
    lengths, choices, number ranges - before it is written, as the API checks
    the same row (#311). A bad row is a 400 naming it, and the import's
    transaction writes nothing."""
    from django.core.exceptions import ValidationError as DjangoValidationError
    from rest_framework.exceptions import ValidationError

    try:
        obj.full_clean(validate_unique=False, validate_constraints=False)
    except DjangoValidationError as exc:
        problems = [
            " ".join(msgs) if field == "__all__" else f"{field}: {' '.join(msgs)}"
            for field, msgs in exc.message_dict.items()
        ]
        raise ValidationError({where: [f"{name}: {'; '.join(problems)}"]}) from None


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
            obj = model(device_type=dt, **kwargs)
            _clean_row(obj, f"components.{key}", row["name"])
            obj.save()
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
            _clean_row(existing, "sensors", slug)
            existing.save()
            report["sensors"]["updated"] += 1
        else:
            sensor = SnmpSensor(tenant=tenant, slug=slug, **fields)
            _clean_row(sensor, "sensors", slug)
            sensor.save()
            report["sensors"]["created"] += 1
