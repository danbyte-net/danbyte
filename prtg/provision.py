"""What PRTG should have: registration, sensor profiles and the plan.

Danbyte decides, per connection, which of the tenant's devices and VMs PRTG
should monitor, under which PRTG group or probe, and with which sensors. The
planning pass compares that with what the status read found - the links and
the imported sensors - and writes the difference into the review queue as
**planned** changes. Nothing here writes to PRTG: applying a planned change is
refused until the writes arrive.

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
#: The sentence every apply of a planned change answers with.
NOT_YET = "Writing to PRTG arrives in the next release."


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
    #: Why an object is left out, for the preview.
    reason: str = ""
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
    sync = getattr(obj, "prtg_sync", "inherit") or "inherit"
    if sync == "never":
        want.via, want.reason = "never", "Set to Exclude from PRTG."
        return want
    matched = [p for p in ctx.policies if policy_matches(p, obj, ctx)]
    want.policies = matched
    if sync == "always":
        want.via = "always"
    elif _retired(obj):
        want.reason = f"Status {obj.status.name} is left out."
        return want
    elif _address_excluded(obj):
        want.reason = "Its primary address is excluded from monitoring."
        return want
    elif checked is not None and obj.id not in checked:
        want.reason = "No PRTG check on this connection's engines."
        return want
    elif matched:
        want.via = "policy"
    elif conn.register_all and not linked:
        want.via = "register_all"
    else:
        want.reason = (
            "No policy matches." if not conn.register_all
            else "Already in PRTG; Register all only adds devices."
        )
        return want
    if matched:
        seen = set()
        for policy in matched:
            if policy.profile_id and policy.profile_id not in seen:
                seen.add(policy.profile_id)
                want.profiles.append(policy.profile)
        lead = next((p for p in matched if p.group_id), None)
        if lead is not None:
            want.group = {"objid": lead.group_id, "path": lead.group_path,
                          "source": "policy", "policy": lead.name}
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


def credentials_for(obj, tenant, sensors: list[dict]) -> tuple[list, list]:
    """What would be sent with the device, by name only, and a sentence per
    credential a sensor needs that Danbyte does not have."""
    needs = {s.get("needs") for s in sensors} - {None}
    creds, missing = [], []
    if sk.SNMP in needs:
        snmp = snmp_credential(obj, tenant)
        if snmp:
            creds.append(snmp)
        else:
            missing.append(f"SNMP sensors need an SNMP profile; none applies to {_label(obj)}.")
    if sk.WINDOWS in needs:
        win = windows_credentials(obj)
        if win:
            creds.extend(win)
        else:
            missing.append(
                f"WMI sensors need a Windows login; Danbyte holds none for {_label(obj)}."
            )
    return creds, missing


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


def group_problem(want: Want, groups_by_id: dict) -> str:
    if want.group is None:
        return "No PRTG group to create it in: give the policy or Register all one."
    if want.group["objid"] not in groups_by_id:
        path = want.group.get("path") or want.group["objid"]
        return f"PRTG has no group {path} any more."
    return ""


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
              "move": 0, "not_applicable": 0, "no_address": 0, "awaiting_link": 0}
    if not has_work(conn):
        PrtgChange.pending(conn).filter(kind__in=PrtgChange.PLANNED).delete()
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
    with transaction.atomic():
        for obj in _objects(conn):
            link = links.get(obj.id)
            present = link is not None and link.objid in parent_of
            want = decide(conn, obj, ctx, linked=link is not None, checked=checked)
            if want.via == "never":
                continue
            wanted = sensors_for(want) if want.managed else []
            if link is not None and present:
                _plan_linked(conn, obj, link, want, wanted,
                             sensors_by_link.get(link.id, []), parent_of,
                             groups_by_id, counts, fresh)
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
            reasons = []
            problem = group_problem(want, groups_by_id)
            if problem:
                reasons.append(problem)
            creds, missing = credentials_for(obj, conn.tenant, wanted)
            reasons.extend(missing)
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
            }
            if reasons:
                counts["not_applicable"] += 1
            counts["create"] += 1
            PrtgChange.propose(conn, fresh, detail, **_parent(obj),
                               kind=PrtgChange.CREATE_DEVICE, key="")
        PrtgChange.pending(conn).filter(kind__in=PrtgChange.PLANNED).exclude(
            id__in=fresh
        ).delete()
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
                 counts, fresh) -> None:
    """A linked object: missing required sensors, Danbyte sensors nothing
    wants any more, and a group that differs."""
    claimed: set = set()
    missing = []
    for inst in wanted:
        if inst.get("template"):
            # A template cannot be read back; it is what a new device gets.
            continue
        found = find_sensor(inst, sensors, claimed)
        if found is not None:
            claimed.add(found.id)
            continue
        if inst["required"]:
            missing.append(inst)
    for inst in missing:
        reasons = []
        if inst.get("needs"):
            _, gaps = credentials_for(obj, conn.tenant, [inst])
            reasons.extend(gaps)
        counts["add_sensor"] += 1
        if reasons:
            counts["not_applicable"] += 1
        PrtgChange.propose(conn, fresh, {
            "objid": link.objid, "device_name": link.name,
            "definition": {"id": inst["definition"], "profile": inst["profile"],
                           "kind": inst["kind"], "kind_label": inst["kind_label"]},
            "sensor": _sensor_detail(inst),
            "interface": inst.get("interface"),
            "applicable": not reasons, "reason": " ".join(reasons),
        }, **_parent(obj), kind=PrtgChange.ADD_SENSOR, key=inst["key"])

    keys = {i["key"] for i in wanted}
    for s in sensors:
        ours = [t for t in (s.tags or []) if t.startswith(DEF_TAG)]
        if not ours or any(t in keys for t in ours):
            continue
        counts["remove_sensor"] += 1
        PrtgChange.propose(conn, fresh, {
            "objid": link.objid, "device_name": link.name,
            "sensor": {"objid": s.objid, "name": s.name, "kind": s.kind_label or s.kind},
            "tag": ours[0],
            "reason": "Danbyte made this sensor and no profile wants it any more.",
            "applicable": True,
        }, **_parent(obj), kind=PrtgChange.REMOVE_SENSOR, key=s.objid)

    if not want.managed or want.group is None:
        return
    target = want.group["objid"]
    current = parent_of.get(link.objid, "")
    if not current or current == target:
        return
    if target not in groups_by_id:
        problem = group_problem(want, groups_by_id)
        to = {"objid": target, "path": want.group.get("path", ""), "kind": ""}
    else:
        problem = ""
        to = {"objid": target, "path": groups_by_id[target]["path"],
              "kind": groups_by_id[target]["kind"]}
    frm = groups_by_id.get(current)
    counts["move"] += 1
    if problem:
        counts["not_applicable"] += 1
    PrtgChange.propose(conn, fresh, {
        "objid": link.objid, "name": link.name,
        "from": {"objid": current, "path": frm["path"] if frm else link.group_path},
        "to": to,
        "applicable": not problem, "reason": problem,
    }, **_parent(obj), kind=PrtgChange.MOVE_DEVICE, key="")


# ── one object, for the preview ─────────────────────────────────────────────


def preview(conn: PrtgConnection, obj) -> dict:
    """What PRTG would get for one device or VM from this connection, from
    the stored link, sensors and group list - PRTG is not asked and nothing
    is written."""
    ctx, checked = _prepare(conn)
    link = PrtgDeviceLink.objects.filter(connection=conn, **_parent(obj)).first()
    want = decide(conn, obj, ctx, linked=link is not None, checked=checked)
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
    creds, missing = credentials_for(obj, conn.tenant, wanted)
    group = dict(want.group or {}) or None
    if group and group["objid"] in groups_by_id:
        group.update(path=groups_by_id[group["objid"]]["path"],
                     kind=groups_by_id[group["objid"]]["kind"])
    problems = list(missing)
    if want.managed and link is None:
        problem = group_problem(want, groups_by_id) if groups_by_id else (
            "" if want.group else group_problem(want, {})
        )
        if problem:
            problems.append(problem)
        if not host_address(obj):
            problems.append("It has no primary address for PRTG to reach.")
    return {
        "connection": {"id": str(conn.id), "name": conn.name},
        "prtg_sync": getattr(obj, "prtg_sync", "inherit"),
        "managed": want.managed, "via": want.via, "reason": want.reason,
        "linked": (
            {"objid": link.objid, "name": link.name, "group": link.group_path,
             "url": conn.device_url(link.objid)} if link else None
        ),
        "group": group,
        "policies": [{"id": str(p.id), "name": p.name} for p in want.policies],
        "profiles": [p.name for p in want.profiles],
        "sensors": rows,
        "credentials": creds,
        "problems": problems,
    }


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
