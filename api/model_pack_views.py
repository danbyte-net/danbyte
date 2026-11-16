"""``/api/model-packs/``: 3D model packs installed in the app
(api.model_pack_install, docs/dcim/model-packs.md#api).

Reading takes view on device types; adding, installing and forgetting a
pack take what installing one takes (api.model_pack_install.may_install).
Every row is the active tenant's own.
"""
from __future__ import annotations

from rest_framework import permissions, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response

from . import model_pack_install as mpi
from .models import ModelPack
from .pagination import StandardResultsSetPagination


def _user(u) -> str | None:
    return u.get_username() if u is not None else None


class ModelPackSerializer(serializers.ModelSerializer):
    """A pack in the list: what it is, where it came from, where it stands."""

    progress = serializers.SerializerMethodField()
    created_by = serializers.SerializerMethodField()
    installed_by = serializers.SerializerMethodField()
    types = serializers.SerializerMethodField()
    installable = serializers.SerializerMethodField()
    check_errors = serializers.SerializerMethodField()
    check_warnings = serializers.SerializerMethodField()

    class Meta:
        model = ModelPack
        fields = [
            "id", "slug", "name", "version", "license", "author", "source", "source_url",
            "filename", "sha256", "size", "status", "progress", "error", "replace_photos",
            "types", "installable", "check_errors", "check_warnings",
            "created_at", "created_by", "installed_at", "installed_by",
        ]
        read_only_fields = fields

    def get_progress(self, obj):
        return mpi.live_progress(obj)

    def get_created_by(self, obj):
        return _user(obj.created_by)

    def get_installed_by(self, obj):
        return _user(obj.installed_by) if obj.installed_at else None

    def get_types(self, obj):
        r = obj.result if obj.installed_at else (obj.report or {}).get("import") or {}
        return int(r.get("created") or 0) + int(r.get("matched") or 0)

    def get_installable(self, obj):
        return obj.status == "checked" and bool(((obj.report or {}).get("check") or {}).get("ok"))

    def get_check_errors(self, obj):
        return int(((obj.report or {}).get("check") or {}).get("errors") or 0)

    def get_check_warnings(self, obj):
        return int(((obj.report or {}).get("check") or {}).get("warnings") or 0)


class ModelPackDetailSerializer(ModelPackSerializer):
    """One pack: the list fields, the check and dry run (``report``), what
    the install changed (``result``), its files and its other copies."""

    history = serializers.SerializerMethodField()

    class Meta(ModelPackSerializer.Meta):
        fields = [*ModelPackSerializer.Meta.fields, "report", "result", "files", "history"]
        read_only_fields = fields

    def get_history(self, obj):
        if not obj.slug:
            return []
        rows = (ModelPack.objects.filter(tenant_id=obj.tenant_id, slug=obj.slug,
                                         status__in=("installed", "replaced"))
                .exclude(pk=obj.pk).select_related("installed_by")
                .order_by("-installed_at")[:20])
        return [{"id": str(p.pk), "version": p.version, "status": p.status,
                 "installed_at": p.installed_at.isoformat() if p.installed_at else None,
                 "installed_by": _user(p.installed_by)} for p in rows]


class ModelPackViewSet(viewsets.GenericViewSet):
    permission_classes = [permissions.IsAuthenticated]
    pagination_class = StandardResultsSetPagination
    serializer_class = ModelPackSerializer
    queryset = ModelPack.objects.all()
    parser_classes = [JSONParser, MultiPartParser, FormParser]

    def _tenant(self):
        from .views import _get_active_tenant

        tenant = _get_active_tenant(self.request)
        if tenant is None:
            raise PermissionDenied("No active tenant selected.")
        return tenant

    def _viewer(self):
        tenant = self._tenant()
        if not mpi.may_view(self.request.user, tenant):
            raise PermissionDenied("You can't view device types.")
        return tenant

    def _installer(self):
        tenant = self._tenant()
        if not mpi.may_install(self.request.user, tenant):
            raise PermissionDenied("Installing model packs takes tenant admin rights with "
                                   "add and change on device and module types.")
        return tenant

    def get_queryset(self):
        tenant = self._viewer()
        return (ModelPack.objects.filter(tenant=tenant)
                .select_related("created_by", "installed_by"))

    def _get(self, pk):
        try:
            obj = self.get_queryset().filter(pk=pk).first()
        except (ValueError, Exception):  # noqa: BLE001 - a malformed id
            obj = None
        if obj is None:
            raise NotFound()
        return obj

    def list(self, request):
        qs = self.get_queryset()
        raw = request.query_params.get("status")
        if raw:
            wanted = [s for s in raw.split(",") if s]
            known = {c for c, _ in ModelPack.STATUS_CHOICES}
            bad = [s for s in wanted if s not in known]
            if bad:
                raise ValidationError({"status": f"Not a status: {', '.join(bad)}."})
            qs = qs.filter(status__in=wanted)
        page = self.paginate_queryset(qs)
        rows = ModelPackSerializer(page if page is not None else qs, many=True).data
        return self.get_paginated_response(rows) if page is not None else Response(rows)

    def retrieve(self, request, pk=None):
        return Response(ModelPackDetailSerializer(self._get(pk)).data)

    def create(self, request):
        """Add a pack: a multipart ``file`` (.zip) or a JSON ``url``. Its
        check starts at once; poll the row until ``status`` leaves
        ``checking``."""
        tenant = self._installer()
        upload = request.FILES.get("file")
        url = request.data.get("url") if upload is None else None
        try:
            if upload is not None:
                pack = mpi.start_upload(tenant, request.user, upload)
            elif isinstance(url, str) and url.strip():
                pack = mpi.start_url(tenant, request.user, url)
            else:
                raise ValidationError({"file": "Upload a .zip or give a url."})
        except mpi.InstallRefused as exc:
            return Response({exc.field: str(exc)}, status=exc.status)
        return Response(ModelPackDetailSerializer(pack).data, status=status.HTTP_202_ACCEPTED)

    @action(detail=True, methods=["post"])
    def install(self, request, pk=None):
        """Install a checked pack. Body: ``{"replace_photos": bool}``."""
        self._installer()
        pack = self._get(pk)
        replace = request.data.get("replace_photos", False)
        if not isinstance(replace, bool):
            raise ValidationError({"replace_photos": "true or false."})
        try:
            pack = mpi.start_install(pack, request.user, replace_photos=replace)
        except mpi.InstallRefused as exc:
            return Response({exc.field: str(exc)}, status=exc.status)
        return Response(ModelPackDetailSerializer(pack).data, status=status.HTTP_202_ACCEPTED)

    def destroy(self, request, pk=None):
        """Forget a pack: the record and its archive go, the device and
        module types it made or changed stay."""
        self._installer()
        pack = self._get(pk)
        if pack.status in mpi.ACTIVE:
            return Response({"detail": "The pack is being checked or installed."},
                            status=status.HTTP_409_CONFLICT)
        mpi.discard(pack)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=False, methods=["get"])
    def limits(self, request):
        """What the install dialog needs: the upload cap, where downloads may
        come from, and whether the caller may install."""
        from .devicetype_import import airgap_refusal

        tenant = self._viewer()
        return Response({
            "max_bytes": mpi.max_bytes(),
            "source_url": mpi.source_url(),
            "allowed_hosts": mpi.allowed_hosts(),
            "downloads": airgap_refusal() is None,
            "can_install": mpi.may_install(request.user, tenant),
        })
