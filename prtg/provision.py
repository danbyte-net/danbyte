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
_KEPT = ("result", "log", "last_error")
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
    "no_address": "It has no primary address. Set one so PRTG can reach it.",
    "unwanted_sensor": "Danbyte made this sensor and no profile wants it any more.",
    "not_created_sensor": "It carries a Danbyte tag, but Danbyte did not create it. "
                          "Remove it in PRTG if it should go.",
    "no_writes": "This PRTG cannot create objects through its API. Name a seed device "
                 "on the connection, or use PRTG 26.2.120 or later.",
}
_TEXT_ONLY = ("status", "label", "tab")


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


def host_address(obj) -> str:
    ip = getattr(obj, "primary_ip", None) if obj.primary_ip_id else None
    return str(ip.ip_address).split("/")[0] if ip is not None else ""


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
        self._regions: dict = {}
        self._locations: dict = {}

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
        lead = next((p for p in matched if p.group_id), None)
        if lead is not None:
            want.group = {"objid": lead.group_id, "path": lead.group_path,
                          "source": "policy", "policy": lead.name,
                          "policy_id": str(lead.id)}
    if not want.profiles and ctx.register_profile is not None:
        want.profiles.append(ctx.register_profile)
    if want.group is None:
        want.group = _register_group(conn)
    return want


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
        return []
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


def _signature(inst: dict) -> str:
    params = {k: v for k, v in (inst.get("params") or {}).items() if k != "url"}
    return json.dumps([inst["kind"], params, (inst.get("interface") or {}).get("id")],
                      sort_keys=True, default=str)


def sensors_for(want: Want) -> list[dict]:
    """The union of the profiles' definitions, expanded, without the same
    sensor twice: two profiles that both ask for Ping give one Ping."""
    obj = want.obj
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
        return None
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
        .select_related("primary_ip", "status", "site", "location", "platform", "role")
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
    ctx = Context(conn.tenant, load_policies(conn))
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
    counts = {"scoped": 0, "create": 0, "add_sensor": 0, "remove_sensor": 0,
              "move": 0, "remove_device": 0, "not_applicable": 0, "no_address": 0,
              "awaiting_link": 0}
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
    waiting = set()
    for d, v in PrtgChange.pending(conn).filter(
        kind__in=(PrtgChange.LINK, PrtgChange.AMBIGUOUS)
    ).values_list("device_id", "virtual_machine_id"):
        waiting.add(d or v)

    fresh: set = set()
    no_writes = conn.write_mode == PrtgConnection.WRITE_NONE
    with transaction.atomic():
        for obj in _objects(conn):
            link = links.get(obj.id)
            present = link is not None and link.objid in parent_of
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
                continue
            if want.via == "never":
                continue
            wanted = sensors_for(want) if want.managed else []
            if link is not None and present:
                _plan_linked(conn, obj, link, want, wanted,
                             sensors_by_link.get(link.id, []), parent_of,
                             groups_by_id, counts, fresh, no_writes)
                if want.managed:
                    counts["scoped"] += 1
                continue
            if not want.managed or link is not None:
                continue
            counts["scoped"] += 1
            if obj.id in waiting:
                counts["awaiting_link"] += 1
                continue
            host = host_address(obj)
            if not host:
                counts["no_address"] += 1
                continue
            issues = []
            problem = group_issue(want, groups_by_id)
            if problem:
                issues.append(problem)
            creds, missing = credential_issues(obj, conn.tenant, wanted)
            issues.extend(missing)
            if no_writes:
                issues.append(issue("no_writes"))
            reasons = [i["text"] for i in issues]
            group = dict(want.group or {})
            if group.get("objid") in groups_by_id:
                found = groups_by_id[group["objid"]]
                group.update(path=found["path"], kind=found["kind"])
            detail = {
                "name": obj.name, "host": host, "group": group or None,
                "via": want.via,
                "policies": [{"id": str(p.id), "name": p.name} for p in want.policies],
                "profiles": [p.name for p in want.profiles],
                "sensors": [_sensor_detail(i) for i in wanted if not i.get("template")],
                "templates": [i["template"] for i in wanted if i.get("template")],
                "credentials": creds,
                "tags": ["danbyte", f"danbyte-{obj.id}"],
                "applicable": not reasons, "reason": " ".join(reasons),
                "issues": issues,
            }
            if reasons:
                counts["not_applicable"] += 1
            counts["create"] += 1
            propose(conn, fresh, detail, **_parent(obj),
                    kind=PrtgChange.CREATE_DEVICE, key="")
        drop_stale(conn, fresh, now)
    return counts


def _sensor_detail(inst: dict) -> dict:
    return {
        "key": inst["key"], "definition": inst["definition"], "profile": inst["profile"],
        "kind": inst["kind"], "kind_label": inst["kind_label"], "name": inst["name"],
        "params": inst["params"], "interval_seconds": inst["interval_seconds"],
        "tags": inst["tags"], "required": inst["required"],
        "interface": inst.get("interface"),
    }


def _plan_linked(conn, obj, link, want, wanted, sensors, parent_of, groups_by_id,
                 counts, fresh, no_writes=False) -> None:
    """A linked object: missing required sensors, Danbyte sensors nothing
    wants any more, and a group that differs."""
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
    for inst, deleted in missing:
        issues = []
        if inst.get("needs"):
            _, issues = credential_issues(obj, conn.tenant, [inst])
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
    for s in sensors:
        ours = [t for t in (s.tags or []) if t.startswith(DEF_TAG)]
        if not ours or any(t in keys for t in ours):
            continue
        counts["remove_sensor"] += 1
        made = any(v.get("objid") == s.objid for v in created.values())
        if not made:
            counts["not_applicable"] += 1
        propose(conn, fresh, {
            "objid": link.objid, "device_name": link.name,
            "sensor": {"objid": s.objid, "name": s.name, "kind": s.kind_label or s.kind},
            "tag": ours[0],
            "reason": TEXT["unwanted_sensor"] if made else TEXT["not_created_sensor"],
            "issues": [] if made else [issue("not_created_sensor")],
            "applicable": made,
        }, **_parent(obj), kind=PrtgChange.REMOVE_SENSOR, key=s.objid)

    if not want.managed or want.group is None:
        return
    target = want.group["objid"]
    current = parent_of.get(link.objid, "")
    if not current or current == target:
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
    wanted = sensors_for(want) if want.managed else []
    sensors = list(PrtgSensor.objects.filter(link=link).order_by("name")) if link else []
    claimed: set = set()
    rows = []
    for inst in wanted:
        found = None if inst.get("template") else find_sensor(inst, sensors, claimed)
        if found is not None:
            claimed.add(found.id)
        rows.append({
            **_sensor_detail(inst), "template": inst.get("template", ""),
            "present": found is not None,
            "sensor": {"objid": found.objid, "name": found.name} if found else None,
        })
    creds, issues = credential_issues(obj, conn.tenant, wanted)
    group = dict(want.group or {}) or None
    if group and group["objid"] in groups_by_id:
        group.update(path=groups_by_id[group["objid"]]["path"],
                     kind=groups_by_id[group["objid"]]["kind"])
    if want.managed and link is None:
        problem = group_issue(want, groups_by_id) if groups_by_id else (
            None if want.group else group_issue(want, {})
        )
        if problem:
            issues.append(problem)
        if not host_address(obj):
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
        if not r["template"] and not r["present"] and (link is None or r["required"])
    ]
    keys = {r["key"] for r in rows}
    remove = [
        {"objid": s.objid, "name": s.name, "kind": s.kind_label or s.kind}
        for s in (sensors if want.via != "never" else [])
        if (ours := [t for t in (s.tags or []) if t.startswith(DEF_TAG)])
        and not any(t in keys for t in ours)
    ]
    queue = PrtgChange.pending(conn).filter(kind__in=PrtgChange.PLANNED, **_parent(obj))
    move = None
    if link is not None and want.managed:
        row = queue.filter(kind=PrtgChange.MOVE_DEVICE).first()
        if row is not None:
            move = {"from": (row.detail or {}).get("from"), "to": (row.detail or {}).get("to")}
    return {
        "connection": {"id": str(conn.id), "name": conn.name},
        "prtg_sync": getattr(obj, "prtg_sync", "inherit"),
        "linked": (
            {"objid": link.objid, "name": link.name, "host": link.host,
             "group": link.group_path, "matched_by": link.matched_by,
             "created_here": link.created_here, "created_at": link.created_at,
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
            "queued": queue.count(),
        },
        "via": want.via, "reason": reason_issue["text"] if reason_issue else "",
        "reason_issue": reason_issue,
        "group": group,
        "policies": [{"id": str(p.id), "name": p.name} for p in want.policies],
        "profiles": [p.name for p in want.profiles],
        "sensors": rows,
        "credentials": creds,
        "problems": [i["text"] for i in issues],
        "issues": issues,
        "last_apply": _last_apply(conn, obj, link),
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
