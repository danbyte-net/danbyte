"""Fields a serializer shows only to some users.

A serializer that leaves fields out of its output depends on who asks (an SLA
service credit without ``view_credits``) names them in ``hidden_fields``
instead of dropping them ad hoc in ``to_representation``. The API response
and the spreadsheet export (``api.io``) then read the same answer, so a field
the API hides cannot reach the user through a file or an export filter (#387).
"""
from __future__ import annotations


class PermissionHiddenFieldsMixin:
    """Mix into a serializer; override :meth:`hidden_fields`.

    ``hidden_as_null`` keeps a hidden field in the response as ``null``
    instead of leaving it out - for a nullable relation the client already
    reads as "none" (an address's device when that device is out of scope).
    """

    hidden_as_null = False

    def hidden_fields(self, obj) -> set[str]:
        """The serializer field names ``obj`` is shown without, for the
        request in this serializer's context. ``obj`` may be an unsaved
        instance carrying only its tenant (the export asks once per file)."""
        return set()

    def to_representation(self, obj):
        data = super().to_representation(obj)
        for name in self.hidden_fields(obj):
            if self.hidden_as_null and name in data:
                data[name] = None
            else:
                data.pop(name, None)
        return data


#: Fields shown only to holders of an RBAC action, per model label:
#: ``{label: (object-type slug, action, fields)}``. The one table every reader
#: asks: the serializer hides them from the object, the change log from its
#: diff and snapshots, and the export and label template sandbox from a
#: template, however the row is reached.
GATED_FIELDS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "api.supportcontract": ("supportcontract", "view_cost", ("cost", "currency")),
    # SLA money: the API hides it without view_credits, so the history does.
    "monitoring.slaagreement": (
        "slaagreement", "view_credits", ("credit_tiers", "period_fee", "currency"),
    ),
    "monitoring.slatemplate": (
        "slaagreement", "view_credits", ("credit_tiers", "period_fee", "currency"),
    ),
}
#: The change log's name for the same table.
GATED_HISTORY_FIELDS = GATED_FIELDS

#: Relations a row names only when the caller may view the related row, per
#: model label: ``{label: ((field, object-type slug), ...)}``. The API shows
#: such a field as ``null`` (#413); a template reads it as undefined.
GATED_RELATIONS: dict[str, tuple[tuple[str, str], ...]] = {
    "api.ipaddress": (
        ("prefix", "prefix"),
        ("assigned_device", "device"),
        ("assigned_interface", "interface"),
        ("switch", "device"),
        ("switch_interface", "interface"),
        ("assigned_vm", "virtualmachine"),
        ("assigned_vm_interface", "vminterface"),
    ),
    # A coverage row is its device's; its contract may be one the caller
    # cannot view.
    "api.supportcoverage": (("contract", "supportcontract"),),
    # A flow is the site of its first end; the other end may be another
    # site's address, range or prefix (#453).
    "api.applicationflow": (
        ("source_ip", "ipaddress"),
        ("source_range", "iprange"),
        ("source_prefix", "prefix"),
        ("destination_ip", "ipaddress"),
        ("destination_range", "iprange"),
        ("destination_prefix", "prefix"),
        ("service", "service"),
        # A generated flow names the installs behind its host ends.
        ("source_install", "installedsoftware"),
        ("destination_install", "installedsoftware"),
    ),
    # A requirement is tenant-wide; its fixed ends may be another site's
    # address, range or prefix.
    "api.applicationflowrequirement": (
        ("source_ip", "ipaddress"),
        ("source_range", "iprange"),
        ("source_prefix", "prefix"),
        ("destination_ip", "ipaddress"),
        ("destination_range", "iprange"),
        ("destination_prefix", "prefix"),
    ),
    # An intake is its device's; its feed or the CDU outflow it hangs off
    # may be another site's (#453).
    "api.coolingintake": (
        ("cooling_feed", "coolingfeed"),
        ("outflow", "coolingoutflow"),
    ),
}

#: Gated relations a row's own text names (``str(coverage)`` is "contract →
#: device"). A template prints a row it holds, so such a row is not handed to
#: a template at all while that relation is hidden.
ROW_TEXT_RELATIONS: dict[str, str] = {"api.supportcoverage": "contract"}


def hidden_related_spec(label: str) -> tuple[tuple[str, str, str], ...]:
    """``GATED_RELATIONS[label]`` in the shape ``HiddenRelatedFieldsMixin``
    reads: ``(field, slug, fk attname)``."""
    return tuple((f, slug, f"{f}_id") for f, slug in GATED_RELATIONS.get(label, ()))


def gated_fields(user, tenant, label: str, memo: dict | None = None) -> set[str]:
    """The fields of a ``label`` row ``user`` may not see in ``tenant``.
    ``memo`` caches the answer across one page or one render."""
    gate = GATED_FIELDS.get(label)
    if gate is None:
        return set()
    if memo is not None and label in memo:
        return memo[label]
    from auth_api import rbac

    slug, action, fields = gate
    out = set() if rbac.has_action(user, tenant, slug, action) else set(fields)
    if memo is not None:
        memo[label] = out
    return out


def hidden_history_fields(user, tenant, object_type: str, memo: dict | None = None) -> set[str]:
    """The fields of an ``object_type`` change-log entry ``user`` may not
    see in ``tenant``. ``memo`` caches the answer across one page."""
    return gated_fields(user, tenant, object_type, memo)


class RowFieldGate:
    """What ``user`` may not read on a row in ``tenant``, for one render of
    an export or label template: the gated fields of its type, and the gated
    relations that point at a row the user may not view. The answer the API
    gives, so a template prints nothing the API leaves out."""

    def __init__(self, user, tenant):
        self.user = user
        self.tenant = tenant
        self._memo: dict = {}
        self._viewable = None

    def _rows(self):
        if self._viewable is None:
            from auth_api.rbac import ViewableRows

            self._viewable = ViewableRows(self.user, self.tenant)
        return self._viewable

    def fields(self, model) -> set[str]:
        return gated_fields(self.user, self.tenant, model._meta.label_lower, self._memo)

    @staticmethod
    def _relation(model, name):
        """``(slug, fk attname)`` when ``name`` (the relation or its ``_id``)
        is a gated relation of ``model``."""
        for field, slug in GATED_RELATIONS.get(model._meta.label_lower, ()):
            if name in (field, f"{field}_id"):
                return slug, f"{field}_id"
        return None

    def hides(self, obj, attr: str) -> bool:
        """Whether ``obj.<attr>`` is hidden from the user."""
        model = type(obj)
        if attr in self.fields(model):
            return True
        rel = self._relation(model, attr)
        if rel is None:
            return False
        slug, attname = rel
        return not self._rows().may_view(slug, getattr(obj, attname, None))

    def refuses_lookup(self, model, name: str) -> bool:
        """Whether a filter or an ordering on ``name`` would test a value the
        user may not see on some row: a gated field, or a gated relation the
        user does not see on every row."""
        if name in self.fields(model):
            return True
        rel = self._relation(model, name)
        return rel is not None and not self._rows().sees_every(rel[0])

    def narrow(self, qs):
        """``qs`` without the rows whose text names a hidden relation
        (``ROW_TEXT_RELATIONS``)."""
        field = ROW_TEXT_RELATIONS.get(qs.model._meta.label_lower)
        if field is None:
            return qs
        slug = self._relation(qs.model, field)[0]
        if self._rows().sees_every(slug):
            return qs
        from django.db.models import Q

        from auth_api import rbac
        from auth_api.object_types import model_for

        q = rbac.row_filter(self.user, self.tenant, slug, "view")
        if q is None:
            return qs.filter(**{f"{field}__isnull": True})
        related = model_for(slug)._default_manager.filter(q).values("pk")
        return qs.filter(Q(**{f"{field}__in": related}) | Q(**{f"{field}__isnull": True}))

    def hides_row(self, obj) -> bool:
        """Whether ``obj`` itself names a hidden relation in its text."""
        field = ROW_TEXT_RELATIONS.get(type(obj)._meta.label_lower)
        return field is not None and self.hides(obj, field)

    def prime(self, rows) -> None:
        """Answer the gated relations of ``rows`` in one query per type."""
        by_slug: dict[str, set] = {}
        for obj in rows:
            for field, slug in GATED_RELATIONS.get(type(obj)._meta.label_lower, ()):
                by_slug.setdefault(slug, set()).add(getattr(obj, f"{field}_id", None))
        for slug, pks in by_slug.items():
            self._rows().prime(slug, pks)


def strip_history(data, hidden: set[str]):
    """``data`` (a diff or a snapshot) without the ``hidden`` keys."""
    if not hidden or not isinstance(data, dict):
        return data
    return {k: v for k, v in data.items() if k not in hidden}
