"""The sensor kinds a PRTG sensor profile can ask for.

One table, read by the definition serializer (what may be saved), the
planning pass (what a definition expands to and how an existing PRTG sensor
is recognised as it) and the profile editor (``/api/prtg/profiles/kinds/``).

A kind names PRTG's raw sensor types that count as "this sensor is there":
classic and v2 types both, because a server that has run for years carries
both. ``needs`` is the credential the sensor cannot work without - SNMP from
the device's SNMP profile, a Windows login for WMI - and ``per`` says whether
one definition is one sensor or one per interface.

``device_template`` is the coarse alternative: it hands the device to one of
PRTG's own device templates by name, and PRTG decides the sensors. Templates
are files on the PRTG core server and cannot be read through the API, so a
template is part of what a new device gets and is never compared against an
existing one.
"""
from __future__ import annotations

from dataclasses import dataclass, field

SNMP, WINDOWS = "snmp", "windows"
PER_DEVICE, PER_INTERFACE = "device", "interface"


@dataclass(frozen=True)
class Param:
    name: str
    #: ``str``, ``int``, ``bool`` or ``choice``.
    type: str
    label: str
    default: object = None
    required: bool = False
    choices: tuple = ()
    minimum: int | None = None
    maximum: int | None = None


@dataclass(frozen=True)
class SensorKind:
    value: str
    label: str
    #: PRTG raw types (``type_raw``) that are this kind, exactly.
    types: frozenset = frozenset()
    #: Raw-type prefixes that are this kind (v2 types carry a version).
    prefixes: tuple = ()
    needs: str | None = None
    per: str = PER_DEVICE
    params: tuple = field(default_factory=tuple)
    #: The sensor's name when the definition leaves it blank.
    default_name: str = ""

    def matches_type(self, raw: str) -> bool:
        raw = (raw or "").strip().lower()
        if not raw:
            return False
        return raw in self.types or any(raw.startswith(p) for p in self.prefixes)


_PORT = Param("port", "int", "Port", None, minimum=1, maximum=65535)
_SERVICE = Param("require_service", "bool", "Only with a service on the port", False)

KINDS: tuple[SensorKind, ...] = (
    SensorKind(
        "ping", "Ping", frozenset({"ping"}), ("paessler.icmp.ping",),
        default_name="Ping",
    ),
    SensorKind(
        "snmp_uptime", "SNMP uptime", frozenset({"snmpuptime", "snmpsystemuptime"}),
        ("paessler.snmp.uptime",), needs=SNMP, default_name="SNMP Uptime",
    ),
    SensorKind(
        "snmp_traffic", "SNMP traffic", frozenset({"snmptraffic"}),
        ("paessler.snmp.traffic",), needs=SNMP, per=PER_INTERFACE,
        params=(
            Param("interface", "str", "Interfaces", "*"),
            Param("connected_only", "bool", "Connected interfaces only", False),
        ),
        default_name="{interface} Traffic",
    ),
    SensorKind(
        "snmp_cpu", "SNMP CPU load", frozenset({"snmpcpu", "snmpcpuload"}),
        ("paessler.snmp.cpu",), needs=SNMP, default_name="SNMP CPU Load",
    ),
    SensorKind(
        "snmp_memory", "SNMP memory", frozenset({"snmpmemory", "snmphostmemory"}),
        ("paessler.snmp.memory",), needs=SNMP, default_name="SNMP Memory",
    ),
    SensorKind(
        "http", "HTTP", frozenset({"http", "httpadvanced"}), ("paessler.http.",),
        params=(
            Param("scheme", "choice", "Scheme", "http", choices=("http", "https")),
            _PORT,
            Param("path", "str", "Path", "/"),
            _SERVICE,
        ),
        default_name="HTTP",
    ),
    SensorKind(
        "ssl_certificate", "SSL certificate", frozenset({"sslcertificate"}),
        ("paessler.ssl.certificate",), params=(_PORT, _SERVICE),
        default_name="SSL Certificate",
    ),
    SensorKind(
        "ssl_security", "SSL security check", frozenset({"ssl"}),
        ("paessler.ssl.security",), params=(_PORT, _SERVICE),
        default_name="SSL Security Check",
    ),
    SensorKind(
        "wmi_cpu", "WMI CPU load", frozenset({"wmiprocessor", "wmicpuload"}),
        needs=WINDOWS, default_name="CPU Load",
    ),
    SensorKind(
        "wmi_memory", "WMI memory", frozenset({"wmimemory"}),
        needs=WINDOWS, default_name="Memory",
    ),
    SensorKind(
        "wmi_disk", "WMI free disk space", frozenset({"wmidiskspace", "wmivolume"}),
        needs=WINDOWS, default_name="Disk Free",
    ),
    SensorKind(
        "windows_service", "Windows service", frozenset({"wmiservice"}),
        needs=WINDOWS,
        params=(Param("service", "str", "Service name", "", required=True),),
        default_name="Service {service}",
    ),
    SensorKind(
        "device_template", "Device template",
        params=(Param("template", "str", "Template", "", required=True),),
        default_name="Template {template}",
    ),
)

BY_VALUE: dict[str, SensorKind] = {k.value: k for k in KINDS}
CHOICES = [(k.value, k.label) for k in KINDS]
TEMPLATE = "device_template"
#: The intervals PRTG offers in its own settings, in seconds.
INTERVALS = (30, 60, 300, 600, 900, 1800, 3600, 14400, 21600, 43200, 86400)


def label(kind: str) -> str:
    k = BY_VALUE.get(kind)
    return k.label if k else kind


def clean_params(kind: str, params) -> dict:
    """``params`` for ``kind``, typed, with defaults filled in and unknown
    keys refused. Raises ``ValueError`` with a field -> message dict."""
    spec = BY_VALUE.get(kind)
    if spec is None:
        raise ValueError({"kind": f"'{kind}' is not a sensor kind."})
    if params in (None, ""):
        params = {}
    if not isinstance(params, dict):
        raise ValueError({"params": "Expected an object."})
    known = {p.name: p for p in spec.params}
    unknown = sorted(set(params) - set(known))
    if unknown:
        raise ValueError({"params": f"{spec.label} takes no {', '.join(unknown)}."})
    out: dict = {}
    errors: dict = {}
    for p in spec.params:
        value = params.get(p.name, p.default)
        if p.type == "bool":
            if isinstance(value, str):
                value = value.strip().lower() in ("1", "true", "yes", "on")
            out[p.name] = bool(value)
            continue
        if p.type == "int":
            if value in (None, ""):
                if p.required:
                    errors[p.name] = f"{p.label} is needed."
                else:
                    out[p.name] = None
                continue
            try:
                value = int(value)
            except (TypeError, ValueError):
                errors[p.name] = f"{p.label} must be a number."
                continue
            if (p.minimum is not None and value < p.minimum) or (
                p.maximum is not None and value > p.maximum
            ):
                errors[p.name] = f"{p.label} must be {p.minimum}-{p.maximum}."
                continue
            out[p.name] = value
            continue
        value = "" if value is None else str(value).strip()
        if p.type == "choice" and value not in p.choices:
            errors[p.name] = f"{p.label} is one of {', '.join(p.choices)}."
            continue
        if p.required and not value:
            errors[p.name] = f"{p.label} is needed."
            continue
        out[p.name] = value[:255]
    if errors:
        raise ValueError({"params": errors})
    return out


def port_of(kind: str, params: dict) -> int | None:
    """The TCP port a web or SSL sensor watches."""
    if kind == "http":
        return params.get("port") or (443 if params.get("scheme") == "https" else 80)
    if kind in ("ssl_certificate", "ssl_security"):
        return params.get("port") or 443
    return None


def catalog() -> list[dict]:
    """The kinds for the profile editor."""
    return [
        {
            "value": k.value, "label": k.label, "needs": k.needs, "per": k.per,
            "default_name": k.default_name,
            "params": [
                {"name": p.name, "type": p.type, "label": p.label, "default": p.default,
                 "required": p.required, "choices": list(p.choices),
                 "minimum": p.minimum, "maximum": p.maximum}
                for p in k.params
            ],
        }
        for k in KINDS
    ]
