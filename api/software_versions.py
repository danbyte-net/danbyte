"""The running software version of a device or VM (#451): where it came
from, how it is read out of SNMP ``sysDescr``, and the one rule every
automatic writer follows.

Sources (``software_version_source``):

``manual``          typed by a person (form, API, planned change);
``import``          set by a file import;
``snmp``            read from ``sysDescr`` when SNMP facts are collected;
``virtualization``  reported by a hypervisor sync;
``oxidized``        read from a configuration backup held by Oxidized.

A manual or imported value is the operator's and is never overwritten. An
automatic source may replace a blank value or one an automatic source wrote
(``software_version_seen_at`` set); ``seen_at`` is when an automatic source
last set the value. Between automatic sources the value read last wins, with
two exceptions: a value another automatic source already holds is left as it
is (no source ping-pong), and a less specific value never replaces a more
specific one it is a prefix of (a config's ``version 17.9`` keeps SNMP's
``17.9.4a``).

``extract(text, pattern)`` reads a version: the platform's own pattern
first, then the built-in extractors for Cisco IOS, IOS-XE, NX-OS, Juniper
Junos and Arista EOS. A Linux kernel line yields nothing: the kernel is not
the platform's version. ``extract_config(text, pattern)`` reads one out of
the head of a configuration (the pattern first, then config statements and
the ``show version`` comments Oxidized puts on top).
"""
from __future__ import annotations

import re

from django.core.exceptions import ValidationError

#: How much of ``sysDescr`` a pattern reads.
MAX_TEXT = 512
MAX_VERSION = 64

#: Sources a person owns: no automatic writer replaces them.
OWNED_SOURCES = frozenset({"manual", "import"})
AUTOMATIC_SOURCES = frozenset({"snmp", "virtualization", "oxidized"})

_V = r"([0-9][0-9A-Za-z.()\-]*)"

#: ``(scheme, marker, version)`` in the order tried. ``marker`` has to be in
#: the text for ``version`` to be read; both are case-insensitive.
EXTRACTORS: tuple[tuple[str, re.Pattern, re.Pattern], ...] = (
    ("cisco_nxos", re.compile(r"\bNX-OS\b", re.I),
     re.compile(r"\bVersion\s+" + _V, re.I)),
    ("cisco_iosxe",
     re.compile(r"\bIOS[ _-]?XE\b|\bCisco IOS Software \[[^\]]+\]", re.I),
     re.compile(r"\bVersion\s+" + _V, re.I)),
    ("cisco_ios",
     re.compile(r"\bCisco\b.*\bIOS\b|Internetwork Operating System", re.I | re.S),
     re.compile(r"\bVersion\s+" + _V, re.I)),
    ("junos", re.compile(r"\bJUNOS\b", re.I),
     re.compile(r"\bJUNOS(?:\s+Software\s+Release)?\s+\[?" + _V, re.I)),
    ("arista_eos", re.compile(r"\bArista\b", re.I),
     re.compile(r"\bEOS\s+version\s+" + _V, re.I)),
)


def _clean(raw: str) -> str:
    return raw.strip().rstrip(".-,;")[:MAX_VERSION]


def compile_pattern(pattern: str) -> re.Pattern | None:
    """The compiled platform pattern, or None when blank or broken."""
    if not pattern:
        return None
    try:
        rx = re.compile(pattern)
    except re.error:
        return None
    if "version" not in rx.groupindex and rx.groups != 1:
        return None
    return rx


def validate_version_pattern(value: str) -> None:
    """A platform's pattern compiles and captures one version: a group named
    ``version``, or exactly one capture group."""
    if not value:
        return
    try:
        rx = re.compile(value)
    except re.error as exc:
        raise ValidationError(f"Not a valid regular expression: {exc}.") from None
    if "version" not in rx.groupindex and rx.groups != 1:
        raise ValidationError(
            "Needs one capture group, or a group named version."
        )


def extract(text: str | None, pattern: str = "") -> tuple[str, str] | None:
    """``(version, scheme)`` read from ``text`` (``sysDescr``), else None.
    ``scheme`` is ``custom`` when the platform's pattern matched."""
    text = (text or "")[:MAX_TEXT]
    if not text.strip():
        return None
    rx = compile_pattern(pattern)
    if rx is not None:
        m = rx.search(text)
        if m:
            raw = m.group("version") if "version" in rx.groupindex else m.group(1)
            version = _clean(raw or "")
            if version:
                return version, "custom"
    for scheme, marker, version_rx in EXTRACTORS:
        if not marker.search(text):
            continue
        m = version_rx.search(text)
        if m:
            version = _clean(m.group(1))
            if version:
                return version, scheme
    return None


# ─── Configurations (Oxidized) ─────────────────────────────────────────────

#: How much of a configuration is read: the version is stated at the top.
CONFIG_LINES = 200
CONFIG_MAX_CHARS = 32_768

_CV = r"([0-9][0-9A-Za-z.()\-]*)"
#: Without parentheses: EOS and Junos never use them, and the EOS one sits
#: inside ``(…, EOS-4.31.2F)``.
_CVP = r"([0-9][0-9A-Za-z.\-]*)"

#: ``(scheme, regex)`` over the config head, in the order tried. Oxidized
#: puts ``show version`` on top as comments (``!`` or ``#``).
CONFIG_EXTRACTORS: tuple[tuple[str, re.Pattern], ...] = (
    # NX-OS: ``! NXOS: version 10.3(4)`` (or the older ``system: version``),
    # then the running config's own ``version 10.3(4) Bios:version 05.47``.
    ("cisco_nxos", re.compile(r"^[!#\s]*(?:NXOS|system):\s+version\s+" + _CV, re.I | re.M)),
    ("cisco_nxos", re.compile(r"^version\s+(\d+\.\d+\([^)\s]+\)[0-9A-Za-z.()]*)", re.M)),
    # EOS: ``! device: leaf1 (DCS-7050SX3-48YC8, EOS-4.31.2F)``, or the
    # ``Software image version: 4.31.2F`` comment.
    ("arista_eos", re.compile(r"^!\s*device:.*\bEOS-" + _CVP, re.I | re.M)),
    ("arista_eos", re.compile(r"^!\s*Software image version:\s+" + _CVP, re.I | re.M)),
    # Junos: ``version 22.4R3-S2;`` or the ``# Junos: 22.4R3-S2.11`` comment.
    ("junos", re.compile(r"^#\s*Junos:\s+" + _CVP, re.I | re.M)),
    ("junos", re.compile(r"^\s*version\s+(\d[0-9A-Za-z.\-]*)\s*;", re.M)),
)
#: IOS and IOS-XE state only major.minor in the config (``version 17.9``).
_IOS_STATEMENT = re.compile(r"^version\s+(\d+\.\d+)\s*$", re.M)
#: Oxidized's own summary of ``show version``:
#: ``! Image: Software: CAT9K_IOSXE, 17.9.4a, RELEASE SOFTWARE (fc3)``.
_IOS_IMAGE = re.compile(r"^!\s*Image:[^\n]*?Software:\s*[^,\n]+,\s*" + _CV, re.I | re.M)
_IOSXE_MARK = re.compile(r"IOS[ _-]?XE\b|\bCisco IOS Software \[[^\]]+\]", re.I)
_COMMENT = re.compile(r"^\s*[!#]")


def _config_head(text: str) -> str:
    return "\n".join(text[:CONFIG_MAX_CHARS].splitlines()[:CONFIG_LINES])


def extract_config(text: str | None, pattern: str = "") -> tuple[str, str] | None:
    """``(version, scheme)`` read from a configuration, else None.

    Order: the platform's pattern; the NX-OS, EOS and Junos statements and
    comments; a Cisco IOS / IOS-XE ``show version`` comment, then Oxidized's
    ``Image: Software:`` line (the full version); the IOS ``version 17.9``
    statement (major.minor only)."""
    head = _config_head(text or "")
    if not head.strip():
        return None
    rx = compile_pattern(pattern)
    if rx is not None:
        m = rx.search(head)
        if m:
            raw = m.group("version") if "version" in rx.groupindex else m.group(1)
            version = _clean(raw or "")
            if version:
                return version, "custom"
    for scheme, version_rx in CONFIG_EXTRACTORS:
        m = version_rx.search(head)
        if m:
            version = _clean(m.group(1))
            if version:
                return version, scheme
    lines = head.splitlines()
    for line in lines:
        if not _COMMENT.match(line):
            continue
        got = extract(_COMMENT.sub("", line, count=1))
        if got and got[1] in ("cisco_ios", "cisco_iosxe"):
            return got
    scheme = "cisco_iosxe" if _IOSXE_MARK.search(head) else "cisco_ios"
    m = _IOS_IMAGE.search(head)
    if m and _clean(m.group(1)):
        return _clean(m.group(1)), scheme
    m = _IOS_STATEMENT.search(head)
    if m:
        return m.group(1), scheme
    return None


def owned_by_person(obj) -> bool:
    """A value a person typed or imported: no automatic writer touches it."""
    if not obj.software_version:
        return False
    return (
        obj.software_version_seen_at is None
        or obj.software_version_source in OWNED_SOURCES
    )


_PARTS = re.compile(r"\d+|[a-z]+")


def _parts(version: str) -> list:
    return [int(t) if t.isdigit() else t for t in _PARTS.findall(version.lower())]


def less_specific(general: str, specific: str) -> bool:
    """``general`` names fewer parts of the same version as ``specific``:
    ``17.9`` against ``17.9.4a`` or ``17.09.04a``, ``15.2`` against
    ``15.2(7)E8``."""
    a, b = _parts(general), _parts(specific)
    return bool(a) and len(a) < len(b) and b[: len(a)] == a


def record(obj, version: str | None, source: str, now=None) -> list[str]:
    """The single automatic writer: put ``version`` from ``source`` on a
    device or VM unless a person owns the current value. Returns the changed
    field names (the caller saves); an empty list when nothing changed."""
    from django.utils import timezone

    if source not in AUTOMATIC_SOURCES:
        raise ValueError(source)
    version = _clean(version or "")
    if not version or owned_by_person(obj):
        return []
    current, held_by = obj.software_version, obj.software_version_source
    if current and obj.software_version_seen_at is not None and held_by in AUTOMATIC_SOURCES:
        if version == current:
            # Seen again, by this source or another automatic one: nothing
            # new, so no write and no source ping-pong between SNMP and
            # Oxidized.
            return []
        if held_by != source and less_specific(version, current):
            return []
    obj.software_version = version
    obj.software_version_seen_at = now or timezone.now()
    obj.software_version_source = source
    return ["software_version", "software_version_seen_at", "software_version_source"]


def mark_manual(attrs, instance, source: str = "manual") -> None:
    """A person setting the version through the API makes it theirs: the
    integration stamp goes, so no sync overwrites it, and the source says
    who set it. A cleared version clears the source."""
    if "software_version" not in attrs:
        return
    version = attrs["software_version"] or ""
    if instance is not None and version == instance.software_version:
        return
    attrs["software_version_seen_at"] = None
    attrs["software_version_source"] = source if version else ""


# ─── Versions summary (Lifecycle → Versions) ───────────────────────────────

_TOKEN = re.compile(r"(\d+)")


def version_sort_key(version: str):
    """Natural order: 17.9.4 < 17.9.4a < 17.10.1; blank last."""
    if not version:
        return (1, ())
    parts = []
    for tok in _TOKEN.split(version.lower()):
        if not tok:
            continue
        parts.append((0, int(tok), "") if tok.isdigit() else (1, 0, tok))
    return (0, tuple(parts))


# ─── List filters ──────────────────────────────────────────────────────────

SOURCE_FILTER_VALUES = ("manual", "snmp", "virtualization", "oxidized", "import", "none")


def apply_list_filters(qs, request):
    """``?software_version=<exact>`` and ``?software_version_source=<source>``
    (``none`` for no source) on a device or VM list; an unknown source is a
    400."""
    if request is None:
        return qs
    params = request.query_params
    version = params.get("software_version")
    if version:
        qs = qs.filter(software_version=version)
    source = params.get("software_version_source")
    if source:
        if source not in SOURCE_FILTER_VALUES:
            from rest_framework.exceptions import ValidationError as DrfValidationError

            raise DrfValidationError(
                {"software_version_source": f"One of {', '.join(SOURCE_FILTER_VALUES)}."}
            )
        qs = qs.filter(software_version_source="" if source == "none" else source)
    return qs


# ─── SNMP: reading the version out of stored facts ─────────────────────────


def platform_pattern(obj) -> str:
    """The version pattern of the platform the object's version is judged
    against: a device's own platform, else its type's; a VM's own."""
    from .software_target import platform_of

    p = platform_of(obj)
    return (p.version_pattern if p else "") or ""


def apply_snmp_facts(obj, data: dict | None, now=None) -> list[str]:
    """Read the version out of ``data["sys_descr"]`` and record it from
    SNMP; saves and returns the changed fields. ``obj`` is reloaded, so a
    value a person typed since it was read is seen and kept."""
    return _apply(obj, lambda pattern: extract((data or {}).get("sys_descr"), pattern),
                  "snmp", now)


def apply_config(obj, text: str | None, now=None) -> list[str]:
    """Read the version out of a configuration from Oxidized and record it
    with source ``oxidized``; saves and returns the changed fields."""
    return _apply(obj, lambda pattern: extract_config(text, pattern), "oxidized", now)


def _apply(obj, read, source: str, now=None) -> list[str]:
    if obj is None:
        return []
    model = type(obj)
    fresh = (
        model.objects.select_related(
            *(["platform", "device_type__platform"] if model._meta.model_name == "device"
              else ["platform"])
        )
        .filter(pk=obj.pk)
        .first()
    )
    if fresh is None:
        return []
    got = read(platform_pattern(fresh))
    if got is None:
        return []
    changed = record(fresh, got[0], source, now)
    if changed:
        fresh.save(update_fields=[*changed, "updated_at"])
        for name in changed:
            setattr(obj, name, getattr(fresh, name))
    return changed


SOURCES_REREAD = ("snmp", "oxidized")


def reextract(tenant_id=None, platform_id=None, sources=SOURCES_REREAD) -> int:
    """Read the version again (all, one tenant's, or the objects on one
    platform): from every stored set of SNMP facts, and from the current
    configuration of every confirmed Oxidized link (fetched from Oxidized).
    Returns the objects changed. Re-reads scope itself: only facts and links
    whose object is still in the same tenant count."""
    n = 0
    if "snmp" in sources:
        n += _reextract_snmp(tenant_id, platform_id)
    if "oxidized" in sources:
        from oxidized.versions import reextract_configs

        n += reextract_configs(tenant_id=tenant_id, platform_id=platform_id)
    return n


def _reextract_snmp(tenant_id=None, platform_id=None) -> int:
    from django.db.models import F, Q

    from monitoring.models import DeviceSnmp

    qs = DeviceSnmp.objects.filter(
        Q(device__tenant_id=F("tenant_id")) | Q(vm__tenant_id=F("tenant_id"))
    ).select_related("device", "vm")
    if tenant_id:
        qs = qs.filter(tenant_id=tenant_id)
    if platform_id:
        qs = qs.filter(
            Q(device__platform_id=platform_id)
            | Q(device__platform__isnull=True, device__device_type__platform_id=platform_id)
            | Q(vm__platform_id=platform_id)
        )
    n = 0
    for state in qs.iterator(chunk_size=500):
        obj = state.device or state.vm
        if obj is None or not (state.data or {}).get("sys_descr"):
            continue
        if apply_snmp_facts(obj, state.data):
            n += 1
    return n


def run_reextract(tenant_id=None, platform_id=None, sources=SOURCES_REREAD) -> int:
    """RQ entry point for :func:`reextract`."""
    return reextract(tenant_id=tenant_id, platform_id=platform_id, sources=tuple(sources))


def enqueue_reextract(platform) -> None:
    """Queue a re-read for a platform's objects once the transaction
    commits; inline when the queue is down."""
    import logging

    from django.db import transaction

    tenant_id, platform_id = str(platform.tenant_id), str(platform.pk)

    def push():
        try:
            import django_rq

            django_rq.get_queue("low").enqueue(
                run_reextract, tenant_id, platform_id, job_timeout=1800
            )
        except Exception:  # noqa: BLE001 - Redis down
            logging.getLogger("api.software_versions").warning(
                "RQ unavailable; re-reading SNMP versions for platform %s inline", platform_id
            )
            # Inline, only what is stored here: no Oxidized fetches in a request.
            reextract(tenant_id=tenant_id, platform_id=platform_id, sources=("snmp",))

    transaction.on_commit(push)
