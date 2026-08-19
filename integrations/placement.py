"""Decide which Site a synced host or VM belongs to.

The hypervisor already knows where things sit — a datacenter, some folders, a
cluster, a host. This turns that **placement path** into a Danbyte Site, using
the operator's rules first and the hierarchy as the last rule.

Two things it will never do:

* **Invent a Site.** Sites are physical facts the operator owns. A rule points
  at a real Site row; the hierarchy fallback only ever *matches* an existing
  Site by name. An unmatched name places nothing and is reported.
* **Match on IP address.** The original request was ``192.168.110.* = UA``, but
  a host's management address isn't in the sync payload, and an address is a
  poor proxy for a location that the operator already models properly.

Both hypervisors produce the same path shape, so Proxmox gets rules for free:

    {"datacenter": "Lab", "folders": ["Test site", "Linux"],
     "cluster": "cl-01", "host": "esxi-01"}
"""
from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass, field

# Outermost → innermost. Index is specificity: a host rule beats a folder rule
# beats a cluster rule beats a datacenter rule, whatever their weights.
SCOPE_ORDER = ["datacenter", "cluster", "folder", "host"]

# vCenter's built-in top-level folders. They exist in every inventory and carry
# no operator meaning, so they never appear in a path.
_BUILTIN_FOLDERS = {"vm", "host", "network", "datastore", "Datacenters"}


@dataclass(frozen=True)
class Placement:
    """Where one object should sit, and why — ``reason`` is operator-facing."""

    site: object = None
    location: object = None
    reason: str = ""

    @property
    def ok(self) -> bool:
        return self.site is not None


@dataclass
class PlacementPath:
    """Where the hypervisor says an object sits."""

    datacenter: str = ""
    cluster: str = ""
    host: str = ""
    #: Outermost → innermost, built-ins already stripped.
    folders: list = field(default_factory=list)

    def values_for(self, scope: str) -> list:
        """Candidate strings for one scope, **innermost first**.

        Folders yield both the bare name and the full path, so a rule can be
        written either way — and they come innermost-first so the closest
        matching ancestor wins.
        """
        if scope == "folder":
            out = []
            for i in range(len(self.folders) - 1, -1, -1):
                out.append(self.folders[i])
                out.append("/".join(self.folders[: i + 1]))
            return out
        return [getattr(self, scope, "") or ""]


def strip_builtin_folders(names) -> list:
    return [n for n in names if n and n not in _BUILTIN_FOLDERS]


def _matches(pattern: str, value: str) -> bool:
    pattern = (pattern or "").strip()
    if not pattern or not value:
        return False
    if pattern.startswith("regex:"):
        try:
            return re.search(pattern[6:], value, re.IGNORECASE) is not None
        except re.error:
            return False  # a broken rule matches nothing rather than exploding
    return fnmatch.fnmatch(value.lower(), pattern.lower())


def resolve(path: PlacementPath, rules, *, site_by_name=None) -> Placement:
    """Resolve ``path`` to a Site.

    ``rules`` is this source's :class:`VirtPlacementRule` rows (already
    fetched — this runs per object, so it must not query). ``site_by_name`` is
    an optional ``{lowercased name: Site}`` map used for the hierarchy
    fallback; omit it to disable the fallback entirely.
    """
    best = None  # (scope_rank, folder_depth, weight, rule)
    for rule in rules:
        try:
            rank = SCOPE_ORDER.index(rule.scope)
        except ValueError:
            continue  # unknown scope — ignore rather than guess
        for depth, value in enumerate(path.values_for(rule.scope)):
            if not _matches(rule.pattern, value):
                continue
            key = (-rank, depth, rule.weight)
            if best is None or key < best[0]:
                best = (key, rule)
            break  # innermost match for this rule is the one that counts
    if best is not None:
        rule = best[1]
        loc = rule.location if rule.location_id else None
        # A Location only means anything inside its own Site.
        if loc is not None and loc.site_id != rule.site_id:
            loc = None
        return Placement(rule.site, loc, f"rule: {rule.scope} {rule.pattern}")

    # The hierarchy, as the implicit last rule: a Site already named after the
    # datacenter (vCenter) or the cluster (Proxmox).
    if site_by_name:
        for scope in ("datacenter", "cluster"):
            name = (getattr(path, scope, "") or "").strip().lower()
            site = site_by_name.get(name) if name else None
            if site is not None:
                return Placement(site, None, f"site named after the {scope}")
    return Placement(None, None, "")


def unplaced_warning(path: PlacementPath) -> str:
    """Why nothing matched, and what to do about it."""
    where = path.datacenter or path.cluster or path.host or "this source"
    return (
        f'"{where}": no placement rule matched and no site is named after it '
        f"— add a rule for this source, or create a site with that name"
    )
