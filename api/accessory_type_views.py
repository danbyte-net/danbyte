"""``/api/accessory-types/``: the parts seated in ports on 3D models - the
Pluggables page (api.port_plugs, docs/dcim/pluggables.md).

Accessory types come with model packs. An editor may change a part's
``fits``, ``parts``, ``standard``, ``wavelength_nm``, ``reach_m`` and
``cable``, and replace its model; each field changed by hand is listed in
``hand_edited``, and a pack re-import keeps it (api.port_plugs.apply_accessory).
Name, vendor, kind and connector stay the pack's.

Permissions are the ``accessorytype`` grant ("Pluggables"): view to read,
change to edit and replace the model, delete to delete - and only a part
nothing uses. Every row is the active tenant's own. ``model/`` serves a
part's ``.glb`` like a type's model (api.model_3d.serve); ``usage/`` lists
the ports that show it (api.port_plugs.usage).
"""
from __future__ import annotations

from types import SimpleNamespace

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.utils.text import slugify
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import permissions, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response

from . import port_plugs as pp
from .models import AccessoryType
from .pagination import StandardResultsSetPagination

#: The editable fields, in the order a hand edit lists them.
EDITABLE = ("fits", "parts", "standard", "wavelength_nm", "reach_m", "cable")
REACH_MAX_M = 1_000_000


class AccessoryTypeSerializer(serializers.ModelSerializer):
    model_url = serializers.SerializerMethodField()
    in_use = serializers.SerializerMethodField()
    hand_edited = serializers.ListField(child=serializers.CharField(), required=False)
    cable = serializers.JSONField(required=False, allow_null=True)
    fits = serializers.JSONField(required=False)
    parts = serializers.JSONField(required=False)

    class Meta:
        model = AccessoryType
        fields = ["id", "vendor", "name", "kind", "connector", "fits", "parts", "standard",
                  "wavelength_nm", "reach_m", "cable", "u_height", "model_url", "pack_import",
                  "hand_edited", "in_use", "created_at", "updated_at"]
        read_only_fields = ["id", "vendor", "name", "kind", "connector", "u_height", "model_url",
                            "pack_import", "in_use", "created_at", "updated_at"]
        extra_kwargs = {
            "wavelength_nm": {"min_value": 1, "max_value": 100_000},
            "reach_m": {"min_value": 0, "max_value": REACH_MAX_M},
            "standard": {"max_length": 64},
        }

    def get_model_url(self, obj):
        from .model_3d import version_of

        if not obj.model_3d:
            return None
        return f"/api/accessory-types/{obj.pk}/model/?v={version_of(obj.model_3d)}"

    def get_in_use(self, obj) -> int | None:
        counts = self.context.get("counts")
        return None if counts is None else counts.get(str(obj.pk), 0)

    def validate_fits(self, value):
        if self.instance is not None and self.instance.kind in pp.RACK_KINDS:
            if value:
                raise ValidationError("A rack part plugs into no port.")
            return []
        if not isinstance(value, list) or not value:
            raise ValidationError("List the port types it plugs into.")
        if len(value) > pp.MAX_FITS:
            raise ValidationError(f"At most {pp.MAX_FITS} port types.")
        out: list[str] = []
        for x in value:
            s = x.strip().lower() if isinstance(x, str) else ""
            if not pp._SLUG.match(s):
                raise ValidationError(f"{x!r} is not a port type slug.")
            if s not in out:
                out.append(s)
        return out

    def validate_parts(self, value):
        if not isinstance(value, list):
            raise ValidationError("A list of part numbers.")
        if len(value) > pp.MAX_PARTS:
            raise ValidationError(f"At most {pp.MAX_PARTS} part numbers.")
        out: list[str] = []
        seen: set[str] = set()
        for x in value:
            ok = isinstance(x, (str, int)) and not isinstance(x, bool)
            s = str(x).strip() if ok else ""
            if not s or len(s) > pp.PART_MAX or not pp.part_key(s):
                raise ValidationError(f"{x!r} is not a part number.")
            if pp.part_key(s) not in seen:
                seen.add(pp.part_key(s))
                out.append(s)
        return out

    def validate_standard(self, value):
        return (value or "").strip()

    def validate_cable(self, value):
        if value is None:
            return None
        if self.instance is not None and self.instance.kind == "transceiver":
            raise ValidationError("A transceiver has no cable of its own; its cord does.")
        notes: list[str] = []
        block = pp.read_cable(value, notes)
        if block is None or any("ignored" in n or "needed" in n for n in notes):
            raise ValidationError(notes or ["Not a cable block."])
        return block

    def validate_hand_edited(self, value):
        have = list(self.instance.hand_edited or []) if self.instance is not None else []
        if any(v not in have for v in value):
            raise ValidationError("Only fields changed by hand can be handed back to the pack.")
        return [v for v in have if v in value]

    def update(self, instance, validated_data):
        flags = validated_data.pop("hand_edited", None)
        flags = list(instance.hand_edited or []) if flags is None else flags
        for f in EDITABLE:
            if f in validated_data and validated_data[f] != getattr(instance, f):
                setattr(instance, f, validated_data[f])
                if f not in flags:
                    flags.append(f)
        instance.hand_edited = [f for f in pp.HAND_FIELDS if f in flags]
        instance.save()
        return instance


def _part_records(items, acc) -> dict[str, int]:
    """``{part number: records with no part set by hand whose part ID it
    matches}`` among ``items`` (none without view on inventory items)."""
    from django.db.models import Q

    if items is None or not acc.parts:
        return {}
    keys = {pp.part_key(str(p)): str(p) for p in acc.parts}
    counts = dict.fromkeys(keys.values(), 0)
    q = Q()
    for k in keys:
        q |= Q(part_id__iexact=k) | Q(part_id__iexact=f"{k}=")
    for part in items.filter(accessory_type__isnull=True).filter(q).values_list(
            "part_id", flat=True):
        p = keys.get(pp.part_key(part))
        if p is not None:
            counts[p] += 1
    return counts


#: Reads every port and record: a delete checks what anyone uses.
_EVERYONE = SimpleNamespace(is_superuser=True, is_authenticated=True)


class AccessoryTypeViewSet(viewsets.GenericViewSet):
    permission_classes = [permissions.IsAuthenticated]
    pagination_class = StandardResultsSetPagination
    serializer_class = AccessoryTypeSerializer
    queryset = AccessoryType.objects.all()
    parser_classes = [JSONParser, MultiPartParser, FormParser]

    def _tenant(self):
        from .views import _get_active_tenant

        tenant = _get_active_tenant(self.request)
        if tenant is None:
            raise PermissionDenied("No active tenant selected.")
        return tenant

    def get_queryset(self):
        tenant = self._tenant()
        if not pp.may_view_types(self.request.user, tenant):
            raise PermissionDenied("You can't view pluggables.")
        return AccessoryType.objects.filter(tenant=tenant)

    def _get(self, pk):
        try:
            obj = self.get_queryset().filter(pk=pk).first()
        except (ValueError, DjangoValidationError):  # a malformed id
            obj = None
        if obj is None:
            raise NotFound()
        return obj

    def _need(self, act: str):
        from auth_api import rbac

        if not rbac.has_action(self.request.user, self._tenant(), "accessorytype", act):
            raise PermissionDenied(f"You can't {act} pluggables.")

    def list(self, request):
        """The tenant's parts. Filters: ``kind``, ``connector``, ``fits`` (a
        port type slug), ``pack`` (a pack name), ``in_use`` (true / false),
        ``search`` (name, vendor, standard or a part number). Each row's
        ``in_use`` counts the ports and spare records that show it."""
        from django.db.models import Q, TextField
        from django.db.models.functions import Cast

        qs = self.get_queryset()
        p = request.query_params
        if kind := p.get("kind"):
            qs = qs.filter(kind=kind)
        if conn := p.get("connector"):
            qs = qs.filter(connector=conn.strip().lower())
        if fits := p.get("fits"):
            qs = qs.filter(fits__contains=[fits.strip().lower()])
        if pack := p.get("pack"):
            qs = qs.filter(pack_import__pack__name=pack)
        if s := p.get("search", "").strip():
            qs = qs.annotate(_parts=Cast("parts", TextField())).filter(
                Q(name__icontains=s) | Q(vendor__icontains=s) | Q(_parts__icontains=s)
                | Q(standard__icontains=s))
        counts = pp.usage_counts(request.user, self._tenant())
        used = p.get("in_use")
        if used in ("true", "false"):
            ids = [k for k, n in counts.items() if n]
            qs = qs.filter(pk__in=ids) if used == "true" else qs.exclude(pk__in=ids)
        ctx = {"request": request, "counts": counts}
        page = self.paginate_queryset(qs)
        rows = AccessoryTypeSerializer(page if page is not None else qs, many=True,
                                       context=ctx).data
        return self.get_paginated_response(rows) if page is not None else Response(rows)

    def _detail(self, request, obj):
        _s, _c, items = pp._readable(request.user, obj.tenant)
        counts = {str(obj.pk): len(pp.usage(obj, request.user, obj.tenant))}
        data = AccessoryTypeSerializer(obj, context={"request": request,
                                                     "counts": counts}).data
        cord = None
        if obj.kind == "transceiver" and obj.connector:
            c = pp.cord_for(pp.accessories_of(obj.tenant), obj.connector)
            if c is not None:
                cord = {"id": str(c.pk), "name": c.name, "connector": c.connector,
                        "model_url": AccessoryTypeSerializer().get_model_url(c),
                        "cable": c.cable}
        return {**data, "part_records": _part_records(items, obj), "cord": cord}

    def retrieve(self, request, pk=None):
        """One part, with ``part_records`` (per part number, the records
        whose part ID it matches) and, for a transceiver, the ``cord`` that
        plugs into it (api.port_plugs.cord_for)."""
        return Response(self._detail(request, self._get(pk)))

    @extend_schema(request=AccessoryTypeSerializer, responses=AccessoryTypeSerializer)
    def partial_update(self, request, pk=None):
        """Change ``fits``, ``parts``, ``standard``, ``wavelength_nm``,
        ``reach_m`` or ``cable``: each one changed joins ``hand_edited``.
        ``hand_edited`` itself may only shrink - a field left out goes back
        to the pack on its next import."""
        obj = self._get(pk)
        self._need("change")
        ser = AccessoryTypeSerializer(obj, data=request.data, partial=True,
                                      context={"request": request})
        ser.is_valid(raise_exception=True)
        with transaction.atomic():
            ser.save()
        return Response(self._detail(request, obj))

    @extend_schema(request=AccessoryTypeSerializer, responses=AccessoryTypeSerializer)
    def update(self, request, pk=None):
        return self.partial_update(request, pk)

    def destroy(self, request, pk=None):
        """Delete a part nothing uses: no record names it, and no port
        shows it (as anyone sees them)."""
        obj = self._get(pk)
        self._need("delete")
        if obj.inventory_items.exists() or pp.usage(obj, _EVERYONE, obj.tenant):
            return Response({"detail": f"{obj.name} is in use - it can't be deleted."},
                            status=status.HTTP_409_CONFLICT)
        field = obj.model_3d
        with transaction.atomic():
            obj.delete()
        if field:
            field.storage.delete(field.name)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @extend_schema(
        request={"multipart/form-data": {"type": "object", "properties": {
            "file": {"type": "string", "format": "binary"}}}},
        responses={200: OpenApiTypes.BINARY},
    )
    @action(detail=True, methods=["get", "post"], url_path="model")
    def model_file(self, request, pk=None):
        """GET the part's 3D model (binary glTF). POST a multipart ``file``
        to replace it (change on pluggables): checked like any model
        (api.model_3d), noted against the part's triangle budget and the
        empties stacking needs; ``model`` joins ``hand_edited``. Answers
        the part with ``model_notes``."""
        from django.http import Http404

        from . import model_3d
        from .model_pack_check import triangles

        obj = self._get(pk)
        if request.method == "GET":
            if not obj.model_3d:
                raise Http404("No 3D model.")
            return model_3d.serve(obj.model_3d, f"{slugify(obj.name) or 'accessory'}.glb")
        self._need("change")
        upload = request.FILES.get("file")
        if upload is None:
            raise ValidationError({"file": "Choose a .glb file."})
        try:
            data = model_3d.read_upload(upload)
            doc = model_3d.validate_glb(data)
        except DjangoValidationError as exc:
            raise ValidationError({"file": exc.messages}) from exc
        tri = triangles(doc)
        notes = [f"{tri:,} triangles."]
        budget = pp.triangle_budget(obj.kind)
        if tri > budget:
            notes.append(f"Over the {budget:,}-triangle budget for a {obj.kind}.")
        notes += pp.empty_warnings(doc, {"kind": obj.kind, "connector": obj.connector,
                                         "cable": obj.cable})
        with transaction.atomic():
            flags = list(obj.hand_edited or [])
            if "model" not in flags:
                flags.append("model")
            obj.hand_edited = [f for f in pp.HAND_FIELDS if f in flags]
            model_3d.store(obj, data)
        return Response({**self._detail(request, obj), "model_notes": notes})

    @extend_schema(responses={200: OpenApiTypes.OBJECT})
    @action(detail=True, methods=["get"], url_path="usage")
    def usage(self, request, pk=None):
        """Every port showing the part, and the spare records naming it, among
        those the reader may view (api.port_plugs.usage). ``source``: ``set``
        (a record set to it by hand), ``part`` (a record whose part ID it
        lists) or ``fallback`` (the part a port takes without one)."""
        obj = self._get(pk)
        rows = pp.usage(obj, request.user, obj.tenant)
        page = self.paginate_queryset(rows)
        return (self.get_paginated_response(page) if page is not None
                else Response({"count": len(rows), "results": rows}))
