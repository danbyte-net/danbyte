"""The review queue's API, for any external monitor.

Changes are proposed by a planning pass, never created through the API - so
the queue offers apply, dismiss, restore and apply-all, and nothing else.
Each system mixes :class:`ChangeQueueMixin` into its change viewset and says
how one change is applied; the toggle mixin and the tenant scoping stay on
the concrete viewset.
"""
from __future__ import annotations

from rest_framework.decorators import action
from rest_framework.response import Response


class ChangeQueueMixin:
    """Apply / dismiss / restore / apply-all over an ``ExternalChangeBase``.

    Must sit before ``TenantScopedViewSet`` in the bases, so its
    ``get_queryset`` narrows the tenant-scoped one. A concrete viewset sets
    ``change_model`` and ``connection_model`` and implements
    :meth:`apply_change`, :meth:`apply_pending` and :meth:`remote_errors`.
    """

    change_model = None
    connection_model = None
    http_method_names = ["get", "post", "head", "options"]

    # ── what a system supplies ──────────────────────────────────────────
    def apply_change(self, change) -> str:
        """Do one proposed write; return a sentence for the operator. Raise
        ``ValueError`` for a proposal that cannot be applied as it stands."""
        raise NotImplementedError

    def apply_pending(self, conn) -> dict:
        """Apply every applicable proposal of one connection."""
        raise NotImplementedError

    def remote_errors(self) -> tuple:
        """Exception types meaning the remote system refused or was
        unreachable - reported as 502, not as the operator's mistake."""
        return ()

    # ── the queue ───────────────────────────────────────────────────────
    def get_queryset(self):
        qs = super().get_queryset()
        params = self.request.query_params if self.request else {}
        conn = params.get("connection")
        if conn:
            qs = qs.filter(connection_id=conn)
        # The queue by default; `?ignored=1` is the dismissed pile, which
        # exists so a mis-click is not a permanent silence.
        return qs.filter(ignored=params.get("ignored") in ("1", "true"))

    @action(detail=True, methods=["post"])
    def restore(self, request, pk=None):
        """Un-dismiss. Back in the queue; the next pass re-checks it anyway."""
        from api.views import _get_active_tenant

        change = self.change_model.objects.filter(
            pk=pk, tenant=_get_active_tenant(request), ignored=True
        ).first()
        if change is None:
            return Response({"detail": "Not found."}, status=404)
        change.ignored = False
        change.save(update_fields=["ignored"])
        return Response({"ok": True})

    @action(detail=True, methods=["post"])
    def apply(self, request, pk=None):
        """Do this one write. The operator's act, not Danbyte's."""
        change = self.get_object()
        try:
            return Response({"ok": True, "detail": self.apply_change(change)})
        except ValueError as exc:
            return Response({"ok": False, "detail": str(exc)}, status=400)
        except self.remote_errors() as exc:
            return Response({"ok": False, "detail": str(exc)}, status=502)

    @action(detail=True, methods=["post"])
    def dismiss(self, request, pk=None):
        """Not now. Kept, so the next pass does not raise it again."""
        change = self.get_object()
        change.ignored = True
        change.save(update_fields=["ignored"])
        return Response({"ok": True})

    @action(detail=False, methods=["post"], url_path="apply-all")
    def apply_all(self, request):
        """Apply every applicable proposal for one connection.

        Ambiguous ones are skipped - they need a person, and "apply all" must
        not quietly resolve them by guessing.
        """
        from api.views import _get_active_tenant

        # Scoped to the active tenant, not just looked up by id: a connection
        # id is a UUID somebody could have from anywhere.
        conn = self.connection_model.objects.filter(
            pk=request.data.get("connection"),
            tenant=_get_active_tenant(request),
        ).first()
        if conn is None:
            return Response({"detail": "Unknown connection."}, status=404)
        return Response(self.apply_pending(conn))
