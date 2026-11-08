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

A detached or released flow is hand-made but keeps the generated name
(``name_generated``), so it stays masked until someone renames it. A pair's
``binding_key`` names the address, range or prefix and the device or VM at
each end by id: a reader who may not view one of them reads it as null.
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


def named(flow) -> bool:
    """Whether ``flow``'s name was built by a requirement: it is generated,
    or was and nobody renamed it since."""
    return bool(getattr(flow, "generated", False) or getattr(flow, "name_generated", False))


def _snap_named(snap: dict) -> bool:
    return bool(snap.get("generated") or snap.get("name_generated"))


def key_refs(key: str):
    """``[(object-type slug, pk), ...]`` for every row a binding key names -
    the address, range or prefix and the device or VM of each end - or None
    when the key cannot be read."""
    out = []
    halves = str(key or "").split("|")
    if len(halves) != 2:
        return None
    for t in halves:
        parts = t.split(":")
        if parts == ["any"]:
            continue
        if len(parts) == 3 and parts[0] in ("d", "v"):
            host, ip = _uuid(parts[1]), _uuid(parts[2])
            if host is None or ip is None:
                return None
            out += [("device" if parts[0] == "d" else "virtualmachine", host),
                    ("ipaddress", ip)]
        elif len(parts) == 2 and parts[0] in END_SLUGS and _uuid(parts[1]) is not None:
            out.append((END_SLUGS[parts[0]], _uuid(parts[1])))
        else:
            return None
    return out


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

    def hides_key(self, key) -> bool:
        """Whether an excluded pair's label reads masked: an end, or the
        device or VM behind an end, the reader may not view. A label
        defaults to the key itself."""
        return self.hides(pair_of_key(key)) or self.key_hidden(key)

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
            return self.hides_key(flow.binding_key)
        return named(flow) and self.hides(pair_of_row(flow))

    def prime(self, flows) -> None:
        """Answer ``flows`` in a query per type before ``name`` is asked."""
        if not self.active:
            return
        keys = [f.binding_key for f in flows if getattr(f, "binding_key", "")]
        flows = [f for f in flows if named(f)]
        pairs = [pair_of_row(f) for f in flows]
        self._prime_pairs(pairs)
        self.prime_keys(keys)
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
        """The flows whose name reads unmasked: named by hand, or every end
        the reader may view."""
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
        return Q(**{f"{prefix}generated": False, f"{prefix}name_generated": False}) | ends

    def narrow(self, qs):
        """``qs`` (flows or excluded pairs) without the rows whose name
        reads masked - for a template, which prints a row it holds."""
        if not self.active:
            return qs
        if qs.model._meta.label_lower == EXCLUSION:
            keys = list(qs.values_list("pk", "binding_key"))
            self.prime_keys(k for _pk, k in keys)
            keep = [pk for pk, key in keys if not self.hides_key(key)]
            return qs.filter(pk__in=keep)
        return qs.filter(self.visible_q())

    # ── binding keys ──────────────────────────────────────────────────────
    def prime_keys(self, keys) -> None:
        """Answer the rows ``keys`` name in a query per type."""
        if not self.active:
            return
        by_slug: dict = {}
        for key in keys:
            for slug, pk in key_refs(key) or ():
                by_slug.setdefault(slug, set()).add(pk)
        for slug, pks in by_slug.items():
            self.viewable.prime(slug, pks)

    def key_hidden(self, key) -> bool:
        """Whether a binding key names a row the reader may not view - its
        ids would tell them which (#453)."""
        if not self.active or not key:
            return False
        refs = key_refs(key)
        return refs is None or any(not self.viewable.may_view(slug, pk) for slug, pk in refs)

    def binding_key(self, key):
        """``key`` as the reader may read it: null when it names a hidden row."""
        return None if self.key_hidden(key) else key

    def hidden_attrs(self, obj) -> set[str]:
        """The attributes of ``obj`` (a flow or an excluded pair) a template
        may not print for this reader."""
        return {"binding_key"} if self.key_hidden(getattr(obj, "binding_key", "")) else set()

    # ── excluded pairs ────────────────────────────────────────────────────
    def exclusion_label(self, exclusion) -> str:
        """An excluded pair's label (the name its flow had)."""
        if not self.hides_key(exclusion.binding_key):
            return exclusion.label
        return self.label(pair_of_key(exclusion.binding_key), exclusion.requirement_id,
                          exclusion.label)

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
            hidden = self.hides_key(key)
        else:
            flow = ApplicationFlow.objects.filter(requirement_id=req_id, name=label).first()
            pair = pair_of_row(flow) if flow is not None else UNKNOWN
            hidden = self.hides(pair)
        if not hidden:
            return text
        shown = self.label(pair, req_id, label) if pair.known else HIDDEN
        return f"{verb} {shown}."

    # ── the change log ────────────────────────────────────────────────────
    def _entry_rows(self, entry):
        """``(pre, post)``: the flow or exclusion before and after the entry,
        as ``(pair, named, requirement id, stored name, binding key)`` or
        None. A flow entry without snapshots (a bulk edit) reads the live
        row."""
        out = []
        for snap in (entry.pre_change, entry.post_change):
            if not isinstance(snap, dict) or not snap:
                out.append(None)
                continue
            if entry.object_type == EXCLUSION:
                out.append((pair_of_key(snap.get("binding_key")), True,
                            snap.get("requirement"), snap.get("label") or "",
                            snap.get("binding_key") or ""))
            else:
                out.append((pair_of_snapshot(snap), _snap_named(snap),
                            snap.get("requirement"), snap.get("name") or "", ""))
        if out == [None, None]:
            if entry.object_type == EXCLUSION:
                return None, None
            flow = self._flows.get(str(entry.object_id))
            if flow is None:
                # Gone and never snapshotted: nothing tells whose it was.
                row = (UNKNOWN, True, None, entry.object_repr, "")
            else:
                row = (pair_of_row(flow), named(flow), flow.requirement_id, flow.name, "")
            return None, row
        if entry.object_type == FLOW:
            out = [self._older_snapshot(entry, i, out) for i in range(2)]
        return out[0], out[1]

    @staticmethod
    def _undated(entry) -> bool:
        """Whether a flow entry has a snapshot from before ``name_generated``
        that reads hand-made."""
        return any(isinstance(s, dict) and s and "name_generated" not in s
                   and not s.get("generated") for s in (entry.pre_change, entry.post_change))

    def _flow(self, object_id):
        oid = str(object_id)
        if oid not in self._flows:
            from .models import ApplicationFlow

            pk = _uuid(oid)
            self._flows[oid] = (ApplicationFlow.objects.filter(pk=pk).first()
                                if pk is not None else None)
        return self._flows[oid]

    def _older_snapshot(self, entry, i, both):
        """A snapshot from before ``name_generated`` existed does not say a
        detached or released flow's name was generated: it was when the
        entry's other snapshot, or the live row, has the same name and
        says so."""
        row = both[i]
        if row is None or row[1]:
            return row
        snap = (entry.pre_change, entry.post_change)[i]
        if "name_generated" in snap:
            return row
        other = both[1 - i]
        if (other is not None and other[1] and other[3] == row[3]) or (
                (flow := self._flow(entry.object_id)) is not None
                and named(flow) and flow.name == row[3]):
            return (row[0], True, *row[2:])
        return row

    def prime_history(self, entries) -> None:
        """Answer a page of change-log entries in a query per type."""
        if not self.active:
            return
        entries = [e for e in entries if e.object_type in (FLOW, EXCLUSION)]
        bare = list({str(e.object_id) for e in entries if e.object_type == FLOW
                     and ((not e.pre_change and not e.post_change) or self._undated(e))
                     and str(e.object_id) not in self._flows})
        if bare:
            from .models import ApplicationFlow

            found = {str(f.pk): f for f in ApplicationFlow.objects.filter(
                pk__in=[pk for pk in (_uuid(b) for b in bare) if pk is not None])}
            for b in bare:
                self._flows[b] = found.get(b)
        rows = [r for e in entries for r in self._entry_rows(e) if r is not None]
        self._prime_pairs(r[0] for r in rows)
        self.prime_keys(k for e in entries for k in self._entry_keys(e))
        masked = [r for r in rows if r[1] and self.hides(r[0])]
        if masked:
            self._load(r[0] for r in masked)
            self._prime_requirements(r[2] for r in masked)

    @staticmethod
    def _entry_keys(entry):
        """Every binding key an entry carries: its diff and snapshots."""
        diff = (entry.changes or {}).get("binding_key")
        if isinstance(diff, dict):
            yield from (v for v in (diff.get("old"), diff.get("new")) if v)
        for snap in (entry.pre_change, entry.post_change):
            if isinstance(snap, dict) and snap.get("binding_key"):
                yield snap["binding_key"]

    def _mask_keys(self, data: dict) -> dict:
        """``data`` with a binding key that names a hidden row as null, in
        the diff and the snapshots."""
        diff = (data.get("changes") or {}).get("binding_key")
        if isinstance(diff, dict) and any(self.key_hidden(diff.get(s)) for s in ("old", "new")):
            diff = {**diff, **{s: None for s in ("old", "new") if self.key_hidden(diff.get(s))}}
            data["changes"] = {**data["changes"], "binding_key": diff}
        for key in ("pre_change", "post_change"):
            snap = data.get(key)
            if isinstance(snap, dict) and self.key_hidden(snap.get("binding_key")):
                data[key] = {**snap, "binding_key": None}
        return data

    def _masked(self, row) -> str | None:
        if row is None:
            return None
        pair, generated, req_id, stored, key = row
        if not generated or not (self.hides(pair) or self.key_hidden(key)):
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
        a binding key that names a hidden row as null, and its cause cut to
        the requirement it names."""
        if not self.active or entry.object_type not in (FLOW, EXCLUSION):
            return data
        data = self._mask_keys(data)
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
        from django.db.models import CharField
        from django.db.models.functions import Cast

        from .models import ApplicationFlow

        named_live = (ApplicationFlow.objects.filter(name_generated=True)
                      .annotate(sid=Cast("pk", output_field=CharField())).values("sid"))
        cands = list(
            qs.filter(object_type__in=(FLOW, EXCLUSION))
            .filter(Q(object_type=EXCLUSION) | Q(post_change__generated=True)
                    | Q(pre_change__generated=True)
                    | Q(post_change__name_generated=True)
                    | Q(pre_change__name_generated=True)
                    | Q(object_id__in=named_live)
                    | (Q(pre_change__isnull=True) & Q(post_change__isnull=True)))
            .select_related(None)
            .only("pk", "object_type", "object_id", "object_repr", "pre_change", "post_change")
        )
        self.prime_history(cands)
        needle = term.lower()
        drop = [e.pk for e in cands
                if (shown := self.history_repr(e)) is not None and needle not in shown.lower()]
        return qs.exclude(pk__in=drop) if drop else qs
