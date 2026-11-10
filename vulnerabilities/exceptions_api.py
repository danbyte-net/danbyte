"""Vulnerability exceptions (#451, decision 13): ``/api/vulnerability-exceptions/``.

CRUD on the ``vulnerabilityexception`` object type, plus the shared
``bulk-delete``. 404 while vulnerability data is off.

* One record (``vuln_id``: a CVE id, an OSV id or an alias) the tenant
  matched or maps, and at most one scope: ``device_id``,
  ``virtual_machine_id``, ``platform_id`` or ``application_id`` (none: the
  whole tenant). Both are set on create and do not change.
* ``status`` ``not_applicable`` or ``risk_accepted``; ``reason`` and
  ``owner_id`` (a member of the tenant) required; ``expires_on`` required
  for a risk acceptance, from today to today + 365 days; optional for not
  applicable, not in the past.
* CycloneDX analysis (``analysis_state``, ``analysis_justification``,
  ``analysis_response``) defaults from the status and is checked against
  it, so the SBOM's VEX section carries what was decided.
* Site scope follows the host (``device__site|virtual_machine__site``): a
  role limited to sites may only write exceptions for hosts at its sites;
  platform, application and tenant-wide exceptions need a role without a
  site limit. Reading needs ``view`` on the subject too.

Filters: ``vuln_id``, ``status``, ``scope``, ``device``, ``virtual_machine``,
``platform``, ``application``, ``owner``, ``active`` and ``q``.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db.models import Count, Q
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_field
from rest_framework import serializers
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response

from api.bulk_delete import SafeBulkDeleteMixin
from api.models import Application, Device, Platform, VirtualMachine
from api.serializers import NumIdModelSerializer, TenantScopedPrimaryKeyRelatedField
from api.views import _get_active_tenant
from api.viewsets import TenantScopedViewSet
from auth_api import rbac

from . import exceptions as exc_logic
from .models import (
    ANALYSIS_RESPONSES,
    EXCEPTION_SCOPES,
    MAX_RISK_DAYS,
    STATUS_STATES,
    Cve,
    VulnerabilityException,
    VulnerabilitySettings,
)

User = get_user_model()
SLUG = "vulnerabilityexception"
REASON_MAX = 4000
_RESPONSES = tuple(k for k, _ in ANALYSIS_RESPONSES)
_SUBJECT_SLUGS = {"device": "device", "virtual_machine": "virtualmachine",
                  "platform": "platform", "application": "application"}
_SCOPES = (*EXCEPTION_SCOPES, "tenant")
_TRUE = ("1", "true", "yes")
_FALSE = ("0", "false", "no")


def _ref(obj) -> dict | None:
    if obj is None:
        return None
    return {"id": str(obj.pk), "name": getattr(obj, "name", str(obj))}


def _user_ref(user) -> dict | None:
    if user is None:
        return None
    return {"id": user.pk, "username": user.get_username(),
            "display_name": f"{user.first_name} {user.last_name}".strip()
            or user.get_username()}


def display_name(user) -> str:
    return (f"{user.first_name} {user.last_name}".strip() or user.get_username())[:150]


class VulnerabilityExceptionSerializer(NumIdModelSerializer):
    cve = serializers.SerializerMethodField()
    vuln_id = serializers.CharField(write_only=True, required=False, max_length=64)
    scope = serializers.CharField(read_only=True)
    device = serializers.SerializerMethodField()
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), write_only=True, required=False,
        allow_null=True)
    virtual_machine = serializers.SerializerMethodField()
    virtual_machine_id = TenantScopedPrimaryKeyRelatedField(
        source="virtual_machine", queryset=VirtualMachine.objects.all(), write_only=True,
        required=False, allow_null=True)
    platform = serializers.SerializerMethodField()
    platform_id = TenantScopedPrimaryKeyRelatedField(
        source="platform", queryset=Platform.objects.all(), write_only=True, required=False,
        allow_null=True)
    application = serializers.SerializerMethodField()
    application_id = TenantScopedPrimaryKeyRelatedField(
        source="application", queryset=Application.objects.all(), write_only=True,
        required=False, allow_null=True)
    owner = serializers.SerializerMethodField()
    owner_id = serializers.PrimaryKeyRelatedField(
        source="owner", queryset=User.objects.all(), write_only=True, required=False,
        allow_null=True)
    created_by = serializers.SerializerMethodField()
    reason = serializers.CharField(required=False, allow_blank=True, max_length=REASON_MAX)
    analysis_response = serializers.ListField(
        child=serializers.CharField(max_length=32), required=False)
    active = serializers.SerializerMethodField()
    cyclonedx = serializers.SerializerMethodField()
    matches = serializers.SerializerMethodField()

    class Meta:
        model = VulnerabilityException
        fields = [
            "id", "cve", "vuln_id", "scope", "device", "device_id", "virtual_machine",
            "virtual_machine_id", "platform", "platform_id", "application", "application_id",
            "status", "reason", "owner", "owner_id", "owner_name", "expires_on", "active",
            "analysis_state", "analysis_justification", "analysis_response", "cyclonedx",
            "matches", "created_by", "expiry_notified_at", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "owner_name", "expiry_notified_at", "created_at",
                            "updated_at"]
        extra_kwargs = {"status": {"required": False}}

    # ── read ────────────────────────────────────────────────────────────────

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_cve(self, obj):
        c = obj.cve
        return {"id": str(c.pk), "vuln_id": c.vuln_id, "aliases": c.aliases,
                "cvss_score": c.cvss_score, "cvss_severity": c.cvss_severity,
                "kev": c.kev_added is not None, "summary": c.summary[:300]}

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_device(self, obj):
        return _ref(obj.device)

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_virtual_machine(self, obj):
        return _ref(obj.virtual_machine)

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_platform(self, obj):
        return _ref(obj.platform)

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_application(self, obj):
        return _ref(obj.application)

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_owner(self, obj):
        return _user_ref(obj.owner)

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_created_by(self, obj):
        return _user_ref(obj.created_by)

    def get_active(self, obj) -> bool:
        return obj.is_active()

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_cyclonedx(self, obj):
        return exc_logic.cyclonedx_analysis(obj)

    def get_matches(self, obj) -> int:
        """Open matches it covers now, of the hosts the caller may see."""
        counts = self.context.get("match_counts")
        if counts is not None:
            return counts.get(obj.pk, 0)
        return _match_counts(self.context.get("request"), [obj.pk]).get(obj.pk, 0)

    # ── write ───────────────────────────────────────────────────────────────

    def _request(self):
        return self.context.get("request")

    def _tenant(self):
        request = self._request()
        tenant = _get_active_tenant(request) if request is not None else None
        if tenant is None and self.instance is not None:
            tenant = self.instance.tenant
        return tenant

    def validate_reason(self, value: str) -> str:
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("Say why.")
        return value

    def validate_analysis_response(self, value):
        bad = [v for v in value if v not in _RESPONSES]
        if bad:
            raise serializers.ValidationError(f"Each one of: {', '.join(_RESPONSES)}.")
        return list(dict.fromkeys(value))

    def _record(self, vuln_id: str, tenant) -> Cve:
        from .match_api import _relevant

        vuln_id = vuln_id.strip()
        c = Cve.objects.filter(vuln_id=vuln_id).first() \
            or Cve.objects.filter(aliases__contains=[vuln_id]).first()
        request = self._request()
        if c is None or tenant is None or not _relevant(request, tenant, c):
            raise ValidationError({"vuln_id": "No such record in this tenant."})
        return c

    def _scope_of(self, attrs) -> tuple[str, object]:
        given = [(n, attrs[n]) for n in EXCEPTION_SCOPES if attrs.get(n) is not None]
        if len(given) > 1:
            raise ValidationError({"scope": "At most one of device, virtual machine, "
                                             "platform or application."})
        return given[0] if given else ("tenant", None)

    def validate(self, attrs):
        attrs = super().validate(attrs)
        request = self._request()
        user = getattr(request, "user", None)
        tenant = self._tenant()
        inst = self.instance
        today = timezone.localdate()
        errors: dict = {}

        vuln_id = attrs.pop("vuln_id", None)
        if inst is None:
            if not vuln_id:
                raise ValidationError({"vuln_id": "Name the record (CVE or advisory id)."})
            attrs["cve"] = self._record(vuln_id, tenant)
            scope, subject = self._scope_of(attrs)
            for name in EXCEPTION_SCOPES:
                attrs.setdefault(name, None)
        else:
            changed_scope = any(
                n in attrs and getattr(attrs[n], "pk", None) != getattr(inst, f"{n}_id")
                for n in EXCEPTION_SCOPES)
            if (vuln_id and self._record(vuln_id, tenant).pk != inst.cve_id) or changed_scope:
                raise ValidationError({"scope": "The record and scope do not change; "
                                                "remove the exception and add another."})
            for n in EXCEPTION_SCOPES:
                attrs.pop(n, None)
            scope, subject = inst.scope, inst.subject

        # The subject must be one the caller may view; a role limited to
        # sites writes only exceptions for hosts at those sites.
        if user is not None and tenant is not None and not user.is_superuser:
            action = "add" if inst is None else "change"
            sites = rbac.site_scope(user, tenant, SLUG, action)
            if sites is not None and scope not in ("device", "virtual_machine"):
                raise ValidationError({"scope": "Your role is limited to sites: an "
                                                "exception for a platform, an "
                                                "application or the whole tenant needs "
                                                "a role without a site limit."})
            if subject is not None and not rbac.can_act_on(
                    user, tenant, _SUBJECT_SLUGS[scope], "view", subject):
                raise ValidationError({f"{scope}_id": "Not found."})
            if sites is not None and subject.site_id not in sites:
                raise ValidationError({f"{scope}_id": "Outside the sites your role "
                                                      "may edit."})

        status = attrs.get("status", getattr(inst, "status", None))
        if not status:
            errors["status"] = "not_applicable or risk_accepted."
        if inst is None and "reason" not in attrs:
            errors["reason"] = "Say why."

        if "owner" in attrs or inst is None:
            owner = attrs.get("owner")
            if owner is None:
                errors["owner_id"] = "Pick an owner."
            elif tenant is not None:
                from auth_api.people_api import tenant_members

                if not tenant_members(tenant).filter(pk=owner.pk).exists():
                    errors["owner_id"] = "Not a member of this tenant."
                else:
                    attrs["owner_name"] = display_name(owner)

        if status and ("expires_on" in attrs or "status" in attrs or inst is None):
            expires = attrs.get("expires_on", getattr(inst, "expires_on", None))
            latest = today + timedelta(days=MAX_RISK_DAYS)
            if status == "risk_accepted" and expires is None:
                errors["expires_on"] = "A risk acceptance needs an expiry date."
            elif expires is not None and expires < today:
                errors["expires_on"] = "Not in the past."
            elif status == "risk_accepted" and expires > latest:
                errors["expires_on"] = (f"At most {MAX_RISK_DAYS} days ahead "
                                        f"({latest.isoformat()}).")

        if status in STATUS_STATES:
            allowed = STATUS_STATES[status]
            state = attrs.get("analysis_state", getattr(inst, "analysis_state", "") or "")
            if state and state not in allowed:
                if "analysis_state" in attrs:
                    errors["analysis_state"] = f"With {status}: {', '.join(allowed)}."
                else:
                    state = ""
            attrs["analysis_state"] = state or allowed[0]
            just = attrs.get("analysis_justification",
                             getattr(inst, "analysis_justification", "") or "")
            if just and attrs["analysis_state"] != "not_affected":
                if "analysis_justification" in attrs:
                    errors["analysis_justification"] = "Only with the not_affected state."
                just = ""
            attrs["analysis_justification"] = just
            if inst is None and status == "risk_accepted" and not attrs.get("analysis_response"):
                attrs["analysis_response"] = ["will_not_fix"]

        if errors:
            raise ValidationError(errors)

        # One active exception per record and scope.
        cve_id = attrs["cve"].pk if inst is None else inst.cve_id
        expires = attrs.get("expires_on", getattr(inst, "expires_on", None))
        if tenant is not None and (expires is None or expires >= today):
            scope_filter = {f"{n}_id": (getattr(subject, "pk", None) if n == scope else None)
                            for n in EXCEPTION_SCOPES}
            dup = VulnerabilityException.objects.filter(
                tenant=tenant, cve_id=cve_id, **scope_filter).filter(exc_logic.active_q(today))
            if inst is not None:
                dup = dup.exclude(pk=inst.pk)
            if dup.exists():
                raise ValidationError({"vuln_id": "This record already has an active "
                                                  "exception for that scope."})
        return attrs


def _match_counts(request, pks) -> dict:
    from .match_api import visible_matches

    tenant = _get_active_tenant(request) if request is not None else None
    if tenant is None or not pks:
        return {}
    return dict(visible_matches(request, tenant).filter(
        excepted_id__in=list(pks), resolved_at__isnull=True)
        .values_list("excepted_id").annotate(n=Count("id")))


def _uuid(params, key):
    raw = params.get(key)
    if not raw:
        return None
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise ValidationError({key: "A valid UUID."}) from None


class VulnerabilityExceptionViewSet(SafeBulkDeleteMixin, TenantScopedViewSet):
    """The active tenant's vulnerability exceptions."""

    rbac_action_map = {"bulk_delete": "delete"}
    queryset = VulnerabilityException.objects.select_related(
        "cve", "device", "virtual_machine", "platform", "application", "owner",
        "created_by").order_by("-created_at", "id")
    serializer_class = VulnerabilityExceptionSerializer

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        if not VulnerabilitySettings.load().enabled:
            raise NotFound("Vulnerability data is off.")

    def get_queryset(self):
        qs = super().get_queryset()
        request = self.request
        if request is None:
            return qs
        params = request.query_params
        for key in ("device", "virtual_machine", "platform", "application"):
            v = _uuid(params, key)
            if v:
                qs = qs.filter(**{f"{key}_id": v})
        vuln = [p.strip() for p in (params.get("vuln_id") or "").split(",") if p.strip()]
        if vuln:
            cq = Q(cve__vuln_id__in=vuln)
            for v in vuln[:50]:
                cq |= Q(cve__aliases__contains=[v])
            qs = qs.filter(cq)
        status = params.get("status")
        if status:
            if status not in STATUS_STATES:
                raise ValidationError({"status": "not_applicable or risk_accepted."})
            qs = qs.filter(status=status)
        scope = params.get("scope")
        if scope:
            if scope not in _SCOPES:
                raise ValidationError({"scope": f"One of: {', '.join(_SCOPES)}."})
            empty = {f"{n}__isnull": True for n in EXCEPTION_SCOPES}
            if scope == "tenant":
                qs = qs.filter(**empty)
            else:
                qs = qs.filter(**{f"{scope}__isnull": False})
        owner = params.get("owner")
        if owner:
            if not owner.isdigit():
                raise ValidationError({"owner": "A user id."})
            qs = qs.filter(owner_id=int(owner))
        active = (params.get("active") or "").strip().lower()
        if active:
            today = timezone.localdate()
            if active in _TRUE:
                qs = qs.filter(exc_logic.active_q(today))
            elif active in _FALSE:
                qs = qs.filter(expires_on__lt=today)
            else:
                raise ValidationError({"active": "true or false."})
        q = (params.get("q") or "").strip()
        if q:
            qs = qs.filter(Q(cve__vuln_id__icontains=q) | Q(reason__icontains=q)
                           | Q(owner_name__icontains=q))
        return self._subject_visible(qs)

    def _subject_visible(self, qs):
        """Only exceptions whose subject the caller may view: a platform or
        application exception is not shown to someone who cannot see it."""
        user = getattr(self.request, "user", None)
        if user is None or not user.is_authenticated or user.is_superuser:
            return qs
        tenant = _get_active_tenant(self.request)
        q = Q(device__isnull=True, virtual_machine__isnull=True, platform__isnull=True,
              application__isnull=True)
        for name, model in (("device", Device), ("virtual_machine", VirtualMachine),
                            ("platform", Platform), ("application", Application)):
            seen = rbac.restrict_queryset(model.objects.filter(tenant=tenant), user, tenant,
                                          _SUBJECT_SLUGS[name], "view")
            q |= Q(**{f"{name}__in": seen.values("pk")})
        return qs.filter(q)

    @extend_schema(parameters=[
        *[OpenApiParameter(k, OpenApiTypes.UUID, OpenApiParameter.QUERY)
          for k in ("device", "virtual_machine", "platform", "application")],
        *[OpenApiParameter(k, OpenApiTypes.STR, OpenApiParameter.QUERY)
          for k in ("vuln_id", "status", "scope", "owner", "active", "q")],
    ])
    def list(self, request, *args, **kwargs):
        qs = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(qs)
        rows = page if page is not None else list(qs)
        ctx = {**self.get_serializer_context(),
               "match_counts": _match_counts(request, [r.pk for r in rows])}
        data = self.serializer_class(rows, many=True, context=ctx).data
        if page is not None:
            return self.get_paginated_response(data)
        return Response(data)

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        serializer.save(tenant=tenant, created_by=self.request.user)

    def perform_update(self, serializer):
        inst = serializer.instance
        extra = {}
        expires = serializer.validated_data.get("expires_on", inst.expires_on)
        if inst.expiry_notified_at and (expires is None or expires >= timezone.localdate()):
            # Extended past its expiry: the next expiry tells the owner again.
            extra["expiry_notified_at"] = None
        serializer.save(**extra)
