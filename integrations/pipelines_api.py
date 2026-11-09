"""Deploy pipelines API: ``/api/deploy-pipelines/`` (steps nested and
writable, export/import as code, bulk deploy) and ``/api/deploy-pipeline-runs/``
(list, detail with steps, cancel, re-run)."""
from __future__ import annotations

import uuid as _uuid

from django.db import transaction
from django.db.models import Prefetch, Q
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response

from api.bulk_edit import BulkEditMixin, BulkEditSpec
from api.models import DeviceRole
from api.serializers import TenantScopedPrimaryKeyRelatedField
from api.viewsets import TenantScopedViewSet

from .dispatch import target_covers
from .models import AutomationTarget, DeployPipeline, DeployPipelineRun, DeployPipelineStep
from .pipelines import WAITABLE_KINDS, earlier_steps, pipeline_covers, step_status

#: What a pipeline can run against. The engine builds a payload for these.
PIPELINE_OBJECT_TYPES = ("device", "virtualmachine")
MAX_STEPS = 20
MAX_TIMEOUT_MINUTES = 7 * 24 * 60


def _active_tenant(request):
    from api.views import _get_active_tenant

    return _get_active_tenant(request) if request is not None else None


# ── pipelines ────────────────────────────────────────────────────────────────


class DeployPipelineStepSerializer(serializers.ModelSerializer):
    target = TenantScopedPrimaryKeyRelatedField(queryset=AutomationTarget.objects.all())
    target_name = serializers.CharField(source="target.name", read_only=True)
    target_kind = serializers.CharField(source="target.kind", read_only=True)
    target_kind_display = serializers.CharField(
        source="target.get_kind_display", read_only=True
    )
    target_enabled = serializers.BooleanField(source="target.enabled", read_only=True)
    timeout_minutes = serializers.IntegerField(
        min_value=1, max_value=MAX_TIMEOUT_MINUTES, required=False,
        default=DeployPipelineStep.DEFAULT_TIMEOUT_MINUTES,
    )

    class Meta:
        model = DeployPipelineStep
        fields = ["id", "order", "target", "target_name", "target_kind",
                  "target_kind_display", "target_enabled", "stop_on_failure",
                  "wait_for_result", "timeout_minutes"]
        read_only_fields = ["id", "order", "target_name", "target_kind",
                            "target_kind_display", "target_enabled"]


class DeployPipelineSerializer(serializers.ModelSerializer):
    steps = DeployPipelineStepSerializer(many=True, required=False)
    roles = TenantScopedPrimaryKeyRelatedField(
        many=True, queryset=DeviceRole.objects.all(), required=False
    )
    role_details = serializers.SerializerMethodField()
    steps_count = serializers.SerializerMethodField()
    last_run = serializers.SerializerMethodField()

    def get_role_details(self, obj) -> list[dict]:
        return [{"id": str(r.id), "name": r.name, "color": r.color} for r in obj.roles.all()]

    def get_steps_count(self, obj) -> int:
        return len(obj.steps.all())

    def get_last_run(self, obj):
        latest = getattr(obj, "latest_runs", None)
        if latest is None:
            latest = list(obj.runs.order_by("-created_at")[:1])
        if not latest:
            return None
        r = latest[0]
        return {"id": str(r.id), "numid": r.numid, "status": r.status,
                "created_at": r.created_at, "finished_at": r.finished_at}

    def _tenant(self):
        if self.instance is not None and getattr(self.instance, "tenant_id", None):
            return self.instance.tenant
        return self.context.get("tenant") or _active_tenant(self.context.get("request"))

    def validate_object_types(self, value):
        if value in (None, ""):
            return ["device"]
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise serializers.ValidationError("A list of object types.")
        bad = [v for v in value if v not in PIPELINE_OBJECT_TYPES]
        if bad:
            raise serializers.ValidationError(
                f"Not something a pipeline deploys: {', '.join(bad)}. "
                f"Use {' or '.join(PIPELINE_OBJECT_TYPES)}."
            )
        return list(dict.fromkeys(value)) or ["device"]

    def validate(self, attrs):
        tenant = self._tenant()
        if tenant is None:
            raise serializers.ValidationError("No active tenant selected.")
        inst = self.instance
        types = attrs.get("object_types", getattr(inst, "object_types", None)) or ["device"]
        roles = attrs.get("roles")
        if roles is not None:
            if any(r.tenant_id != tenant.pk for r in roles):
                raise serializers.ValidationError({"roles": ["Unknown role."]})
        steps = attrs.get("steps")
        if steps is None and inst is None:
            raise serializers.ValidationError({"steps": ["Add at least one step."]})
        if steps is not None:
            if not steps:
                raise serializers.ValidationError({"steps": ["Add at least one step."]})
            if len(steps) > MAX_STEPS:
                raise serializers.ValidationError(
                    {"steps": [f"At most {MAX_STEPS} steps."]}
                )
            errors = []
            for step in steps:
                err = {}
                target = step["target"]
                if target.tenant_id != tenant.pk:
                    err["target"] = ["Unknown target."]
                else:
                    missing = [t for t in types if not target_covers(target, t)]
                    if missing:
                        err["target"] = [
                            f"{target.name} does not take {', '.join(missing)}."
                        ]
                    if (step.get("wait_for_result") and target.kind != "script"
                            and target.kind not in WAITABLE_KINDS):
                        err["wait_for_result"] = [
                            f"A {target.get_kind_display()} target cannot report a result. "
                            "Only a webhook target can."
                        ]
                errors.append(err)
            if any(errors):
                raise serializers.ValidationError({"steps": errors})
        return attrs

    def _write_steps(self, pipeline, steps):
        existing = list(pipeline.steps.order_by("order"))
        for i, data in enumerate(steps, start=1):
            row = existing[i - 1] if i <= len(existing) else DeployPipelineStep(pipeline=pipeline)
            row.order = i
            row.target = data["target"]
            row.stop_on_failure = data.get("stop_on_failure", True)
            row.wait_for_result = data.get("wait_for_result", False)
            row.timeout_minutes = data.get(
                "timeout_minutes", DeployPipelineStep.DEFAULT_TIMEOUT_MINUTES
            )
            row.save()
        for row in existing[len(steps):]:
            row.delete()

    def create(self, validated):
        steps = validated.pop("steps", [])
        roles = validated.pop("roles", None)
        with transaction.atomic():
            pipeline = DeployPipeline.objects.create(**validated)
            if roles is not None:
                pipeline.roles.set(roles)
            self._write_steps(pipeline, steps)
        return pipeline

    def update(self, instance, validated):
        steps = validated.pop("steps", None)
        roles = validated.pop("roles", None)
        with transaction.atomic():
            for k, v in validated.items():
                setattr(instance, k, v)
            instance.save()
            if roles is not None:
                instance.roles.set(roles)
            if steps is not None:
                self._write_steps(instance, steps)
        return instance

    class Meta:
        model = DeployPipeline
        fields = ["id", "name", "description", "object_types", "auto_on_change",
                  "enabled", "roles", "role_details", "steps", "steps_count",
                  "last_run", "created_at", "updated_at"]
        read_only_fields = ["id", "role_details", "steps_count", "last_run",
                            "created_at", "updated_at"]


def pipeline_as_code(p: DeployPipeline) -> dict:
    """The pipeline as plain data, targets and roles by name - the "As code"
    form the editor shows and import reads back."""
    out = {
        "name": p.name,
        "description": p.description,
        "object_types": list(p.object_types or ["device"]),
        "auto_on_change": p.auto_on_change,
        "enabled": p.enabled,
        "roles": [r.name for r in p.roles.order_by("name")],
        "steps": [
            {
                "target": s.target.name,
                "stop_on_failure": s.stop_on_failure,
                "wait_for_result": s.wait_for_result,
                "timeout_minutes": s.timeout_minutes,
            }
            for s in p.steps.select_related("target").order_by("order")
        ],
    }
    return out


class DeployPipelineViewSet(BulkEditMixin, TenantScopedViewSet):
    queryset = DeployPipeline.objects.all().order_by("name")
    serializer_class = DeployPipelineSerializer
    bulk_edit = BulkEditSpec(fields=("enabled", "auto_on_change"), tags=False)
    rbac_action_map = {**BulkEditMixin.rbac_action_map, "export": "view", "import_code": "add"}

    def get_queryset(self):
        qs = super().get_queryset().prefetch_related(
            Prefetch("steps", queryset=DeployPipelineStep.objects.select_related("target")
                     .order_by("order")),
            "roles",
            Prefetch("runs", queryset=DeployPipelineRun.objects.order_by("-created_at")[:1],
                     to_attr="latest_runs"),
        )
        if self.request:
            p = self.request.query_params
            s = p.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s)
            role = p.get("role")
            if role:
                try:
                    qs = qs.filter(roles=_uuid.UUID(str(role)))
                except ValueError:
                    qs = qs.none()
            object_type = p.get("object_type")
            if object_type:
                match = Q(object_types__contains=[object_type]) | Q(object_types__contains=["*"])
                if object_type == "device":
                    match |= Q(object_types=[])
                qs = qs.filter(match)
            if p.get("enabled") in ("true", "1"):
                qs = qs.filter(enabled=True)
        return qs

    @action(detail=True, methods=["get"])
    def export(self, request, pk=None):
        return Response(pipeline_as_code(self.get_object()))

    @action(detail=False, methods=["post"], url_path="import")
    def import_code(self, request):
        """Create or update a pipeline from its as-code form. Targets and
        roles are looked up by name in the active tenant only. An existing
        pipeline of the same name is updated, which needs ``change``."""
        from auth_api import rbac

        tenant = self._tenant_or_403()
        data = request.data if isinstance(request.data, dict) else None
        if data is None:
            return Response({"detail": "A JSON object."}, status=400)
        name = data.get("name")
        if not isinstance(name, str) or not name.strip():
            return Response({"name": ["This field is required."]}, status=400)
        raw_steps = data.get("steps")
        if not isinstance(raw_steps, list):
            return Response({"steps": ["A list of steps."]}, status=400)
        step_errors, steps = [], []
        for raw in raw_steps:
            if not isinstance(raw, dict) or not isinstance(raw.get("target"), str):
                step_errors.append({"target": ["Name the target."]})
                continue
            target = AutomationTarget.objects.filter(tenant=tenant, name=raw["target"]).first()
            if target is None:
                step_errors.append({"target": [f"No target named {raw['target']}."]})
                continue
            step_errors.append({})
            step = {"target": str(target.id)}
            for key in ("stop_on_failure", "wait_for_result", "timeout_minutes"):
                if key in raw:
                    step[key] = raw[key]
            steps.append(step)
        if any(step_errors):
            return Response({"steps": step_errors}, status=400)
        body = {"name": name.strip(), "steps": steps}
        for key in ("description", "object_types", "auto_on_change", "enabled"):
            if key in data:
                body[key] = data[key]
        if "roles" in data:
            names = data.get("roles") or []
            if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
                return Response({"roles": ["A list of role names."]}, status=400)
            roles = {r.name: r for r in DeviceRole.objects.filter(tenant=tenant, name__in=names)}
            missing = [n for n in names if n not in roles]
            if missing:
                return Response({"roles": [f"No role named {', '.join(missing)}."]}, status=400)
            body["roles"] = [str(roles[n].id) for n in names]
        existing = DeployPipeline.objects.filter(tenant=tenant, name=body["name"]).first()
        if existing is not None:
            if not (request.user.is_superuser or rbac.can_act_on(
                    request.user, tenant, "deploypipeline", "change", existing)):
                return Response(
                    {"detail": "A pipeline of this name exists and you may not change it."},
                    status=403,
                )
            ser = self.get_serializer(existing, data=body, partial=True)
            ser.is_valid(raise_exception=True)
            ser.save()
            return Response(self.get_serializer(self.get_queryset().get(pk=existing.pk)).data)
        ser = self.get_serializer(data=body)
        ser.is_valid(raise_exception=True)
        ser.save(tenant=tenant)
        return Response(
            self.get_serializer(self.get_queryset().get(pk=ser.instance.pk)).data, status=201
        )

    @action(detail=True, methods=["post"])
    def deploy(self, request, pk=None):
        """Bulk deploy: run this pipeline for the given devices (or intended
        VMs) in one run. Body ``{"device_ids": [...], "dry_run": false}``.
        Ids are checked against the caller's own scope, as the target bulk
        deploy checks them."""
        pipeline = self.get_object()
        ids = (request.data or {}).get("device_ids") or []
        object_type = (request.data or {}).get("object_type") or "device"
        if not isinstance(ids, list) or not ids:
            return Response({"detail": "device_ids must be a non-empty list."}, status=400)
        run, err = start_for(request, pipeline, ids, object_type=object_type,
                             dry_run=bool((request.data or {}).get("dry_run")))
        if err:
            return err
        return Response(DeployPipelineRunSerializer(run, context={"request": request}).data,
                        status=202)


def resolve_pipeline(request, tenant, pipeline_id, object_type="device"):
    """The enabled pipeline ``pipeline_id`` of ``tenant`` that the caller can
    see and that deploys ``object_type``, or ``(None, Response)``."""
    from auth_api import rbac

    try:
        pid = _uuid.UUID(str(pipeline_id))
    except (ValueError, TypeError, AttributeError):
        pid = None
    qs = DeployPipeline.objects.filter(pk=pid, tenant=tenant, enabled=True) if pid else None
    if qs is not None and not request.user.is_superuser:
        qs = rbac.restrict_queryset(qs, request.user, tenant, "deploypipeline", "view")
    pipeline = qs.first() if qs is not None else None
    if pipeline is None:
        return None, Response({"pipeline_id": "Unknown or disabled pipeline."}, status=400)
    if not pipeline_covers(pipeline, object_type):
        return None, Response(
            {"pipeline_id": f"{pipeline.name} does not take {object_type}."}, status=400
        )
    return pipeline, None


def start_for(request, pipeline, ids, *, object_type="device", dry_run=False,
              trigger="deploy", rerun_of=None):
    """Start ``pipeline`` for the ids the caller may deploy. Returns
    ``(run, None)`` or ``(None, Response)``."""
    from api.models import Device, VirtualMachine
    from auth_api import rbac

    from .pipelines import start

    tenant = pipeline.tenant
    if object_type not in PIPELINE_OBJECT_TYPES or not pipeline_covers(pipeline, object_type):
        return None, Response({"detail": f"{pipeline.name} does not take {object_type}."},
                              status=400)
    try:
        ids = [_uuid.UUID(str(i)) for i in ids]
    except (ValueError, TypeError, AttributeError):
        return None, Response({"device_ids": ["A list of ids."]}, status=400)
    if object_type == "virtualmachine":
        qs = VirtualMachine.objects.filter(tenant=tenant, intended=True, id__in=ids)
        qs = rbac.restrict_queryset(qs, request.user, tenant, "virtualmachine", "provision")
    else:
        qs = Device.objects.filter(tenant=tenant, id__in=ids)
        qs = rbac.restrict_queryset(qs, request.user, tenant, "device", "view")
    valid = list(qs.values_list("id", flat=True))
    if not valid:
        return None, Response({"detail": "No matching objects in this tenant."}, status=400)
    run = start(pipeline, valid, object_type=object_type, trigger=trigger,
                user=request.user, dry_run=dry_run, rerun_of=rerun_of)
    return run, None


# ── runs ─────────────────────────────────────────────────────────────────────


def _object_names(run, request, cache=None) -> list[dict]:
    from api.models import Device, VirtualMachine
    from auth_api import rbac

    model, slug = (
        (VirtualMachine, "virtualmachine") if run.object_type == "virtualmachine"
        else (Device, "device")
    )
    qs = model.objects.filter(tenant_id=run.tenant_id, id__in=run.object_ids)
    user = getattr(request, "user", None)
    if user is not None and user.is_authenticated:
        qs = rbac.restrict_queryset(qs, user, run.tenant, slug, "view")
    names = dict(qs.values_list("id", "name"))
    return [{"id": str(k), "name": v} for k, v in names.items()]


def _first_line(text: str) -> str:
    for line in (text or "").splitlines():
        if line.strip():
            return line.strip()[:300]
    return ""


class DeployPipelineRunSerializer(serializers.ModelSerializer):
    trigger_display = serializers.CharField(source="get_trigger_display", read_only=True)
    triggered_by_name = serializers.CharField(
        source="triggered_by.username", read_only=True, default=None
    )
    rerun_of_numid = serializers.IntegerField(source="rerun_of.numid", read_only=True,
                                              default=None)
    duration_ms = serializers.SerializerMethodField()
    objects = serializers.SerializerMethodField()
    steps = serializers.SerializerMethodField()
    failing_step = serializers.SerializerMethodField()

    def get_duration_ms(self, obj):
        start = obj.started_at or obj.created_at
        if obj.finished_at and start:
            return int((obj.finished_at - start).total_seconds() * 1000)
        return None

    def get_objects(self, obj):
        return _object_names(obj, self.context.get("request"))

    def _step_runs(self, obj):
        cache = getattr(obj, "_step_runs_cache", None)
        if cache is None:
            prefetched = getattr(obj, "prefetched_step_runs", None)
            rows = prefetched if prefetched is not None else list(
                obj.step_runs.select_related("script_run")
            )
            cache = {dr.pipeline_step: dr for dr in rows}
            obj._step_runs_cache = cache
        return cache

    def _step_row(self, obj, no, step, dr):
        status = step_status(step, dr, obj)
        row = {
            "step": no,
            "target": step.get("target"),
            "target_name": step.get("target_name"),
            "kind": step.get("kind"),
            "stop_on_failure": step.get("stop_on_failure", True),
            "wait_for_result": step.get("wait_for_result", False),
            "timeout_minutes": step.get("timeout_minutes"),
            "status": status,
            "deploy_run": str(dr.id) if dr else None,
            "detail": dr.detail if dr else "",
            "started_at": dr.created_at if dr else None,
            "finished_at": dr.finished_at if dr else None,
            "duration_ms": (
                int((dr.finished_at - dr.created_at).total_seconds() * 1000)
                if dr and dr.finished_at else None
            ),
            "script_run": str(dr.script_run_id) if dr and dr.script_run_id else None,
            "script_run_status": dr.script_run.status if dr and dr.script_run_id else None,
            "result_deadline": dr.result_deadline if dr else None,
        }
        return row

    def get_steps(self, obj):
        runs = self._step_runs(obj)
        return [self._step_row(obj, no, step, runs.get(no))
                for no, step in enumerate(obj.steps or [], start=1)]

    def get_failing_step(self, obj):
        if obj.status != "failed":
            return None
        runs = self._step_runs(obj)
        for no, step in enumerate(obj.steps or [], start=1):
            dr = runs.get(no)
            if dr is not None and dr.status == "failed":
                return {"step": no, "target_name": step.get("target_name"),
                        "error": _first_line(dr.detail)}
        return {"step": None, "target_name": None, "error": _first_line(obj.detail)}

    class Meta:
        model = DeployPipelineRun
        fields = ["id", "numid", "pipeline", "pipeline_name", "object_type", "object_ids",
                  "objects", "trigger", "trigger_display", "rerun_of", "rerun_of_numid",
                  "triggered_by_name", "dry_run", "status", "detail", "created_at",
                  "started_at", "finished_at", "duration_ms", "steps", "failing_step"]
        read_only_fields = fields


class DeployPipelineRunDetailSerializer(DeployPipelineRunSerializer):
    """Adds each step's log lines and outputs, and what the next step
    receives. A script step's log and outputs show only to someone who may
    see that script's runs."""

    next_payload = serializers.SerializerMethodField()

    def _may_see_script(self, sr) -> bool:
        from auth_api import rbac
        from scripting.visibility import can_see

        request = self.context.get("request")
        user = getattr(request, "user", None)
        if user is None or not user.is_authenticated:
            return False
        return bool(
            rbac.has_action(user, sr.script.tenant, "script", "view") and can_see(sr.script, user)
        )

    def _step_row(self, obj, no, step, dr):
        from .pipelines import output_url

        row = super()._step_row(obj, no, step, dr)
        row["log"] = ""
        row["log_source"] = None
        row["outputs"] = []
        if dr is None:
            return row
        sr = dr.script_run
        if sr is not None:
            if self._may_see_script(sr):
                row["log"] = sr.log or ""
                row["log_source"] = "script"
                row["outputs"] = [
                    {"name": o.name, "size": o.size, "url": output_url(sr.id, o.id)}
                    for o in sorted(sr.outputs.all(), key=lambda o: o.name)
                ]
            else:
                row["log_source"] = "hidden"
        elif dr.log:
            row["log"] = dr.log
            row["log_source"] = "runner"
        return row

    def get_next_payload(self, obj):
        steps = obj.steps or []
        if not steps:
            return None
        runs = self._step_runs(obj)
        started = [n for n in range(1, len(steps) + 1) if n in runs]
        no = min((max(started) + 1) if started else 1, len(steps))
        ids = [o["id"] for o in self.get_objects(obj)] or list(obj.object_ids)
        return {
            "event": obj.event,
            "object_type": obj.object_type,
            "device_ids": ids,
            "pipeline_run_id": str(obj.id),
            "pipeline": obj.pipeline_name,
            "step": no,
            "dry_run": obj.dry_run,
            "steps": earlier_steps(obj, no),
        }

    class Meta(DeployPipelineRunSerializer.Meta):
        fields = [*DeployPipelineRunSerializer.Meta.fields, "next_payload"]
        read_only_fields = fields


class DeployPipelineRunViewSet(TenantScopedViewSet):
    # Unambiguous id aliases (core.query_params).
    query_param_aliases = {"device_id": "device"}
    queryset = DeployPipelineRun.objects.select_related(
        "tenant", "triggered_by", "rerun_of"
    ).order_by("-created_at")
    serializer_class = DeployPipelineRunSerializer
    http_method_names = ["get", "post"]

    def create(self, request, *args, **kwargs):
        from rest_framework.exceptions import MethodNotAllowed

        raise MethodNotAllowed("POST")

    def get_serializer_class(self):
        if self.action in ("retrieve", "cancel"):
            return DeployPipelineRunDetailSerializer
        return DeployPipelineRunSerializer

    def get_queryset(self):
        from .models import DeployRun

        qs = super().get_queryset().prefetch_related(
            Prefetch("step_runs", queryset=DeployRun.objects.select_related(
                "script_run", "script_run__script", "script_run__script__tenant"
            ).prefetch_related("script_run__outputs"), to_attr="prefetched_step_runs")
        )
        p = self.request.query_params
        if p.get("status"):
            qs = qs.filter(status=p["status"])
        if p.get("pipeline"):
            try:
                qs = qs.filter(pipeline_id=_uuid.UUID(str(p["pipeline"])))
            except ValueError:
                qs = qs.none()
        device = p.get("device")
        if device:
            qs = qs.filter(object_ids__contains=[device])
        if p.get("object_type"):
            qs = qs.filter(object_type=p["object_type"])
        return qs

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        from .pipelines import cancel

        run = self.get_object()
        if run.status in run.FINAL_STATUSES:
            return Response({"detail": f"This run is {run.status}."}, status=400)
        cancel(run)
        return Response(DeployPipelineRunDetailSerializer(
            self.get_queryset().get(pk=run.pk), context={"request": request}
        ).data)

    @action(detail=True, methods=["post"])
    def rerun(self, request, pk=None):
        run = self.get_object()
        tenant = self._tenant_or_403()
        if run.pipeline_id is None:
            return Response({"detail": "The pipeline was deleted."}, status=400)
        pipeline, err = resolve_pipeline(request, tenant, run.pipeline_id, run.object_type)
        if err:
            return err
        new, err = start_for(request, pipeline, run.object_ids, object_type=run.object_type,
                             dry_run=run.dry_run, trigger="rerun", rerun_of=run)
        if err:
            return err
        return Response(DeployPipelineRunSerializer(new, context={"request": request}).data,
                        status=202)
