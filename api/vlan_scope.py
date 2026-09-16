"""Which VLAN a bare VID means.

A VLAN ID is only unique within its **group**, or - ungrouped - within its
**site** (#159). Kyiv VLAN 105 and Warsaw VLAN 105 are different broadcast
domains that happen to share a number, so anything that resolves a VID it
read off a switch, a hypervisor or an import file has to say *whose* 105 it
means. Guessing is how an interface at one site ends up pointing at another
site's segment, and nothing downstream would ever flag it.

The rule here: resolve from the most specific scope outwards, and when two
candidates are equally plausible, resolve to **nothing**. A caller that gets
``None`` back can skip the assignment, or mint its own VLAN in its own group
- both are recoverable. A wrong VLAN is not.
"""
from __future__ import annotations

from .models import VLAN


def resolve_vid(
    tenant,
    vid: int,
    *,
    site=None,
    cluster=None,
    exclude_group_prefix: str = "",
) -> tuple[VLAN | None, str]:
    """The VLAN ``vid`` means in ``site``, and why.

    Returns ``(vlan, reason)``. ``reason`` is for the caller's log/summary:
    ``"site"``, ``"group"``, ``"global"``, ``"none"`` (no VLAN with that VID)
    or ``"ambiguous"`` (several, and nothing to choose between them).

    ``exclude_group_prefix`` skips groups whose slug starts with it - virt
    sync uses it to ignore the per-source groups it mints itself, so a resync
    matches the operator's VLAN rather than its own copy.
    """
    rows = VLAN.objects.filter(tenant=tenant, vlan_id=vid).select_related(
        "group", "site"
    )
    if exclude_group_prefix:
        rows = rows.exclude(group__slug__startswith=exclude_group_prefix)
    rows = list(rows)
    if not rows:
        return None, "none"

    # 1. The site's own ungrouped VLAN - the common case, and unambiguous by
    #    construction: the constraint allows exactly one per site.
    if site is not None:
        for v in rows:
            if v.group_id is None and v.site_id == site.id:
                return v, "site"

    # 2. A group scoped to this site (or this cluster). A group spans sites
    #    deliberately, so its VID is the same segment wherever it appears.
    scoped = [
        v
        for v in rows
        if v.group_id is not None
        and (
            (site is not None and v.group.site_id == site.id)
            or (cluster is not None and v.group.cluster_id == cluster.id)
        )
    ]
    if len(scoped) == 1:
        return scoped[0], "group"
    if len(scoped) > 1:
        return None, "ambiguous"

    # 3. A tenant-wide VLAN: no group, no site. It belongs to everywhere, so
    #    it is the right answer when nothing more specific exists.
    globals_ = [v for v in rows if v.group_id is None and v.site_id is None]
    if len(globals_) == 1 and not scoped:
        return globals_[0], "global"

    # 4. One candidate in total - still correct when the estate has only one
    #    VLAN 105, which is the shape most installs actually have.
    if len(rows) == 1:
        return rows[0], "global"

    return None, "ambiguous"
