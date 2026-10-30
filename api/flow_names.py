"""What a generated application flow's name reads as for one reader (#453).

A requirement names each flow it makes after the pair it stands for -
``WMS to Broker: wms-1 → broker-b`` - so the stored name names the hosts at
both ends, and one end may be another site's. A reader who may not view an
end (a site role under enhanced site separation) reads that end as Hidden in
the name, as the end itself reads Hidden: ``WMS to Broker: wms-1 → Hidden``.

:class:`FlowNames` is the one answer every path asks: the flow API and its
picker, the spreadsheet export, export and label templates, the global
search, custom-field labels, the change log (object, diff, snapshots and
cause, masked when read - the stored history is never rewritten), and a
requirement's excluded pairs and their journal notes, whose label is a
flow's name. A superuser, or a reader who sees every address, range and
prefix, reads the stored name.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass

from django.db.models import Q

HIDDEN = "Hidden"
SIDES = ("source", "destination")
#: The object type of each end kind.
END_SLUGS = {"ip": "ipaddress", "range": "iprange", "prefix": "prefix"}
FLOW = "api.applicationflow"
EXCLUSION = "api.applicationflowrequirementexclusion"
REQUIREMENT = "api.applicationflowrequirement"

#: The requirement journal notes that carry a pair's label.
_PAIR_NOTE = re.compile(
    r"^(Excluded the pair|Detached the pair|Restored the excluded pair) (.+)\.$", re.S)
#: The part of a resolver's change-log cause that names the requirement.
_CAUSE_HEAD = re.compile(r"^Requirement '.*?'(?=: |$)", re.S)


def _uuid(value):
    if value in (None, ""):
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


@dataclass(frozen=True)
class Pair:
    """The ends a generated name was built from: ``(kind, pk)`` per side,
    kind ``any`` with no pk. ``known`` is False when the ends could not be
    read (a malformed key) - such a pair is hidden from a scoped reader."""

    source: tuple = ("any", None)
    destination: tuple = ("any", None)
    known: bool = True

    def ends(self):
        return (self.source, self.destination)


UNKNOWN = Pair(known=False)


def pair_of_row(flow) -> Pair:
    def side(s):
        for kind in END_SLUGS:
            pk = getattr(flow, f"{s}_{kind}_id", None)
            if pk:
                return kind, pk
        return "any", None

    return Pair(side("source"), side("destination"))


def pair_of_snapshot(snap: dict) -> Pair:
    def side(s):
        for kind in END_SLUGS:
            raw = snap.get(f"{s}_{kind}")
            if raw not in (None, ""):
                pk = _uuid(raw)
                return (kind, pk) if pk is not None else None
        return "any", None

    src, dst = side("source"), side("destination")
    return UNKNOWN if src is None or dst is None else Pair(src, dst)


def pair_of_key(key: str) -> Pair:
    """The ends of a requirement's binding key: ``<token>|<token>``, each
    ``d:<device>:<ip>``, ``v:<vm>:<ip>``, ``ip:<id>``, ``range:<id>``,
    ``prefix:<id>`` or ``any`` (``api.flow_requirements``)."""

    def token(t):
        parts = t.split(":")
        if parts == ["any"]:
            return "any", None
        if len(parts) == 3 and parts[0] in ("d", "v"):
            pk = _uuid(parts[2])
            return ("ip", pk) if pk is not None else None
        if len(parts) == 2 and parts[0] in END_SLUGS:
            pk = _uuid(parts[1])
            return (parts[0], pk) if pk is not None else None
        return None

    halves = str(key or "").split("|")
    if len(halves) != 2:
        return UNKNOWN
    src, dst = token(halves[0]), token(halves[1])
    return UNKNOWN if src is None or dst is None else Pair(src, dst)


class FlowNames:
    """Generated flow names as ``user`` may read them in ``tenant``. Memoised
    for one response: ``prime`` / ``prime_history`` answer a page in a query
    per type. ``viewable`` reuses a serializer's ``rbac.ViewableRows``
    (``False`` for a caller nothing is hidden from)."""

    def __init__(self, user, tenant, viewable=None):
        from auth_api.rbac import ViewableRows

        self.user = user
        self.tenant = tenant
        if viewable is False or user is None or getattr(user, "is_superuser", False):
            self.viewable = None
            self.active = False
        else:
            self.viewable = viewable or ViewableRows(user, tenant)
            self.active = not all(self.viewable.sees_every(s) for s in END_SLUGS.values())
        self._objs: dict = {}
        self._reqs: dict = {}
        self._flows: dict = {}

    @classmethod
    def for_context(cls, context: dict, viewable=None) -> FlowNames:
        """One instance per serializer context (a page, a response)."""
        names = context.get("_flow_names")
        if names is None:
            request = context.get("request")
            user = getattr(request, "user", None)
            if user is not None and not getattr(user, "is_authenticated", False):
                user = None
            tenant = None
            if user is not None:
                from api.views import _get_active_tenant

                tenant = _get_active_tenant(request)
            names = context["_flow_names"] = cls(user, tenant, viewable)
        return names

    # ── ends ──────────────────────────────────────────────────────────────
    def hides(self, pair: Pair) -> bool:
        """Whether a name built from ``pair`` reads masked."""
        if not self.active:
            return False
        if not pair.known:
            return True
        return any(kind != "any" and not self.viewable.may_view(END_SLUGS[kind], pk)
                   for kind, pk in pair.ends())

    def _prime_pairs(self, pairs) -> None:
        by_slug: dict = {}
        for p in pairs:
            for kind, pk in p.ends():
                if kind != "any" and pk is not None:
                    by_slug.setdefault(END_SLUGS[kind], set()).add(pk)
        for slug, pks in by_slug.items():
            self.viewable.prime(slug, pks)

    def _load(self, pairs) -> None:
        """The end rows of ``pairs``, in one query per kind, and whether
        their devices and VMs are viewable."""
        from .models import IPAddress, IPRange, Prefix

        want: dict = {}
        for p in pairs:
            for kind, pk in p.ends():
                if kind != "any" and pk is not None and (kind, pk) not in self._objs:
                    want.setdefault(kind, set()).add(pk)
        models = {"ip": IPAddress.objects.select_related("assigned_device", "assigned_vm"),
                  "range": IPRange.objects.all(), "prefix": Prefix.objects.all()}
        for kind, pks in want.items():
            found = {o.pk: o for o in models[kind].filter(pk__in=pks)}
            for pk in pks:
                self._objs[(kind, pk)] = found.get(pk)
        ips = [o for (k, _pk), o in self._objs.items() if k == "ip" and o is not None]
        self.viewable.prime("device", {ip.assigned_device_id for ip in ips})
        self.viewable.prime("virtualmachine", {ip.assigned_vm_id for ip in ips})

    def _end_label(self, kind, pk) -> str:
        if kind == "any":
            return "Any"
        if pk is None or not self.viewable.may_view(END_SLUGS[kind], pk):
            return HIDDEN
        if (kind, pk) not in self._objs:
            self._load([Pair((kind, pk))])
        obj = self._objs.get((kind, pk))
        if obj is None:
            return HIDDEN
        if kind == "ip":
            if obj.assigned_device_id and self.viewable.may_view("device", obj.assigned_device_id):
                return obj.assigned_device.name
            if obj.assigned_vm_id and self.viewable.may_view("virtualmachine", obj.assigned_vm_id):
                return obj.assigned_vm.name
            return str(obj.ip_address)
        if kind == "range":
            return f"{obj.start_address}-{obj.end_address}"
        return str(obj.cidr)

    def _requirement_name(self, req_id, stored: str) -> str:
        req_id = _uuid(req_id)
        if req_id is not None and req_id not in self._reqs:
            from .models import ApplicationFlowRequirement

            self._reqs[req_id] = (ApplicationFlowRequirement.objects.filter(pk=req_id)
                                  .values_list("name", flat=True).first())
        name = self._reqs.get(req_id) if req_id is not None else None
        return name or str(stored or "").split(":")[0]

    def _prime_requirements(self, ids) -> None:
        from .models import ApplicationFlowRequirement

        todo = {pk for pk in (_uuid(i) for i in ids) if pk is not None and pk not in self._reqs}
        if not todo:
            return
        found = dict(ApplicationFlowRequirement.objects.filter(pk__in=todo)
                     .values_list("pk", "name"))
        for pk in todo:
            self._reqs[pk] = found.get(pk)

    def label(self, pair: Pair, req_id, stored: str) -> str:
        """The name a requirement gives ``pair``, with each end the reader
        may not view as Hidden."""
        prefix = self._requirement_name(req_id, stored)
        if not pair.known:
            return f"{prefix}: {HIDDEN}"
        src, dst = (self._end_label(k, pk) for k, pk in pair.ends())
        return f"{prefix}: {src} → {dst}"

    # ── live rows ─────────────────────────────────────────────────────────
    def masks(self, flow) -> bool:
        """Whether ``flow``'s name (an excluded pair's label) reads masked."""
        if not self.active:
            return False
        if flow._meta.label_lower == EXCLUSION:
            return self.hides(pair_of_key(flow.binding_key))
        return bool(flow.generated and self.hides(pair_of_row(flow)))

    def prime(self, flows) -> None:
        """Answer ``flows`` in a query per type before ``name`` is asked."""
        if not self.active:
            return
        flows = [f for f in flows if getattr(f, "generated", False)]
        pairs = [pair_of_row(f) for f in flows]
        self._prime_pairs(pairs)
        masked = [p for p in pairs if self.hides(p)]
        if masked:
            self._load(masked)
            self._prime_requirements(f.requirement_id for f in flows if self.masks(f))

    def name(self, flow) -> str:
        """``flow``'s name as the reader may read it."""
        if flow._meta.label_lower == EXCLUSION:
            return self.exclusion_label(flow)
        if not self.masks(flow):
            return flow.name
        return self.label(pair_of_row(flow), flow.requirement_id, flow.name)

    def visible_q(self, prefix: str = "") -> Q:
        """The flows whose name reads unmasked: hand-made, or every end the
        reader may view."""
        if not self.active:
            return Q()
        from auth_api import rbac
        from auth_api.object_types import model_for

        ends = Q()
        for kind, slug in END_SLUGS.items():
            f = rbac.row_filter(self.user, self.tenant, slug, "view")
            if f is True:
                continue
            visible = (model_for(slug)._default_manager.filter(f).values("pk")
                       if f is not None else model_for(slug)._default_manager.none())
            for side in SIDES:
                field = f"{prefix}{side}_{kind}"
                ends &= Q(**{f"{field}__isnull": True}) | Q(**{f"{field}__in": visible})
        return Q(**{f"{prefix}generated": False}) | ends

    def narrow(self, qs):
        """``qs`` (flows or excluded pairs) without the rows whose name
        reads masked - for a template, which prints a row it holds."""
        if not self.active:
            return qs
        if qs.model._meta.label_lower == EXCLUSION:
            keep = [pk for pk, key in qs.values_list("pk", "binding_key")
                    if not self.hides(pair_of_key(key))]
            return qs.filter(pk__in=keep)
        return qs.filter(self.visible_q())

    # ── excluded pairs ────────────────────────────────────────────────────
    def exclusion_label(self, exclusion) -> str:
        """An excluded pair's label (the name its flow had)."""
        pair = pair_of_key(exclusion.binding_key)
        if not self.hides(pair):
            return exclusion.label
        return self.label(pair, exclusion.requirement_id, exclusion.label)

    def journal_note(self, entry, text: str) -> str:
        """A requirement journal note that names a pair, with the pair as
        the reader may read it. A pair no longer known (restored, its flow
        gone) is Hidden whole."""
        if not self.active or entry.object_type != REQUIREMENT:
            return text
        m = _PAIR_NOTE.match(text or "")
        if m is None:
            return text
        from .models import ApplicationFlow, ApplicationFlowRequirementExclusion

        verb, label = m.groups()
        req_id = _uuid(entry.object_id)
        key = (ApplicationFlowRequirementExclusion.objects
               .filter(requirement_id=req_id, label=label)
               .values_list("binding_key", flat=True).first())
        if key is not None:
            pair = pair_of_key(key)
        else:
            flow = ApplicationFlow.objects.filter(requirement_id=req_id, name=label).first()
            pair = pair_of_row(flow) if flow is not None else UNKNOWN
        if not self.hides(pair):
            return text
        shown = self.label(pair, req_id, label) if pair.known else HIDDEN
        return f"{verb} {shown}."

    # ── the change log ────────────────────────────────────────────────────
    def _entry_rows(self, entry):
        """``(pre, post)``: the flow or exclusion before and after the entry,
        as ``(pair, generated, requirement id, stored name)`` or None. A
        flow entry without snapshots (a bulk edit) reads the live row."""
        out = []
        for snap in (entry.pre_change, entry.post_change):
            if not isinstance(snap, dict) or not snap:
                out.append(None)
                continue
            if entry.object_type == EXCLUSION:
                out.append((pair_of_key(snap.get("binding_key")), True,
                            snap.get("requirement"), snap.get("label") or ""))
            else:
                out.append((pair_of_snapshot(snap), bool(snap.get("generated")),
                            snap.get("requirement"), snap.get("name") or ""))
        if out == [None, None]:
            if entry.object_type == EXCLUSION:
                return None, None
            flow = self._flows.get(str(entry.object_id))
            if flow is None:
                # Gone and never snapshotted: nothing tells whose it was.
                row = (UNKNOWN, True, None, entry.object_repr)
            else:
                row = (pair_of_row(flow), flow.generated, flow.requirement_id, flow.name)
            return None, row
        return out[0], out[1]

    def prime_history(self, entries) -> None:
        """Answer a page of change-log entries in a query per type."""
        if not self.active:
            return
        entries = [e for e in entries if e.object_type in (FLOW, EXCLUSION)]
        bare = [str(e.object_id) for e in entries if e.object_type == FLOW
                and not e.pre_change and not e.post_change and str(e.object_id) not in self._flows]
        if bare:
            from .models import ApplicationFlow

            found = {str(f.pk): f for f in ApplicationFlow.objects.filter(
                pk__in=[pk for pk in (_uuid(b) for b in bare) if pk is not None])}
            for b in bare:
                self._flows[b] = found.get(b)
        rows = [r for e in entries for r in self._entry_rows(e) if r is not None]
        self._prime_pairs(r[0] for r in rows)
        masked = [r for r in rows if r[1] and self.hides(r[0])]
        if masked:
            self._load(r[0] for r in masked)
            self._prime_requirements(r[2] for r in masked)

    def _masked(self, row) -> str | None:
        if row is None:
            return None
        pair, generated, req_id, stored = row
        if not generated or not self.hides(pair):
            return None
        return self.label(pair, req_id, stored)

    def history_repr(self, entry) -> str | None:
        """The entry's ``object_repr`` masked, or None when it reads as
        stored."""
        if not self.active or entry.object_type not in (FLOW, EXCLUSION):
            return None
        pre, post = self._entry_rows(entry)
        return self._masked(post if post is not None else pre)

    def mask_history(self, entry, data: dict) -> dict:
        """``data`` (an entry as served) with the generated name masked in
        its ``object_repr``, its ``name`` (or ``label``) diff and snapshots,
        and its cause cut to the requirement it names."""
        if not self.active or entry.object_type not in (FLOW, EXCLUSION):
            return data
        pre, post = self._entry_rows(entry)
        old, new = self._masked(pre), self._masked(post)
        field = "label" if entry.object_type == EXCLUSION else "name"
        shown = new if post is not None else old
        if shown is not None and "object_repr" in data:
            data["object_repr"] = shown
        diff = (data.get("changes") or {}).get(field)
        if isinstance(diff, dict) and (old is not None or new is not None):
            diff = dict(diff)
            if old is not None:
                diff["old"] = old
            if new is not None:
                diff["new"] = new
            data["changes"] = {**data["changes"], field: diff}
        for key, value in (("pre_change", old), ("post_change", new)):
            snap = data.get(key)
            if value is not None and isinstance(snap, dict) and field in snap:
                data[key] = {**snap, field: value}
        # A resolver's cause names what set it off - a host, an address, a
        # flow's own name - at any site: a scoped reader reads which
        # requirement, not why.
        cause = data.get("cause")
        if entry.object_type == FLOW and cause:
            head = _CAUSE_HEAD.match(cause)
            if head is not None:
                data["cause"] = head.group(0)
        return data

    def narrow_history_search(self, qs, term: str):
        """``qs`` (entries whose stored ``object_repr`` matched ``term``)
        without the ones that matched only through a masked name."""
        if not self.active or not term:
            return qs
        cands = list(
            qs.filter(object_type__in=(FLOW, EXCLUSION))
            .filter(Q(object_type=EXCLUSION) | Q(post_change__generated=True)
                    | Q(pre_change__generated=True)
                    | (Q(pre_change__isnull=True) & Q(post_change__isnull=True)))
            .select_related(None)
            .only("pk", "object_type", "object_id", "object_repr", "pre_change", "post_change")
        )
        self.prime_history(cands)
        needle = term.lower()
        drop = [e.pk for e in cands
                if (shown := self.history_repr(e)) is not None and needle not in shown.lower()]
        return qs.exclude(pk__in=drop) if drop else qs
