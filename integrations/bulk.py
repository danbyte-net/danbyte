"""Safe bulk delete for the lists whose single delete asks a Windows server
first (a pushed DHCP scope or reservation).

The shared :class:`~api.bulk_delete.SafeBulkDeleteMixin` deletes the rows in
one go and treats any other error as fatal. Here each row is its own call to
the server, so one refusal must not undo the rows the server already let go:
each row goes in its own savepoint, as its single delete would, and a row the
server refuses stays and is reported among the kept rows with the single
delete's message.
"""
from __future__ import annotations

from django.db import transaction
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError

from api.bulk_delete import SafeBulkDeleteMixin


def _message(exc: ValidationError) -> str:
    detail = exc.detail
    if isinstance(detail, dict):
        detail = detail.get("detail") or next(iter(detail.values()), "")
    if isinstance(detail, list):
        detail = detail[0] if detail else ""
    return str(detail)


class RemoteBulkDeleteMixin(SafeBulkDeleteMixin):
    """The safe bulk delete, row by row through ``perform_destroy``, keeping
    the rows the server refuses. Put it before ``BulkEditMixin`` when the
    list has a bulk edit too."""

    rbac_action_map = {"bulk_delete": "delete"}

    def bulk_destroy(self, rows) -> None:
        refused = self._bulk_refused = []
        for obj in rows:
            pk, name = str(obj.pk), str(obj)
            try:
                with transaction.atomic():
                    self.perform_destroy(obj)
            except ValidationError as exc:
                refused.append({"id": pk, "name": name, "reason": _message(exc)})

    @action(detail=False, methods=["post"], url_path="bulk-delete")
    def bulk_delete(self, request):
        self._bulk_refused = []
        response = super().bulk_delete(request)
        refused = self._bulk_refused
        if refused:
            gone = {r["id"] for r in refused}
            data = response.data
            data["deleted_ids"] = [i for i in data["deleted_ids"] if i not in gone]
            data["deleted"] = len(data["deleted_ids"])
            data["skipped"] = [*data["skipped"], *refused]
        return response
