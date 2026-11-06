"""The object reports (``api/object_report.py``) as kinds: the device,
prefix and IP address reports and their per-object sections. The object
report builds them itself; registering them lets the framework list them
beside the other kinds."""

from __future__ import annotations

from ... import object_report as rep
from ..registry import ReportKind, SectionSpec, register_kind, register_section

_PATHS = {
    "device": "/api/devices/report/",
    "prefix": "/api/prefixes/report/",
    "ipaddress": "/api/ips/report/",
}

for _rt in rep.REPORT_TYPES.values():
    for _s in _rt.sections:
        register_section(
            SectionSpec(
                key=_s.key,
                label=_s.label,
                applies_to=(_rt.slug,),
                path=_s.path or "",
                columns=_s.columns,
                default=_s.default,
            )
        )
    register_kind(
        ReportKind(
            slug=_rt.slug,
            label=f"{_rt.label} report",
            scope=_rt.slug,
            sections=tuple(s.key for s in _rt.sections),
            path=_PATHS[_rt.slug],
        )
    )
