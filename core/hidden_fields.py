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


#: Fields the change log shows only to holders of an RBAC action, per stored
#: ``object_type`` label: ``{label: (object-type slug, action, fields)}``. The
#: serializer hides them from the object; the history must not show them in
#: its diff or snapshots either.
GATED_HISTORY_FIELDS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "api.supportcontract": ("supportcontract", "view_cost", ("cost", "currency")),
    # SLA money: the API hides it without view_credits, so the history does.
    "monitoring.slaagreement": (
        "slaagreement", "view_credits", ("credit_tiers", "period_fee", "currency"),
    ),
    "monitoring.slatemplate": (
        "slaagreement", "view_credits", ("credit_tiers", "period_fee", "currency"),
    ),
}


def hidden_history_fields(user, tenant, object_type: str, memo: dict | None = None) -> set[str]:
    """The fields of an ``object_type`` change-log entry ``user`` may not
    see in ``tenant``. ``memo`` caches the answer across one page."""
    gate = GATED_HISTORY_FIELDS.get(object_type)
    if gate is None:
        return set()
    if memo is not None and object_type in memo:
        return memo[object_type]
    from auth_api import rbac

    slug, action, fields = gate
    out = set() if rbac.has_action(user, tenant, slug, action) else set(fields)
    if memo is not None:
        memo[object_type] = out
    return out


def strip_history(data, hidden: set[str]):
    """``data`` (a diff or a snapshot) without the ``hidden`` keys."""
    if not hidden or not isinstance(data, dict):
        return data
    return {k: v for k, v in data.items() if k not in hidden}
