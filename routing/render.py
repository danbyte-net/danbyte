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
    BGPInstance,
    Community,
    CommunityList,
    ISISInstance,
    OSPFInstance,
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


def _name(obj) -> str | None:
    return obj.name if obj is not None else None


def session_dict(s, policies: set[str]) -> dict:
    """One neighbour with every knob resolved (session → group → instance)."""
    eff = s.effective()
    for key in ("import_policy", "export_policy"):
        if eff[key] is not None:
            policies.add(eff[key].name)
    local = s.local_address if s.local_address_id else None
    return {
        "id": str(s.id),
        "name": s.name or None,
        "peer_group": s.peer_group.name if s.peer_group_id else None,
        "remote_asn": eff["remote_asn"],
        "remote_asn_mode": eff["remote_asn_mode"],
        "kind": eff["kind"],
        "local_asn": eff["local_asn"],
        "local_address": {
            "address": local.ip_address,
            "cidr": f"{local.ip_address}/{str(local.prefix.cidr).split('/')[-1]}" if local.prefix_id else None,
            "interface": local.assigned_interface.name if local.assigned_interface_id else None,
        } if local is not None else None,
        "remote_address": s.remote_address or None,
        "interface": s.interface.name if s.interface_id else None,
        "peer_device": s.peer_device.name if s.peer_device_id else None,
        "address_families": list(eff["address_families"] or []),
        "import_policy": _name(eff["import_policy"]),
        "export_policy": _name(eff["export_policy"]),
        "bfd": bool(eff["bfd"]),
        "ebgp_multihop": eff["ebgp_multihop"],
        "update_source": eff["update_source"] or None,
        "next_hop_self": bool(eff["next_hop_self"]),
        "route_reflector_client": bool(eff["route_reflector_client"]),
        "send_community": eff["send_community"] or None,
        "keepalive": eff["keepalive"],
        "hold_time": eff["hold_time"],
        "keychain": _name(eff["keychain"]),
        "description": s.description or "",
        "extra": eff["extra"],
    }


def bgp_dict(inst: BGPInstance, policies: set[str]) -> dict:
    afs = []
    for af in inst.address_families.all():
        for key in ("import_policy", "export_policy"):
            pol = getattr(af, key)
            if pol is not None:
                policies.add(pol.name)
        redist = []
        for r in af.redistributions.all():
            if r.policy_id:
                policies.add(r.policy.name)
            redist.append({
                "source": r.source, "policy": _name(r.policy) if r.policy_id else None,
                "metric": r.metric, **(r.extra or {}),
            })
        afs.append({
            "afi_safi": af.afi_safi,
            "networks": list(af.networks or []),
            "maximum_paths": af.maximum_paths,
            "maximum_paths_ibgp": af.maximum_paths_ibgp,
            "import_policy": _name(af.import_policy) if af.import_policy_id else None,
            "export_policy": _name(af.export_policy) if af.export_policy_id else None,
            "redistribute": redist,
            "extra": af.extra or {},
        })
    # Addressed neighbours first, then unnumbered ones by port - the order a
    # config lists them, and stable across renders.
    ordered = sorted(
        inst.sessions.all(),
        key=lambda s: (not s.remote_address, s.remote_address,
                       s.interface.name if s.interface_id else ""),
    )
    sessions = [session_dict(s, policies) for s in ordered]
    groups = {}
    for s in inst.sessions.all():
        if s.peer_group_id and s.peer_group.name not in groups:
            g = s.peer_group
            groups[g.name] = {
                "name": g.name,
                "remote_asn": g.remote_asn,
                "remote_asn_mode": g.remote_asn_mode,
                "local_asn": g.local_asn.asn if g.local_asn_id else inst.asn.asn,
                "update_source": g.update_source or None,
                "address_families": list(g.address_families or []),
                "import_policy": _name(g.import_policy) if g.import_policy_id else None,
                "export_policy": _name(g.export_policy) if g.export_policy_id else None,
                "bfd": inst.bfd if g.bfd is None else g.bfd,
                "ebgp_multihop": g.ebgp_multihop,
                "next_hop_self": bool(g.next_hop_self),
                "route_reflector_client": bool(g.route_reflector_client),
                "send_community": g.send_community or None,
                "keepalive": g.keepalive,
                "hold_time": g.hold_time,
                "keychain": _name(g.keychain) if g.keychain_id else None,
                "extra": g.extra or {},
            }
    return {
        "id": str(inst.id),
        "vrf": _vrf_name(inst.vrf),
        "asn": inst.asn.asn,
        "router_id": inst.router_id or None,
        "cluster_id": inst.cluster_id or None,
        "graceful_restart": inst.graceful_restart,
        "bfd": inst.bfd,
        "address_families": afs,
        "sessions": sessions,
        "peer_groups": [groups[k] for k in sorted(groups)],
        "description": inst.description or "",
        "extra": inst.extra or {},
    }


def _redistribute(rows, policies: set[str]) -> list[dict]:
    out = []
    for r in rows:
        if r.policy_id:
            policies.add(r.policy.name)
        out.append({
            "source": r.source,
            "policy": r.policy.name if r.policy_id else None,
            "metric": r.metric,
            **(r.extra or {}),
        })
    return out


def ospf_dict(inst: OSPFInstance, policies: set[str]) -> dict:
    areas = {}
    ifaces = []
    for row in inst.interfaces.all():
        areas.setdefault(row.area.area_id, {"area_id": row.area.area_id,
                                            "name": row.area.name, "kind": row.area.kind})
        ifaces.append({
            "interface": row.interface.name,
            "area": row.area.area_id,
            "cost": row.cost,
            "network_type": row.network_type or None,
            "passive": inst.passive_by_default if row.passive is None else row.passive,
            "priority": row.priority,
            "hello": row.hello,
            "dead": row.dead,
            "bfd": row.bfd,
            "mtu_ignore": row.mtu_ignore,
            "authentication": row.authentication if row.authentication != "none" else None,
            "keychain": row.keychain.name if row.keychain_id else None,
            "extra": row.extra or {},
        })
    return {
        "id": str(inst.id),
        "vrf": _vrf_name(inst.vrf),
        "process_id": inst.process_id or None,
        "version": inst.version,
        "router_id": inst.router_id or None,
        "reference_bandwidth": inst.reference_bandwidth,
        "passive_by_default": inst.passive_by_default,
        "default_originate": inst.default_originate,
        "bfd": inst.bfd,
        "redistribute": _redistribute(inst.redistributions.all(), policies),
        "areas": [areas[k] for k in sorted(areas)],
        "interfaces": sorted(ifaces, key=lambda i: i["interface"]),
        "description": inst.description or "",
        "extra": inst.extra or {},
    }


def isis_dict(inst: ISISInstance, policies: set[str]) -> dict:
    ifaces = []
    for row in inst.interfaces.all():
        ifaces.append({
            "interface": row.interface.name,
            "families": list(row.families or ["ipv4"]),
            "level": row.level or inst.level,
            "metric": row.metric,
            "metric_l2": row.metric_l2,
            "network_type": row.network_type or None,
            "passive": bool(row.passive),
            "hello_interval": row.hello_interval,
            "hello_multiplier": row.hello_multiplier,
            "bfd": row.bfd,
            "authentication": row.authentication if row.authentication != "none" else None,
            "keychain": row.keychain.name if row.keychain_id else None,
            "extra": row.extra or {},
        })
    return {
        "id": str(inst.id),
        "vrf": _vrf_name(inst.vrf),
        "process": inst.process or None,
        "net": inst.net,
        "level": inst.level,
        "metric_style": inst.metric_style,
        "bfd": inst.bfd,
        "authentication": inst.authentication if inst.authentication != "none" else None,
        "keychain": inst.keychain.name if inst.keychain_id else None,
        "redistribute": _redistribute(inst.redistributions.all(), policies),
        "interfaces": sorted(ifaces, key=lambda i: i["interface"]),
        "description": inst.description or "",
        "extra": inst.extra or {},
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
    instances = (
        BGPInstance.objects.filter(device=device)
        .select_related("vrf", "asn")
        .prefetch_related(
            "address_families__import_policy", "address_families__export_policy",
            "address_families__redistributions__policy",
            "sessions__peer_group__import_policy", "sessions__peer_group__export_policy",
            "sessions__peer_group__keychain", "sessions__peer_group__local_asn",
            "sessions__local_asn", "sessions__local_address__prefix",
            "sessions__local_address__assigned_interface", "sessions__interface",
            "sessions__peer_device", "sessions__import_policy",
            "sessions__export_policy", "sessions__keychain",
        )
        .order_by(F("vrf__name").asc(nulls_first=True))
    )
    bgp = [bgp_dict(i, referenced_policies) for i in instances]
    ospf_instances = (
        OSPFInstance.objects.filter(device=device)
        .select_related("vrf")
        .prefetch_related("redistributions__policy", "interfaces__interface",
                          "interfaces__area", "interfaces__keychain")
        .order_by(F("vrf__name").asc(nulls_first=True), "process_id")
    )
    ospf = [ospf_dict(i, referenced_policies) for i in ospf_instances]
    isis_instances = (
        ISISInstance.objects.filter(device=device)
        .select_related("vrf", "keychain")
        .prefetch_related("redistributions__policy", "interfaces__interface",
                          "interfaces__keychain")
        .order_by("process")
    )
    isis = [isis_dict(i, referenced_policies) for i in isis_instances]
    for inst in (*instances, *ospf_instances, *isis_instances):
        if inst.vrf_id:
            vrfs[inst.vrf.name] = inst.vrf

    # What an interfaces loop needs without a nested search: the IGP rows
    # keyed by port name.
    by_interface: dict[str, dict] = {}
    for iface in device.interfaces.all():
        by_interface[iface.name] = {
            "vrf": iface.vrf.name if iface.vrf_id else None, "ospf": None, "isis": None,
        }
    for o in ospf:
        for row in o["interfaces"]:
            by_interface.setdefault(row["interface"], {"vrf": None, "ospf": None, "isis": None})
            by_interface[row["interface"]]["ospf"] = {
                "process_id": o["process_id"], "version": o["version"], **row,
            }
    for i in isis:
        for row in i["interfaces"]:
            by_interface.setdefault(row["interface"], {"vrf": None, "ospf": None, "isis": None})
            by_interface[row["interface"]]["isis"] = {"process": i["process"], **row}

    out = {
        "vrfs": [vrf_dict(v) for _, v in sorted(vrfs.items())],
        "static_routes": [static_route_dict(r) for r in static_routes],
        "bgp": bgp,
        "ospf": ospf,
        "isis": isis,
        "by_interface": dict(sorted(by_interface.items())),
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
