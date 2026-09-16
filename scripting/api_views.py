"""Scripts API - ``/api/scripts/``.

RBAC decides who may work with scripts at all; :mod:`scripting.visibility`
decides which ones a user sees. Running one is its own verb, and so is
marking one trusted.
"""
from __future__ import annotations

import logging

from django.db.models import Count, OuterRef, Prefetch, Subquery
from django.http import FileResponse
from rest_framework.decorators import action
from rest_framework.response import Response

from api.viewsets import TenantScopedReadViewSet, TenantScopedViewSet

from .models import Script, ScriptOutput, ScriptRun
from .runner import cancel, create_run, enqueue
from .serializers import (
    ScriptRunDetailSerializer,
    ScriptRunSerializer,
    ScriptSerializer,
    coerce_params,
)
from .visibility import visible_scripts

logger = logging.getLogger(__name__)


class ScriptViewSet(TenantScopedViewSet):
    """Scripts the caller can see. `run` and `trust` are their own grants."""

    queryset = Script.objects.all()
    serializer_class = ScriptSerializer
    rbac_action_map = {"run": "run", "runs": "view", "trust": "trust"}

    def get_queryset(self):
        qs = super().get_queryset().select_related("owner").prefetch_related(
            "shared_users", "shared_groups"
        )
        qs = visible_scripts(qs, self.request.user)
        if self.request.query_params.get("search"):
            qs = qs.filter(name__icontains=self.request.query_params["search"])
        if self.request.query_params.get("mine") == "1":
            qs = qs.filter(owner=self.request.user)
        # The newest run's outcome, in one subquery rather than a query per
        # row. Named apart from the model's own last_run_at, which is the
        # schedule's bookkeeping and moves only when a schedule fires.
        newest = ScriptRun.objects.filter(script=OuterRef("pk")).order_by("-created_at")
        return qs.annotate(
            run_count=Count("runs", distinct=True),
            last_run_state=Subquery(newest.values("status")[:1]),
            last_run_time=Subquery(newest.values("created_at")[:1]),
        )

    def perform_create(self, serializer):
        # The base stamps the tenant; the author is always the creator.
        serializer.save(tenant=self._tenant_or_403(), owner=self.request.user)

    @action(detail=True, methods=["post"])
    def run(self, request, pk=None):
        """Queue a run. Parameters are validated against the script's schema."""
        script = self.get_object()
        if not script.enabled:
            return Response({"detail": "This script is disabled."}, status=400)
        params = coerce_params(script.params_schema, request.data.get("params") or {})
        if script.run_as == "owner" and script.owner_id is None:
            return Response({"detail": "This script has no owner to run as."}, status=400)
        run = create_run(script, user=request.user, params=params)
        enqueue(run)
        return Response(ScriptRunSerializer(run).data, status=201)

    @action(detail=True, methods=["post"])
    def trust(self, request, pk=None):
        """Mark a script trusted (or not). Trusted scripts reach the database
        directly, so this is deliberately a separate grant."""
        script = self.get_object()
        wanted = bool(request.data.get("trusted", True))
        Script.objects.filter(pk=script.pk).update(trusted=wanted)
        script.refresh_from_db()
        return Response(self.get_serializer(script).data)

    @action(detail=True, methods=["get"])
    def runs(self, request, pk=None):
        script = self.get_object()
        qs = script.runs.select_related("started_by", "run_as_user").prefetch_related("outputs")
        page = self.paginate_queryset(qs)
        ser = ScriptRunSerializer(page if page is not None else qs, many=True)
        return self.get_paginated_response(ser.data) if page is not None else Response(ser.data)


class ScriptRunViewSet(TenantScopedReadViewSet):
    """Runs of scripts the caller can see. The detail view carries the log,
    which the run page polls while the run is active."""

    queryset = ScriptRun.objects.all()
    serializer_class = ScriptRunSerializer
    rbac_object_type = "script"
    rbac_action_map = {"cancel": "run", "download": "view"}
    tenant_field = "script__tenant"

    def get_serializer_class(self):
        if self.action in ("retrieve", "cancel"):
            return ScriptRunDetailSerializer
        return ScriptRunSerializer

    def get_queryset(self):
        qs = super().get_queryset().select_related(
            "script", "started_by", "run_as_user"
        ).prefetch_related(Prefetch("outputs", queryset=ScriptOutput.objects.order_by("name")))
        visible = visible_scripts(Script.objects.all(), self.request.user)
        qs = qs.filter(script__in=visible)
        p = self.request.query_params
        if p.get("script"):
            qs = qs.filter(script_id=p["script"])
        if p.get("status"):
            qs = qs.filter(status=p["status"])
        return qs

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        run = self.get_object()
        if not run.active:
            return Response({"detail": "This run has already finished."}, status=400)
        cancel(run)
        run.refresh_from_db()
        return Response(self.get_serializer(run).data)

    @action(detail=True, methods=["get"], url_path=r"outputs/(?P<output_id>[^/.]+)/download")
    def download(self, request, pk=None, output_id=None):
        run = self.get_object()
        out = run.outputs.filter(pk=output_id).first()
        if out is None or not out.file:
            return Response({"detail": "No such output."}, status=404)
        return FileResponse(
            out.file.open("rb"), as_attachment=True, filename=out.name,
            content_type=out.content_type or "application/octet-stream",
        )
