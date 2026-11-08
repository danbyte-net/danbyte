"""The running software version of a device or VM (#451): where it came
from, how it is read out of SNMP ``sysDescr``, and the one rule every
automatic writer follows.

Sources (``software_version_source``):

``manual``          typed by a person (form, API, planned change);
``import``          set by a file import;
``snmp``            read from ``sysDescr`` when SNMP facts are collected;
``virtualization``  reported by a hypervisor sync;
``oxidized``        read from a stored configuration.

A manual or imported value is the operator's and is never overwritten. An
automatic source may replace a blank value or one an automatic source wrote
(``software_version_seen_at`` set); ``seen_at`` is when an automatic source
last set the value.

``extract(text, pattern)`` reads a version: the platform's own pattern
first, then the built-in extractors for Cisco IOS, IOS-XE, NX-OS, Juniper
Junos and Arista EOS. A Linux kernel line yields nothing: the kernel is not
the platform's version.
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


def owned_by_person(obj) -> bool:
    """A value a person typed or imported: no automatic writer touches it."""
    if not obj.software_version:
        return False
    return (
        obj.software_version_seen_at is None
        or obj.software_version_source in OWNED_SOURCES
    )


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
    if (
        version == obj.software_version
        and obj.software_version_source == source
        and obj.software_version_seen_at is not None
    ):
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
    got = extract((data or {}).get("sys_descr"), platform_pattern(fresh))
    if got is None:
        return []
    changed = record(fresh, got[0], "snmp", now)
    if changed:
        fresh.save(update_fields=[*changed, "updated_at"])
        for name in changed:
            setattr(obj, name, getattr(fresh, name))
    return changed


def reextract(tenant_id=None, platform_id=None) -> int:
    """Read the version again from every stored set of SNMP facts (all, one
    tenant's, or the objects on one platform). Returns the objects changed.
    Re-reads scope itself: only facts whose object is still in the same
    tenant count."""
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


def run_reextract(tenant_id=None, platform_id=None) -> int:
    """RQ entry point for :func:`reextract`."""
    return reextract(tenant_id=tenant_id, platform_id=platform_id)


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
                "RQ unavailable; re-reading versions for platform %s inline", platform_id
            )
            reextract(tenant_id=tenant_id, platform_id=platform_id)

    transaction.on_commit(push)
