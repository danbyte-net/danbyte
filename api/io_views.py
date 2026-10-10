"""Round-trip export/import API - generic over any IO-capable object type.

* ``GET  /api/io/types/``            - types the user may export/import.
* ``GET  /api/io/<slug>/fields/``    - columns + field metadata for a type.
* ``GET  /api/io/<slug>/export/``    - stream the (RBAC-scoped) rows as CSV/JSON/XLSX.
* ``POST /api/io/<slug>/export/``    - the same, with the ids in the body.
* ``POST /api/io/<slug>/import/``    - upsert rows (dry-run preview + commit).

RBAC is enforced per row: creating needs ``add``, updating needs ``change``, and
the target of an update/create must fall inside the user's row scope
(``restrict_queryset`` - constraints **and** site scope). The pretty client-side
export is unrelated; this is the editable data round-trip.
"""
from __future__ import annotations

import csv
import io as _io
import json
import re

from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import DatabaseError, transaction
from django.http import HttpResponse, StreamingHttpResponse
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api import rbac
from auth_api.object_types import is_registered, model_for

from .bulk_import import plain_db_error
from .io import io_for, io_types
from .views import _get_active_tenant

MAX_IMPORT_ROWS = 5000
#: An import file larger than this is refused before it is opened. XLSX is
#: zipped XML, so a small file can hold a very large sheet; the row cap below
#: is what really bounds the work, this only stops the obviously absurd.
MAX_IMPORT_BYTES = 25 * 1024 * 1024
#: Rows scanned, blank ones included, before giving up. Spreadsheets often
#: carry thousands of formatted-but-empty rows, so blank rows do not count
#: against MAX_IMPORT_ROWS - but they cannot run forever either.
MAX_IMPORT_SCANNED_ROWS = MAX_IMPORT_ROWS * 4
#: Cells one sheet row may hold. Wider rows are refused before openpyxl
#: builds them: its reader materialises a whole row at once.
MAX_IMPORT_COLUMNS = 500
#: XLSX limits checked on the zip itself, before openpyxl opens it (#374).
#: The upload cap bounds the compressed file only; XML compresses a
#: thousandfold, so the unpacked size and the shared-strings table (which
#: openpyxl loads whole, even in read-only mode) are capped as well.
MAX_XLSX_UNPACKED_BYTES = 50 * 1024 * 1024
MAX_XLSX_SHARED_STRINGS = 250_000
MAX_XLSX_MEMBERS = 1000


class TooManyRows(ValueError):
    """The import has more rows than the cap; raised while reading."""


class FileTooLarge(TooManyRows):
    """The workbook would unpack past a limit; raised before it is opened."""
MAX_XLSX_EXPORT_ROWS = 50000
#: Ids one export may name. A long selection is POSTed: in a GET's query
#: string ~200 UUIDs already pass the proxy's and gunicorn's 8 KB line limit.
MAX_EXPORT_IDS = MAX_XLSX_EXPORT_ROWS


def _resolve(request, slug):
    """``(tenant, handler, model)`` or a ``Response`` error."""
    if not is_registered(slug):
        return Response({"detail": "Unknown object type."}, status=400)
    handler = io_for(slug)
    if handler is None:
        return Response({"detail": "This object type isn't importable."}, status=400)
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    return tenant, handler, model_for(slug)


def _can(request, tenant, slug, action) -> bool:
    return request.user.is_superuser or rbac.has_action(
        request.user, tenant, slug, action
    )


@extend_schema(
    summary="List object types the user may export and/or import",
    tags=["import-export"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "An ``object_types`` array; each entry is the type metadata plus "
            "``can_export`` and ``can_import`` booleans for the current user."
        ),
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def io_types_view(request):
    tenant = _get_active_tenant(request)
    out = []
    for t in io_types():
        slug = t["slug"]
        can_export = _can(request, tenant, slug, "view")
        can_import = t["importable"] and (
            _can(request, tenant, slug, "add") or _can(request, tenant, slug, "change")
        )
        if can_export or can_import:
            out.append({**t, "can_export": can_export, "can_import": can_import})
    return Response({"object_types": out})


@extend_schema(
    summary="Columns, field metadata, and natural key for an object type",
    tags=["import-export"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "``fields`` (per-field metadata), ``columns`` (ordered column "
            "names), and ``natural_key`` for the requested object type."
        ),
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def io_fields_view(request, slug):
    res = _resolve(request, slug)
    if isinstance(res, Response):
        return res
    _tenant, handler, _model = res
    return Response({
        "fields": handler.field_info(),
        "columns": handler.column_names(),
        "natural_key": handler.natural_key,
    })


def _scoped_qs(request, tenant, handler, model, action):
    qs = model._default_manager.filter(tenant=tenant)
    qs = rbac.restrict_queryset(qs, request.user, tenant, handler.slug, action)
    return handler.export_queryset(qs)


@extend_schema(
    summary="Stream RBAC-scoped rows of an object type as CSV, JSON, or XLSX",
    tags=["import-export"],
    request=None,
    parameters=[
        OpenApiParameter(
            name="fmt",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Export format: 'csv' (default), 'json', or 'xlsx'.",
        ),
        OpenApiParameter(
            name="ids",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Comma-separated primary keys to restrict the export to.",
        ),
        OpenApiParameter(
            name="<field>",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description=(
                "Any concrete model field name may be passed as an exact-match "
                "filter to further narrow the RBAC-scoped rows."
            ),
        ),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.BINARY,
        description="An attachment file download (CSV, JSON, or XLSX).",
    ),
    methods=["GET"],
)
@extend_schema(
    summary="Export the rows with the given ids (a long selection)",
    description=(
        "The GET export with its parameters in a JSON body, for an id list too "
        f"long for a URL. At most {MAX_EXPORT_IDS} ids."
    ),
    tags=["import-export"],
    request=inline_serializer(
        name="IoExportRequest",
        fields={
            "fmt": serializers.ChoiceField(
                choices=["csv", "json", "xlsx"], required=False,
                help_text="Export format (default 'csv').",
            ),
            "ids": serializers.ListField(
                child=serializers.CharField(),
                help_text="Primary keys to restrict the export to.",
            ),
        },
    ),
    responses=OpenApiResponse(
        response=OpenApiTypes.BINARY,
        description="An attachment file download (CSV, JSON, or XLSX).",
    ),
    methods=["POST"],
)
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def io_export_view(request, slug):
    res = _resolve(request, slug)
    if isinstance(res, Response):
        return res
    tenant, handler, model = res
    if not _can(request, tenant, slug, "view"):
        return Response({"detail": f"You can't view {slug}."}, status=403)

    # A POST carries the same parameters as the GET, in its body - a bulk
    # bar's selection runs to more ids than a URL can hold.
    if request.method == "POST":
        data = request.data if isinstance(request.data, dict) else {}
        params = {k: v for k, v in data.items() if k != "ids" and isinstance(v, str)}
        raw_ids = data.get("ids")
    else:
        params = request.query_params.dict()
        raw_ids = request.query_params.get("ids")
    try:
        ids = _export_ids(raw_ids, model)
    except ValueError as e:
        return Response({"ids": str(e)}, status=400)

    # NB: not ``format`` - that's DRF's reserved content-negotiation param.
    fmt = (params.get("fmt") or "csv").lower()
    qs = _scoped_qs(request, tenant, handler, model, "view")
    if ids is not None:
        qs = qs.filter(pk__in=ids)
    # Optional field filters (e.g. ipaddress export scoped to ?prefix=<id>).
    # Only narrows the already RBAC-scoped queryset - a concrete model field →
    # exact match; unknown params ignored. Can't widen access, only restrict.
    field_names = {f.name for f in model._meta.concrete_fields}
    reserved = {"fmt", "ids", "format"}
    for key, val in params.items():
        if key in reserved or key not in field_names or not val:
            continue
        try:
            qs = qs.filter(**{key: val})
        except (ValueError, TypeError, DjangoValidationError):
            continue
    # Not every type has a created_at (tags don't, #355).
    has_created = any(f.name == "created_at" for f in model._meta.concrete_fields)
    qs = qs.order_by("created_at" if has_created else "pk")
    cols = handler.column_names()
    # One reference cache per export: a site or VRF named on a thousand rows
    # is checked for ambiguity once.
    refs: dict = {}
    fname = f"{slug}.{fmt if fmt != 'xlsx' else 'xlsx'}"

    if fmt == "json":
        def gen():
            yield "["
            first = True
            for obj in qs.iterator(chunk_size=500):
                yield ("" if first else ",") + json.dumps(handler.to_row(obj, refs=refs))
                first = False
            yield "]"
        resp = StreamingHttpResponse(gen(), content_type="application/json")
        resp["Content-Disposition"] = f'attachment; filename="{fname}"'
        return resp

    if fmt == "xlsx":
        return _export_xlsx(qs, handler, cols, slug, refs)

    # CSV (default), streamed.
    class _Echo:
        def write(self, value):
            return value

    writer = csv.DictWriter(_Echo(), fieldnames=cols, extrasaction="ignore")

    from .spreadsheet import csv_cell

    def gen():
        yield writer.writerow(dict(zip(cols, cols)))  # header
        for obj in qs.iterator(chunk_size=500):
            yield writer.writerow(
                {k: csv_cell(v) for k, v in handler.to_row(obj, refs=refs).items()}
            )

    resp = StreamingHttpResponse(gen(), content_type="text/csv; charset=utf-8")
    resp["Content-Disposition"] = f'attachment; filename="{fname}"'
    return resp


def _export_ids(raw, model):
    """The ids an export is restricted to - a comma-separated string (GET) or
    a list (POST) - or ``None`` when none were given. Raises ``ValueError``
    with a message for a malformed id or too long a list."""
    if raw is None or raw == "":
        return None
    if isinstance(raw, str):
        items = raw.split(",")
    elif isinstance(raw, list):
        items = raw
    else:
        raise ValueError("Give a list of ids.")
    ids = [str(i).strip() for i in items if str(i).strip()]
    if len(ids) > MAX_EXPORT_IDS:
        raise ValueError(f"At most {MAX_EXPORT_IDS} ids per export.")
    pk = model._meta.pk
    try:
        return [pk.to_python(i) for i in ids]
    except DjangoValidationError:
        raise ValueError("One of the ids is not valid.") from None


def _export_xlsx(qs, handler, cols, slug, refs=None):
    from openpyxl import Workbook
    from openpyxl.utils import get_column_letter

    from .spreadsheet import xlsx_text_row

    wb = Workbook()
    ws = wb.active
    ws.title = slug[:31]
    ws.append(cols)
    for cell in ws[1]:
        cell.font = cell.font.copy(bold=True)
    n = 0
    for obj in qs.iterator(chunk_size=500):
        if n >= MAX_XLSX_EXPORT_ROWS:
            break
        row = handler.to_row(obj, refs=refs)
        ws.append([row.get(c, "") for c in cols])
        xlsx_text_row(ws)
        n += 1
    for i in range(1, len(cols) + 1):
        ws.column_dimensions[get_column_letter(i)].width = 20
    ws.freeze_panes = "A2"
    buf = _io.BytesIO()
    wb.save(buf)
    resp = HttpResponse(
        buf.getvalue(),
        content_type=(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ),
    )
    resp["Content-Disposition"] = f'attachment; filename="{slug}.xlsx"'
    return resp


def _parse_upload(request):
    """Rows from a multipart xlsx ``file``, a pre-parsed JSON ``rows`` array, or
    raw ``content`` + ``format`` (csv/json)."""
    upload = request.FILES.get("file")
    if upload is not None:
        from openpyxl import load_workbook

        if upload.size and upload.size > MAX_IMPORT_BYTES:
            raise TooManyRows(
                f"The file is larger than {MAX_IMPORT_BYTES // (1024 * 1024)} MB."
            )
        _check_xlsx(upload)
        upload.seek(0)
        wb = load_workbook(upload, read_only=True, data_only=True)
        ws = wb.active
        # Stream the sheet and stop at the cap. It used to be list()-ed whole
        # before the cap was checked, so a few MB of compressed rows held a
        # web worker for most of a minute only to be refused (#225).
        rows = ws.iter_rows(values_only=True, max_col=MAX_IMPORT_COLUMNS)
        first = next(rows, None)
        if first is None:
            return []
        headers = [(str(h).strip() if h is not None else "") for h in first]
        out = []
        for scanned, r in enumerate(rows, start=1):
            if scanned > MAX_IMPORT_SCANNED_ROWS:
                raise TooManyRows(f"Too many rows (max {MAX_IMPORT_ROWS}).")
            d = {h: ("" if v is None else str(v)) for h, v in zip(headers, r)}
            if any(v != "" for v in d.values()):
                out.append(d)
                if len(out) > MAX_IMPORT_ROWS:
                    raise TooManyRows(f"Too many rows (max {MAX_IMPORT_ROWS}).")
        return out

    data = request.data or {}
    if isinstance(data.get("rows"), list):
        return [r for r in data["rows"] if isinstance(r, dict)]
    from .bulk_import import parse_rows

    return parse_rows(data.get("content", ""), data.get("format", "csv"))


_XLSX_TAG = re.compile(rb"<(?:\w{1,16}:)?(si|row|c)[\s>/]")


def _check_xlsx(upload) -> None:
    """Refuse a workbook that would unpack past the limits, reading only the
    zip directory and streaming the XML through a tag counter (#374).

    Every member counts towards the unpacked size; a zip entry is never
    read past its declared size, so the directory is a safe upper bound.
    Shared strings (``<si>``) are counted wherever they are, as is the
    widest row, because openpyxl loads the string table whole and builds a
    row at a time."""
    import zipfile

    upload.seek(0)
    with zipfile.ZipFile(upload) as zf:
        infos = zf.infolist()
        if len(infos) > MAX_XLSX_MEMBERS:
            raise FileTooLarge("The workbook has too many parts.")
        mb = MAX_XLSX_UNPACKED_BYTES // (1024 * 1024)
        if sum(i.file_size for i in infos) > MAX_XLSX_UNPACKED_BYTES:
            raise FileTooLarge(f"The workbook is too large once unpacked (max {mb} MB).")
        strings = 0
        for info in infos:
            if info.is_dir():
                continue
            cells = 0
            with zf.open(info) as f:
                tail = b""
                while True:
                    chunk = f.read(1024 * 1024)
                    buf = tail + chunk
                    cut = len(buf) if not chunk else max(len(buf) - 32, 0)
                    for m in _XLSX_TAG.finditer(buf, 0, len(buf)):
                        if m.start() >= cut:
                            break
                        tag = m.group(1)
                        if tag == b"si":
                            strings += 1
                            if strings > MAX_XLSX_SHARED_STRINGS:
                                raise FileTooLarge(
                                    "The workbook holds too many distinct texts "
                                    f"(max {MAX_XLSX_SHARED_STRINGS})."
                                )
                        elif tag == b"row":
                            cells = 0
                        else:
                            cells += 1
                            if cells > MAX_IMPORT_COLUMNS:
                                raise FileTooLarge(
                                    f"A row has too many columns (max {MAX_IMPORT_COLUMNS})."
                                )
                    if not chunk:
                        break
                    tail = buf[cut:]


@extend_schema(
    summary="Upsert rows for an object type (dry-run preview or commit)",
    tags=["import-export"],
    request=inline_serializer(
        name="IoImportRequest",
        fields={
            "file": serializers.FileField(
                required=False,
                help_text="Multipart XLSX upload of rows to import.",
            ),
            "rows": serializers.ListField(
                child=serializers.DictField(),
                required=False,
                help_text="Pre-parsed array of row objects.",
            ),
            "content": serializers.CharField(
                required=False,
                help_text="Raw CSV or JSON body (paired with 'format').",
            ),
            "format": serializers.CharField(
                required=False,
                help_text="Format of 'content': 'csv' (default) or 'json'.",
            ),
            "dry_run": serializers.BooleanField(
                required=False,
                help_text="When true, validate and preview without committing.",
            ),
        },
    ),
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "Import outcome: ``total``, ``created``, ``updated``, ``errors`` "
            "(per-row), ``dry_run``, and ``preview`` (per-row when dry-run)."
        ),
    ),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def io_import_view(request, slug):
    res = _resolve(request, slug)
    if isinstance(res, Response):
        return res
    tenant, handler, model = res
    if not handler.importable():
        # Import writes only what the API can write (#364).
        return Response({"detail": "This object type isn't importable."}, status=400)
    can_add = _can(request, tenant, slug, "add")
    can_change = _can(request, tenant, slug, "change")
    if not (can_add or can_change):
        return Response({"detail": f"You can't import {slug}."}, status=403)
    dry_run = str(request.data.get("dry_run", "")).lower() in ("1", "true", "yes") \
        or request.data.get("dry_run") is True

    try:
        rows = _parse_upload(request)
    except TooManyRows as exc:
        return Response({"detail": str(exc)}, status=400)
    except Exception as exc:  # noqa: BLE001
        return Response({"detail": f"Couldn't parse file: {exc}"}, status=400)
    if not rows:
        return Response({"detail": "No rows found."}, status=400)
    if len(rows) > MAX_IMPORT_ROWS:
        return Response(
            {"detail": f"Too many rows (max {MAX_IMPORT_ROWS})."}, status=400
        )

    # Row scope for update-target / create-target enforcement.
    change_qs = rbac.restrict_queryset(
        model._default_manager.filter(tenant=tenant), request.user, tenant,
        slug, "change",
    )
    add_qs = rbac.restrict_queryset(
        model._default_manager.filter(tenant=tenant), request.user, tenant,
        slug, "add",
    )

    created = updated = 0
    errors, preview = [], []
    # One index write per imported object, after the rows, instead of one
    # inline per save - and none at all for a dry run's rolled-back rows.
    from . import search_index

    with search_index.deferred(flush=not dry_run):
        _import_rows(
            rows, handler, tenant, request, change_qs, add_qs, can_add, can_change,
            dry_run, errors, preview, counts := {"created": 0, "updated": 0},
        )
    created, updated = counts["created"], counts["updated"]

    return Response({
        "total": len(rows), "created": created, "updated": updated,
        "errors": errors, "dry_run": dry_run, "preview": preview,
    })


def _import_rows(rows, handler, tenant, request, change_qs, add_qs, can_add,
                 can_change, dry_run, errors, preview, counts) -> None:
    for i, row in enumerate(rows, start=1):
        try:
            with transaction.atomic():
                existing = handler.lookup(row, tenant, request.user)
                if existing is not None and not change_qs.filter(
                    pk=existing.pk
                ).exists():
                    raise PermissionRow("not permitted to update this row")
                obj, action, changes, tag_names = handler.apply(
                    existing, row, tenant, request.user, request=request
                )
                if action == "create" and not can_add:
                    raise PermissionRow("creating new rows needs 'add' permission")
                if action == "update" and not can_change:
                    raise PermissionRow("updating rows needs 'change' permission")

                # Saved through the type's API hooks in a dry run too, then
                # rolled back, so the preview refuses what the commit would.
                obj = handler.commit(obj, tag_names)
                # Site-scope guard: the saved row must be in the user's
                # add/change scope (mirrors the viewset's create/update guard),
                # so an edit cannot move a row out of the sites they may edit.
                scope_qs = add_qs if action == "create" else change_qs
                if not scope_qs.filter(pk=obj.pk).exists():
                    raise PermissionRow(
                        "the row falls outside the sites you may edit"
                    )
                if dry_run:
                    transaction.set_rollback(True)
                counts["created" if action == "create" else "updated"] += 1
                if dry_run:
                    preview.append({
                        "row": i, "action": action,
                        "key": _row_key(handler, row), "changes": changes,
                    })
        except (PermissionRow, DjangoPermissionDenied) as exc:
            errors.append({"row": i, "error": str(exc), "action": "permission"})
        except DatabaseError as exc:
            # Validation catches what it can; the database's own refusal is
            # worded plainly, never its text with constraint names and ids.
            errors.append({"row": i, "error": plain_db_error(exc)})
        except Exception as exc:  # noqa: BLE001
            # Name the field: "name: This field cannot be blank." beats a bare
            # "This field cannot be blank." with five columns to guess from.
            md = getattr(exc, "message_dict", None)
            msgs = (
                [f"{k}: {' '.join(v)}" if k != "__all__" else " ".join(v) for k, v in md.items()]
                if md else getattr(exc, "messages", None)
            )
            errors.append({
                "row": i,
                "error": "; ".join(msgs) if msgs else str(exc),
            })


class PermissionRow(Exception):
    """A per-row RBAC rejection (rolled back, reported, batch continues)."""


def _row_key(handler, row) -> str:
    if handler.natural_key:
        return " / ".join(str(row.get(k, "")) for k in handler.natural_key)
    return str(row.get("id", ""))
