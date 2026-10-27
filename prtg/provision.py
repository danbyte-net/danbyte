"""What PRTG should have: registration, sensor profiles and the plan.

Danbyte decides, per connection, which of the tenant's devices and VMs PRTG
should monitor, under which PRTG group or probe, and with which sensors. The
planning pass compares that with what the status read found - the links and
the imported sensors - and writes the difference into the review queue as
**planned** changes. Nothing here writes to PRTG; applying a planned change
does (:mod:`prtg.writer`).

Which objects PRTG should have, strongest first:

1. **Exclude from PRTG** on the object (``prtg_sync = never``) - nothing,
   whatever a policy or "register all" says.
2. **Monitor in PRTG** (``always``) - in scope even when nothing else picks
   it, and even with a retired status.
3. **Policies** - every enabled policy whose scope and filters match.
4. **Register all** on the connection - every device and VM left, less
   those already linked.

Policies and "register all" both skip objects with a retired status
(``decommissioning``, ``decommissioned``, ``retired``) and objects whose
primary address is excluded from monitoring. With the connection's
provisioning scope set to *devices with a PRTG check*, only objects carrying
a ``prtg`` check on one of its engines are considered at all (``always``
still wins).

Policies stack: every matching policy adds its profile's sensors, and the
matching policy with the lowest priority decides the group. An object picked
by "always" or "register all" alone gets the connection's registration
profile and group.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from fnmatch import fnmatchcase

from django.db import transaction
from django.utils import timezone

from monitoring.external.policy import device_matches
from monitoring.policy_scopes import filters_pass, hardware_names

from . import sensor_kinds as sk
from .models import (
    PrtgChange,
    PrtgConnection,
    PrtgDeviceLink,
    PrtgPolicy,
    PrtgSensor,
    PrtgSensorDefinition,
    PrtgSensorOverride,
    PrtgSensorProfile,
)

log = logging.getLogger("prtg.provision")

#: Lifecycle states whose objects policies and "register all" leave out.
RETIRED_STATUSES = frozenset({"decommissioning", "decommissioned", "retired"})
#: The tag prefix Danbyte will write on every sensor it creates, followed by
#: a short hash of the definition (and interface) that wants it.
DEF_TAG = "danbyte-def-"
#: What a planned row says when this PRTG cannot create anything.
NO_WRITES = "This PRTG cannot create objects through its API."
#: Keys of a row's detail the writer keeps, which a new pass must not drop.
_KEPT = ("result", "log", "last_error", "queued_apply")
#: How long an applied row stays in the queue once nothing proposes it.
APPLIED_KEEP_HOURS = 24


def propose(conn, fresh: set, detail: dict, **lookup):
    """:meth:`PrtgChange.propose`, keeping what the writer recorded on the
    row (progress, log, last error) so a retry resumes and the panel keeps
    its history. A row proposed again is wanted again: it is not applied."""
    old = PrtgChange.objects.filter(connection=conn, **lookup).values_list(
        "detail", flat=True
    ).first() or {}
    kept = {k: old[k] for k in _KEPT if k in old}
    return PrtgChange.propose(conn, fresh, {**detail, **kept}, **lookup)


def drop_stale(conn, fresh: set, now) -> None:
    """Delete planned rows this pass did not propose again - except rows
    applied within the last day, which stay as *Applied* to be seen."""
    from datetime import timedelta

    PrtgChange.pending(conn).filter(kind__in=PrtgChange.PLANNED).exclude(
        id__in=fresh
    ).exclude(
        detail__has_key="applied",
        updated_at__gte=now - timedelta(hours=APPLIED_KEEP_HOURS),
    ).delete()


#: Why an object is left out or a planned row cannot be written, as plain
#: sentences that say what is missing and where to fix it. Each issue also
#: carries a ``code`` so the SPA can link to the place it names.
TEXT = {
    "excluded": "Exclude from PRTG is set on this object.",
    "retired": "Its status {status} is left out of PRTG. Set Monitor in PRTG on the "
               "object to keep it.",
    "address_excluded": "Its primary address is excluded from monitoring. Include the "
                        "address again or set Monitor in PRTG on the object.",
    "no_check": "It has no PRTG check, and this connection only registers objects "
                "with one. Add a PRTG check to its primary address.",
    "no_match": "Nothing registers this object. Add a policy that matches it, set "
                "Monitor in PRTG on the object, or turn on Register all.",
    "already_linked": "It is already in PRTG. Register all only adds new devices.",
    "no_group": "No PRTG group chosen. Set one on the matching policy or under "
                "Register all on the connection.",
    "group_gone": "The PRTG group {path} is gone. Pick another on the matching policy "
                  "or under Register all on the connection.",
    "no_snmp": "No SNMP profile applies to {label}. Set one on its {tab} tab.",
    "no_windows": "Danbyte holds no Windows login for {label}. Add one on its Access tab.",
    "no_windows_vm": "Danbyte holds no Windows logins for VMs yet, so WMI sensors on "
                     "{label} cannot be set up.",
    "no_address": "It has no address PRTG can poll. Set a primary address, or the "
                  "host PRTG polls on the object.",
    "unwanted_sensor": "Danbyte made this sensor and no profile wants it any more.",
    "sensor_off": "Turned off for this device.",
    "not_created_sensor": "It carries a Danbyte tag, but Danbyte did not create it. "
                          "Remove it in PRTG if it should go.",
    "no_writes": "This PRTG cannot create objects through its API. Name a seed device "
                 "on the connection, or use PRTG 26.2.120 or later.",
    "group_writes": "Creating and changing groups needs PRTG API v2, from PRTG 26.2.120 "
                    "on.",
    "credentials_missing": "{label} credentials are not set on any group above this "
                           "device. Set them in PRTG, or choose Set on the group or Set on "
                           "the device for {label} on the profile.",
    "no_credential": "{label} is set on the {where} by the profile, but Danbyte has no "
                     "{label} credential to send. Pick one on the profile, or add one on "
                     "the object's Access tab.",
    "empty_group": "Danbyte made this group and nothing goes in it any more.",
}
_TEXT_ONLY = ("status", "label", "tab", "where")


def issue(code: str, **values) -> dict:
    """One reason as ``{code, text}`` plus what the SPA needs for its link:
    ``policy`` (a policy to edit) or ``object`` (``{kind, id}``)."""
    out = {"code": code, "text": TEXT[code].format(**values)}
    out.update({k: v for k, v in values.items() if k not in _TEXT_ONLY and k != "path"})
    return out


def instance_tag(definition_id, part: str = "") -> str:
    digest = hashlib.sha1(f"{definition_id}:{part}".encode()).hexdigest()[:12]
    return f"{DEF_TAG}{digest}"


def _is_vm(obj) -> bool:
    return obj._meta.model_name == "virtualmachine"


def _label(obj) -> str:
    return f"VM {obj.name}" if _is_vm(obj) else obj.name


def _parent(obj) -> dict:
    return {"virtual_machine": obj} if _is_vm(obj) else {"device": obj}


#: Which rule chose the host PRTG polls, strongest first, as the row says it.
HOST_SOURCES = {
    "override": "the PRTG host set on the object",
    "primary": "the primary address",
    "oob": "the OOB address",
    "assigned": "the first assigned address",
    "dns": "the DNS name of its address",
}
#: Hosts chosen by a fallback: a stronger one later is proposed as
#: ``update_host`` on a device Danbyte created.
FALLBACK_SOURCES = ("oob", "assigned", "dns")


def _bare(ip) -> str:
    return str(ip.ip_address).split("/")[0]


def host_choice(obj) -> tuple[str, str]:
    """What PRTG polls and which rule chose it, as ``(host, source)``: the
    PRTG host override; the primary address; the OOB address; the first
    address assigned to the object or one of its interfaces (lowest, IPv4
    before IPv6); with none of those usable, the DNS name of the primary or
    first address. An address excluded from monitoring is not usable.
    ``("", "")`` when nothing is left."""
    from api.ip_usage import assigned_addresses

    override = (getattr(obj, "prtg_host", "") or "").strip()
    if override:
        return override, "override"
    primary = getattr(obj, "primary_ip", None) if obj.primary_ip_id else None
    if primary is not None and not primary.monitoring_excluded:
        return _bare(primary), "primary"
    oob = getattr(obj, "oob_ip", None) if getattr(obj, "oob_ip_id", None) else None
    if oob is not None and not oob.monitoring_excluded:
        return _bare(oob), "oob"
    if obj.pk is None:
        return "", ""
    assigned = assigned_addresses("vm" if _is_vm(obj) else "device", obj)
    usable = [ip for ip in assigned if not ip.monitoring_excluded]
    if usable:
        return _bare(usable[0]), "assigned"
    for ip in (primary, *assigned[:1]):
        dns = ((ip.dns_name if ip is not None else "") or "").strip().rstrip(".")
        if dns:
            return dns, "dns"
    return "", ""


def host_address(obj) -> str:
    """What PRTG polls (:func:`host_choice`)."""
    return host_choice(obj)[0]


def host_note(host: str, source: str) -> str:
    return f"Host {host} from {HOST_SOURCES[source]}" if host and source else ""


# ── matching context ────────────────────────────────────────────────────────


class Context:
    """Per-pass caches, so a pass over many objects and policies reads each
    site's region chain and each location's ancestry once."""

    def __init__(self, tenant, policies):
        self.tenant = tenant
        self.policies = policies
        self.want_hardware = any((p.match_hardware or "").strip() for p in policies)
        #: The connection's registration profile, definitions prefetched.
        self.register_profile = None
        #: The connection's retirement rules, in order (:mod:`prtg.retire`).
        self.retire_rules: list = []
        self._regions: dict = {}
        self._locations: dict = {}
        #: The group layout's pass state (:class:`LayoutPass`), made on use.
        self.layout_pass = None
        #: Whether this pass may ask PRTG what credentials are in effect
        #: (the full plan); one object's plan uses what the last read kept.
        self.live = False
        self.v2 = None
        self.reads: dict = {}

    def layout(self, conn) -> LayoutPass:
        if self.layout_pass is None:
            self.layout_pass = LayoutPass(conn)
        return self.layout_pass

    def region_chain(self, site_id) -> set:
        if not site_id:
            return set()
        if site_id not in self._regions:
            from monitoring.policy_scopes import _region_chain

            self._regions[site_id] = _region_chain(site_id)
        return self._regions[site_id]

    def location_chain(self, location_id) -> set:
        if not location_id:
            return set()
        if location_id not in self._locations:
            from api.models import Location

            out, current = set(), location_id
            while current and current not in out and len(out) < 32:
                out.add(current)
                current = (
                    Location.objects.filter(pk=current)
                    .values_list("parent_id", flat=True).first()
                )
            self._locations[location_id] = out
        return self._locations[location_id]

    def tags(self, obj) -> set:
        return {t.slug for t in obj.tags.all()}

    def hardware(self, obj) -> set:
        if _is_vm(obj) or not self.want_hardware:
            return set()
        return hardware_names(obj)


def vm_site_id(vm):
    if vm.site_id:
        return vm.site_id
    cluster = getattr(vm, "cluster", None)
    return getattr(cluster, "site_id", None) if cluster is not None else None


def policy_matches(policy: PrtgPolicy, obj, ctx: Context) -> bool:
    """Whether a policy picks this device or VM. Policies of another
    connection or tenant never match: the caller passes its own."""
    if policy.tenant_id != obj.tenant_id:
        return False
    tags = ctx.tags(obj)
    if _is_vm(obj):
        if not policy.applies_to_vms:
            return False
        site_id = vm_site_id(obj)
        scope = policy.scope
        if scope == "global":
            ok = True
        elif scope == "region":
            ok = policy.region_id in ctx.region_chain(site_id)
        elif scope == "site":
            ok = policy.target_site_id is not None and policy.target_site_id == site_id
        elif scope == "location":
            host = obj.device if obj.device_id else None
            ok = host is not None and policy.location_id in ctx.location_chain(
                host.location_id
            )
        elif scope == "platform":
            ok = policy.platform_id is not None and policy.platform_id == obj.platform_id
        elif scope == "device_role":
            ok = policy.device_role_id is not None and policy.device_role_id == obj.role_id
        else:
            # A VM has no device type; nothing hardware-shaped either.
            ok = False
        return ok and filters_pass(
            policy, None, obj, device_tags=tags, device_hardware=set()
        )
    if not policy.applies_to_devices:
        return False
    hardware = ctx.hardware(obj)
    if policy.scope == "location":
        if policy.location_id not in ctx.location_chain(obj.location_id):
            return False
        return filters_pass(policy, None, obj, device_tags=tags, device_hardware=hardware)
    if policy.scope == "region":
        if policy.region_id not in ctx.region_chain(obj.site_id):
            return False
        return filters_pass(policy, None, obj, device_tags=tags, device_hardware=hardware)
    return device_matches(policy, obj, device_tags=tags, device_hardware=hardware)


# ── what one object should have ─────────────────────────────────────────────


@dataclass
class Want:
    obj: object
    #: never | always | policy | register_all - or "" when out of scope.
    via: str = ""
    #: Why an object is left out, for the preview, and the same as an issue.
    reason: str = ""
    reason_issue: dict | None = None
    policies: list = field(default_factory=list)
    profiles: list = field(default_factory=list)
    group: dict | None = None
    #: The group comes from the connection's group layout.
    layout: bool = False

    @property
    def managed(self) -> bool:
        return self.via in ("always", "policy", "register_all")


def _retired(obj) -> bool:
    status = getattr(obj, "status", None) if obj.status_id else None
    return status is not None and status.slug in RETIRED_STATUSES


def _address_excluded(obj) -> bool:
    ip = obj.primary_ip if obj.primary_ip_id else None
    return bool(ip is not None and ip.monitoring_excluded)


def _register_group(conn) -> dict | None:
    if not conn.register_group_id:
        return None
    return {"objid": conn.register_group_id, "path": conn.register_group_path,
            "source": "connection"}


def decide(conn: PrtgConnection, obj, ctx: Context, *, linked: bool,
           checked: set | None = None) -> Want:
    """Whether PRTG should have this object and why: the precedence in the
    module docstring, one object at a time."""
    want = Want(obj)

    def out(code, **values):
        want.reason_issue = issue(code, **values)
        want.reason = want.reason_issue["text"]
        return want

    sync = getattr(obj, "prtg_sync", "inherit") or "inherit"
    if sync == "never":
        want.via = "never"
        return out("excluded")
    matched = [p for p in ctx.policies if policy_matches(p, obj, ctx)]
    want.policies = matched
    if sync == "always":
        want.via = "always"
    elif _retired(obj):
        return out("retired", status=obj.status.name)
    elif _address_excluded(obj):
        return out("address_excluded")
    elif checked is not None and obj.id not in checked:
        return out("no_check")
    elif matched:
        want.via = "policy"
    elif conn.register_all and not linked:
        want.via = "register_all"
    else:
        return out("no_match" if not conn.register_all else "already_linked")
    if matched:
        seen = set()
        for policy in matched:
            if policy.profile_id and policy.profile_id not in seen:
                seen.add(policy.profile_id)
                want.profiles.append(policy.profile)
        lead = next((p for p in matched if p.group_id or p.use_layout), None)
        if lead is not None and lead.use_layout:
            want.layout = True
            want.group = _layout_group(conn, lead)
        elif lead is not None:
            want.group = {"objid": lead.group_id, "path": lead.group_path,
                          "source": "policy", "policy": lead.name,
                          "policy_id": str(lead.id)}
    if not want.profiles and ctx.register_profile is not None:
        want.profiles.append(ctx.register_profile)
    if want.group is None and not want.layout:
        if conn.group_layout != PrtgConnection.LAYOUT_NONE:
            want.layout = True
            want.group = _layout_group(conn)
        else:
            want.group = _register_group(conn)
    return want


def _layout_group(conn, policy=None) -> dict | None:
    """The layout's root as a placeholder group, until the planning pass
    works out the chain under it. None without a root."""
    from .layout import root_of

    root = root_of(conn)
    if root is None:
        return None
    out = {"objid": root["objid"], "path": root["path"], "kind": root["kind"],
           "source": "layout", "layout": True, "root": root}
    if policy is not None:
        out.update(policy=policy.name, policy_id=str(policy.id))
    return out


class LayoutPass:
    """The group layout over one planning pass: Danbyte's tree, PRTG's
    groups, and the group rows proposed so far."""

    def __init__(self, conn):
        from .layout import Groups, Tree

        self.conn = conn
        self.tree = Tree(conn.tenant)
        self.groups = Groups(conn.groups_cache or [])
        self.proposed: set = set()
        #: Every PRTG group the layout wants, by object id - kept by pruning.
        self.used: set = set()

    def place(self, obj, want) -> list:
        """Turn ``want.group`` (the root) into the object's own group and
        return the chain's steps."""
        from .layout import chain, resolve, target

        root = (want.group or {}).get("root")
        if root is None:
            return []
        layout = self.conn.group_layout
        if layout == PrtgConnection.LAYOUT_NONE:
            # A policy asked for the layout while the connection has none.
            layout = PrtgConnection.LAYOUT_SITES
        nodes = chain(self.conn, obj, self.tree, layout=layout)
        steps = resolve(root, nodes, self.groups)
        extra = {k: v for k, v in want.group.items()
                 if k in ("policy", "policy_id")}
        want.group = {**target(root, steps), **extra}
        self.used.add(root["objid"])
        self.used.update(s.objid for s in steps if s.objid)
        return steps


# ── definitions into sensors ────────────────────────────────────────────────


def _globs(pattern: str) -> list[str]:
    return [g.lower() for g in re.split(r"[,\s]+", pattern or "") if g] or ["*"]


def interfaces_for(obj, params: dict) -> list:
    """The interfaces a per-interface definition reaches: enabled, matching
    the glob (name or SNMP name, any of several separated by commas), and -
    with *connected only* - cabled or marked connected. A VM interface has
    no cable; enabled is what connected means there."""
    from api.models import Interface, VMInterface

    globs = _globs(params.get("interface") or "*")
    if _is_vm(obj):
        rows = VMInterface.objects.filter(vm=obj, enabled=True).order_by("name")
    else:
        rows = Interface.objects.filter(device=obj, enabled=True).order_by("name")
        if params.get("connected_only"):
            from django.db.models import Q

            rows = rows.filter(
                Q(mark_connected=True) | Q(terminations__isnull=False)
            ).distinct()
    out = []
    for iface in rows:
        names = {iface.name.lower(), (iface.snmp_name or "").lower()} - {""}
        if any(fnmatchcase(n, g) for n in names for g in globs):
            out.append(iface)
    from api.natural import natural_key

    return sorted(out, key=lambda i: natural_key(i.name))


def service_ports(obj) -> set:
    from api.models import Service

    rows = Service.objects.filter(**({"virtual_machine": obj} if _is_vm(obj) else {"device": obj}))
    ports: set = set()
    for svc in rows:
        for port in svc.ports or []:
            try:
                ports.add(int(port))
            except (TypeError, ValueError):
                continue
    return ports


class _Safe(dict):
    def __missing__(self, key):
        return "{" + key + "}"


def _name(defn, kind, **values) -> str:
    template = (defn.name or kind.default_name or kind.label).strip()
    return template.format_map(_Safe({k: v for k, v in values.items() if v is not None}))


def expand(defn: PrtgSensorDefinition, obj, *, host: str = "", ports=None) -> list[dict]:
    """One definition as the sensors it means for this object."""
    kind = sk.BY_VALUE.get(defn.kind)
    if kind is None:
        return expand_generic(defn)
    params = dict(defn.params or {})
    base = {
        "definition": str(defn.id), "profile": defn.profile.name, "kind": kind.value,
        "kind_label": kind.label, "required": bool(defn.required),
        "interval_seconds": defn.interval_seconds, "needs": kind.needs,
    }
    if kind.value == sk.TEMPLATE:
        return [{**base, "key": instance_tag(defn.id), "template": params.get("template", ""),
                 "name": _name(defn, kind, template=params.get("template", "")),
                 "params": params, "tags": list(defn.tags or []), "interface": None}]
    port = sk.port_of(kind.value, params)
    if params.get("require_service"):
        if ports is None:
            ports = service_ports(obj)
        if port not in ports:
            return []
    if kind.value == "http":
        scheme = params.get("scheme") or "http"
        default = 443 if scheme == "https" else 80
        suffix = f":{port}" if port and port != default else ""
        params["url"] = f"{scheme}://{host or '{host}'}{suffix}{params.get('path') or '/'}"
    if kind.per == sk.PER_INTERFACE:
        out = []
        for iface in interfaces_for(obj, params):
            tag = instance_tag(defn.id, str(iface.id))
            out.append({
                **base, "key": tag, "name": _name(defn, kind, interface=iface.name),
                "params": {**params, "interface_name": iface.name},
                "tags": [*(defn.tags or []), tag],
                "interface": {"id": str(iface.id), "name": iface.name},
            })
        return out
    tag = instance_tag(defn.id)
    return [{
        **base, "key": tag,
        "name": _name(defn, kind, service=params.get("service"), port=port),
        "params": params, "tags": [*(defn.tags or []), tag], "interface": None,
    }]


def expand_generic(defn: PrtgSensorDefinition) -> list[dict]:
    """A definition of a kind only PRTG knows: one sensor, created from
    PRTG's form as the profile filled it in - the way a sensor added by
    hand is (:meth:`prtg.writer.Writer._create_v2_generic`). A kind PRTG
    scans for gets every row its scan finds."""
    from .manual import cached_kind, needs_of, sections_of

    row = cached_kind(defn.profile.connection, defn.kind)
    label = str((row or {}).get("name") or defn.kind)
    params = dict(defn.params or {})
    tag = instance_tag(defn.id)
    return [{
        "definition": str(defn.id), "profile": defn.profile.name, "kind": defn.kind,
        "kindid": defn.kind, "kind_label": label, "required": bool(defn.required),
        "interval_seconds": defn.interval_seconds, "needs": needs_of(row),
        "key": tag, "name": (defn.name or label).strip(), "params": params,
        "sections": sections_of(params), "tags": [*(defn.tags or []), tag],
        "interface": None,
    }]


def _signature(inst: dict) -> str:
    params = {k: v for k, v in (inst.get("params") or {}).items() if k != "url"}
    return json.dumps([inst["kind"], params, (inst.get("interface") or {}).get("id")],
                      sort_keys=True, default=str)


def sensors_for(want: Want, host: str | None = None) -> list[dict]:
    """The union of the profiles' definitions, expanded, without the same
    sensor twice: two profiles that both ask for Ping give one Ping."""
    obj = want.obj
    if host is None:
        host = host_address(obj)
    ports = None
    out, seen = [], set()
    for profile in want.profiles:
        for defn in profile.definitions.all():
            if defn.kind in ("http", "ssl_certificate", "ssl_security") and ports is None:
                ports = service_ports(obj)
            for inst in expand(defn, obj, host=host, ports=ports):
                sig = _signature(inst)
                if sig in seen:
                    continue
                seen.add(sig)
                out.append(inst)
    return out


# ── per-object overrides ────────────────────────────────────────────────────


def overrides_for(conn, obj) -> dict:
    """The object's sensor overrides on this connection, by definition key."""
    return {
        o.definition_key: o
        for o in PrtgSensorOverride.objects.filter(connection=conn, **_parent(obj))
        .select_related("created_by")
    }


def split_overrides(wanted: list[dict], overrides: dict) -> tuple[list, list]:
    """``wanted`` as ``(on, off)``: a sensor turned off for the object is
    left out of what the plan proposes; one turned on counts as required."""
    on, off = [], []
    for inst in wanted:
        o = overrides.get(inst["key"])
        if o is None:
            on.append(inst)
        elif o.enabled:
            on.append({**inst, "required": True})
        else:
            off.append(inst)
    return on, off


def override_detail(o) -> dict | None:
    """An override as the coverage row shows it."""
    if o is None:
        return None
    by = o.created_by.get_username() if o.created_by_id and o.created_by else ""
    return {"enabled": o.enabled, "by": by, "at": o.updated_at, "note": o.note}


def _made_here(link, sensor) -> bool:
    return any(v.get("objid") == sensor.objid for v in (link.created_sensors or {}).values())


# ── credentials ─────────────────────────────────────────────────────────────


def snmp_credential(obj, tenant) -> dict | None:
    from monitoring.snmp_resolve import resolve_device_profile, resolve_vm_profile

    resolver = resolve_vm_profile if _is_vm(obj) else resolve_device_profile
    profile, _source = resolver(obj, tenant)
    if profile is None:
        return None
    return {"kind": "snmp", "name": profile.name, "version": profile.version}


def windows_credentials(obj) -> list[dict]:
    """The Windows logins Danbyte holds for the object, by name. Stored
    device credentials of a Windows kind, where that kind exists; a VM has
    no stored credentials of its own."""
    from monitoring.models import DeviceCredential

    kind = getattr(DeviceCredential.Kind, "WINDOWS_LOGIN", None)
    if kind is None or _is_vm(obj):
        return []
    return [
        {"kind": "windows", "name": c.name}
        for c in DeviceCredential.objects.filter(device=obj, kind=kind).order_by("name")
    ]


def _target(obj) -> dict:
    return {"kind": "virtual_machine" if _is_vm(obj) else "device", "id": str(obj.id)}


def credential_issues(obj, tenant, sensors: list[dict]) -> tuple[list, list]:
    """What would be sent with the device, by name only, and an issue per
    credential a sensor needs that Danbyte does not have."""
    needs = {s.get("needs") for s in sensors} - {None}
    creds, missing = [], []
    vm = _is_vm(obj)
    if sk.SNMP in needs:
        snmp = snmp_credential(obj, tenant)
        if snmp:
            creds.append(snmp)
        else:
            missing.append(issue("no_snmp", label=_label(obj),
                                 tab="SNMP" if vm else "Access", object=_target(obj)))
    if sk.WINDOWS in needs:
        win = windows_credentials(obj)
        if win:
            creds.extend(win)
        elif vm:
            missing.append(issue("no_windows_vm", label=_label(obj)))
        else:
            missing.append(issue("no_windows", label=_label(obj), object=_target(obj)))
    return creds, missing


def credentials_for(obj, tenant, sensors: list[dict]) -> tuple[list, list]:
    """:func:`credential_issues` with each issue as its sentence."""
    creds, missing = credential_issues(obj, tenant, sensors)
    return creds, [m["text"] for m in missing]


# ── recognising existing sensors ────────────────────────────────────────────

_TRAFFIC_NAME = re.compile(r"^\s*\(\d+\)\s*|\s+traffic\s*$", re.I)


def _sensor_iface_name(sensor) -> str:
    return _TRAFFIC_NAME.sub("", sensor.name or "").strip().lower()


def find_sensor(inst: dict, sensors: list, claimed: set):
    """The PRTG sensor already doing what this instance asks: one carrying
    its tag, else the first unclaimed sensor of a matching type (for a
    traffic sensor, on the same interface)."""
    for s in sensors:
        if s.id not in claimed and inst["key"] in (s.tags or []):
            return s
    kind = sk.BY_VALUE.get(inst["kind"])
    if kind is None:
        # A PRTG-only kind: a sensor of exactly that type.
        want = str(inst.get("kindid") or inst["kind"]).lower()
        return next((s for s in sensors
                     if s.id not in claimed and (s.kind or "").lower() == want), None)
    iface = ((inst.get("interface") or {}).get("name") or "").lower()
    for s in sensors:
        if s.id in claimed or not kind.matches_type(s.kind):
            continue
        if iface and _sensor_iface_name(s) != iface:
            continue
        return s
    return None


# ── groups ──────────────────────────────────────────────────────────────────


def read_groups(conn, client=None, now=None) -> list[dict]:
    """PRTG's probes and groups, read now and kept on the connection for the
    pickers. Raises :class:`~prtg.client.PrtgError`."""
    from .reader import client_for

    groups = (client or client_for(conn)).groups_tree()
    conn.groups_cache = groups
    conn.groups_read_at = now or timezone.now()
    conn.save(update_fields=["groups_cache", "groups_read_at"])
    return groups


def group_issue(want: Want, groups_by_id: dict) -> dict | None:
    """Why the object has no usable group: none chosen, or one PRTG no
    longer lists. Names the policy that decides the group, when one does."""
    lead = (want.group or {}).get("policy_id") or (
        str(want.policies[0].id) if want.policies else None
    )
    extra = {"policy": lead} if lead else {}
    if want.group is None:
        return issue("no_group", **extra)
    if want.group.get("layout") and not want.group.get("objid"):
        # A layout group the plan creates first.
        return None
    if want.group["objid"] not in groups_by_id:
        path = want.group.get("path") or want.group["objid"]
        return issue("group_gone", path=path, **extra)
    return None


def group_problem(want: Want, groups_by_id: dict) -> str:
    found = group_issue(want, groups_by_id)
    return found["text"] if found else ""


# ── the pass ────────────────────────────────────────────────────────────────


def load_policies(conn) -> list[PrtgPolicy]:
    return list(
        PrtgPolicy.objects.filter(connection=conn, tenant=conn.tenant, enabled=True)
        .select_related("profile")
        .prefetch_related("profile__definitions__profile")
        .order_by("priority", "name")
    )


def _objects(conn):
    from api.models import Device, VirtualMachine

    devices = (
        Device.objects.filter(tenant=conn.tenant)
        .select_related("primary_ip", "oob_ip", "status", "site", "location", "platform",
                        "role")
        .prefetch_related("tags")
    )
    vms = (
        VirtualMachine.objects.filter(tenant=conn.tenant)
        .select_related("primary_ip", "status", "site", "cluster", "device", "platform", "role")
        .prefetch_related("tags")
    )
    return [*devices, *vms]


def checked_objects(conn) -> set:
    """Objects carrying a ``prtg`` check on one of this connection's
    engines: the scope when provisioning follows checks."""
    from monitoring.models import CheckState

    from .checker import KIND

    rows = CheckState.objects.filter(
        tenant=conn.tenant, kind=KIND, engine__in=conn.engines.all()
    ).values_list("target_ip__assigned_device_id", "target_ip__assigned_vm_id")
    return {d or v for d, v in rows if d or v}


def _prepare(conn):
    from .retire import load_rules

    ctx = Context(conn.tenant, load_policies(conn))
    ctx.retire_rules = load_rules(conn)
    if conn.register_profile_id:
        ctx.register_profile = (
            PrtgSensorProfile.objects.filter(pk=conn.register_profile_id, connection=conn)
            .prefetch_related("definitions__profile").first()
        )
    checked = (
        checked_objects(conn) if conn.provision_scope == PrtgConnection.SCOPE_CHECKS else None
    )
    return ctx, checked


def has_work(conn) -> bool:
    """Whether a plan could propose anything: a policy, "register all", an
    object set to Monitor in PRTG, or a Danbyte-tagged sensor to account for."""
    from api.models import Device, VirtualMachine

    return (
        conn.register_all
        or PrtgPolicy.objects.filter(connection=conn, enabled=True).exists()
        or Device.objects.filter(tenant=conn.tenant, prtg_sync="always").exists()
        or VirtualMachine.objects.filter(tenant=conn.tenant, prtg_sync="always").exists()
        or PrtgSensor.objects.filter(connection=conn, tags__icontains=DEF_TAG).exists()
        or PrtgChange.objects.filter(connection=conn, kind__in=PrtgChange.PLANNED).exists()
        or PrtgDeviceLink.objects.filter(connection=conn, created_here=True).exists()
        or conn.group_links.filter(created_here=True).exists()
        or conn.retire_rules.exists()
        or PrtgDeviceLink.objects.filter(connection=conn, rule_paused_at__isnull=False).exists()
    )


def plan(conn: PrtgConnection, device_rows: list | None = None, *, client=None,
         now=None) -> dict:
    """Work out what PRTG should have and propose the difference.

    ``device_rows`` are the normalised PRTG device rows of the status read
    this follows (read here when not given). Raises
    :class:`~prtg.client.PrtgError` when PRTG cannot be read; nothing is
    proposed or dropped then. Writes nothing to PRTG.
    """
    from .reader import client_for

    now = now or timezone.now()
    counts = new_counts()
    if not has_work(conn):
        drop_stale(conn, set(), now)
        return counts
    client = client or client_for(conn)
    if device_rows is None:
        device_rows = client.devices().rows
    groups = read_groups(conn, client, now)
    groups_by_id = {g["objid"]: g for g in groups}
    parent_of = {str(r["objid"]): str(r.get("parent_id")) for r in device_rows}

    ctx, checked = _prepare(conn)
    links = {
        (lk.device_id or lk.virtual_machine_id): lk
        for lk in PrtgDeviceLink.objects.filter(connection=conn)
    }
    sensors_by_link: dict = {}
    for s in PrtgSensor.objects.filter(connection=conn).order_by("name", "objid"):
        sensors_by_link.setdefault(s.link_id, []).append(s)
    overrides: dict = {}
    for o in PrtgSensorOverride.objects.filter(connection=conn):
        overrides.setdefault(o.device_id or o.virtual_machine_id, {})[o.definition_key] = o
    waiting = set()
    for d, v in PrtgChange.pending(conn).filter(
        kind__in=(PrtgChange.LINK, PrtgChange.AMBIGUOUS)
    ).exclude(detail__has_key="applied").values_list("device_id", "virtual_machine_id"):
        waiting.add(d or v)

    fresh: set = set()
    no_writes = conn.write_mode == PrtgConnection.WRITE_NONE
    ctx.live = True
    with transaction.atomic():
        for obj in _objects(conn):
            link = links.get(obj.id)
            _plan_object(
                conn, obj, link=link,
                present=link is not None and link.objid in parent_of,
                ctx=ctx, checked=checked, groups_by_id=groups_by_id,
                parent_of=parent_of,
                sensors=sensors_by_link.get(link.id, []) if link else [],
                waiting=obj.id in waiting, counts=counts, fresh=fresh,
                no_writes=no_writes, overrides=overrides.get(obj.id, {}),
            )
        _plan_prune_groups(conn, ctx, groups, parent_of, counts, fresh)
        drop_stale(conn, fresh, now)
    return counts


def new_counts() -> dict:
    return {"scoped": 0, "create": 0, "add_sensor": 0, "remove_sensor": 0,
            "move": 0, "update_host": 0, "remove_device": 0, "not_applicable": 0,
            "no_address": 0, "awaiting_link": 0, "create_group": 0, "rename_group": 0,
            "remove_group": 0, "group_creds": 0, "pause": 0, "resume": 0}


def group_writes(conn) -> bool:
    """Whether this PRTG takes group writes: API v2 only."""
    return conn.write_mode == PrtgConnection.WRITE_V2 or bool(conn.v2_available)


def _plan_groups(conn, ctx, steps, counts, fresh) -> None:
    """The group rows one object's chain needs: ``create_group`` for each
    missing group, top-down, and ``rename_group`` for a group Danbyte made
    (found by its tag) whose Danbyte object was renamed. Each once a pass."""
    from .models import PrtgGroupLink

    lp = ctx.layout(conn)
    blocked = [] if group_writes(conn) else [issue("group_writes")]
    for step in steps:
        if step.key in lp.proposed:
            continue
        lp.proposed.add(step.key)
        node = step.node
        if not step.exists:
            counts["create_group"] += 1
            if blocked:
                counts["not_applicable"] += 1
            parent_path = step.path.rsplit(" / ", 1)[0]
            propose(conn, fresh, {
                "name": node.name, "kind": node.kind, "object_id": node.object_id,
                "tag": node.tag, "tags": ["danbyte", node.tag],
                "parent": {"objid": step.parent_objid, "key": step.parent_key,
                           "path": parent_path},
                "path": step.path, "depth": step.depth,
                "applicable": not blocked, "reason": " ".join(i["text"] for i in blocked),
                "issues": blocked,
            }, kind=PrtgChange.CREATE_GROUP, key=step.key)
            continue
        made = step.matched_by == "tag"
        if made and step.current_name != node.name:
            counts["rename_group"] += 1
            if blocked:
                counts["not_applicable"] += 1
            propose(conn, fresh, {
                "objid": step.objid, "kind": node.kind, "object_id": node.object_id,
                "from": step.current_name, "to": node.name, "path": step.path,
                "depth": step.depth,
                "applicable": not blocked, "reason": " ".join(i["text"] for i in blocked),
                "issues": blocked,
            }, kind=PrtgChange.RENAME_GROUP, key=step.key)
        # Keep what PRTG has on record, so the writer and pruning know it.
        PrtgGroupLink.objects.update_or_create(
            connection=conn, key=step.key,
            defaults={"tenant": conn.tenant, "objid": step.objid, "name": step.current_name,
                      "path": step.path[:500], "parent_objid": step.parent_objid,
                      "kind": node.kind, "object_id": node.object_id, "tag": node.tag},
        )


def _group_kind(conn, objid: str, known: str = "") -> str:
    """``probe`` or ``group`` for a PRTG object id, from the last group
    list: API v2 reads and writes probes and groups at different paths."""
    if known:
        return known
    for g in conn.groups_cache or []:
        if g.get("objid") == str(objid):
            return g.get("kind") or "group"
    return "group"


def _above(want, steps, conn=None) -> tuple[str, str] | None:
    """The PRTG object whose settings a new device inherits: its group, or
    for a layout group not made yet the deepest one that is there."""
    group = want.group or {}
    if group.get("objid"):
        kind = group.get("kind") or (_group_kind(conn, group["objid"]) if conn else "group")
        return group["objid"], kind
    for step in reversed(steps):
        if step.exists:
            return step.objid, "group"
    root = group.get("root") or {}
    if root.get("objid"):
        return root["objid"], root.get("kind") or "group"
    return None


def _by_profile(entry: dict) -> dict:
    by = entry.get("by") or {}
    out = {}
    if by.get("profile"):
        out["profile"] = by["profile"]
    if by.get("policy"):
        out["policy"] = by["policy"]
    return out


def _inherit_issues(conn, ctx, placement: dict, above, *, kind_hint=None) -> list:
    """``credentials_missing`` for each section left to inheritance that
    PRTG has set nowhere above ``above`` - read live in the full plan, from
    the last read otherwise."""
    from .credentials import INHERIT, cached_effective, read_effective, section_label

    sections = [s for s, e in placement.items() if e.get("mode", INHERIT) == INHERIT]
    if not sections or above is None:
        return []
    objid, kind = above
    if ctx.live:
        state = read_effective(conn, objid, kind_hint or kind, sections, v2=ctx.v2,
                               cache=ctx.reads) or {}
    else:
        state = cached_effective(conn, objid)
    out = []
    for name in sections:
        if (state.get(name) or {}).get("set") is False:
            out.append(issue("credentials_missing", label=section_label(name),
                             section=name, **_by_profile(placement[name])))
    return out


def _unplaced(missing: list, placement: dict) -> list:
    """Drop "Danbyte holds no SNMP profile / Windows login" for a section
    the profile places with a credential of its own choosing."""
    from .credentials import GROUP, INHERIT

    section = {"no_snmp": "snmpversiongroup", "no_windows": "windowsconnection",
               "no_windows_vm": "windowsconnection"}
    out = []
    for m in missing:
        entry = placement.get(section.get(m.get("code"), ""), {})
        mode = entry.get("mode", INHERIT)
        if mode == GROUP or (mode != INHERIT and (entry.get("credential")
                                                  or entry.get("snmp_profile"))):
            continue
        out.append(m)
    return out


def _unsaid(placement: dict, missing: list) -> dict:
    """The placement less sections an issue already speaks for (Danbyte
    holds no SNMP profile or Windows login): one sentence per problem."""
    said = {{"no_snmp": "snmpversiongroup", "no_windows": "windowsconnection",
             "no_windows_vm": "windowsconnection"}.get(m.get("code")) for m in missing}
    return {k: v for k, v in placement.items() if k not in said}


def _device_placement(obj, placement: dict) -> tuple[list, list]:
    """The sections set on the device itself, by name, and an issue for
    each Danbyte has nothing to send for."""
    from .credentials import DEVICE, section_label, values_for

    names, issues = [], []
    for name, entry in placement.items():
        if entry.get("mode") != DEVICE:
            continue
        values, source = values_for(name, entry, obj)
        if values:
            names.append({"section": name, "label": section_label(name), "credential": source})
        else:
            issues.append(issue("no_credential", label=section_label(name), where="device",
                                section=name, **_by_profile(entry)))
    return names, issues


def _credential_name(entry: dict) -> str:
    from monitoring.models import SnmpProfile

    from .models import PrtgCredential

    if entry.get("credential"):
        row = PrtgCredential.objects.filter(pk=entry["credential"]).values("name").first()
        return row["name"] if row else ""
    if entry.get("snmp_profile"):
        row = SnmpProfile.objects.filter(pk=entry["snmp_profile"]).values("name").first()
        return f"SNMP {row['name']}" if row else ""
    return ""


def _placement_detail(placement: dict) -> list:
    from .credentials import section_label

    return [{"section": name, "label": section_label(name), "mode": entry.get("mode"),
             "credential": _credential_name(entry), "by": entry.get("by") or {},
             "entry": {k: v for k, v in entry.items() if k != "by"}}
            for name, entry in placement.items()]


def _plan_group_credentials(conn, obj, want, steps, placement, counts, fresh) -> None:
    """``group_creds`` for the sections a profile sets on the device's
    group, when what Danbyte would write differs from what it wrote there
    last (a keyed hash per section). One row per group, every object's
    sections merged; the first object's choice for a section wins."""
    from .credentials import GROUP, section_label, values_for
    from .models import PrtgGroupLink
    from .writer import credentials_hash

    entries = {s: e for s, e in placement.items() if e.get("mode") == GROUP}
    group = want.group or {}
    if not entries or not (group.get("objid") or group.get("key")):
        return
    gkey = group.get("key") or f"objid:{group['objid']}"
    link = PrtgGroupLink.objects.filter(connection=conn, key=gkey).first()
    done = dict((link.credential_hashes if link else None) or {})
    rows = PrtgChange.objects.filter(connection=conn, kind=PrtgChange.GROUP_CREDENTIALS,
                                     key=f"c:{gkey}"[:64]).first()
    seen = rows.id in fresh if rows is not None else False
    detail = dict(rows.detail or {}) if seen else {}
    sections = {s["section"]: s for s in detail.get("sections") or []}
    kept = dict(detail.get("entries") or {})
    issues = list(detail.get("issues") or []) if seen else []
    for name, entry in entries.items():
        if name in sections:
            continue
        values, source = values_for(name, entry)
        if not values:
            issues.append(issue("no_credential", label=section_label(name), where="group",
                                section=name, **_by_profile(entry)))
            continue
        digest = credentials_hash(values)
        if done.get(name) == digest:
            continue
        sections[name] = {"section": name, "label": section_label(name),
                          "credential": source, "hash": digest}
        kept[name] = {k: v for k, v in entry.items() if k != "by"}
    if not sections and not issues:
        return
    if not group_writes(conn):
        issues.append(issue("group_writes"))
    if not seen:
        counts["group_creds"] += 1
        if issues:
            counts["not_applicable"] += 1
    path = group.get("path") or ""
    propose(conn, fresh, {
        "group": {"objid": group.get("objid", ""), "key": gkey, "path": path,
                  "kind": _group_kind(conn, group.get("objid", ""), group.get("kind") or ""),
                  "created_here": bool(link and link.created_here)},
        "sections": list(sections.values()), "entries": kept,
        "depth": path.count(" / ") + 1,
        "applicable": not issues, "reason": " ".join(i["text"] for i in issues),
        "issues": issues,
    }, kind=PrtgChange.GROUP_CREDENTIALS, key=f"c:{gkey}"[:64])


def _plan_prune_groups(conn, ctx, groups, parent_of, counts, fresh) -> None:
    """With Propose removing devices on: a group Danbyte made (its tag and
    its record) that no object wants any more and that holds nothing is
    proposed for removal."""
    from .layout import GROUP_TAG
    from .models import PrtgGroupLink

    if not conn.prune_devices:
        return
    used = ctx.layout_pass.used if ctx.layout_pass is not None else set()
    occupied = set(parent_of.values()) | {str(g.get("parent_id") or "") for g in groups}
    made = {gl.objid: gl for gl in PrtgGroupLink.objects.filter(
        connection=conn, created_here=True).exclude(objid="")}
    for g in groups:
        if g.get("kind") != "group" or g["objid"] in used or g["objid"] in occupied:
            continue
        link = made.get(g["objid"])
        if link is None or not any(t.startswith(GROUP_TAG) for t in g.get("tags") or []):
            continue
        counts["remove_group"] += 1
        propose(conn, fresh, {
            "objid": g["objid"], "name": g.get("name", ""), "path": g.get("path", ""),
            "kind": link.kind, "reason": TEXT["empty_group"], "applicable": True,
            "depth": g.get("path", "").count(" / "),
        }, kind=PrtgChange.REMOVE_GROUP, key=link.key)


def _plan_object(conn, obj, *, link, present, ctx, checked, groups_by_id, parent_of,
                 sensors, waiting, counts, fresh, no_writes, overrides=None) -> None:
    """One object of the planning pass: propose its rows into ``fresh``.
    ``present`` is whether PRTG still has the linked device; ``waiting``
    whether a link or ambiguity for it waits in the queue; ``overrides``
    the object's sensor overrides by definition key."""
    from .retire import plan_rules

    # Retirement rules first: a rule that claims the object leaves nothing
    # for registration to plan. "Exclude from PRTG" does not stop them.
    if ctx.retire_rules or (link is not None and link.rule_paused_at is not None):
        if plan_rules(conn, obj, link=link, present=present, rules=ctx.retire_rules,
                      tags=ctx.tags(obj), counts=counts, fresh=fresh, propose=propose,
                      parent=_parent(obj), no_writes=no_writes):
            return
    # A device Danbyte created is still wanted by "register all":
    # register all only skips what was in PRTG already.
    want = decide(conn, obj, ctx,
                  linked=link is not None and not link.created_here,
                  checked=checked)
    if link is not None and present and link.created_here and not want.managed:
        if conn.prune_devices:
            counts["remove_device"] += 1
            propose(conn, fresh, {
                "objid": link.objid, "name": link.name,
                "group": link.group_path,
                "reason": want.reason or "Set to Exclude from PRTG.",
                "applicable": True,
            }, **_parent(obj), kind=PrtgChange.REMOVE_DEVICE, key="")
        return
    if want.via == "never":
        return
    host, source = host_choice(obj) if want.managed else ("", "")
    wanted, off = split_overrides(
        sensors_for(want, host) if want.managed else [], overrides or {}
    )
    steps = []
    if want.managed and want.layout and want.group is not None:
        steps = ctx.layout(conn).place(obj, want)
        if not waiting and (link is None or (present and link.created_here)):
            _plan_groups(conn, ctx, steps, counts, fresh)
    placement = {}
    if want.managed:
        from .credentials import needed_sections, placement_for

        placement = placement_for(want, needed_sections(conn, wanted))
        if link is None or present:
            _plan_group_credentials(conn, obj, want, steps, placement, counts, fresh)
    if link is not None and present:
        _plan_linked(conn, obj, link, want, wanted,
                     sensors, parent_of,
                     groups_by_id, counts, fresh, no_writes, off=off,
                     ctx=ctx, placement=placement)
        if want.managed:
            _plan_host(conn, obj, link, host, source, counts, fresh, no_writes)
        if want.managed:
            counts["scoped"] += 1
        return
    if not want.managed or link is not None:
        return
    counts["scoped"] += 1
    if waiting:
        counts["awaiting_link"] += 1
        return
    # A blocked create is proposed all the same, as Needs attention with
    # what blocks it, and turns Ready on the pass after the fix.
    issues = []
    if not host:
        counts["no_address"] += 1
        issues.append(issue("no_address", object=_target(obj)))
    problem = group_issue(want, groups_by_id)
    if problem:
        issues.append(problem)
    creds, missing = credential_issues(obj, conn.tenant, wanted)
    missing = _unplaced(missing, placement)
    issues.extend(missing)
    on_device, cred_issues = _device_placement(obj, placement)
    issues.extend(cred_issues)
    issues.extend(_inherit_issues(conn, ctx, _unsaid(placement, missing),
                                  _above(want, steps, conn)))
    if no_writes:
        issues.append(issue("no_writes"))
    reasons = [i["text"] for i in issues]
    group = dict(want.group or {})
    group.pop("root", None)
    found = groups_by_id.get(group.get("objid"))
    if found:
        group.update(path=found["path"], kind=found["kind"])
    detail = {
        "name": obj.name, "host": host, "host_source": source,
        "host_note": host_note(host, source), "group": group or None,
        "via": want.via,
        "policies": [{"id": str(p.id), "name": p.name} for p in want.policies],
        "profiles": [p.name for p in want.profiles],
        "sensors": [_sensor_detail(i) for i in wanted if not i.get("template")],
        "templates": [i["template"] for i in wanted if i.get("template")],
        "credentials": creds,
        "placement": _placement_detail(placement),
        "device_credentials": on_device,
        "tags": ["danbyte", f"danbyte-{obj.id}"],
        "applicable": not reasons, "reason": " ".join(reasons),
        "issues": issues,
    }
    if reasons:
        counts["not_applicable"] += 1
    counts["create"] += 1
    propose(conn, fresh, detail, **_parent(obj),
            kind=PrtgChange.CREATE_DEVICE, key="")


def _plan_host(conn, obj, link, host, source, counts, fresh, no_writes) -> None:
    """A device Danbyte created on a fallback host (OOB, first assigned
    address, DNS name) whose object now has a stronger one - a primary
    address set later - gets ``update_host``."""
    if not (link.created_here and host and link.host_source in FALLBACK_SOURCES):
        return
    order = list(HOST_SOURCES)
    if order.index(source) >= order.index(link.host_source) or host == link.host:
        return
    issues = [issue("no_writes")] if no_writes else []
    counts["update_host"] += 1
    if issues:
        counts["not_applicable"] += 1
    propose(conn, fresh, {
        "objid": link.objid, "name": link.name,
        "from": {"host": link.host, "source": link.host_source},
        "host": host, "host_source": source, "host_note": host_note(host, source),
        "applicable": not issues, "reason": " ".join(i["text"] for i in issues),
        "issues": issues,
    }, **_parent(obj), kind=PrtgChange.UPDATE_HOST, key="")



class _Unread(dict):
    """No group list read yet: a picked group counts as present - it was
    picked from PRTG's list - until a read says otherwise."""

    def __contains__(self, key) -> bool:
        return True


def plan_object(conn: PrtgConnection, obj, *, now=None) -> dict:
    """The planning pass for one device or VM, from what Danbyte holds - the
    stored link, its sensors and the last group list. PRTG is not asked.

    Proposes and drops only this object's rows. A pending move is kept:
    where PRTG has the device now is only known from a read. Runs when an
    object's PRTG setting changes, and before Add to PRTG now."""
    from datetime import timedelta

    now = now or timezone.now()
    counts = new_counts()
    ctx, checked = _prepare(conn)
    parent = _parent(obj)
    link = PrtgDeviceLink.objects.filter(connection=conn, **parent).first()
    sensors = (
        list(PrtgSensor.objects.filter(link=link).order_by("name", "objid")) if link else []
    )
    waiting = PrtgChange.pending(conn).filter(
        kind__in=(PrtgChange.LINK, PrtgChange.AMBIGUOUS), **parent
    ).exclude(detail__has_key="applied").exists()
    groups = conn.groups_cache or []
    groups_by_id = {g["objid"]: g for g in groups} if groups else _Unread()
    fresh: set = set()
    with transaction.atomic():
        _plan_object(
            conn, obj, link=link, present=link is not None, ctx=ctx, checked=checked,
            groups_by_id=groups_by_id, parent_of={}, sensors=sensors, waiting=waiting,
            counts=counts, fresh=fresh,
            no_writes=conn.write_mode == PrtgConnection.WRITE_NONE,
            overrides=overrides_for(conn, obj),
        )
        PrtgChange.pending(conn).filter(kind__in=PrtgChange.PLANNED, **parent).exclude(
            id__in=fresh
        ).exclude(kind=PrtgChange.MOVE_DEVICE).exclude(
            detail__has_key="applied",
            updated_at__gte=now - timedelta(hours=APPLIED_KEEP_HOURS),
        ).delete()
    return counts


#: How long a queued apply counts as running before the plan stops saying so.
QUEUED_APPLY_SECONDS = 600


def plan_after_save(obj) -> dict | None:
    """Plan one device or VM right after its PRTG setting changed, on every
    enabled connection of its tenant; with Apply automatically on, queue an
    apply of its ready rows after commit, so the save does not wait on PRTG.

    Returns ``{"state", "connections", "object", "issue"}`` for the form's
    toast - ``state`` is ``applying``, ``planned``, ``attention``,
    ``excluded`` or ``none``; ``issue`` the first thing blocking a row that
    needs attention - or None while the integration is off. Never raises: a save must not fail
    over a plan; the beat plans the object later anyway."""
    from integrations.toggles import integration_enabled

    from .writer import ready

    tenant = obj.tenant
    if tenant is None or not integration_enabled(tenant, "prtg"):
        return None
    names, applying_now, planned, attention = [], False, False, False
    first_issue = None
    for conn in PrtgConnection.objects.filter(tenant=tenant, enabled=True).order_by("name"):
        try:
            plan_object(conn, obj)
            rows = list(PrtgChange.pending(conn).filter(
                kind__in=PrtgChange.PLANNED, **_parent(obj)
            ))
            ok = [r for r in rows if ready(r)]
            if ok and conn.auto_apply_registration and conn.api_key_set:
                queue_apply(conn, obj, ok)
                applying_now = True
            elif ok:
                planned = True
            elif blocked := [r for r in rows if not (r.detail or {}).get("applied")]:
                attention = True
                # The device row first: nothing else lands before it.
                blocked.sort(key=lambda r: r.kind != PrtgChange.CREATE_DEVICE)
                for r in blocked:
                    found = (r.detail or {}).get("issues") or []
                    if first_issue is None and found:
                        first_issue = found[0]
        except Exception:  # noqa: BLE001
            log.exception("prtg plan on save failed for %s", obj.pk)
            continue
        names.append(conn.name)
    if getattr(obj, "prtg_sync", "inherit") == "never":
        state = "excluded"
    elif applying_now:
        state = "applying"
    elif planned:
        state = "planned"
    elif attention:
        state = "attention"
    else:
        state = "none"
    return {"state": state, "connections": names, "object": _target(obj),
            "issue": first_issue if state == "attention" else None}


def queue_apply(conn, obj, rows) -> None:
    """Mark ``rows`` as being applied and queue
    :func:`prtg.writer.run_apply_object` for the object, after commit."""
    import django_rq

    from .writer import run_apply_object

    at = timezone.now().isoformat()
    for row in rows:
        row.detail = {**(row.detail or {}), "queued_apply": at}
        row.save(update_fields=["detail", "updated_at"])
    args = (str(conn.id), "virtual_machine" if _is_vm(obj) else "device", str(obj.pk))

    def _go():
        try:
            django_rq.get_queue("low").enqueue(run_apply_object, *args, job_timeout=900)
        except Exception:  # noqa: BLE001 - the beat's apply picks it up
            log.exception("prtg apply on save could not be queued")

    transaction.on_commit(_go)


def applying(conn, obj, now=None) -> bool:
    """Whether an apply of this object's rows was queued in the last few
    minutes and has not finished."""
    from datetime import datetime

    now = now or timezone.now()
    for d in PrtgChange.pending(conn).filter(
        kind__in=PrtgChange.PLANNED, detail__has_key="queued_apply", **_parent(obj)
    ).values_list("detail", flat=True):
        try:
            at = datetime.fromisoformat(d["queued_apply"])
        except (TypeError, ValueError):
            continue
        if not d.get("applied") and (now - at).total_seconds() < QUEUED_APPLY_SECONDS:
            return True
    return False

def _sensor_detail(inst: dict) -> dict:
    return {
        "key": inst["key"], "definition": inst["definition"], "profile": inst["profile"],
        "kind": inst["kind"], "kind_label": inst["kind_label"], "name": inst["name"],
        "params": inst["params"], "interval_seconds": inst["interval_seconds"],
        "tags": inst["tags"], "required": inst["required"],
        "interface": inst.get("interface"),
        # A PRTG-only kind: what the writer's generic create needs.
        **({"kindid": inst["kindid"], "sections": inst.get("sections") or {}}
           if inst.get("kindid") else {}),
    }


def _plan_linked(conn, obj, link, want, wanted, sensors, parent_of, groups_by_id,
                 counts, fresh, no_writes=False, off=(), *, ctx=None,
                 placement=None) -> None:
    """A linked object: missing required sensors, Danbyte sensors nothing
    wants any more, and a group that differs. ``off`` are the wanted
    sensors turned off for the object: never proposed, and one Danbyte
    made is proposed for removal only when the connection prunes."""
    claimed: set = set()
    missing = []
    created = dict(link.created_sensors or {})
    present_objids = {s.objid for s in sensors}
    for inst in wanted:
        if inst.get("template"):
            # A template cannot be read back; it is what a new device gets.
            continue
        found = find_sensor(inst, sensors, claimed)
        if found is not None:
            claimed.add(found.id)
            continue
        # One Danbyte made and somebody deleted in PRTG is wanted again,
        # required or not.
        deleted = inst["key"] in created and created[inst["key"]].get(
            "objid"
        ) not in present_objids
        if inst["required"] or deleted:
            missing.append((inst, deleted))
    placement = placement or {}
    for inst, deleted in missing:
        issues = []
        if inst.get("needs"):
            _, issues = credential_issues(obj, conn.tenant, [inst])
            issues = _unplaced(issues, placement)
        mine = {}
        on_device = []
        if placement:
            from .credentials import sections_of

            mine = {s: placement[s] for s in sections_of(conn, inst.get("kindid")
                                                           or inst["kind"]) if s in placement}
            on_device, found = _device_placement(obj, mine)
            issues.extend(found)
            if ctx is not None and mine:
                issues.extend(_inherit_issues(conn, ctx, _unsaid(mine, issues),
                                              (link.objid, "device")))
        if no_writes:
            issues.append(issue("no_writes"))
        reasons = [i["text"] for i in issues]
        counts["add_sensor"] += 1
        if reasons:
            counts["not_applicable"] += 1
        propose(conn, fresh, {
            "objid": link.objid, "device_name": link.name,
            "definition": {"id": inst["definition"], "profile": inst["profile"],
                           "kind": inst["kind"], "kind_label": inst["kind_label"]},
            "sensor": _sensor_detail(inst),
            "interface": inst.get("interface"),
            "applicable": not reasons,
            "reason": " ".join(reasons) or ("Deleted in PRTG." if deleted else ""),
            "issues": issues,
            "deleted_in_prtg": deleted,
            "placement": _placement_detail(mine),
            "device_credentials": on_device,
        }, **_parent(obj), kind=PrtgChange.ADD_SENSOR, key=inst["key"])
    # Forget sensors Danbyte made that nothing wants and PRTG no longer has.
    wanted_keys = {i["key"] for i in wanted}
    stale = [k for k, v in created.items()
             if k not in wanted_keys and v.get("objid") not in present_objids]
    if stale:
        for k in stale:
            created.pop(k)
        link.created_sensors = created
        link.save(update_fields=["created_sensors"])

    keys = {i["key"] for i in wanted}
    off_keys = {i["key"] for i in off}
    for s in sensors:
        ours = [t for t in (s.tags or []) if t.startswith(DEF_TAG)]
        if not ours or any(t in keys for t in ours):
            continue
        made = any(v.get("objid") == s.objid for v in created.values())
        turned_off = any(t in off_keys for t in ours)
        if turned_off and not (made and conn.prune_devices):
            # Turned off for this object: left in PRTG unless Danbyte made
            # it and the connection prunes.
            continue
        counts["remove_sensor"] += 1
        if not made:
            counts["not_applicable"] += 1
        reason = (TEXT["sensor_off"] if turned_off
                  else TEXT["unwanted_sensor"] if made else TEXT["not_created_sensor"])
        propose(conn, fresh, {
            "objid": link.objid, "device_name": link.name,
            "sensor": {"objid": s.objid, "name": s.name, "kind": s.kind_label or s.kind},
            "tag": ours[0],
            "reason": reason,
            "issues": [] if made else [issue("not_created_sensor")],
            "applicable": made,
        }, **_parent(obj), kind=PrtgChange.REMOVE_SENSOR, key=s.objid)

    if not want.managed or want.group is None:
        return
    target = want.group["objid"]
    current = parent_of.get(link.objid, "")
    if not current or current == target:
        return
    if want.layout and not link.created_here:
        # The layout moves only devices Danbyte created.
        return
    if want.layout and not target:
        # Into a layout group the plan creates first.
        counts["move"] += 1
        frm = groups_by_id.get(current)
        propose(conn, fresh, {
            "objid": link.objid, "name": link.name,
            "from": {"objid": current, "path": frm["path"] if frm else link.group_path},
            "to": {"objid": "", "key": want.group.get("key", ""),
                   "path": want.group.get("path", ""), "kind": "group"},
            "applicable": True, "reason": "", "issues": [],
        }, **_parent(obj), kind=PrtgChange.MOVE_DEVICE, key="")
        return
    if target not in groups_by_id:
        found = group_issue(want, groups_by_id)
        issues = [found] if found else []
        problem = found["text"] if found else ""
        to = {"objid": target, "path": want.group.get("path", ""), "kind": ""}
    else:
        problem, issues = "", []
        to = {"objid": target, "path": groups_by_id[target]["path"],
              "kind": groups_by_id[target]["kind"]}
    frm = groups_by_id.get(current)
    counts["move"] += 1
    if problem:
        counts["not_applicable"] += 1
    propose(conn, fresh, {
        "objid": link.objid, "name": link.name,
        "from": {"objid": current, "path": frm["path"] if frm else link.group_path},
        "to": to,
        "applicable": not problem, "reason": problem, "issues": issues,
    }, **_parent(obj), kind=PrtgChange.MOVE_DEVICE, key="")


# ── one object, for the preview ─────────────────────────────────────────────


#: The registration decision's ``via`` as the plan's ``registration.mode``.
MODES = {"never": "never", "always": "always", "policy": "policies",
         "register_all": "register_all", "": "none"}


def preview(conn: PrtgConnection, obj) -> dict:
    """What PRTG has and would get for one device or VM from this
    connection, from the stored link, sensors, queue and group list - PRTG
    is not asked and nothing is written.

    Four separate answers: ``linked`` (is it in PRTG - the stored link,
    however it was made), ``managed`` (Danbyte created that PRTG device),
    ``registration`` (what registers it, if anything) and ``planned`` (what
    the next plan would propose). Being in PRTG never depends on the
    registration decision."""
    ctx, checked = _prepare(conn)
    link = PrtgDeviceLink.objects.filter(connection=conn, **_parent(obj)).first()
    want = decide(conn, obj, ctx, linked=link is not None and not link.created_here,
                  checked=checked)
    groups_by_id = {g["objid"]: g for g in (conn.groups_cache or [])}
    overrides = overrides_for(conn, obj)
    every = sensors_for(want) if want.managed else []
    wanted, off = split_overrides(every, overrides)
    off_keys = {i["key"] for i in off}
    sensors = list(PrtgSensor.objects.filter(link=link).order_by("name")) if link else []
    claimed: set = set()
    found_by_key: dict = {}
    for inst in wanted:
        found = None if inst.get("template") else find_sensor(inst, sensors, claimed)
        if found is not None:
            claimed.add(found.id)
        found_by_key[inst["key"]] = found
    for inst in off:
        # One turned off is only still there when a sensor carries its tag.
        found = next(
            (s for s in sensors if s.id not in claimed and inst["key"] in (s.tags or [])),
            None,
        )
        if found is not None:
            claimed.add(found.id)
        found_by_key[inst["key"]] = found
    rows, matches = [], []
    by_key = {i["key"]: i for i in [*wanted, *off]}
    for inst in (by_key[i["key"]] for i in every):
        found = found_by_key.get(inst["key"])
        matches.append((inst, found))
        rows.append({
            **_sensor_detail(inst), "template": inst.get("template", ""),
            "present": found is not None, "off": inst["key"] in off_keys,
            "sensor": {"objid": found.objid, "name": found.name} if found else None,
        })
    steps = []
    if want.managed and want.layout and want.group is not None:
        steps = ctx.layout(conn).place(obj, want)
    placement_rows = []
    if want.managed:
        from .credentials import (
            cached_effective,
            describe,
            needed_sections,
            placement_for,
            section_label,
        )

        placement = placement_for(want, needed_sections(conn, wanted))
        above = (link.objid, "device") if link is not None else _above(want, steps, conn)
        state = cached_effective(conn, above[0]) if above else {}
        for row in _placement_detail(placement):
            st = state.get(row["section"]) if row["mode"] == "inherit" else None
            placement_rows.append({**row, "state": st,
                                   "text": describe(st, section_label(row["section"]))})
    creds, issues = credential_issues(obj, conn.tenant, wanted)
    group = dict(want.group or {}) or None
    if group:
        group.pop("root", None)
    if group and group["objid"] in groups_by_id:
        group.update(path=groups_by_id[group["objid"]]["path"],
                     kind=groups_by_id[group["objid"]]["kind"])
    if want.managed and link is None:
        problem = group_issue(want, groups_by_id) if groups_by_id else (
            None if want.group else group_issue(want, {})
        )
        if problem:
            issues.append(problem)
        if not host_choice(obj)[0]:
            issues.append(issue("no_address", object=_target(obj)))

    # A linked object nothing registers is simply left alone: "nothing
    # registers this object" would read as "not in PRTG".
    reason_issue = want.reason_issue
    if link is not None and reason_issue and reason_issue["code"] in (
        "no_match", "already_linked"
    ):
        reason_issue = None
    planned_sensors = [
        {"key": r["key"], "name": r["name"], "kind": r["kind"],
         "kind_label": r["kind_label"], "interface": r["interface"]}
        for r in rows
        if not r["template"] and not r["present"] and not r["off"]
        and (link is None or r["required"])
    ]
    keys = {r["key"] for r in rows if not r["off"]}
    remove = [
        {"objid": s.objid, "name": s.name, "kind": s.kind_label or s.kind}
        for s in (sensors if want.via != "never" else [])
        if (ours := [t for t in (s.tags or []) if t.startswith(DEF_TAG)])
        and not any(t in keys for t in ours)
        and (not any(t in off_keys for t in ours)
             or (conn.prune_devices and _made_here(link, s)))
    ]
    queue = PrtgChange.pending(conn).filter(kind__in=PrtgChange.PLANNED, **_parent(obj))
    move = None
    if link is not None and want.managed:
        row = queue.filter(kind=PrtgChange.MOVE_DEVICE).first()
        if row is not None:
            move = {"from": (row.detail or {}).get("from"), "to": (row.detail or {}).get("to")}
    from .writer import change_status, ready

    rows_now = list(queue)
    return {
        "connection": {"id": str(conn.id), "name": conn.name,
                       "auto_apply": conn.auto_apply_registration,
                       "write_mode": conn.write_mode},
        "prtg_sync": getattr(obj, "prtg_sync", "inherit"),
        "linked": (
            {"objid": link.objid, "name": link.name, "host": link.host,
             "group": link.group_path, "matched_by": link.matched_by,
             "created_here": link.created_here, "created_at": link.created_at,
             "sent_tags": list(link.sent_tags or []),
             "url": conn.device_url(link.objid)} if link else None
        ),
        "managed": bool(link is not None and link.created_here),
        "registers": want.managed,
        "registration": {
            "mode": MODES.get(want.via, "none"),
            "policies": [{"id": str(p.id), "name": p.name} for p in want.policies],
            "group": group,
        },
        "planned": {
            "create_device": want.managed and link is None,
            "sensors": planned_sensors,
            "move": move,
            "remove": remove,
            "reasons": [reason_issue] if reason_issue else [],
            "queued": len(rows_now),
            # Rows Add to PRTG now would write, and how the rest stand.
            "ready": sum(1 for r in rows_now if ready(r)),
            "statuses": sorted({change_status(r) for r in rows_now}),
            "applying": applying(conn, obj),
        },
        "via": want.via, "reason": reason_issue["text"] if reason_issue else "",
        "reason_issue": reason_issue,
        "group": group,
        "policies": [{"id": str(p.id), "name": p.name} for p in want.policies],
        "profiles": [p.name for p in want.profiles],
        "sensors": rows,
        "credentials": creds,
        "credential_placement": placement_rows,
        "problems": [i["text"] for i in issues],
        "issues": issues,
        "last_apply": _last_apply(conn, obj, link),
        "coverage": coverage(conn, obj, want, link, matches, sensors, issues, group,
                             overrides=overrides),
    }


#: Why a wanted sensor is not in PRTG, when no queue row says.
COVERAGE_TEXT = {
    "dismissed": "Dismissed in the review queue.",
    "optional": "Optional: only added with a new PRTG device.",
    "unplanned": "Not planned yet. The next planning pass proposes it.",
    "applied": "Applied. It shows after the next status read.",
    "off": "Off for this device.",
    "off_kept": "Off for this device. Danbyte leaves the sensor in PRTG.",
    "off_remove": "Off for this device. Removing it waits in the review queue.",
}


def _sensor_origin(sensor) -> str:
    """Who made a PRTG sensor no definition wants: ``manual`` (added by
    hand in Danbyte), ``danbyte`` (an old definition) or ``prtg``."""
    from .manual import MANUAL_TAG

    tags = sensor.tags or []
    if MANUAL_TAG in tags:
        return "manual"
    if any(t.startswith(DEF_TAG) for t in tags):
        return "danbyte"
    return "prtg"


def _row_state(row, inst_issues: list) -> dict:
    """A wanted sensor's state from the queue row that would write it."""
    from .writer import change_status

    d = row.detail or {}
    out = {"change_id": str(row.id)}
    if row.ignored:
        return {**out, "status": "skipped", "reason": COVERAGE_TEXT["dismissed"]}
    if d.get("applied"):
        return {"status": "planned", "reason": COVERAGE_TEXT["applied"]}
    status = change_status(row)
    if status == "failed":
        err = d.get("last_error") or {}
        return {**out, "status": "failed", "reason": err.get("detail") or "",
                "issue": err.get("issue")}
    if status == "attention":
        found = inst_issues or d.get("issues") or []
        first = found[0] if found else None
        return {**out, "status": "waiting",
                "reason": (first or {}).get("text") or d.get("reason") or "",
                "issue": first}
    return {**out, "status": "planned"}


def coverage(conn, obj, want: Want, link, matches: list, sensors: list,
             object_issues: list, group: dict | None = None, *,
             overrides: dict | None = None) -> dict:
    """Per wanted sensor, where it stands - ``present`` (PRTG has it, by
    tag or by kind as the planner decides), ``planned`` (a ready queue
    row), ``failed`` (the last apply failed), ``waiting`` (not applicable
    yet, with the issue) or ``skipped`` (dismissed, or optional on a device
    that already exists) - plus the PRTG sensors on the linked device no
    definition wants, by origin. A sensor turned off for the object is
    ``off``, with ``override`` saying who and when, and is not counted.
    Read from what :func:`preview` already loaded and one queue query."""
    overrides = overrides or {}
    profile_of: dict = {}
    for profile in want.profiles:
        for defn in profile.definitions.all():
            profile_of.setdefault(str(defn.id), profile)
    policy_of: dict = {}
    for policy in want.policies:
        if policy.profile_id:
            policy_of.setdefault(policy.profile_id, policy)
    queue = {
        (r.kind, r.key): r
        for r in PrtgChange.objects.filter(
            connection=conn,
            kind__in=(PrtgChange.ADD_SENSOR, PrtgChange.CREATE_DEVICE,
                      PrtgChange.REMOVE_SENSOR),
            **_parent(obj),
        )
    }
    create = queue.get((PrtgChange.CREATE_DEVICE, ""))
    created = dict(link.created_sensors or {}) if link else {}
    present_objids = {s.objid for s in sensors}
    items = []
    for inst, found in matches:
        if inst.get("template"):
            continue
        profile = profile_of.get(inst["definition"])
        policy = policy_of.get(profile.id) if profile is not None else None
        item = {
            "key": inst["key"], "definition": inst["definition"],
            "profile": ({"id": str(profile.id), "name": profile.name}
                        if profile is not None else None),
            "policy": {"id": str(policy.id), "name": policy.name} if policy else None,
            "name": inst["name"], "kind": inst["kind"], "kind_label": inst["kind_label"],
            "required": inst["required"], "interface": inst.get("interface"),
            "override": override_detail(overrides.get(inst["key"])),
        }
        o = overrides.get(inst["key"])
        if o is not None and not o.enabled:
            state = {"status": "off", "reason": COVERAGE_TEXT["off"]}
            if found is not None:
                state.update(sensor_id=str(found.id), sensor_objid=found.objid)
                row = queue.get((PrtgChange.REMOVE_SENSOR, found.objid))
                if row is not None and not row.ignored:
                    state.update(reason=COVERAGE_TEXT["off_remove"], change_id=str(row.id))
                else:
                    state["reason"] = COVERAGE_TEXT["off_kept"]
            items.append({**item, **state})
            continue
        if found is not None:
            items.append({**item, "status": "present", "sensor_id": str(found.id),
                          "sensor_objid": found.objid})
            continue
        inst_issues = (credential_issues(obj, conn.tenant, [inst])[1]
                       if inst.get("needs") else [])
        if link is not None:
            row = queue.get((PrtgChange.ADD_SENSOR, inst["key"]))
            deleted = inst["key"] in created and created[inst["key"]].get(
                "objid"
            ) not in present_objids
            if row is not None:
                state = _row_state(row, inst_issues)
            elif not inst["required"] and not deleted:
                state = {"status": "skipped", "reason": COVERAGE_TEXT["optional"]}
            elif inst_issues:
                state = {"status": "waiting", "reason": inst_issues[0]["text"],
                         "issue": inst_issues[0]}
            else:
                state = {"status": "waiting", "reason": COVERAGE_TEXT["unplanned"]}
        elif create is not None:
            state = _row_state(create, inst_issues)
        else:
            first = (inst_issues or object_issues or [None])[0]
            state = {"status": "waiting",
                     "reason": first["text"] if first else COVERAGE_TEXT["unplanned"],
                     "issue": first}
        items.append({**item, **state})
    claimed = {i.get("sensor_id") for i in items}
    extra = [
        {"sensor_id": str(s.id), "objid": s.objid, "name": s.name,
         "kind_label": s.kind_label or s.kind, "origin": _sensor_origin(s)}
        for s in sensors if str(s.id) not in claimed
    ]
    return {
        "policies": [
            {"id": str(p.id), "name": p.name,
             "profile": ({"id": str(p.profile_id), "name": p.profile.name}
                         if p.profile_id else None)}
            for p in want.policies
        ],
        "group": group,
        "wanted": items,
        "present": sum(1 for i in items if i["status"] == "present"),
        "extra": extra,
    }


def _last_apply(conn, obj, link) -> dict | None:
    """What Danbyte last wrote to PRTG for this object: the link's record,
    or a pending create's last attempt."""
    if link is not None and link.last_apply:
        return link.last_apply
    change = PrtgChange.objects.filter(
        connection=conn, kind=PrtgChange.CREATE_DEVICE, **_parent(obj)
    ).first()
    if change is None:
        return None
    entries = (change.detail or {}).get("log") or []
    if not entries:
        return None
    last = entries[-1]
    return {"at": last.get("at"), "kind": change.kind, "ok": last.get("ok"),
            "detail": last.get("detail"), "result": (change.detail or {}).get("result") or {},
            "by": last.get("by")}


# ── the starter profile ─────────────────────────────────────────────────────

STARTER_NAME = "Starter profile"
STARTER = (
    ("ping", "", {}, True),
    ("snmp_uptime", "", {}, True),
    ("snmp_traffic", "", {"interface": "*", "connected_only": True}, True),
    ("http", "HTTPS", {"scheme": "https", "port": 443, "path": "/",
                       "require_service": True}, True),
)


def make_starter(conn: PrtgConnection) -> PrtgSensorProfile:
    """A sensible first profile, made on request and editable like any
    other: Ping, SNMP uptime, SNMP traffic on connected interfaces, and
    HTTPS where the object has a service on 443. Nothing is seeded."""
    names = set(
        PrtgSensorProfile.objects.filter(connection=conn).values_list("name", flat=True)
    )
    name, n = STARTER_NAME, 2
    while name in names:
        name, n = f"{STARTER_NAME} {n}", n + 1
    with transaction.atomic():
        profile = PrtgSensorProfile.objects.create(
            tenant=conn.tenant, connection=conn, name=name,
            description="Ping, SNMP uptime, traffic on connected interfaces, "
                        "HTTPS where a service listens on 443.",
        )
        for position, (kind, label, params, required) in enumerate(STARTER):
            PrtgSensorDefinition.objects.create(
                profile=profile, position=position, kind=kind, name=label,
                params=sk.clean_params(kind, params), required=required,
            )
    return profile


def run_plan(connection_id: str) -> dict:
    """The planning pass as an RQ job, re-checking every switch at run time."""
    from monitoring.external.beat import skip_reason

    from .client import PrtgError

    conn = PrtgConnection.objects.filter(pk=connection_id).select_related("tenant").first()
    reason = skip_reason(conn, "prtg")
    if reason:
        return {"skipped": reason}
    if not (conn.enabled and conn.api_key_set):
        return {"skipped": "connection off"}
    now = timezone.now()
    try:
        counts = plan(conn, now=now)
    except PrtgError as exc:
        counts = {"error": str(exc)[:300]}
    stamp(conn, now, counts)
    return counts


def stamp(conn, now, counts) -> None:
    conn.last_plan_at = now
    conn.last_plan_summary = counts
    conn.save(update_fields=["last_plan_at", "last_plan_summary"])
