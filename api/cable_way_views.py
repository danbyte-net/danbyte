"""``/api/cable-ways/``: cables' ways through racks (api.cable_ways,
docs/dcim/racks.md → Cable ways).

- the rows: CRUD of stored ways. A way someone writes is ``manual``: its
  hops are checked (pathways of that rack, shown, in an order that makes a
  way) and measured here, never taken from the payload;
- ``summary/?cable=<id>`` and ``propose/`` (``{cable_id}``): every rack the
  cable is in with its stored way, the proposal and its alternatives, and
  the cable's length estimate. Nothing is written;
- ``accept/`` (``{cable_id, rack_id, alternative?}``) records the proposal
  (or one of its alternatives) as an automatic way; ``dismiss/`` records
  that the rack has no way to propose.

Permissions are the ``cableway`` grant, scoped by the rack's site, and the
cable must be one the reader may view.
"""
from __future__ import annotations

import uuid

from django.db import transaction
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import serializers, status
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response

from . import cable_way_engine as eng
from . import cable_ways as cw
from .cable_scope import restrict_cables
from .models import Cable, CableWay, Rack
from .serializers import TenantScopedPrimaryKeyRelatedField
from .views import _get_active_tenant
from .viewsets import StandardPagination, TenantScopedViewSet

#: Hops one way may have.
HOPS_MAX = 16


class HopSerializer(serializers.Serializer):
    pathway_id = serializers.UUIDField(required=False, allow_null=True)
    key = serializers.CharField(required=False, allow_blank=True, max_length=100)
    enter_u = serializers.IntegerField(required=False, allow_null=True, min_value=1,
                                       max_value=100)
    leave_u = serializers.IntegerField(required=False, allow_null=True, min_value=1,
                                       max_value=100)


class CableWaySerializer(serializers.ModelSerializer):
    cable_id = TenantScopedPrimaryKeyRelatedField(source="cable", queryset=Cable.objects.all())
    rack_id = TenantScopedPrimaryKeyRelatedField(source="rack", queryset=Rack.objects.all())
    hops = HopSerializer(many=True, required=False)
    state = serializers.ChoiceField(choices=[("recorded", "Recorded"),
                                             ("dismissed", "Dismissed")], required=False)

    class Meta:
        model = CableWay
        fields = ["id", "cable_id", "rack_id", "end", "state", "source", "exit", "hops",
                  "points", "length_mm", "reasons", "created_at", "updated_at"]
        read_only_fields = ["id", "end", "source", "points", "length_mm", "reasons",
                            "created_at", "updated_at"]
        validators: list = []

    def to_representation(self, instance):
        ctx = (self.context.get("ctxs") or {}).get(instance.rack_id)
        return cw.way_doc(instance, ctx)

    def validate(self, attrs):
        inst = self.instance
        request = self.context.get("request")
        tenant = _get_active_tenant(request) if request else None
        cable = attrs.get("cable", inst.cable if inst else None)
        rack = attrs.get("rack", inst.rack if inst else None)
        if inst is not None:
            for f, src in (("cable_id", "cable"), ("rack_id", "rack")):
                if src in attrs and attrs[src] != getattr(inst, src):
                    raise ValidationError({f: "Can't be changed; delete the way and add another."})
        elif CableWay.objects.filter(cable=cable, rack=rack).exists():
            raise ValidationError({"rack_id": "The cable has a way in this rack; edit it."})
        if not restrict_cables(Cable.objects.filter(pk=cable.pk, tenant=tenant),
                               request.user, tenant, "view").exists():
            raise ValidationError({"cable_id": "Not found."})
        ctx = cw.rack_ends(cable).get(rack.pk)
        if ctx is None:
            raise ValidationError({"rack_id": "The cable has no end in this rack."})
        state = attrs.get("state", inst.state if inst else "recorded")
        if state == "proposed":
            state = "recorded"
        hops = attrs.get("hops")
        if hops is None:
            hops = [{"key": h.get("key"), "enter_u": h.get("enter_u"),
                     "leave_u": h.get("leave_u")} for h in (inst.hops if inst else [])]
        # New hops say their own way out, unless an exit comes with them.
        exit_ = attrs.get("exit", "" if "hops" in attrs or inst is None else inst.exit)
        if state == "dismissed":
            attrs["_doc"] = {"hops": [], "exit": ""}
        else:
            attrs["_doc"] = self._measure(ctx, hops, exit_)
        attrs["_ctx"] = ctx
        attrs["state"] = state
        return attrs

    @staticmethod
    def _measure(ctx, hops, exit_):
        if len(hops) > HOPS_MAX:
            raise ValidationError({"hops": f"At most {HOPS_MAX} hops."})
        if not hops:
            raise ValidationError({"hops": "Give at least one pathway, or dismiss the way."})
        keyed = []
        for i, h in enumerate(hops):
            it = ctx.item(h.get("pathway_id"), h.get("key"))
            if it is None:
                raise ValidationError({"hops": f"Hop {i + 1}: not a pathway of this rack."})
            keyed.append({"key": it["key"], "enter_u": h.get("enter_u"),
                          "leave_u": h.get("leave_u")})
        last = ctx.item(key=keyed[-1]["key"])
        if ctx.end == "AB":
            exit_ = "port"
        elif last["kind"] == "entry":
            exit_ = last.get("surface") or "top"
        elif exit_ in ("", "port"):
            exit_ = "top"
        for prev, nxt in zip(keyed, keyed[1:], strict=False):
            if prev["leave_u"] is not None and nxt["enter_u"] is not None and \
                    prev["leave_u"] != nxt["enter_u"]:
                raise ValidationError({"hops": (
                    f"{ctx.item(key=nxt['key'])['label']} starts at U{nxt['enter_u']}, "
                    f"not where the hop before it ends (U{prev['leave_u']}).")})
        try:
            return eng.measure(ctx.items, ctx.geo, ctx.engine_ends(), keyed, exit_)
        except ValueError as exc:
            raise ValidationError({"hops": str(exc)}) from exc

    def _save(self, validated, way=None):
        ctx = validated["_ctx"]
        try:
            way, _ = cw.save_way(validated.get("cable") or way.cable, ctx, validated["_doc"],
                                 state=validated["state"], source="manual", way=way)
        except ValueError as exc:
            raise ValidationError({"hops": str(exc)}) from exc
        cw.remeasure_paths(way.cable)
        self.context.setdefault("ctxs", {})[way.rack_id] = ctx
        return way

    def create(self, validated_data):
        return self._save(validated_data)

    def update(self, instance, validated_data):
        return self._save(validated_data, instance)


def _uuid(raw, name):
    try:
        return uuid.UUID(str(raw))
    except (TypeError, ValueError) as exc:
        raise ValidationError({name: "Not an id."}) from exc


class CableWayViewSet(TenantScopedViewSet):
    queryset = CableWay.objects.select_related("cable", "rack")
    serializer_class = CableWaySerializer
    pagination_class = StandardPagination
    rbac_action_map = {"summary": "view", "propose": "view", "accept": "add",
                       "dismiss": "add"}

    def get_queryset(self):
        qs = super().get_queryset()
        tenant = _get_active_tenant(self.request) if self.request else None
        if tenant is None:
            return qs.none()
        viewable = restrict_cables(Cable.objects.filter(tenant=tenant), self.request.user,
                                   tenant, "view")
        qs = qs.filter(cable__in=viewable.values("pk"))
        if self.action == "list":
            p = self.request.query_params
            for name, field in (("cable", "cable_id"), ("rack", "rack_id")):
                if p.get(name):
                    qs = qs.filter(**{field: _uuid(p[name], name)})
            if p.get("pathway"):
                qs = qs.filter(hops__contains=[{"pathway": str(_uuid(p["pathway"], "pathway"))}])
            if p.get("state"):
                qs = qs.filter(state=p["state"])
        return qs.order_by("cable_id", "end", "created_at")

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        if self.action in ("retrieve",):
            way = self.get_object()
            ctx["ctxs"] = cw.rack_ends(way.cable)
        return ctx

    def perform_destroy(self, instance):
        cable = instance.cable
        instance.delete()
        cw.remeasure_paths(cable)

    def _cable(self, raw, action_="view"):
        tenant = self._tenant_or_403()
        cable = restrict_cables(Cable.objects.filter(tenant=tenant), self.request.user, tenant,
                                "view").filter(pk=_uuid(raw, "cable_id")).first()
        if cable is None:
            raise NotFound("No such cable.")
        return cable

    def _rack_ctx(self, cable, raw):
        from auth_api import rbac

        tenant = self._tenant_or_403()
        rack_id = _uuid(raw, "rack_id")
        if not rbac.restrict_queryset(Rack.objects.filter(tenant=tenant, pk=rack_id),
                                      self.request.user, tenant, "rack", "view").exists():
            raise NotFound("No such rack.")
        ctx = cw.rack_ends(cable).get(rack_id)
        if ctx is None:
            raise ValidationError({"rack_id": "The cable has no end in this rack."})
        return ctx

    def _doc(self, cable):
        from auth_api import rbac

        tenant = self._tenant_or_403()
        doc = cw.cable_doc(cable)
        racks = {r["rack"]["id"] for r in doc["racks"]} | {
            w["rack"]["id"] for w in doc["orphans"]}
        seen = {str(pk) for pk in rbac.restrict_queryset(
            Rack.objects.filter(tenant=tenant, pk__in=racks), self.request.user, tenant,
            "rack", "view").values_list("pk", flat=True)}
        doc["racks"] = [r for r in doc["racks"] if r["rack"]["id"] in seen]
        doc["orphans"] = [w for w in doc["orphans"] if w["rack"]["id"] in seen]
        return doc

    @extend_schema(responses=OpenApiTypes.OBJECT)
    @action(detail=False, methods=["get"])
    def summary(self, request):
        """The cable's racks, stored ways, proposals and length estimate."""
        return Response(self._doc(self._cable(request.query_params.get("cable"))))

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT)
    @action(detail=False, methods=["post"])
    def propose(self, request):
        """``{cable_id}``: the proposals and alternatives, written nowhere."""
        data = request.data if isinstance(request.data, dict) else {}
        return Response(self._doc(self._cable(data.get("cable_id"))))

    def _write(self, request, state):
        data = request.data if isinstance(request.data, dict) else {}
        cable = self._cable(data.get("cable_id"))
        with transaction.atomic():
            ctx = self._rack_ctx(cable, data.get("rack_id"))
            existing = CableWay.objects.filter(cable=cable, rack=ctx.rack).first()
            if existing is not None:
                from auth_api import rbac

                if not rbac.restrict_queryset(
                        CableWay.objects.filter(pk=existing.pk), request.user,
                        self._tenant_or_403(), "cableway", "change").exists():
                    raise NotFound("No such way.")
            if state == "dismissed":
                doc = {"hops": [], "exit": ""}
            else:
                prefs = cw.exit_prefs(cable, {ctx.rack.pk: ctx})
                prop = cw.propose_for(ctx, prefs.get(ctx.rack.pk, ("",))[0])
                if prop is None:
                    raise ValidationError({"rack_id": "Nothing to propose in this rack."})
                alt = data.get("alternative")
                if alt not in (None, ""):
                    if not isinstance(alt, int) or isinstance(alt, bool) or \
                            not 0 <= alt < len(prop["alternatives"]):
                        raise ValidationError({"alternative": "Not one of the alternatives."})
                    prop = prop["alternatives"][alt]
                doc = prop
            way, _ = cw.save_way(cable, ctx, doc, state=state, source="auto", way=existing)
            cw.remeasure_paths(cable)
            response = Response(cw.way_doc(way, ctx),
                                status=status.HTTP_200_OK if existing else status.HTTP_201_CREATED)
            self._assert_write_in_site_scope(response, "add")
        return response

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT)
    @action(detail=False, methods=["post"])
    def accept(self, request):
        """``{cable_id, rack_id, alternative?}``: record the proposal."""
        return self._write(request, "recorded")

    @extend_schema(request=OpenApiTypes.OBJECT, responses=OpenApiTypes.OBJECT)
    @action(detail=False, methods=["post"])
    def dismiss(self, request):
        """``{cable_id, rack_id}``: no way in this rack; stop proposing one."""
        return self._write(request, "dismissed")
