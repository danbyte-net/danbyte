"""Application flow requirements: flows with variable ends.

A requirement (``ApplicationFlowRequirement``) says what an application
needs - "the hosts of WMS client to the hosts of Broker, TCP 5672" - without
naming addresses. :func:`resolve` documents it as ordinary
``ApplicationFlow`` rows, one per pair of addresses, marked ``generated`` and
linked back to the requirement and to the installs behind their host ends.

Resolution is idempotent: it locks the requirement, builds the wanted set
``{binding_key: spec}`` (less the exclusions), creates what is missing,
updates the drifted rows' fields nobody overrode, deletes what no longer
applies and *releases* (keeps as hand-made, with a journal note) an obsolete
row someone edited. A second run writes nothing; the partial unique
``(requirement, binding_key)`` catches a race that gets past the lock.

Every query is pinned to the requirement's tenant. The rows are written per
row through the ORM, so the change log records each with the triggering
user, ``request_id`` and an ``audit.context.cause``.

Triggers (:func:`connect_signals`): installs, IP addresses, a device's or
VM's primary address or site, and a service's address mark the affected
requirements dirty for the transaction; :func:`flush` resolves them after
commit - inline when the estimated pairs to touch are
:data:`INLINE_PAIRS` or fewer, else on the ``default`` RQ queue
(:func:`enqueue_resolve`). The nightly ``reconcile_flow_requirements`` sweep
heals writes that skip signals.
"""
from __future__ import annotations

import hashlib
import logging
import threading
import uuid
from dataclasses import dataclass, field

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

log = logging.getLogger(__name__)

#: Work at or under this many estimated pairs runs in the request.
INLINE_PAIRS = 250
#: The fields a generated row may carry an override for.
OVERRIDABLE = ("protocol", "ports", "direction", "status", "service")
#: Spec keys the resolver writes, by the override name that freezes them.
_SPEC_OVERRIDE = {"protocol": "protocol", "ports": "ports", "direction": "direction",
                  "status_id": "status", "service_id": "service"}
_SIDES = ("source", "destination")


def warn_pairs() -> int:
    """The preview warns above this many pairs."""
    return int(getattr(settings, "FLOW_REQUIREMENT_WARN_PAIRS", 500))


def max_pairs() -> int:
    """A requirement resolving to more pairs is refused (Unresolved)."""
    return int(getattr(settings, "FLOW_REQUIREMENT_MAX_PAIRS", 5000))


# ─── expansion ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Host:
    kind: str  # "d" (device) or "v" (virtual machine)
    id: str
    name: str
    site_id: str | None

    @property
    def key(self) -> str:
        return f"{self.kind}:{self.id}"

    def ref(self) -> dict:
        return {"kind": "device" if self.kind == "d" else "vm", "id": self.id,
                "name": self.name}


@dataclass
class End:
    """One usable end of a pair: a host's address, or a fixed end."""

    token: str
    label: str
    host: Host | None = None
    install_id: str | None = None
    ip_id: str | None = None
    range_id: str | None = None
    prefix_id: str | None = None
    any: bool = False
    address: str = ""
    service_id: str | None = None


@dataclass
class Side:
    ends: list[End] = field(default_factory=list)
    hosts: list[Host] = field(default_factory=list)
    gaps: list[dict] = field(default_factory=list)
    #: A host side whose application is installed nowhere.
    empty: bool = False
    application_name: str = ""


def host_of_install(inst) -> Host:
    if inst.device_id:
        d = inst.device
        return Host("d", str(d.pk), d.name, str(d.site_id) if d.site_id else None)
    v = inst.virtual_machine
    return Host("v", str(v.pk), v.name, str(v.site_id) if v.site_id else None)


def _family_ok(address: str, family: str) -> bool:
    if family == "ipv4":
        return ":" not in address
    if family == "ipv6":
        return ":" in address
    return True


def _family_label(family: str) -> str:
    return {"ipv4": "IPv4", "ipv6": "IPv6"}.get(family, "")


def _host_addresses(tenant_id, hosts: list[Host], extra_ids) -> tuple[dict, dict]:
    """``({host key: [(ip id, address, role id)]}, {ip id: (address, role)})``
    for the hosts' assigned addresses (directly or through an interface),
    plus the addresses ``extra_ids`` name (primary and service addresses)."""
    from .models import IPAddress

    dev = [h.id for h in hosts if h.kind == "d"]
    vms = [h.id for h in hosts if h.kind == "v"]
    extra = [i for i in extra_ids if i]
    if not (dev or vms or extra):
        return {}, {}
    q = Q(pk__in=extra)
    if dev:
        q |= Q(assigned_device_id__in=dev) | Q(assigned_interface__device_id__in=dev)
    if vms:
        q |= Q(assigned_vm_id__in=vms) | Q(assigned_vm_interface__vm_id__in=vms)
    rows = (
        IPAddress.objects.filter(tenant_id=tenant_id).filter(q)
        .values_list("pk", "ip_address", "role_id", "assigned_device_id",
                     "assigned_interface__device_id", "assigned_vm_id",
                     "assigned_vm_interface__vm_id")
        .order_by("ip_address", "pk")
    )
    by_host: dict = {}
    by_id: dict = {}
    devs, vmset = set(dev), set(vms)
    for pk, addr, role, d1, d2, v1, v2 in rows:
        pk, addr = str(pk), str(addr)
        by_id[pk] = (addr, str(role) if role else None)
        owners = set()
        for d in (d1, d2):
            if d and str(d) in devs:
                owners.add(f"d:{d}")
        for v in (v1, v2):
            if v and str(v) in vmset:
                owners.add(f"v:{v}")
        for o in owners:
            lst = by_host.setdefault(o, [])
            if all(x[0] != pk for x in lst):
                lst.append((pk, addr, str(role) if role else None))
    return by_host, by_id


def _host_primary(inst) -> str | None:
    h = inst.device if inst.device_id else inst.virtual_machine
    pid = getattr(h, "primary_ip_id", None)
    return str(pid) if pid else None


def _expand_hosts(req, side: str, application) -> Side:
    """A host end: every install of ``application`` in the tenant, then its
    host, then the addresses ``<side>_address`` picks."""
    from .models import InstalledSoftware

    out = Side(application_name=application.name if application else "")
    if application is None:
        out.empty = True
        return out
    mode = getattr(req, f"{side}_address") or ("primary" if getattr(req, f"{side}_kind")
                                                == "self" else "service")
    role_id = getattr(req, f"{side}_address_role_id")
    role_id = str(role_id) if role_id else None
    family = req.family or "any"
    installs = list(
        InstalledSoftware.objects.filter(tenant_id=req.tenant_id, application_id=application.pk)
        .select_related("device", "virtual_machine", "service")
        .order_by("created_at", "pk")
    )
    if not installs:
        out.empty = True
        return out
    first: dict = {}
    for inst in installs:
        h = host_of_install(inst)
        if h.key not in first:
            first[h.key] = (h, inst)
    hosts = [h for h, _i in first.values()]
    extra = []
    for _h, inst in first.values():
        extra.append(_host_primary(inst))
        if inst.service_id and inst.service.ip_address_id:
            extra.append(str(inst.service.ip_address_id))
    by_host, by_id = _host_addresses(req.tenant_id, hosts, extra)
    out.hosts = sorted(hosts, key=lambda h: (h.name.lower(), h.id))
    for h in out.hosts:
        inst = first[h.key][1]
        assigned = by_host.get(h.key, [])
        picked: list[tuple[str, str]] = []
        service_id = None
        reason = ""
        if mode in ("primary", "service"):
            pid = None
            if mode == "service" and inst.service_id:
                service_id = str(inst.service_id)
                sip = inst.service.ip_address_id
                if sip and str(sip) in by_id:
                    pid = str(sip)
            if pid is None:
                pid = _host_primary(inst)
                if pid is not None and pid not in by_id:
                    pid = None
            if pid is None and len(assigned) == 1:
                pid = assigned[0][0]
            if pid is not None:
                picked = [(pid, by_id[pid][0])]
            else:
                reason = "no primary address" if assigned else "no address"
        elif mode == "role":
            picked = [(i, a) for i, a, r in assigned if role_id and r == role_id]
            if not picked:
                reason = "no address with the role"
        else:  # all
            picked = [(i, a) for i, a, _r in assigned]
            if not picked:
                reason = "no address"
        if picked:
            kept = [(i, a) for i, a in picked if _family_ok(a, family)]
            if not kept:
                reason = f"no {_family_label(family)} address"
            picked = kept
        if not picked:
            out.gaps.append({"side": side, "host": h, "reason": reason})
            continue
        for ip_id, addr in picked:
            out.ends.append(End(
                token=f"{h.key}:{ip_id}", label=h.name, host=h, install_id=str(inst.pk),
                ip_id=ip_id, address=addr, service_id=service_id,
            ))
    return out


def _range_label(r) -> str:
    return f"{r.start_address}-{r.end_address}"


def _expand_fixed(req, side: str) -> Side:
    kind = getattr(req, f"{side}_kind")
    out = Side()
    if kind == "any":
        out.ends.append(End(token="any", label="Any", any=True, address="any"))
        return out
    obj = getattr(req, f"{side}_{kind}")
    if obj is None:
        return out
    if kind == "ip":
        label = str(obj.ip_address)
        out.ends.append(End(token=f"ip:{obj.pk}", label=label, ip_id=str(obj.pk),
                            address=label))
    elif kind == "range":
        label = _range_label(obj)
        out.ends.append(End(token=f"range:{obj.pk}", label=label, range_id=str(obj.pk),
                            address=label))
    else:
        label = str(obj.cidr)
        out.ends.append(End(token=f"prefix:{obj.pk}", label=label, prefix_id=str(obj.pk),
                            address=label))
    return out


def expand_side(req, side: str) -> Side:
    kind = getattr(req, f"{side}_kind")
    if kind == "self":
        return _expand_hosts(req, side, req.application)
    if kind == "app":
        return _expand_hosts(req, side, getattr(req, f"{side}_application"))
    return _expand_fixed(req, side)


@dataclass
class Plan:
    """What a requirement resolves to, before any write."""

    src: Side
    dst: Side
    pairs: list[tuple[End, End]]
    too_many: bool
    count: int

    @property
    def gaps(self) -> list[dict]:
        return self.src.gaps + self.dst.gaps

    def hosts(self) -> set[str]:
        return {h.key for h in self.src.hosts} | {h.key for h in self.dst.hosts}


def plan(req) -> Plan:
    """Expand both ends and pair them: never a host with itself, and with
    ``same_site`` only hosts at one site. Stops counting past the cap."""
    src, dst = expand_side(req, "source"), expand_side(req, "destination")
    limit = max_pairs()
    pairs: list = []
    count = 0
    too_many = False
    same_site = req.pairing == "same_site"
    for s in src.ends:
        for d in dst.ends:
            if s.host and d.host:
                if s.host.key == d.host.key:
                    continue
                if same_site and (s.host.site_id is None or s.host.site_id != d.host.site_id):
                    continue
            count += 1
            if count > limit:
                too_many = True
                break
            pairs.append((s, d))
        if too_many:
            break
    return Plan(src, dst, [] if too_many else pairs, too_many, count)


def state_of(req, p: Plan) -> tuple[str, str]:
    """``(state, detail)`` for a plan."""
    if p.too_many:
        return "unresolved", (f"Too many pairs (over {max_pairs()}); narrow with "
                              "pairing or address.")
    self_sides = [s for side, s in zip(_SIDES, (p.src, p.dst), strict=True)
                  if getattr(req, f"{side}_kind") == "self"]
    if any(s.empty for s in self_sides):
        return "idle", f"{req.application.name} is not installed anywhere."
    for side, s in zip(_SIDES, (p.src, p.dst), strict=True):
        if getattr(req, f"{side}_kind") == "app" and s.empty:
            return "unresolved", f"{s.application_name} is not installed anywhere."
    if p.gaps:
        n = len({g["host"].key for g in p.gaps})
        return "partial", f"{n} host{'s' if n != 1 else ''} without a usable address."
    return "resolved", ""


# ─── the wanted rows ────────────────────────────────────────────────────────


def _hash4(key: str) -> str:
    return hashlib.sha1(key.encode()).hexdigest()[:4]


def _pair_group(e: End) -> str:
    return e.host.key if e.host else e.token


def wanted_rows(req, p: Plan, *, status_id=None) -> dict:
    """``{binding_key: spec}`` for the plan's pairs - the fields of each
    generated flow - with names unique within the application."""
    from .models import ApplicationFlow

    groups: dict = {}
    for s, d in p.pairs:
        k = (_pair_group(s), _pair_group(d))
        groups[k] = groups.get(k, 0) + 1
    dst_service = (req.destination_kind in ("self", "app")
                   and (req.destination_address or ("primary" if req.destination_kind == "self"
                                                    else "service")) == "service")
    taken = set(
        ApplicationFlow.objects.filter(application_id=req.application_id)
        .exclude(requirement_id=req.pk).values_list("name", flat=True)
    ) if req.pk else set()
    used: set = set()
    out: dict = {}
    for s, d in sorted(p.pairs, key=lambda sd: (sd[0].label.lower(), sd[1].label.lower(),
                                                 sd[0].address, sd[1].address)):
        key = f"{s.token}|{d.token}"
        name = f"{req.name}: {s.label} → {d.label}"
        if groups[(_pair_group(s), _pair_group(d))] > 1:
            name += f" ({s.address} → {d.address})"
        if len(name) > 128 or name in taken or name in used:
            name = f"{name[:121]} #{_hash4(key)}"
        used.add(name)
        out[key] = {
            "name": name,
            "source_ip_id": s.ip_id, "source_range_id": s.range_id,
            "source_prefix_id": s.prefix_id, "source_any": s.any,
            "destination_ip_id": d.ip_id, "destination_range_id": d.range_id,
            "destination_prefix_id": d.prefix_id, "destination_any": d.any,
            "source_install_id": s.install_id, "destination_install_id": d.install_id,
            "protocol": req.protocol, "ports": req.ports or "", "direction": req.direction,
            "status_id": status_id,
            "service_id": d.service_id if dst_service else None,
        }
    return out


def _default_status_id(req):
    from .models import Status

    if req.status_id:
        return req.status_id
    return (Status.objects.filter(tenant_id=req.tenant_id,
                                  default_for__contains=["applicationflow"])
            .values_list("pk", flat=True).first())


def _same(a, b) -> bool:
    return (str(a) if a is not None else None) == (str(b) if b is not None else None)


# ─── resolve ────────────────────────────────────────────────────────────────


def _journal(tenant_id, object_type: str, obj, text: str, kind: str = "info") -> None:
    from audit.context import current_user
    from audit.models import JournalEntry
    from audit.site_capture import entry_site_id

    user = current_user()
    JournalEntry.objects.create(
        tenant_id=tenant_id, created_by=user if getattr(user, "pk", None) else None,
        author_name=(user.get_username() if getattr(user, "pk", None) else "Danbyte"),
        object_type=object_type, object_id=str(obj.pk),
        object_site_id=entry_site_id(obj) if object_type == "api.applicationflow" else None,
        kind=kind, comments=text,
    )


def _release(flow, req_name: str) -> None:
    """Keep an edited row as a hand-made flow. Its name stays the generated
    one (``name_generated``) until someone renames it."""
    flow.requirement = None
    flow.generated = False
    flow.binding_key = ""
    flow.source_install = None
    flow.destination_install = None
    flow.overridden_fields = []
    flow.save(update_fields=["requirement", "generated", "binding_key", "source_install",
                             "destination_install", "overridden_fields", "updated_at"])
    _journal(flow.tenant_id, "api.applicationflow", flow,
             f"Kept after requirement {req_name} stopped applying.")


def _apply(req, wanted: dict) -> dict:
    """Make the requirement's rows ``wanted``. Returns the counts."""
    from .models import ApplicationFlow

    counts = {"created": 0, "updated": 0, "removed": 0, "released": 0}
    excluded = set(req.exclusions.values_list("binding_key", flat=True))
    wanted = {k: v for k, v in wanted.items() if k not in excluded}
    existing = {f.binding_key: f for f in
                ApplicationFlow.objects.filter(tenant_id=req.tenant_id, requirement=req)}
    for key, flow in existing.items():
        if key in wanted:
            continue
        if flow.overridden_fields:
            _release(flow, req.name)
            counts["released"] += 1
        else:
            flow.delete()
            counts["removed"] += 1
    for key, spec in wanted.items():
        flow = existing.get(key)
        if flow is None:
            new = ApplicationFlow(tenant_id=req.tenant_id, application_id=req.application_id,
                                  requirement=req, generated=True, name_generated=True,
                                  binding_key=key, **spec)
            try:
                with transaction.atomic():
                    new.save()
            except IntegrityError:
                log.warning("flow requirement %s: %s already there", req.pk, key)
                continue
            counts["created"] += 1
            continue
        frozen = set(flow.overridden_fields or [])
        changed = []
        for attr, value in spec.items():
            override = _SPEC_OVERRIDE.get(attr)
            if override and override in frozen:
                continue
            if not _same(getattr(flow, attr), value):
                setattr(flow, attr, value)
                changed.append(attr[:-3] if attr.endswith("_id") else attr)
        if not flow.generated:
            flow.generated = True
            changed.append("generated")
        if not flow.name_generated:
            flow.name_generated = True
            changed.append("name_generated")
        if changed:
            try:
                with transaction.atomic():
                    flow.save(update_fields=[*changed, "updated_at"])
            except IntegrityError:
                log.warning("flow requirement %s: could not update %s", req.pk, key)
                continue
            counts["updated"] += 1
    return counts


def resolve(requirement, *, reason: str = "") -> dict:
    """Bring a requirement's generated flows in step. Returns ``{created,
    updated, removed, released, gaps, state, pairs}``. Idempotent."""
    from audit.context import cause

    from .models import ApplicationFlow, ApplicationFlowRequirement

    with transaction.atomic():
        req = (ApplicationFlowRequirement.objects.select_for_update()
               .filter(pk=requirement.pk, tenant_id=requirement.tenant_id).first())
        if req is None:
            return {"created": 0, "updated": 0, "removed": 0, "released": 0, "gaps": 0,
                    "state": "gone", "pairs": 0}
        p = plan(req)
        state, detail = state_of(req, p)
        counts = {"created": 0, "updated": 0, "removed": 0, "released": 0}
        if not p.too_many:
            text = f"Requirement '{req.name}'" + (f": {reason}" if reason else "")
            with cause(text):
                counts = _apply(req, wanted_rows(req, p, status_id=_default_status_id(req)))
        n = ApplicationFlow.objects.filter(tenant_id=req.tenant_id, requirement=req).count()
        gap_hosts = len({g["host"].key for g in p.gaps})
        ApplicationFlowRequirement.objects.filter(pk=req.pk).update(
            state=state, state_detail=detail[:255], generated_count=n, gap_count=gap_hosts,
            resolved_at=timezone.now(),
        )
    return {**counts, "gaps": gap_hosts, "state": state, "pairs": p.count}


def release_all(requirement, *, reason: str = "requirement deleted") -> dict:
    """Before a requirement goes: its untouched rows go, its edited rows stay
    as hand-made flows with a journal note."""
    from audit.context import cause

    from .models import ApplicationFlow

    counts = {"removed": 0, "released": 0}
    with cause(f"Requirement '{requirement.name}': {reason}"):
        for flow in ApplicationFlow.objects.filter(tenant_id=requirement.tenant_id,
                                                   requirement=requirement):
            if flow.overridden_fields:
                _release(flow, requirement.name)
                counts["released"] += 1
            else:
                flow.delete()
                counts["removed"] += 1
    return counts


# ─── reading: gaps, preview, a host's view ─────────────────────────────────


def _visible_gaps(gaps: list[dict], viewable) -> tuple[list[dict], int]:
    """The gaps a reader may see - a host they can't view is counted, not
    named."""
    out, hidden = [], 0
    for g in gaps:
        h = g["host"]
        slug = "device" if h.kind == "d" else "virtualmachine"
        if viewable and not viewable.may_view(slug, uuid.UUID(h.id)):
            hidden += 1
            continue
        out.append({"side": g["side"], "host": h.ref(), "reason": g["reason"]})
    return out, hidden


def gaps_payload(req, viewable=None) -> dict:
    p = plan(req)
    state, detail = state_of(req, p)
    gaps, hidden = _visible_gaps(p.gaps, viewable)
    return {"state": state, "detail": detail, "gaps": gaps, "hidden": hidden}


def preview(req, viewable=None) -> dict:
    """What saving ``req`` (saved or not) would document, without a write."""
    p = plan(req)
    state, detail = state_of(req, p)
    excluded = set()
    if req.pk:
        excluded = set(req.exclusions.values_list("binding_key", flat=True))
    pairs = p.count if p.too_many else sum(
        1 for s, d in p.pairs if f"{s.token}|{d.token}" not in excluded)
    gaps, hidden = _visible_gaps(p.gaps, viewable)
    return {
        "pairs": pairs, "hosts": len(p.hosts()), "state": state, "detail": detail,
        "warn": pairs > warn_pairs(), "refused": p.too_many,
        "warn_at": warn_pairs(), "max": max_pairs(),
        "gaps": gaps, "hidden": hidden,
    }


def host_summary(req, host_kind: str, host_id) -> dict:
    """The requirement on one host: its flows there, and why it is missing
    some (``reason``) - the device or VM Flows strip."""
    from .models import ApplicationFlow

    key = f"{'d' if host_kind == 'device' else 'v'}:{host_id}"
    p = plan(req)
    state, detail = state_of(req, p)
    reason = ""
    for g in p.gaps:
        if g["host"].key == key:
            reason = g["reason"]
            break
    if not reason and state == "unresolved":
        reason = detail
    flows = ApplicationFlow.objects.filter(tenant_id=req.tenant_id, requirement=req).filter(
        Q(binding_key__startswith=f"{key}:") | Q(binding_key__contains=f"|{key}:")
    ).count()
    return {"flows": flows, "reason": reason, "state": state}


# ─── triggers ───────────────────────────────────────────────────────────────

_local = threading.local()


def _pending() -> dict:
    st = getattr(_local, "pending", None)
    if st is None:
        st = _local.pending = {}
    return st


def mark(tenant_id, *, apps=(), hosts=(), requirements=(), reason: str = "") -> None:
    """Note that requirements of ``tenant_id`` may need resolving after this
    transaction commits: those touching ``apps``, those touching the
    applications installed on ``hosts`` (``"d:<id>"``/``"v:<id>"``), and
    ``requirements`` themselves (fully)."""
    if tenant_id is None:
        return
    st = _pending().setdefault(str(tenant_id), {"apps": {}, "hosts": {}, "reqs": {}})
    hosts = {h for h in hosts if h}
    for a in apps:
        if a:
            entry = st["apps"].setdefault(str(a), [reason, set()])
            entry[1] |= hosts
    for h in hosts:
        st["hosts"].setdefault(h, reason)
    for r in requirements:
        if r:
            st["reqs"].setdefault(str(r), reason)
    transaction.on_commit(flush)


def _tenant_has_requirements(tenant_id) -> bool:
    from .models import ApplicationFlowRequirement

    return bool(tenant_id) and ApplicationFlowRequirement.objects.filter(
        tenant_id=tenant_id).exists()


def _affected(tenant_id, st: dict) -> dict:
    """``{requirement: (reason, touched host keys or None for all)}``."""
    from .models import ApplicationFlowRequirement, InstalledSoftware

    # {application: [reason, touched hosts]} - from the marks themselves, and
    # from the applications installed on the marked hosts.
    apps: dict = {a: [r, set(h)] for a, (r, h) in st["apps"].items()}
    if st["hosts"]:
        dev = [h[2:] for h in st["hosts"] if h.startswith("d:")]
        vms = [h[2:] for h in st["hosts"] if h.startswith("v:")]
        for app_id, d, v in InstalledSoftware.objects.filter(tenant_id=tenant_id).filter(
            Q(device_id__in=dev) | Q(virtual_machine_id__in=vms)
        ).values_list("application_id", "device_id", "virtual_machine_id"):
            key = f"d:{d}" if d else f"v:{v}"
            entry = apps.setdefault(str(app_id), [st["hosts"].get(key, ""), set()])
            entry[1].add(key)
    out: dict = {}
    if apps:
        qs = ApplicationFlowRequirement.objects.filter(tenant_id=tenant_id).filter(
            Q(application_id__in=list(apps)) | Q(source_application_id__in=list(apps))
            | Q(destination_application_id__in=list(apps))
        ).select_related("application")
        for req in qs:
            mine = {str(req.application_id), str(req.source_application_id or ""),
                    str(req.destination_application_id or "")} & set(apps)
            touched: set = set()
            reason = ""
            full = False
            for a in sorted(mine):
                reason = reason or apps[a][0]
                if apps[a][1]:
                    touched |= apps[a][1]
                else:
                    full = True
            out[req] = (reason, None if full or not touched else touched)
    if st["reqs"]:
        for req in ApplicationFlowRequirement.objects.filter(
            tenant_id=tenant_id, pk__in=list(st["reqs"])
        ).select_related("application"):
            out[req] = (st["reqs"][str(req.pk)], None)
    return out


def estimate(req, touched=None) -> int:
    """Pairs a resolution of ``req`` would touch: every pair, or with
    ``touched`` host keys about those hosts' pairs."""
    from .models import InstalledSoftware

    def n_hosts(side):
        kind = getattr(req, f"{side}_kind")
        if kind not in ("self", "app"):
            return 1
        app_id = req.application_id if kind == "self" else getattr(
            req, f"{side}_application_id")
        rows = InstalledSoftware.objects.filter(tenant_id=req.tenant_id,
                                                application_id=app_id)
        return (rows.values("device_id", "virtual_machine_id").distinct().count())

    a, b = n_hosts("source"), n_hosts("destination")
    if touched is None:
        return a * b
    return len(touched) * max(a, b)


def run_or_enqueue(req, *, reason: str = "", touched=None) -> dict:
    """Resolve inline when the work is small, else queue it. Returns the
    resolve result, or ``{"job": id}``."""
    if estimate(req, touched) <= INLINE_PAIRS:
        return resolve(req, reason=reason)
    from audit.context import current_request_id, current_user, current_via

    user = current_user()
    job_id = str(uuid.uuid4())
    args = (req.tenant_id, req.pk, getattr(user, "pk", None), current_request_id(),
            current_via(), reason)
    # Queued once the write that asked for it commits, so the job finds it.
    transaction.on_commit(lambda: enqueue_resolve(*args, job_id=job_id))
    return {"job": job_id}


def flush() -> None:
    """Resolve what this transaction marked. Runs after commit; a failure is
    logged and healed by the nightly sweep, never raised into the request."""
    pending = getattr(_local, "pending", None)
    _local.pending = None
    if not pending:
        return
    for tenant_id, st in pending.items():
        try:
            for req, (reason, touched) in _affected(tenant_id, st).items():
                try:
                    run_or_enqueue(req, reason=reason, touched=touched)
                except Exception:  # noqa: BLE001 - one requirement must not stop the rest
                    log.exception("resolving flow requirement %s failed", req.pk)
        except Exception:  # noqa: BLE001
            log.exception("flow requirement triggers for tenant %s failed", tenant_id)


# ─── background ─────────────────────────────────────────────────────────────


def enqueue_resolve(tenant_id, requirement_id, user_id, request_id="", via="",
                    reason="", *, job_id=None) -> str:
    """Queue :func:`run_resolve`; returns the job id shown on /jobs. Ids
    only: the job re-reads everything."""
    import django_rq

    job = django_rq.get_queue("default").enqueue(
        run_resolve, str(tenant_id), str(requirement_id), user_id,
        request_id=request_id or "", via=via or "", reason=reason or "",
        job_id=job_id, job_timeout=3600,
        description="Resolve application flow requirement",
    )
    return job.id


def run_resolve(tenant_id, requirement_id, user_id, request_id="", via="",
                reason="") -> dict:
    """The RQ job: re-read the tenant (active) and the requirement by id
    within it, then resolve as the user who triggered it."""
    from django.contrib.auth import get_user_model

    from audit.context import clear_context, set_context
    from core.models import Tenant

    from .models import ApplicationFlowRequirement

    tenant = Tenant.objects.filter(pk=tenant_id, is_active=True).first()
    if tenant is None:
        return {"skipped": "tenant"}
    req = ApplicationFlowRequirement.objects.filter(pk=requirement_id, tenant=tenant).first()
    if req is None:
        return {"skipped": "requirement"}
    user = (get_user_model().objects.filter(pk=user_id, is_active=True).first()
            if user_id else None)
    set_context(user, request_id or "", via if via in ("ui", "api", "chat") else "")
    try:
        return resolve(req, reason=reason)
    finally:
        clear_context()


def reconcile_all(tenant=None) -> dict:
    """The nightly sweep: resolve every requirement (of ``tenant``, or of
    every active tenant) as the system."""
    from audit.context import clear_context

    from .models import ApplicationFlowRequirement

    clear_context()
    qs = ApplicationFlowRequirement.objects.filter(tenant__is_active=True)
    if tenant is not None:
        qs = qs.filter(tenant=tenant)
    tally = {"requirements": 0, "created": 0, "updated": 0, "removed": 0, "released": 0,
             "failed": 0}
    for req in qs.select_related("application").order_by("tenant_id", "pk"):
        try:
            out = resolve(req, reason="nightly sweep")
        except Exception:  # noqa: BLE001 - one requirement must not stop the sweep
            log.exception("sweeping flow requirement %s failed", req.pk)
            tally["failed"] += 1
            continue
        tally["requirements"] += 1
        for k in ("created", "updated", "removed", "released"):
            tally[k] += out.get(k, 0)
    return tally


# ─── signal receivers ───────────────────────────────────────────────────────

_IP_FIELDS = ("ip_address", "vrf_id", "role_id", "assigned_device_id", "assigned_vm_id",
              "assigned_interface_id", "assigned_vm_interface_id")
_IP_UPDATE_FIELDS = {"ip_address", "vrf", "role", "assigned_device", "assigned_vm",
                     "assigned_interface", "assigned_vm_interface", "prefix"}
_HOST_FIELDS = ("primary_ip_id", "site_id")
_HOST_UPDATE_FIELDS = {"primary_ip", "secondary_ip", "site"}


def _ip_hosts(values: dict) -> set[str]:
    out = set()
    if values.get("assigned_device_id"):
        out.add(f"d:{values['assigned_device_id']}")
    if values.get("assigned_vm_id"):
        out.add(f"v:{values['assigned_vm_id']}")
    if values.get("_iface_device"):
        out.add(f"d:{values['_iface_device']}")
    if values.get("_vm_iface_vm"):
        out.add(f"v:{values['_vm_iface_vm']}")
    return out


def _ip_values(ip) -> dict:
    out = {f: getattr(ip, f) for f in _IP_FIELDS}
    out["ip_address"] = str(out["ip_address"])
    if ip.assigned_vm_interface_id:
        from .models import VMInterface

        out["_vm_iface_vm"] = (VMInterface.objects.filter(pk=ip.assigned_vm_interface_id)
                               .values_list("vm_id", flat=True).first())
    return out


def _skip_update(kwargs, relevant: set) -> bool:
    fields = kwargs.get("update_fields")
    return fields is not None and not (set(fields) & relevant)


def _ip_pre_save(sender, instance, raw=False, **kwargs):
    instance._flowreq_old = None
    instance._flowreq_track = False
    if raw or _skip_update(kwargs, _IP_UPDATE_FIELDS):
        return
    if not _tenant_has_requirements(instance.tenant_id):
        return
    instance._flowreq_track = True
    if instance.pk and not instance._state.adding:
        old = sender.objects.filter(pk=instance.pk).first()
        instance._flowreq_old = _ip_values(old) if old else None


def _ip_post_save(sender, instance, created, raw=False, **kwargs):
    if raw or not getattr(instance, "_flowreq_track", False):
        return
    instance._flowreq_track = False
    new = _ip_values(instance)
    old = getattr(instance, "_flowreq_old", None)
    if not created and old is not None and all(old.get(f) == new.get(f) for f in _IP_FIELDS):
        return
    hosts = _ip_hosts(new) | (_ip_hosts(old) if old else set())
    if hosts:
        verb = "added" if created else "changed"
        mark(instance.tenant_id, hosts=hosts, reason=f"address {new['ip_address']} {verb}")


def _ip_post_delete(sender, instance, **kwargs):
    if not _tenant_has_requirements(instance.tenant_id):
        return
    values = {f: getattr(instance, f) for f in _IP_FIELDS}
    hosts = _ip_hosts(values)
    if instance.assigned_vm_interface_id:
        from .models import VMInterface

        vm = (VMInterface.objects.filter(pk=instance.assigned_vm_interface_id)
              .values_list("vm_id", flat=True).first())
        if vm:
            hosts.add(f"v:{vm}")
    if hosts:
        mark(instance.tenant_id, hosts=hosts,
             reason=f"address {instance.ip_address} deleted")


def _host_pre_save(sender, instance, raw=False, **kwargs):
    instance._flowreq_old = None
    if raw or instance._state.adding or _skip_update(kwargs, _HOST_UPDATE_FIELDS):
        return
    if not _tenant_has_requirements(instance.tenant_id):
        return
    instance._flowreq_old = (sender.objects.filter(pk=instance.pk)
                             .values(*_HOST_FIELDS).first())


def _host_post_save(sender, instance, created, raw=False, **kwargs):
    old = getattr(instance, "_flowreq_old", None)
    instance._flowreq_old = None
    if raw or created or not old:
        return
    changed = [f for f in _HOST_FIELDS if old.get(f) != getattr(instance, f)]
    if not changed:
        return
    kind = "d" if sender._meta.model_name == "device" else "v"
    what = "site" if changed == ["site_id"] else "primary address"
    mark(instance.tenant_id, hosts=[f"{kind}:{instance.pk}"],
         reason=f"{what} changed on {instance.name}")


def _install_host(inst) -> tuple[str | None, str]:
    try:
        if inst.device_id:
            return f"d:{inst.device_id}", inst.device.name
        if inst.virtual_machine_id:
            return f"v:{inst.virtual_machine_id}", inst.virtual_machine.name
    except Exception:  # noqa: BLE001 - the host may be going in the same delete
        pass
    key = (f"d:{inst.device_id}" if inst.device_id
           else f"v:{inst.virtual_machine_id}" if inst.virtual_machine_id else None)
    return key, ""


def _install_pre_save(sender, instance, raw=False, **kwargs):
    instance._flowreq_old = None
    instance._flowreq_track = False
    if raw or not _tenant_has_requirements(instance.tenant_id):
        return
    instance._flowreq_track = True
    if instance._state.adding:
        return
    instance._flowreq_old = (sender.objects.filter(pk=instance.pk)
                             .values("application_id", "device_id", "virtual_machine_id",
                                     "service_id").first())


def _install_post_save(sender, instance, created, raw=False, **kwargs):
    if raw or not getattr(instance, "_flowreq_track", False):
        return
    instance._flowreq_track = False
    old = getattr(instance, "_flowreq_old", None)
    instance._flowreq_old = None
    fields = ("application_id", "device_id", "virtual_machine_id", "service_id")
    if not created and old and all(old[f] == getattr(instance, f) for f in fields):
        return
    host, name = _install_host(instance)
    hosts = {host} if host else set()
    apps = {instance.application_id}
    if old:
        apps.add(old["application_id"])
        if old["device_id"]:
            hosts.add(f"d:{old['device_id']}")
        if old["virtual_machine_id"]:
            hosts.add(f"v:{old['virtual_machine_id']}")
    app = instance.application.name if instance.application_id else "install"
    verb = "installed on" if created else "install changed on"
    mark(instance.tenant_id, apps=apps, hosts=hosts,
         reason=f"{app} {verb} {name}".strip())


def _install_post_delete(sender, instance, **kwargs):
    if not _tenant_has_requirements(instance.tenant_id):
        return
    host, name = _install_host(instance)
    try:
        app = instance.application.name
    except Exception:  # noqa: BLE001
        app = "install"
    mark(instance.tenant_id, apps={instance.application_id}, hosts={host} if host else (),
         reason=f"{app} removed from {name}".strip())


def _service_pre_save(sender, instance, raw=False, **kwargs):
    instance._flowreq_old = None
    if raw or instance._state.adding or not _tenant_has_requirements(instance.tenant_id):
        return
    instance._flowreq_old = (sender.objects.filter(pk=instance.pk)
                             .values_list("ip_address_id", flat=True).first() or "none")


def _service_post_save(sender, instance, created, raw=False, **kwargs):
    old = getattr(instance, "_flowreq_old", None)
    instance._flowreq_old = None
    if raw or created or old is None:
        return
    if (None if old == "none" else old) == instance.ip_address_id:
        return
    from .models import InstalledSoftware

    hosts = set()
    for d, v in InstalledSoftware.objects.filter(service=instance).values_list(
            "device_id", "virtual_machine_id"):
        hosts.add(f"d:{d}" if d else f"v:{v}")
    if hosts:
        mark(instance.tenant_id, hosts=hosts,
             reason=f"service {instance.name} address changed")


def _service_post_delete(sender, instance, **kwargs):
    if not _tenant_has_requirements(instance.tenant_id):
        return
    host = (f"d:{instance.device_id}" if instance.device_id
            else f"v:{instance.virtual_machine_id}" if instance.virtual_machine_id else None)
    if host:
        mark(instance.tenant_id, hosts=[host], reason=f"service {instance.name} deleted")


def connect_signals() -> None:
    from django.db.models.signals import post_delete, post_save, pre_save

    from .models import Device, InstalledSoftware, IPAddress, Service, VirtualMachine

    pairs = [
        (IPAddress, _ip_pre_save, _ip_post_save, _ip_post_delete, "ip"),
        (InstalledSoftware, _install_pre_save, _install_post_save, _install_post_delete,
         "install"),
        (Service, _service_pre_save, _service_post_save, _service_post_delete, "service"),
    ]
    for model, pre, post, delete, uid in pairs:
        pre_save.connect(pre, sender=model, dispatch_uid=f"flowreq_{uid}_pre")
        post_save.connect(post, sender=model, dispatch_uid=f"flowreq_{uid}_post")
        post_delete.connect(delete, sender=model, dispatch_uid=f"flowreq_{uid}_delete")
    for model in (Device, VirtualMachine):
        uid = model._meta.model_name
        pre_save.connect(_host_pre_save, sender=model, dispatch_uid=f"flowreq_{uid}_pre")
        post_save.connect(_host_post_save, sender=model, dispatch_uid=f"flowreq_{uid}_post")
