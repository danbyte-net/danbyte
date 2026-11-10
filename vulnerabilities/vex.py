"""The CycloneDX ``vulnerabilities`` section of the SBOM export (#451,
decision 24): ``GET /api/sbom/?vex=1``.

Each open match on a host or install *in the document* becomes an
``affects`` entry of its record: the host's operating-system component for a
platform match, the install's component for an application match. Only
components the document already holds are named, so a host or install the
caller may not view never appears - the document's own scoping is the VEX's.
A record is public data; the section only says which of the document's
components it affects.

Every entry carries an ``analysis``. A match an exception covers takes the
exception's (``exceptions.cyclonedx_analysis``: ``not_affected`` with a
justification, ``exploitable`` with ``will_not_fix``…); otherwise the
default is ``exploitable`` for a record in CISA KEV and ``in_triage``.
:func:`register_analysis` lets another source answer first. Matches of one
record with different analyses become separate entries, so each
``affects`` list states one analysis.
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable

from django.db.models import Q

_providers: list[Callable] = []
_CWE = re.compile(r"^CWE-(\d+)$")
_METHOD = {"4.0": "CVSSv4", "3.1": "CVSSv31", "3.0": "CVSSv3", "2.0": "CVSSv2"}


def register_analysis(fn: Callable) -> None:
    """``fn(match) -> dict | None``: a CycloneDX ``analysis`` object for one
    match, or None to fall through to the next provider and the default."""
    if fn not in _providers:
        _providers.append(fn)


def unregister_analysis(fn: Callable) -> None:
    if fn in _providers:
        _providers.remove(fn)


def default_analysis(match) -> dict:
    if match.excepted_id is not None:
        from .exceptions import cyclonedx_analysis

        return cyclonedx_analysis(match.excepted)
    if match.cve.kev_added is not None:
        return {"state": "exploitable",
                "detail": "Listed in CISA Known Exploited Vulnerabilities."}
    return {"state": "in_triage"}


def analysis(match) -> dict:
    for fn in _providers:
        got = fn(match)
        if got:
            return got
    return default_analysis(match)


def _source(vuln_id: str) -> dict:
    if vuln_id.startswith("CVE-"):
        return {"name": "NVD", "url": f"https://nvd.nist.gov/vuln/detail/{vuln_id}"}
    return {"name": "OSV", "url": f"https://osv.dev/vulnerability/{vuln_id}"}


def _iso(dt) -> str | None:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def _record(c) -> dict:
    """The record's facts, as CycloneDX puts them."""
    out: dict = {"id": c.vuln_id, "source": _source(c.vuln_id)}
    aliases = [a for a in (c.aliases or []) if isinstance(a, str) and a != c.vuln_id]
    if aliases:
        out["references"] = [{"id": a, "source": _source(a)} for a in aliases[:50]]
    if c.cvss_score is not None or c.cvss_vector:
        rating: dict = {"source": {"name": _source(c.vuln_id)["name"]}}
        if c.cvss_score is not None:
            rating["score"] = float(c.cvss_score)
        if c.cvss_severity:
            rating["severity"] = c.cvss_severity
        rating["method"] = _METHOD.get(c.cvss_version, "other")
        if c.cvss_vector:
            rating["vector"] = c.cvss_vector
        out["ratings"] = [rating]
    cwes = [int(m.group(1)) for w in (c.cwes or []) if isinstance(w, str)
            and (m := _CWE.match(w))]
    if cwes:
        out["cwes"] = cwes
    if c.summary:
        out["description"] = c.summary
    if c.published:
        out["published"] = _iso(c.published)
    if c.last_modified:
        out["updated"] = _iso(c.last_modified)
    return out


def _props(c, priority: str) -> list[dict]:
    props = [{"name": "danbyte:priority", "value": priority}]
    if c.kev_added:
        props.append({"name": "danbyte:kev_added", "value": c.kev_added.isoformat()})
    if c.kev_due:
        props.append({"name": "danbyte:kev_due", "value": c.kev_due.isoformat()})
    if c.epss is not None:
        props.append({"name": "danbyte:epss", "value": str(c.epss)})
    return props


def section(tenant, devices, vms, os_refs: dict, install_refs: dict) -> list[dict] | None:
    """The ``vulnerabilities`` list for the document's hosts, or None while
    vulnerability data is off. ``devices``/``vms`` are the document's host
    querysets; ``os_refs`` maps ``(kind, host pk)`` to the host's
    operating-system bom-ref and ``install_refs`` an install's pk to its
    bom-ref - only those components are named."""
    from .models import VulnerabilityMatch, VulnerabilitySettings

    if tenant is None or not VulnerabilitySettings.objects.filter(pk=1, enabled=True).exists():
        return None
    matches = (
        VulnerabilityMatch.objects.filter(tenant=tenant, resolved_at__isnull=True)
        .filter(Q(device__in=devices.order_by().values("pk"))
                | Q(virtual_machine__in=vms.order_by().values("pk")))
        .select_related("cve", "excepted")
        .order_by("cve__vuln_id", "id")
    )
    groups: dict[tuple, dict] = {}
    for m in matches:
        if m.installed_software_id:
            ref = install_refs.get(m.installed_software_id)
        elif m.device_id:
            ref = os_refs.get(("device", m.device_id))
        else:
            ref = os_refs.get(("virtual_machine", m.virtual_machine_id))
        if ref is None:
            continue  # a component the document does not hold
        a = analysis(m)
        key = (m.cve_id, json.dumps(a, sort_keys=True))
        g = groups.get(key)
        if g is None:
            g = groups[key] = {"cve": m.cve, "priority": m.priority, "analysis": a,
                               "affects": {}}
        g["affects"].setdefault(ref, m.version)
    out = []
    seen: dict[str, int] = {}
    for g in groups.values():
        c = g["cve"]
        n = seen[c.vuln_id] = seen.get(c.vuln_id, 0) + 1
        entry = {"bom-ref": f"danbyte:vulnerability:{c.vuln_id}"
                            + (f":{n}" if n > 1 else ""),
                 **_record(c)}
        entry["affects"] = [
            {"ref": ref, **({"versions": [{"version": v, "status": "affected"}]}
                            if v else {})}
            for ref, v in g["affects"].items()]
        entry["analysis"] = g["analysis"]
        entry["properties"] = _props(c, g["priority"])
        out.append(entry)
    return out
