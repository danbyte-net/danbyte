"""Custom end-of-life products: the products a tenant enters by hand.

endoflife.date does not know every product a tenant runs - an in-house
application, a niche appliance, a vendor's own support matrix. A custom
product is an :class:`~compliance.models.EolProduct` with ``source="custom"``
and the tenant as its owner, so every reader of the catalog - the platform
and application pickers, an install's cycle, the mappings, the Lifecycle
page, compliance rules - takes it exactly like a fetched one. No refresh or
import touches it (``eol.store_catalog`` writes the source's rows only).

``/api/eol/custom-products/`` - tenant-scoped CRUD on the ``eolproduct``
object type. Each save refills the mappings on the product and redoes the
cycles of the installs that name it (``eol.apply_custom``). A product an
application or a platform still names cannot be deleted.
"""
from __future__ import annotations

import re
from datetime import date

from django.db import transaction
from django.db.models import Count, IntegerField, OuterRef, Subquery, Value
from django.db.models.functions import Coalesce
from rest_framework import serializers
from rest_framework import status as drf_status
from rest_framework.response import Response

from api.views import _get_active_tenant
from api.viewsets import TenantScopedViewSet

from . import eol
from .eol_sources import CUSTOM
from .models import EolMapping, EolProduct

#: The product's key, as applications and mappings name it.
_NAME = re.compile(r"^[a-z0-9][a-z0-9._+-]*$")
#: A cycle's name: the version prefix an install's version is matched on.
_CYCLE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
MAX_CYCLES = 500
_DATES = ("release_date", "support_until", "eol_date", "extended_until")


def _date(value, label: str, errors: list[str], cycle: str) -> str | None:
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(str(value)[:10]).isoformat()
    except ValueError:
        errors.append(f"Cycle {cycle}: {label} must be a date (YYYY-MM-DD).")
        return None


def _iso(value):
    try:
        return date.fromisoformat(value) if value else None
    except (TypeError, ValueError):
        return None


def clean_cycles(raw) -> list[dict]:
    """Validate and normalise a custom product's cycles to the shape the
    sources store (``eol_sources``), newest first. Raises ValidationError
    with one message per problem."""
    if not isinstance(raw, list):
        raise serializers.ValidationError("A list of cycles.")
    if len(raw) > MAX_CYCLES:
        raise serializers.ValidationError(f"At most {MAX_CYCLES} cycles.")
    errors: list[str] = []
    out, seen = [], set()
    labels = {"release_date": "Released", "support_until": "Active support until",
              "eol_date": "End of life", "extended_until": "Extended support until"}
    for item in raw:
        if not isinstance(item, dict):
            errors.append("Each cycle is an object.")
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            errors.append("Every cycle needs a name.")
            continue
        if len(name) > 64 or not _CYCLE.match(name):
            errors.append(f"Cycle {name[:64]}: letters, digits, '.', '-', '_' or '+'.")
            continue
        if name in seen:
            errors.append(f"Cycle {name} is listed twice.")
            continue
        seen.add(name)
        row = {"name": name, "label": name}
        for f in _DATES:
            row[f] = _date(item.get(f), labels[f], errors, name)
        if row["support_until"] and row["eol_date"] and row["support_until"] > row["eol_date"]:
            errors.append(f"Cycle {name}: active support ends after end of life.")
        if row["extended_until"] and row["eol_date"] and row["extended_until"] < row["eol_date"]:
            errors.append(f"Cycle {name}: extended support ends before end of life.")
        for f in ("eol", "lts"):
            v = item.get(f, False)
            if not isinstance(v, bool):
                errors.append(f"Cycle {name}: {f} is true or false.")
                v = False
            row[f] = v
        latest = str(item.get("latest") or "").strip()
        if len(latest) > 64:
            errors.append(f"Cycle {name}: the latest version is at most 64 characters.")
        row["latest"] = latest[:64]
        out.append(row)
    if errors:
        raise serializers.ValidationError(errors)
    return sort_cycles(out)


def _natural(name: str) -> tuple:
    return tuple((0, int(p), "") if p.isdigit() else (1, 0, p)
                 for p in re.split(r"[.\-_+]", name))


def sort_cycles(rows: list[dict]) -> list[dict]:
    """Newest first, as a source lists them: by release date, then by the
    version in the name."""
    rows = sorted(rows, key=lambda r: _natural(r["name"]), reverse=True)
    return sorted(rows, key=lambda r: r.get("release_date") or "", reverse=True)


class EolCustomProductSerializer(serializers.ModelSerializer):
    """``name`` is the key applications and mappings name the product by:
    set once, on create. ``label`` is what people read."""

    releases = serializers.JSONField(required=False)
    cycle_count = serializers.SerializerMethodField()
    application_count = serializers.SerializerMethodField()
    platform_count = serializers.SerializerMethodField()

    class Meta:
        model = EolProduct
        fields = [
            "id", "source", "name", "label", "link", "notes", "releases",
            "cycle_count", "application_count", "platform_count",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "source", "created_at", "updated_at"]
        extra_kwargs = {"label": {"required": True, "allow_blank": False},
                        "name": {"required": False, "allow_blank": True}}

    def to_representation(self, obj):
        """Each cycle carries its ``status`` by the rule every reader uses
        (``eol.date_status``); a write ignores it."""
        out = super().to_representation(obj)
        cfg = eol.config_for(self.context.get("request"))
        out["releases"] = [
            {**r, "status": eol.date_status(_iso(r.get("eol_date")), cfg.warning_days,
                                            eol_reached=r.get("eol"))}
            for r in out.get("releases") or [] if isinstance(r, dict)
        ]
        return out

    def get_cycle_count(self, obj) -> int:
        return len(obj.releases or [])

    def get_application_count(self, obj) -> int:
        n = getattr(obj, "application_count", None)
        return n if n is not None else _usage(obj)[0]

    def get_platform_count(self, obj) -> int:
        n = getattr(obj, "platform_count", None)
        return n if n is not None else _usage(obj)[1]

    def validate_name(self, value: str) -> str:
        value = (value or "").strip().lower()
        if self.instance is not None and value != self.instance.name:
            raise serializers.ValidationError(
                "The key is set when the product is made; applications name it.")
        if not value and self.instance is None:
            return ""  # made from the label in validate()
        if not value or len(value) > 128 or not _NAME.match(value):
            raise serializers.ValidationError(
                "Lowercase letters, digits, '.', '-', '_' or '+'.")
        return value

    def validate_link(self, value: str) -> str:
        if value and not value.lower().startswith(("https://", "http://")):
            raise serializers.ValidationError("An http or https link.")
        return value

    def validate_releases(self, value):
        return clean_cycles(value)

    def validate(self, attrs):
        attrs = super().validate(attrs)
        if self.instance is None:
            name = attrs.get("name") or _slug(attrs.get("label", ""))
            if not name or not _NAME.match(name):
                raise serializers.ValidationError({"name": "Give the product a key."})
            attrs["name"] = name
            request = self.context.get("request")
            tenant = _get_active_tenant(request) if request else None
            if tenant is not None and EolProduct.objects.filter(
                tenant=tenant, name=name
            ).exists():
                raise serializers.ValidationError(
                    {"name": "A custom product with this key already exists."})
        return attrs


def _slug(label: str) -> str:
    s = re.sub(r"[^a-z0-9.+_]+", "-", (label or "").lower()).strip("-.")
    return s[:128]


def _usage(product) -> tuple[int, int]:
    from api.models import Application

    apps = Application.objects.filter(
        tenant_id=product.tenant_id, eol_source=CUSTOM, eol_product=product.name).count()
    platforms = EolMapping.objects.filter(
        tenant_id=product.tenant_id, platform__isnull=False,
        source=CUSTOM, product=product.name).count()
    return apps, platforms


def _count(qs):
    return Coalesce(
        Subquery(qs.order_by().values("tenant_id").annotate(c=Count("pk")).values("c")[:1],
                 output_field=IntegerField()),
        Value(0),
    )


class EolCustomProductViewSet(TenantScopedViewSet):
    """The active tenant's custom end-of-life products."""

    serializer_class = EolCustomProductSerializer
    queryset = EolProduct.objects.filter(source=CUSTOM).order_by("label", "name")

    def get_queryset(self):
        from api.models import Application

        qs = super().get_queryset()
        q = (self.request.query_params.get("search") or "").strip() if self.request else ""
        if q:
            from django.db.models import Q

            qs = qs.filter(Q(label__icontains=q) | Q(name__icontains=q)
                           | Q(notes__icontains=q))
        return qs.annotate(
            application_count=_count(Application.objects.filter(
                tenant_id=OuterRef("tenant_id"), eol_source=CUSTOM,
                eol_product=OuterRef("name"))),
            platform_count=_count(EolMapping.objects.filter(
                tenant_id=OuterRef("tenant_id"), platform__isnull=False,
                source=CUSTOM, product=OuterRef("name"))),
        )

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        with transaction.atomic():
            product = serializer.save(tenant=tenant, source=CUSTOM)
            eol.apply_custom(product)

    def perform_update(self, serializer):
        with transaction.atomic():
            product = serializer.save()
            eol.apply_custom(product)

    def destroy(self, request, *args, **kwargs):
        product = self.get_object()
        apps, platforms = _usage(product)
        if apps or platforms:
            parts = []
            if apps:
                parts.append(f"{apps} application{'' if apps == 1 else 's'}")
            if platforms:
                parts.append(f"{platforms} platform{'' if platforms == 1 else 's'}")
            return Response(
                {"detail": f"In use by {' and '.join(parts)} - map them to "
                           "another product first."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)
