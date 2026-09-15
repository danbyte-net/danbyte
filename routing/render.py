"""The ``routing`` block a device's config template and Ansible hostvars
see - plain dicts, sorted by name so a rendered config diffs the same way
twice, every row carrying its ``id``, and never a secret (a keychain says
``key_set``; the key comes from the store through ``reveal-psk``).

Each protocol adds its slice here as it lands; a template written against
an earlier slice keeps working because keys are only ever added.
"""
from __future__ import annotations

from django.db.models import F

from .models import (
    ASPathList,
    Community,
    CommunityList,
    PrefixList,
    RoutingKeychain,
    RoutingPolicy,
    StaticRoute,
)


def _vrf_name(vrf) -> str | None:
    return vrf.name if vrf is not None else None


def _rt_names(qs) -> list[str]:
    return sorted(rt.name for rt in qs.all())


def vrf_dict(vrf) -> dict:
    return {
        "id": str(vrf.id),
        "name": vrf.name,
        "rd": vrf.rd or None,
        "import_targets": _rt_names(vrf.import_targets),
        "export_targets": _rt_names(vrf.export_targets),
        "l3vni": None,
        "description": vrf.description or "",
    }


def static_route_dict(r: StaticRoute) -> dict:
    return {
        "id": str(r.id),
        "vrf": _vrf_name(r.vrf),
        "prefix": r.prefix,
        "kind": r.kind,
        "next_hop": r.next_hop or None,
        "next_hop_interface": r.next_hop_interface.name if r.next_hop_interface_id else None,
        "next_hop_vrf": _vrf_name(r.next_hop_vrf),
        "distance": r.distance,
        "metric": r.metric,
        "tag": r.tag,
        "bfd": r.bfd,
        "description": r.description or "",
    }


def prefix_list_dict(pl: PrefixList) -> dict:
    return {
        "id": str(pl.id),
        "family": pl.family,
        "rules": [
            {
                "sequence": r.sequence,
                "action": r.action,
                "prefix": r.prefix,
                "ge": r.ge,
                "le": r.le,
                "description": r.description or "",
            }
            for r in pl.rules.all()
        ],
    }


def community_list_dict(cl: CommunityList) -> dict:
    return {
        "id": str(cl.id),
        "kind": cl.kind,
        "rules": [
            {
                "sequence": r.sequence,
                "action": r.action,
                "communities": sorted(c.value for c in r.communities.all()),
                "regex": r.regex or None,
                "description": r.description or "",
            }
            for r in cl.rules.all()
        ],
    }


def as_path_list_dict(al: ASPathList) -> dict:
    return {
        "id": str(al.id),
        "rules": [
            {
                "sequence": r.sequence,
                "action": r.action,
                "regex": r.regex,
                "description": r.description or "",
            }
            for r in al.rules.all()
        ],
    }


def policy_dict(p: RoutingPolicy) -> dict:
    return {
        "id": str(p.id),
        "rules": [
            {
                "sequence": r.sequence,
                "action": r.action,
                "description": r.description or "",
                "match": {
                    "prefix_lists": sorted(x.name for x in r.match_prefix_lists.all()),
                    "community_lists": sorted(x.name for x in r.match_community_lists.all()),
                    "as_path_lists": sorted(x.name for x in r.match_as_path_lists.all()),
                    "next_hop": r.match_next_hop.name if r.match_next_hop_id else None,
                    **(r.match_extra or {}),
                },
                "set": {
                    "local_pref": r.set_local_pref,
                    "med": r.set_med,
                    "weight": r.set_weight,
                    "origin": r.set_origin or None,
                    "next_hop": r.set_next_hop or None,
                    "as_path_prepend": r.set_as_path_prepend or None,
                    "communities": sorted(c.value for c in r.set_communities.all()),
                    "communities_additive": r.set_communities_additive,
                    "metric_type": r.set_metric_type,
                    **(r.set_extra or {}),
                },
                "continue": r.continue_seq,
            }
            for r in p.rules.all()
        ],
    }


def keychain_dict(k: RoutingKeychain) -> dict:
    return {
        "id": str(k.id),
        "name": k.name,
        "algorithm": k.algorithm,
        "key_set": k.psk_set,
    }


def _policies_closure(tenant_id, names: set[str]) -> dict:
    """The policies a device references, plus every list those policies
    match on - so a template prints only what the box needs."""
    policies = {
        p.name: policy_dict(p)
        for p in RoutingPolicy.objects.filter(tenant_id=tenant_id, name__in=names)
        .prefetch_related(
            "rules__match_prefix_lists", "rules__match_community_lists",
            "rules__match_as_path_lists", "rules__set_communities",
        )
    }
    pl_names, cl_names, al_names = set(), set(), set()
    for p in policies.values():
        for r in p["rules"]:
            pl_names.update(r["match"]["prefix_lists"])
            if r["match"]["next_hop"]:
                pl_names.add(r["match"]["next_hop"])
            cl_names.update(r["match"]["community_lists"])
            al_names.update(r["match"]["as_path_lists"])
    return {
        "policies": dict(sorted(policies.items())),
        "prefix_lists": {
            pl.name: prefix_list_dict(pl)
            for pl in PrefixList.objects.filter(tenant_id=tenant_id, name__in=pl_names)
            .prefetch_related("rules").order_by("name")
        },
        "community_lists": {
            cl.name: community_list_dict(cl)
            for cl in CommunityList.objects.filter(tenant_id=tenant_id, name__in=cl_names)
            .prefetch_related("rules__communities").order_by("name")
        },
        "as_path_lists": {
            al.name: as_path_list_dict(al)
            for al in ASPathList.objects.filter(tenant_id=tenant_id, name__in=al_names)
            .prefetch_related("rules").order_by("name")
        },
    }


def routing_context(device) -> dict:
    """The routing block for one device. Only devices have one - a VM (which
    the VM renderer also hands here) gets an empty block."""
    if device._meta.label_lower != "api.device":
        return {}

    static_routes = list(
        StaticRoute.objects.filter(device=device)
        .select_related("vrf", "next_hop_vrf", "next_hop_interface")
        # Global table first, then VRFs by name.
        .order_by(F("vrf__name").asc(nulls_first=True), "prefix", "next_hop")
    )

    # VRFs the box has to define: whatever its interfaces and routes sit in.
    vrfs = {}
    # `.all()` on purpose: the inventory prefetches interfaces with their
    # VRF, and a fresh queryset here would throw that away.
    for iface in device.interfaces.all():
        if iface.vrf_id:
            vrfs[iface.vrf.name] = iface.vrf
    for r in static_routes:
        for vrf in (r.vrf, r.next_hop_vrf):
            if vrf is not None:
                vrfs[vrf.name] = vrf

    referenced_policies: set[str] = set()
    out = {
        "vrfs": [vrf_dict(v) for _, v in sorted(vrfs.items())],
        "static_routes": [static_route_dict(r) for r in static_routes],
        **_policies_closure(device.tenant_id, referenced_policies),
        "communities": [
            {"id": str(c.id), "value": c.value, "kind": c.kind, "name": c.name}
            for c in Community.objects.filter(tenant_id=device.tenant_id).order_by("value")
        ],
        "keychains": [
            keychain_dict(k)
            for k in RoutingKeychain.objects.filter(tenant_id=device.tenant_id).order_by("name")
        ],
    }
    return out
