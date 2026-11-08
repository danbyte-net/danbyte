"""What a support coverage row's name reads as for one reader (#453).

A coverage row is titled after its device - *Coverage of edge-01* - and
entries written before that read *contract → device*. The change log keeps
that title (``object_repr``) after the device moves to another site or is
deleted, so a reader may meet an entry naming a device they may not view.
:class:`CoverageNames` masks it when read, as ``api.flow_names`` masks a
generated flow's name: the device reads *Hidden* (*Coverage of Hidden*), and
an older title drops a contract the reader may not view. The entry's object,
the log's search and the object's History tab read it masked; the stored
history is never rewritten. A superuser, or a reader who sees every device
and contract, reads the stored title.
"""
from __future__ import annotations

import uuid

from django.db.models import Q

HIDDEN = "Hidden"
COVERAGE = "api.supportcoverage"
#: The title a coverage row has had since it was named by device alone.
TITLE = "Coverage of "


def _uuid(value):
    if value in (None, ""):
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


class CoverageNames:
    """Coverage titles as ``user`` may read them in ``tenant``, memoised for
    one response. The masker interface ``core.hidden_fields.MASKED_NAMES``
    names: live rows (``masks``, ``name``, ``prime``, ``narrow``) and the
    change log (``prime_history``, ``mask_history``, ``history_repr``,
    ``narrow_history_search``)."""

    def __init__(self, user, tenant, viewable=None):
        from auth_api.rbac import ViewableRows

        self.user = user
        self.tenant = tenant
        if viewable is False or user is None or getattr(user, "is_superuser", False):
            self.viewable = None
            self.active = False
        else:
            self.viewable = viewable or ViewableRows(user, tenant)
            self.active = not (self.viewable.sees_every("device")
                               and self.viewable.sees_every("supportcontract"))
        self._live: dict = {}

    def _device_hidden(self, pk) -> bool:
        pk = _uuid(pk)
        return pk is None or not self.viewable.may_view("device", pk)

    def _contract_hidden(self, pk) -> bool:
        pk = _uuid(pk)
        return pk is None or not self.viewable.may_view("supportcontract", pk)

    # ── live rows ─────────────────────────────────────────────────────────
    def masks(self, obj) -> bool:
        """Whether ``obj``'s title names a device the reader may not view."""
        return self.active and self._device_hidden(obj.device_id)

    def name(self, obj) -> str:
        return f"{TITLE}{HIDDEN}" if self.masks(obj) else str(obj)

    def prime(self, rows) -> None:
        if self.active:
            self.viewable.prime("device", {r.device_id for r in rows})

    def hidden_attrs(self, obj) -> set[str]:
        return set()

    def narrow(self, qs):
        """``qs`` without the rows whose device the reader may not view."""
        if not self.active:
            return qs
        from auth_api import rbac

        from .models import Device

        f = rbac.row_filter(self.user, self.tenant, "device", "view")
        if f is True:
            return qs
        if f is None:
            return qs.none()
        return qs.filter(device__in=Device.objects.filter(f).values("pk"))

    # ── the change log ────────────────────────────────────────────────────
    def _ids(self, entry):
        """``(contract id, device id)`` of the entry's row, or None when
        nothing tells: from its snapshots, else the live row."""
        for snap in (entry.post_change, entry.pre_change):
            if isinstance(snap, dict) and snap:
                return snap.get("contract"), snap.get("device")
        return self._live.get(str(entry.object_id))

    def prime_history(self, entries) -> None:
        """Answer a page of change-log entries in a query per type."""
        if not self.active:
            return
        entries = [e for e in entries if e.object_type == COVERAGE]
        bare = {str(e.object_id) for e in entries
                if not e.pre_change and not e.post_change and str(e.object_id) not in self._live}
        if bare:
            from .models import SupportCoverage

            found = {str(pk): (c, d) for pk, c, d in SupportCoverage.objects.filter(
                pk__in=[pk for pk in (_uuid(b) for b in bare) if pk is not None],
            ).values_list("pk", "contract_id", "device_id")}
            for b in bare:
                self._live[b] = found.get(b)
        devices, contracts = set(), set()
        for e in entries:
            ids = self._ids(e)
            if ids is not None:
                contracts.add(_uuid(ids[0]))
                devices.add(_uuid(ids[1]))
        self.viewable.prime("device", devices - {None})
        self.viewable.prime("supportcontract", contracts - {None})

    def history_repr(self, entry) -> str | None:
        """The entry's ``object_repr`` masked, or None when it reads as
        stored."""
        if not self.active or entry.object_type != COVERAGE:
            return None
        ids = self._ids(entry)
        if ids is None or self._device_hidden(ids[1]):
            return f"{TITLE}{HIDDEN}"
        stored = entry.object_repr or ""
        if not stored.startswith(TITLE) and self._contract_hidden(ids[0]):
            # An older title, "contract → device": the device alone.
            return f"{TITLE}{stored.rsplit(' → ', 1)[-1]}"
        return None

    def mask_history(self, entry, data: dict) -> dict:
        shown = self.history_repr(entry)
        if shown is not None and "object_repr" in data:
            data["object_repr"] = shown
        return data

    def narrow_history_search(self, qs, term: str):
        """``qs`` (entries whose stored ``object_repr`` matched ``term``)
        without the coverage entries that matched only through a masked
        title."""
        if not self.active or not term:
            return qs
        cands = list(
            qs.filter(Q(object_type=COVERAGE)).select_related(None)
            .only("pk", "object_type", "object_id", "object_repr", "pre_change", "post_change")
        )
        self.prime_history(cands)
        needle = term.lower()
        drop = [e.pk for e in cands
                if (shown := self.history_repr(e)) is not None and needle not in shown.lower()]
        return qs.exclude(pk__in=drop) if drop else qs
