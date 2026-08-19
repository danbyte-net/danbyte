"""Import device types from NetBox's community devicetype-library.

https://github.com/netbox-community/devicetype-library - public-domain YAML
definitions (one file per hardware model) that NetBox and its ecosystem share.
Danbyte's component templates use the same taxonomy slugs, so the mapping is
nearly 1:1:

    manufacturer            → Manufacturer (get_or_create by name)
    model / part_number     → DeviceType.name / .model + .part_number
    u_height                → DeviceType.u_height (ceil - we don't do 0.5U)
    interfaces              → InterfaceTemplate (type, mgmt_only, enabled)
    console-ports           → ConsolePortTemplate
    console-server-ports    → ConsoleServerPortTemplate
    power-ports             → PowerPortTemplate (maximum/allocated draw)
    power-outlets           → PowerOutletTemplate (feeds via power_port name)
    rear-ports              → RearPortTemplate (positions)
    front-ports             → FrontPortTemplate (rear_port name + position)

Module-type files (``module-types/<Manufacturer>/*.yaml`` - line cards whose
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
    AuxPortTemplate,  # noqa: F401 - future: library has no aux ports (yet)
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

# Fields in the YAML we deliberately don't map - reported per import.
# Device-type YAML keys we deliberately don't map - reported per import.
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

# Default repository for *re*-importing images (Danbyte's fork of the library -
# same layout, images under elevation-images/). The YAML importer above keeps
# pulling from netbox-community at the pinned ref, unchanged.
DEFAULT_REIMPORT_REPO = "https://github.com/danbyte-net/device-library"

# GitHub shorthand: a bare "owner/name".
_OWNER_NAME_RE = re.compile(r"^[\w.-]+/[\w.-]+$")
# A repository page URL with no /tree|/blob path: https://github.com/o/r[.git]
_GITHUB_REPO_RE = re.compile(r"^https://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$")

# github.com blob URLs → raw file URLs, so users can paste straight from the
# browser address bar.
_GITHUB_BLOB_RE = re.compile(
    r"^https://github\.com/([^/]+)/([^/]+)/blob/(.+)$"
)

# github.com *directory* URLs - a whole folder of YAML to expand.
#   https://github.com/<owner>/<repo>/(tree|blob)/<ref>/<path…>
# GitHub uses /tree/ for folders and /blob/ for files, but people paste either
# from the address bar, so accept both and decide by the path: a trailing
# segment with a file extension is a file, anything else is a folder.
_GITHUB_DIR_RE = re.compile(
    r"^https://github\.com/([^/]+)/([^/]+)/(?:tree|blob)/([^/]+)(?:/(.*))?$"
)


def is_github_dir(url: str) -> bool:
    m = _GITHUB_DIR_RE.match(url.strip())
    if not m:
        return False
    last = (m.group(4) or "").rstrip("/").rsplit("/", 1)[-1]
    return "." not in last  # no extension → a folder, not a file


def expand_github_dir(url: str, get, *, exts=(".yaml", ".yml")) -> list[str]:
    """Expand a github.com ``/tree/`` directory URL into raw URLs for every
    YAML file under it (recursively).

    Uses the Git *trees* API (one request lists the whole repo tree), then
    keeps blobs whose path sits under the requested sub-path. ``get`` is an
    SSRF-guarded fetcher (``core.ssrf.safe_get``) so the API host is validated
    like any other outbound call. Raises ``ValueError`` with a readable message
    on an unusable response."""
    from urllib.parse import quote, unquote

    m = _GITHUB_DIR_RE.match(url.strip())
    if not m:
        raise ValueError("Not a GitHub directory URL.")
    owner, repo, ref, path = m.group(1), m.group(2), m.group(3), (m.group(4) or "")
    # Address-bar URLs arrive percent-encoded ("Palo%20Alto%20Networks"), but
    # the trees API returns REAL names with spaces - compare like with like,
    # or a pasted manufacturer folder matches zero files and imports nothing.
    prefix = unquote(path).rstrip("/")
    api = (
        f"https://api.github.com/repos/{owner}/{repo}/git/trees/"
        f"{ref}?recursive=1"
    )
    resp = get(api, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if data.get("truncated"):
        # The tree API caps at ~100k entries; the library is well under, but be
        # explicit rather than silently import a partial set.
        raise ValueError(
            "GitHub returned a truncated tree - narrow to a sub-folder."
        )
    raw_base = f"https://raw.githubusercontent.com/{owner}/{repo}/{ref}/"
    out = []
    for node in data.get("tree", []):
        p = node.get("path", "")
        if node.get("type") != "blob" or not p.lower().endswith(exts):
            continue
        if prefix and not (p == prefix or p.startswith(prefix + "/")):
            continue
        # Real names → valid URL (spaces and friends percent-encoded).
        out.append(raw_base + quote(p))
    if not out:
        raise ValueError(
            f"No YAML files found under {prefix or 'the repository root'!r} - "
            "check the folder URL (the folder may be empty or renamed)."
        )
    return out

# Leading slot digit of a slash-numbered component name. Only 0 or 1 qualify -
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


def elevation_image_base(repo: str) -> str:
    """Normalise a repository reference to the https base URL under which
    elevation images live (``<base>/<Manufacturer>/<slug>.<face>.<png|jpg>``).

    Accepts what people actually paste:

    - plain ``owner/name`` GitHub shorthand,
    - a ``https://github.com/owner/name`` page URL, optionally with
      ``/tree/<ref>`` or ``/tree/<ref>/<path>`` (``/blob/`` too - address-bar
      paste), or
    - a full ``https://`` base (a raw.githubusercontent.com URL, or an
      internal mirror that serves the same layout).

    GitHub forms without an explicit ref use ``HEAD`` - the repository's
    default branch, whatever it's called - rather than guessing ``master`` vs
    ``main``. ``elevation-images`` is appended unless the given path already
    ends with it (the library keeps images there and forks keep the layout).
    Raises :class:`ValueError` for anything that isn't https; the fetch itself
    still goes through ``core.ssrf.safe_request`` like every outbound call.
    """
    from urllib.parse import urlparse

    ref = (repo or "").strip().rstrip("/")
    if not ref:
        raise ValueError("Provide a repository - owner/name or an https:// URL.")
    if _OWNER_NAME_RE.match(ref):
        return f"https://raw.githubusercontent.com/{ref}/HEAD/elevation-images"
    m = _GITHUB_REPO_RE.match(ref)
    if m:
        return (
            f"https://raw.githubusercontent.com/{m.group(1)}/{m.group(2)}/"
            "HEAD/elevation-images"
        )
    m = _GITHUB_DIR_RE.match(ref)
    if m:
        owner, name, gref = m.group(1), m.group(2), m.group(3)
        path = (m.group(4) or "").strip("/")
        base = f"https://raw.githubusercontent.com/{owner}/{name}/{gref}"
        if path and path != "elevation-images" and not path.endswith("/elevation-images"):
            path = f"{path}/elevation-images"
        return f"{base}/{path or 'elevation-images'}"
    parsed = urlparse(ref)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError(
            "Repository must be owner/name, a github.com URL, or an https:// "
            "base URL."
        )
    return ref if ref.endswith("/elevation-images") else f"{ref}/elevation-images"


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
    tenant, text: str, *, stack_positions: bool = False, owning_site=None,
    image_inventory: set[str] | None = None,
) -> dict:
    """Create a DeviceType (+ templates) from one devicetype-library YAML doc.

    Returns ``{"ok", "name", "created", "skipped", "error"}`` - ``created`` is
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
        skipped.append(f"airflow {airflow!r} not recognised - dropped")
        airflow = ""
    weight = data.get("weight")
    weight_unit = str(data.get("weight_unit") or "").strip()
    if weight is not None and weight_unit not in VALID_WEIGHT_UNITS:
        skipped.append(f"weight_unit {weight_unit!r} not recognised - weight dropped")
        weight, weight_unit = None, ""
    subdevice_role = str(data.get("subdevice_role") or "").strip()
    if subdevice_role and subdevice_role not in ("parent", "child"):
        skipped.append(f"subdevice_role {subdevice_role!r} not recognised - dropped")
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

    # Best-effort elevation images - the library stores them per manufacturer
    # + slug. Fetch failures degrade to a report note, never an error.
    slug = str(data.get("slug") or "").strip()
    for face in ("front", "rear"):
        if not data.get(f"{face}_image") or not slug:
            continue
        if _fetch_elevation_image(
            dt, manufacturer_name, slug, face, inventory=image_inventory
        ):
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
            f"{key}: {'%d entries ' % n if n else ''}not modelled in Danbyte - skipped"
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
    tenant, text: str, *, stack_positions: bool = False, owning_site=None,
    image_inventory: set[str] | None = None,
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
            tenant, text, stack_positions=stack_positions,
            owning_site=owning_site, image_inventory=image_inventory,
        ),
        "kind": "device-type",
    }


def import_moduletype_yaml(tenant, text: str, *, owning_site=None) -> dict:
    """Create a ModuleType (+ interface templates) from a module-types YAML
    doc. Port names keep their ``{module}`` token - it resolves to the bay
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

    # M1: module types carry interfaces only - report the rest.
    skipped = [
        f"{key}: not modelled on module types (M1) - skipped"
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


def _fetch_elevation_image(
    dt, manufacturer: str, slug: str, face: str, image_base: str = _IMAGE_BASE,
    inventory: set[str] | None = None,
) -> bool:
    """Try to download <slug>.<face>.png|jpg from the devicetype-library and
    attach it to the DeviceType. Returns True on success."""
    return (
        _pull_elevation_image(dt, manufacturer, slug, face, image_base, inventory)
        == "saved"
    )


def _pull_elevation_image(
    dt, manufacturer: str, slug: str, face: str, image_base: str,
    inventory: set[str] | None = None,
) -> str:
    """Download one face's image and attach it. ``"saved"`` on success,
    ``"not_found"`` when the repo simply doesn't have it, ``"fetch_failed"``
    when the network/SSRF layer refused - callers report the difference.

    The attach goes through ``FieldFile.save(..., save=True)`` → a plain model
    ``.save()``, so the audit change-log signal fires for the image change."""
    from urllib.parse import quote

    from django.core.files.base import ContentFile

    from core.ssrf import safe_get

    exts: tuple[str, ...] = ("png", "jpg")
    if inventory is not None:
        # One-shot repo listing: fetch the KNOWN extension directly, and skip
        # absent images without a single request - extension guessing was up
        # to 4 sequential round-trips per type on the bulk import path.
        exts = tuple(
            ext for ext in exts
            if f"{manufacturer}/{slug}.{face}.{ext}" in inventory
        )
        if not exts:
            return "not_found"
    for ext in exts:
        # Manufacturer dirs can contain spaces ("Palo Alto") - quote segments.
        url = f"{image_base}/{quote(manufacturer)}/{quote(slug)}.{face}.{ext}"
        try:
            resp = safe_get(url, timeout=5)
        except Exception:  # noqa: BLE001 - network is best-effort here
            return "fetch_failed"
        if resp.status_code == 200 and resp.content:
            field = dt.front_image if face == "front" else dt.rear_image
            field.save(f"{slug}.{face}.{ext}", ContentFile(resp.content), save=True)
            return "saved"
    return "not_found"


# ─── Re-importing images for EXISTING device types ──────────────────────────
# Recovery tool: the media folder was lost/corrupted (or types were created
# without images) while the DeviceType rows survived. Match each type against
# a devicetype-library-layout repo and re-download only the elevation images -
# no types are created or modified beyond the two image fields.

REIMPORT_FACES = ("front", "rear")

#: Types handled in one synchronous request; bigger catalogs go to the RQ run.
#: A type typically costs 2–4 probe requests (worst-case bounded by the
#: candidate cap below), so 50 types lands in the same outbound budget as the
#: YAML importer's 200-file sync cap.
REIMPORT_SYNC_CAP = 50

#: How many slug candidates to probe per type before declaring no_match.
_MAX_SLUG_CANDIDATES = 5

# The importer saves downloads as "<slug>.<face>.<ext>"; Django dedupes
# collisions to "<slug>.<face>_<rand>.<ext>". Either way the basename still
# carries the library slug - the strongest matching signal we have, since
# DeviceType doesn't persist the library slug itself.
_IMAGE_NAME_RE = re.compile(
    r"^(?P<slug>.+)\.(?:front|rear)(?:_\w+)?\.(?:png|jpe?g)$", re.IGNORECASE
)


#: Refusal shown when an airgapped deployment asks for a repo fetch. Kept in
#: one place so the endpoint and the background task word it identically.
AIRGAP_IMAGES_DETAIL = (
    "This deployment is airgapped (update checks are disabled), so images "
    "can't be re-downloaded from a repository. Recover offline instead: "
    "restore the media folder from a backup, or re-upload images on each "
    "device type - offline device-type bundles carry definitions but "
    "reference images rather than embed them."
)


def airgap_refusal() -> str | None:
    """The refusal message when this deployment is airgapped
    (``DeploymentSettings.disable_update_check`` - the same switch that stops
    release-repo checks), else ``None``. Checked BEFORE any outbound attempt
    so an airgapped install gets a clean error, not a hanging timeout."""
    from core.models import DeploymentSettings

    if DeploymentSettings.load().disable_update_check:
        return AIRGAP_IMAGES_DETAIL
    return None


def summarize_reimport(rows: list[dict]) -> dict:
    """Totals for a batch of :func:`reimport_images_for_type` rows."""
    totals = {
        "types": len(rows), "matched": 0, "no_match": 0,
        "skipped_has_images": 0, "fetch_failed": 0, "images_downloaded": 0,
    }
    for r in rows:
        totals[r["status"]] = totals.get(r["status"], 0) + 1
        totals["images_downloaded"] += r.get("downloaded", 0)
    return totals


def candidate_slugs(dt) -> list[str]:
    """Library slugs this type could be filed under, most-confident first.

    Order: slugs recovered from the stored image *filenames* (exactly what the
    original import wrote - they survive in the DB even when the files are
    gone), then derivations using the same ``django.utils.text.slugify`` the
    importer uses, following the library convention of vendor-prefixed slugs
    (``cisco-c9300-48p``) with unprefixed fallbacks."""
    out: list[str] = []

    def add(s: str) -> None:
        if s and s not in out:
            out.append(s)

    for field in (dt.front_image, dt.rear_image):
        name = (getattr(field, "name", "") or "").rsplit("/", 1)[-1]
        m = _IMAGE_NAME_RE.match(name)
        if m:
            add(m.group("slug"))
    mfr = dt.manufacturer.name if dt.manufacturer_id else ""
    for label in (dt.name, dt.part_number, dt.model):
        label = (label or "").strip()
        if not label:
            continue
        if mfr:
            add(slugify(f"{mfr} {label}"))
        add(slugify(label))
    return out[:_MAX_SLUG_CANDIDATES]


def _face_missing(dt, face: str) -> bool:
    """True when this face needs an image: the field is empty, OR the field
    holds a path whose file no longer exists in storage. The latter is the
    corrupt/lost-media case - the DB survived, the media folder didn't - and
    counts as a gap for fill-gaps-only reimports."""
    field = dt.front_image if face == "front" else dt.rear_image
    if not field or not field.name:
        return True
    try:
        return not field.storage.exists(field.name)
    except Exception:  # noqa: BLE001 - unreadable storage counts as missing
        return True


def repo_image_inventory(image_base: str) -> set[str] | None:
    """Every image path under the repo's elevation-images dir, fetched in TWO
    requests via GitHub's git-trees API - so matching a 1000-type catalog is
    in-memory set lookups instead of ~20 sequential HEAD probes per type
    (which is the difference between sub-second and the better part of an
    hour).

    Returns ``{"<Manufacturer>/<slug>.<face>.<ext>", ...}`` with REAL (un-URL-
    quoted) names, or ``None`` when the base isn't a GitHub raw URL or the
    listing fails (rate limit, private repo, network) - callers fall back to
    per-image probing, which stays correct for arbitrary https mirrors."""
    import json as _json

    from core.ssrf import safe_get

    m = re.match(
        r"^https://raw\.githubusercontent\.com/([^/]+)/([^/]+)/([^/]+)/(.+)$",
        image_base.rstrip("/"),
    )
    if not m:
        return None
    owner, repo, ref, subpath = m.groups()
    try:
        # Top-level tree (non-recursive) → the subtree's sha. Walk one level
        # per path segment so bases like danbyte/elevation-images work too.
        # Segments are unquoted first: a pasted URL carries %20 where the
        # tree API answers with real spaces.
        from urllib.parse import unquote as _unquote

        sha = ref
        for segment in _unquote(subpath).split("/"):
            top = safe_get(
                f"https://api.github.com/repos/{owner}/{repo}/git/trees/{sha}",
                timeout=15,
            )
            if top.status_code != 200:
                return None
            entry = next(
                (
                    e
                    for e in _json.loads(top.content).get("tree", [])
                    if e.get("path") == segment and e.get("type") == "tree"
                ),
                None,
            )
            if entry is None:
                return set()  # repo simply has no such dir - honest empty
            sha = entry["sha"]
        # The subtree, recursive: every image path in one response. The
        # elevation-images subtree is far below GitHub's truncation limits
        # even for the full community library.
        sub = safe_get(
            f"https://api.github.com/repos/{owner}/{repo}/git/trees/{sha}"
            "?recursive=1",
            timeout=30,
        )
        if sub.status_code != 200:
            return None
        body = _json.loads(sub.content)
        if body.get("truncated"):
            return None  # incomplete listing would fabricate no_match rows
        return {
            e["path"] for e in body.get("tree", []) if e.get("type") == "blob"
        }
    except Exception:  # noqa: BLE001 - any trouble → probe fallback
        return None


def _face_in_repo(
    manufacturer: str,
    slug: str,
    face: str,
    image_base: str,
    inventory: set[str] | None = None,
) -> str:
    """Does the repo have this face's image? ``"available"`` / ``"not_found"``
    / ``"fetch_failed"``. With an ``inventory`` (one-shot repo listing) this
    is a set lookup; without one it degrades to HEAD probes - existence only,
    no body."""
    from urllib.parse import quote

    from core.ssrf import safe_request

    if inventory is not None:
        for ext in ("png", "jpg"):
            if f"{manufacturer}/{slug}.{face}.{ext}" in inventory:
                return "available"
        return "not_found"
    for ext in ("png", "jpg"):
        url = f"{image_base}/{quote(manufacturer)}/{quote(slug)}.{face}.{ext}"
        try:
            resp = safe_request("HEAD", url, timeout=5)
        except Exception:  # noqa: BLE001 - SSRF refusal / network trouble
            return "fetch_failed"
        if resp.status_code == 200:
            return "available"
    return "not_found"


def reimport_images_for_type(dt, image_base: str, *, overwrite: bool = False,
                             apply: bool = False,
                             inventory: set[str] | None = None) -> dict:
    """Match one EXISTING DeviceType against a library-layout repo and, when
    ``apply``, re-download its elevation images.

    Returns ``{"id", "name", "manufacturer", "slug", "status", "faces",
    "downloaded"}``. ``status`` is ``matched`` (repo has images for it - on
    apply, see per-face detail), ``no_match``, ``skipped_has_images`` (both
    faces present *and their files exist on disk* - with ``overwrite`` off
    there is nothing to do, so the repo isn't even probed), or
    ``fetch_failed``. ``faces`` maps front/rear to ``kept`` / ``available`` /
    ``downloaded`` / ``not_found`` / ``fetch_failed``.

    Fill-gaps is the default: a face is written only when the field is empty
    or its file is missing from storage (``_face_missing``). ``overwrite``
    replaces intact images too. Network trouble on one face degrades to that
    face's ``fetch_failed`` - never an exception out of here."""
    faces: dict[str, str] = {}
    row = {
        "id": str(dt.id),
        "name": dt.name,
        "manufacturer": dt.manufacturer.name if dt.manufacturer_id else "",
        "slug": "",
        "status": "",
        "faces": faces,
        "downloaded": 0,
    }
    todo = [f for f in REIMPORT_FACES if overwrite or _face_missing(dt, f)]
    if not todo:
        row["status"] = "skipped_has_images"
        faces.update(dict.fromkeys(REIMPORT_FACES, "kept"))
        return row

    mfr = row["manufacturer"]
    candidates = candidate_slugs(dt)
    if not mfr or not candidates:
        # Library images live under a <Manufacturer>/ dir - nothing to probe.
        row["status"] = "no_match"
        return row

    # Resolve THE slug once: the library names both faces with the same slug,
    # so the first candidate with any face present wins. Memoised so the
    # per-face report below doesn't re-probe.
    probed: dict[tuple[str, str], str] = {}

    def probe(slug: str, face: str) -> str:
        key = (slug, face)
        if key not in probed:
            probed[key] = _face_in_repo(
                mfr, slug, face, image_base, inventory=inventory
            )
        return probed[key]

    slug = None
    for cand in candidates:
        statuses = []
        for face in REIMPORT_FACES:
            statuses.append(probe(cand, face))
            if statuses[-1] != "not_found":
                break
        if "fetch_failed" in statuses:
            # Can't tell match from no-match while the repo is unreachable.
            row["status"] = "fetch_failed"
            return row
        if "available" in statuses:
            slug = cand
            break
    if slug is None:
        row["status"] = "no_match"
        return row

    row["slug"] = slug
    row["status"] = "matched"
    for face in REIMPORT_FACES:
        if face not in todo:
            faces[face] = "kept"
        elif not apply:
            faces[face] = probe(slug, face)
        else:
            pulled = _pull_elevation_image(dt, mfr, slug, face, image_base)
            faces[face] = "downloaded" if pulled == "saved" else pulled
            if pulled == "saved":
                row["downloaded"] += 1
    return row


def _err(message: str, name: str = "") -> dict:
    return {
        "ok": False, "name": name, "id": None,
        "created": {}, "skipped": [], "error": message,
    }
