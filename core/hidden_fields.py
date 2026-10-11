"""Fields a serializer shows only to some users.

A serializer that leaves fields out of its output depends on who asks (an SLA
service credit without ``view_credits``) names them in ``hidden_fields``
instead of dropping them ad hoc in ``to_representation``. The API response
and the spreadsheet export (``api.io``) then read the same answer, so a field
the API hides cannot reach the user through a file or an export filter (#387).
"""
from __future__ import annotations


class PermissionHiddenFieldsMixin:
    """Mix into a serializer; override :meth:`hidden_fields`."""

    def hidden_fields(self, obj) -> set[str]:
        """The serializer field names ``obj`` is shown without, for the
        request in this serializer's context. ``obj`` may be an unsaved
        instance carrying only its tenant (the export asks once per file)."""
        return set()

    def to_representation(self, obj):
        data = super().to_representation(obj)
        for name in self.hidden_fields(obj):
            data.pop(name, None)
        return data
