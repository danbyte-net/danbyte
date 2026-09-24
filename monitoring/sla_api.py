"""Service level agreements - serializers and viewsets.

One permission, ``slaagreement``, covers an agreement and everything inside
it (check groups, members, exclusions): the child viewsets name it with
``rbac_object_type``. Members are ``object_type`` + ``object_id`` pairs and
follow the impact rule: attacker-set until the exact row passes the
caller's own view RBAC. Figures shown to a site-scoped viewer are recomputed
over the members they can see, never the whole agreement.
"""
from __future__ import annotations

import datetime as dt
import uuid
from datetime import timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import serializers
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.models import DeviceRole, DeviceType, Platform, Site
from api.viewsets import TenantScopedViewSet
from auth_api import rbac

from . import sla
from .models import (
    CheckKind,
    CheckTemplate,
    HolidayCalendar,
    SlaAgreement,
    SlaAgreementRevision,
    SlaCheckGroup,
    SlaCheckItem,
    SlaExclusion,
    SlaMember,
    SlaPeriodResult,
)
from .sla_time import WEEKDAYS

#: Member object types → their RBAC slug.
MEMBER_TYPES = {
    "api.device": "device",
    "api.virtualmachine": "virtualmachine",
    "api.ipaddress": "ipaddress",
    "api.prefix": "prefix",
    "api.circuit": "circuit",
}


def _tenant_of(serializer):
    view = serializer.context.get("view")
    return view._tenant_or_403() if view is not None else None


def _same_tenant(tenant, **objs):
    for field, obj in objs.items():
        if obj is not None and getattr(obj, "tenant_id", None) != tenant.id:
            raise ValidationError({field: "Not in this tenant."})


# ─── holiday calendars ──────────────────────────────────────────────────────


#: The list's history column counts this many finished periods.
HISTORY_PERIODS = 12


class HolidayCalendarSerializer(serializers.ModelSerializer):
    agreement_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = HolidayCalendar
        fields = ["id", "name", "description", "dates", "agreement_count",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]

    def validate_dates(self, value):
        if not isinstance(value, list):
            raise serializers.ValidationError("Expected a list of dates.")
        out = set()
        for raw in value:
            try:
                out.add(dt.date.fromisoformat(str(raw)).isoformat())
            except ValueError:
                raise serializers.ValidationError(f"«{raw}» is not a date (YYYY-MM-DD).") from None
        return sorted(out)


class HolidayCalendarViewSet(TenantScopedViewSet):
    queryset = HolidayCalendar.objects.all().order_by("name")
    serializer_class = HolidayCalendarSerializer

    def get_queryset(self):
        return super().get_queryset().annotate(agreement_count=Count("agreements"))


# ─── agreements ─────────────────────────────────────────────────────────────


class SlaAgreementSerializer(serializers.ModelSerializer):
    customer_detail = serializers.SerializerMethodField()
    sites = serializers.PrimaryKeyRelatedField(
        queryset=Site.objects.all(), many=True, required=False
    )
    sites_detail = serializers.SerializerMethodField()
    for_label = serializers.CharField(read_only=True)
    holiday_calendar_detail = serializers.SerializerMethodField()
    group_count = serializers.IntegerField(read_only=True, default=0)
    member_count = serializers.IntegerField(read_only=True, default=0)
    #: The open (or rolling) period's headline, when computed.
    current = serializers.SerializerMethodField()

    class Meta:
        model = SlaAgreement
        fields = [
            "id", "name", "description", "provided_for", "sites", "sites_detail",
            "for_label", "customer", "customer_detail", "customer_name",
            "target_pct", "warning_pct", "period", "timezone", "service_hours",
            "holiday_calendar", "holiday_calendar_detail", "count_degraded_as",
            "count_stale_as", "count_unknown_as", "exclude_maintenance",
            "min_outage_seconds", "aggregation", "latency_objectives", "objectives",
            "objectives_in_state", "status",
            "effective_from", "revision", "group_count", "member_count", "current",
            "notify_channels", "alert_burn_rate", "burn_alerts", "alert_coverage_pct",
            "credit_tiers", "period_fee", "currency",
            "report_recipients", "report_format",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "revision", "created_at", "updated_at"]

    def to_representation(self, obj):
        data = super().to_representation(obj)
        if not _may_see_credits(self.context.get("request"), obj):
            for f in CREDIT_FIELDS:
                data.pop(f, None)
        return data

    def get_customer_detail(self, obj):
        c = obj.customer
        return {"id": str(c.id), "name": c.name} if c else None

    def get_sites_detail(self, obj):
        return [{"id": str(s.id), "name": s.name} for s in obj.sites.all()]

    def get_holiday_calendar_detail(self, obj):
        c = obj.holiday_calendar
        return {"id": str(c.id), "name": c.name} if c else None

    def get_current(self, obj):
        res = getattr(obj, "_current", None)
        if res is None:
            return None
        body = _viewer_figures(self.context.get("request"), obj, res)
        # Burn is over the whole agreement: a limited viewer does not get it.
        full = body["limited"] is None
        return {"period_key": res.period_key, "computed_at": res.computed_at,
                "burn": obj.burn_state or None if full else None,
                "history": getattr(obj, "_history", None) if full else None, **body}

    def validate_credit_tiers(self, value):
        if not isinstance(value, list) or len(value) > 10:
            raise serializers.ValidationError("A list of up to 10 tiers.")
        out, seen = [], set()
        for raw in value:
            try:
                below, pct = float(raw["below"]), float(raw["credit_pct"])
            except (TypeError, KeyError, ValueError):
                raise serializers.ValidationError(
                    "Each tier is {below, credit_pct}, both numbers.") from None
            if not (0 < below <= 100 and 0 <= pct <= 100):
                raise serializers.ValidationError(
                    "Below is 0-100 %, the credit 0-100 % of the fee.")
            if below in seen:
                raise serializers.ValidationError(f"Two tiers below {below:g} %.")
            seen.add(below)
            out.append({"below": below, "credit_pct": pct})
        return sorted(out, key=lambda t: -t["below"])

    def validate_currency(self, value):
        value = (value or "").strip().upper()
        if value and not (len(value) == 3 and value.isalpha()):
            raise serializers.ValidationError("A three-letter code, such as DKK or EUR.")
        return value

    def validate_period_fee(self, value):
        if value is not None and value < 0:
            raise serializers.ValidationError("Zero or more.")
        return value

    def validate_burn_alerts(self, value):
        from .sla_burn import validate_rules

        try:
            return validate_rules(value)
        except ValueError as e:
            raise serializers.ValidationError(str(e)) from None

    def validate_alert_burn_rate(self, value):
        if value is not None and value <= 0:
            raise serializers.ValidationError("Above 0; 1.0 is on pace to spend the budget exactly.")
        return value

    def validate_alert_coverage_pct(self, value):
        if value is not None and not Decimal("0") < value <= Decimal("100"):
            raise serializers.ValidationError("Between 0 and 100.")
        return value

    def validate_report_recipients(self, value):
        from django.core.validators import validate_email

        if not isinstance(value, list) or len(value) > 50:
            raise serializers.ValidationError("A list of up to 50 addresses.")
        out = []
        for raw in value:
            addr = str(raw).strip()
            if not addr:
                continue
            try:
                validate_email(addr)
            except Exception:  # noqa: BLE001
                raise serializers.ValidationError(f"«{addr}» is not an email address.") from None
            out.append(addr)
        return out

    def validate_target_pct(self, value):
        if not Decimal("0") < value <= Decimal("100"):
            raise serializers.ValidationError("Between 0 and 100.")
        return value

    def validate_timezone(self, value):
        if value:
            try:
                ZoneInfo(value)
            except (ZoneInfoNotFoundError, ValueError):
                raise serializers.ValidationError("Unknown timezone.") from None
        return value

    def validate_service_hours(self, value):
        """{"mon": [["08:00", "17:00"]], ...}; empty = around the clock."""
        if not isinstance(value, dict):
            raise serializers.ValidationError("Expected {day: [[from, to], ...]}.")
        out = {}
        for day, spans in value.items():
            if day not in WEEKDAYS:
                raise serializers.ValidationError(f"«{day}» is not a day ({', '.join(WEEKDAYS)}).")
            if not isinstance(spans, list):
                raise serializers.ValidationError(f"{day}: expected a list of [from, to].")
            clean = []
            for span in spans:
                try:
                    a, b = span
                    ta, tb = _hhmm(a), _hhmm(b)
                except (TypeError, ValueError):
                    raise serializers.ValidationError(f"{day}: «{span}» is not [HH:MM, HH:MM].") from None
                if tb <= ta:
                    raise serializers.ValidationError(f"{day}: {a}-{b} ends before it starts.")
                clean.append([a, b])
            out[day] = clean
        return out

    def validate_objectives(self, value):
        from .sla_objectives import validate

        try:
            return validate(value)
        except ValueError as e:
            raise serializers.ValidationError(str(e)) from None

    def validate_latency_objectives(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("Expected {kind: milliseconds}.")
        kinds = set(CheckKind.values)
        out = {}
        for k, v in value.items():
            if k not in kinds:
                raise serializers.ValidationError(f"«{k}» is not a check kind.")
            try:
                out[k] = float(v)
            except (TypeError, ValueError):
                raise serializers.ValidationError(f"«{k}»: expected a number.") from None
        return out

    def validate(self, attrs):
        request = self.context.get("request")
        if request is not None and any(f in attrs for f in CREDIT_FIELDS):
            tenant = _tenant_of(self)
            if not rbac.has_action(request.user, tenant, "slaagreement", "view_credits"):
                current = self.instance
                for f in CREDIT_FIELDS:
                    now = getattr(current, f) if current else SlaAgreement._meta.get_field(
                        f).get_default()
                    if f in attrs and attrs[f] != now:
                        raise PermissionDenied("Changing service credits needs view_credits.")
        tenant = _tenant_of(self)
        if tenant is not None:
            _same_tenant(tenant, customer=attrs.get("customer"),
                         holiday_calendar=attrs.get("holiday_calendar"))
            for ch in attrs.get("notify_channels", []):
                _same_tenant(tenant, notify_channels=ch)
            for site in attrs.get("sites", []):
                _same_tenant(tenant, sites=site)
        # "Provided for" needs what it names.
        kind = attrs.get("provided_for", getattr(self.instance, "provided_for", "tenant"))
        sites = attrs.get("sites")
        if sites is None and self.instance is not None:
            sites = list(self.instance.sites.all())
        customer = attrs.get("customer", getattr(self.instance, "customer", None))
        name = attrs.get("customer_name", getattr(self.instance, "customer_name", ""))
        if kind == "sites" and not sites:
            raise ValidationError({"sites": "Pick the sites it covers."})
        if kind == "contact" and customer is None:
            raise ValidationError({"customer": "Pick the contact."})
        if kind == "name" and not (name or "").strip():
            raise ValidationError({"customer_name": "Give the name."})
        target = attrs.get("target_pct", getattr(self.instance, "target_pct", None))
        warning = attrs.get("warning_pct", getattr(self.instance, "warning_pct", None))
        if warning is not None and target is not None and not target < warning <= 100:
            raise ValidationError({"warning_pct": "Above the target, at most 100."})
        return attrs


def _hhmm(v: str) -> int:
    h, m = str(v).split(":")
    h, m = int(h), int(m)
    if not (0 <= h <= 24 and 0 <= m < 60) or (h == 24 and m):
        raise ValueError
    return h * 60 + m


def _visible_keys(request, tenant, units) -> set | None:
    """The member keys a viewer may see, or None when they see everything."""
    members = [u for u in units if u.get("member")]
    by_type: dict = {}
    for m in members:
        by_type.setdefault(m["object_type"], set()).add(m["object_id"])
    visible = set()
    everything = True
    from api import models as api_models

    model_for = {"api.device": api_models.Device,
                 "api.virtualmachine": api_models.VirtualMachine,
                 "api.ipaddress": api_models.IPAddress,
                 "api.prefix": api_models.Prefix,
                 "api.circuit": api_models.Circuit}
    for otype, ids in by_type.items():
        q = rbac.row_filter(request.user, tenant, MEMBER_TYPES.get(otype, ""), "view")
        if q is True:
            visible.update((otype, i) for i in ids)
            continue
        everything = False
        if q is None or otype not in model_for:
            continue
        seen = model_for[otype].objects.filter(tenant=tenant, pk__in=ids).filter(q)
        visible.update((otype, str(pk)) for pk in seen.values_list("pk", flat=True))
    if everything:
        return None
    return {m["key"] for m in members if (m["object_type"], m["object_id"]) in visible}


#: The agreement fields that are money; shown and changed with view_credits.
CREDIT_FIELDS = ("credit_tiers", "period_fee", "currency")


def _may_see_credits(request, agreement) -> bool:
    return request is None or rbac.has_action(
        request.user, agreement.tenant, "slaagreement", "view_credits")


def _credit_gate(request, agreement, figures: dict, whole: bool = True) -> dict:
    """The figures without the service credit, unless the caller may see
    money on this agreement and the figure is the whole agreement's."""
    if not figures or figures.get("credit") is None:
        return figures
    if whole and _may_see_credits(request, agreement):
        return figures
    return {**figures, "credit": None}


def _viewer_figures(request, agreement, res, full=False) -> dict:
    """A result as this viewer may see it. A scoped viewer gets the figure
    over the units whose members they can all see, marked limited."""
    units = [u for u in res.units if not u.get("member")]
    members = [u for u in res.units if u.get("member")]
    keys = _visible_keys(request, agreement.tenant, res.units) if request else None
    body = {"figures": _credit_gate(request, agreement, res.figures), "limited": None}
    if keys is not None:
        shown_units = [u for u in units if all(k in keys for k in u["members"])]
        hidden = len(members) - len(keys)
        body["figures"] = sla.partial(res, shown_units, sla.rules_for(agreement, res))
        body["limited"] = {"hidden_members": hidden}
        units = shown_units
        members = [m for m in members if m["key"] in keys]
    if full:
        unit_keys = {u["key"] for u in units}
        body.update({
            "units": units, "members": members,
            "incidents": [i for i in res.incidents if i["unit"] in unit_keys],
            # Days are the whole agreement's; a limited view does not get them.
            "days": res.days if keys is None else [],
        })
    return body


def _hidden_objects(request, agreement, now):
    """None when the caller sees every member; else the set of
    (object_type, id) they may see."""
    members = sla.resolve_members(agreement, now - timedelta(days=400), now)
    fake_units = [{"member": True, "key": f"{m['object_type']}:{m['object_id']}",
                   "object_type": m["object_type"], "object_id": str(m["object_id"])}
                  for m in members]
    keys = _visible_keys(request, agreement.tenant, fake_units)
    if keys is None:
        return None
    return {tuple(k.split(":", 1)) for k in keys}


def _result_for(agreement, want: str):
    """``(key, result)`` for "current", "previous" or a stored key."""
    now = timezone.now()
    if want == "current":
        key = sla.period_for(agreement, now)[0]
    elif want == "previous":
        prev = sla.previous_period(agreement, now)
        key = prev[0] if prev else None
    else:
        key = want
    res = SlaPeriodResult.objects.filter(agreement=agreement, period_key=key).first() if key else None
    return key, res


class SlaAgreementViewSet(TenantScopedViewSet):
    queryset = SlaAgreement.objects.select_related(
        "customer", "holiday_calendar", "tenant"
    ).prefetch_related("sites")
    serializer_class = SlaAgreementSerializer

    def get_queryset(self):
        qs = super().get_queryset().annotate(
            group_count=Count("check_groups", distinct=True),
            member_count=Count(
                "members", filter=Q(members__left_at__isnull=True, members__excluded=False),
                distinct=True,
            ),
        )
        p = self.request.query_params
        if p.get("status"):
            qs = qs.filter(status__in=p["status"].split(","))
        if p.get("q"):
            qs = qs.filter(
                Q(name__icontains=p["q"]) | Q(customer_name__icontains=p["q"])
                | Q(customer__name__icontains=p["q"]) | Q(sites__name__icontains=p["q"])
            ).distinct()
        if p.get("site"):
            qs = qs.filter(sites__id__in=p["site"].split(",")).distinct()
        return qs.order_by("name")

    def paginate_queryset(self, queryset):
        page = super().paginate_queryset(queryset)
        self._attach_current(page if page is not None else queryset)
        return page

    def get_object(self):
        obj = super().get_object()
        self._attach_current([obj])
        return obj

    def _attach_current(self, agreements):
        agreements = list(agreements)
        current = {}
        for r in SlaPeriodResult.objects.filter(
            agreement__in=agreements, state__in=("open", "rolling")
        ):
            current[r.agreement_id] = r
        # The last twelve finished periods: how many met the target.
        history: dict = {}
        for agreement_id, st_ in (
            SlaPeriodResult.objects.filter(agreement__in=agreements, state__in=("closed", "frozen"))
            .order_by("agreement_id", "-period_start")
            .values_list("agreement_id", "figures__state")
        ):
            h = history.setdefault(agreement_id, {"met": 0, "of": 0})
            if h["of"] < HISTORY_PERIODS and st_ not in (None, "no_data"):
                h["of"] += 1
                h["met"] += st_ in ("ok", "at_risk")
        for a in agreements:
            a._current = current.get(a.id)
            a._history = history.get(a.id, {"met": 0, "of": 0})

    @transaction.atomic
    def perform_create(self, serializer):
        super().perform_create(serializer)
        a = serializer.instance
        SlaAgreementRevision.objects.create(
            agreement=a, number=1, rules=a.rules(), created_by=self.request.user
        )

    @transaction.atomic
    def perform_update(self, serializer):
        before = serializer.instance.rules()
        super().perform_update(serializer)
        a = serializer.instance
        if a.rules() != before:
            # A closed period keeps the revision it ran under; this one, and
            # the periods after, use the new rules.
            a.revision += 1
            a.save(update_fields=["revision", "updated_at"])
            SlaAgreementRevision.objects.create(
                agreement=a, number=a.revision, rules=a.rules(), created_by=self.request.user
            )

    @action(detail=True, methods=["get"])
    def figures(self, request, pk=None):
        """One period's figures. ``?period=`` current (default), previous, or
        a stored key ("2026-08", "2026-Q2")."""
        a = self.get_object()
        key, res = _result_for(a, request.query_params.get("period") or "current")
        if res is None:
            return Response({"period_key": key, "computed": False})
        return Response({
            "period_key": res.period_key, "computed": True, "state": res.state,
            "period_start": res.period_start, "period_end": res.period_end,
            "revision": res.revision, "computed_at": res.computed_at,
            "closed_at": res.closed_at, "frozen_at": res.frozen_at,
            **_viewer_figures(request, a, res, full=True),
        })

    @action(detail=True, methods=["get"])
    def analysis(self, request, pk=None):
        """The agreement over any window, sliced for charts. ``?period=``
        (current / previous / a key) or ``?since=&until=`` (dates), ``?bucket=
        day|hour``, and filters ``group``, ``site``, ``member`` (object ids),
        ``kind``, ``redundancy`` - comma-separated. Computed live, scoped to
        the members the caller can see."""
        import datetime as _dt

        from .sla_analysis import analyse, options

        a = self.get_object()
        p = request.query_params
        now = timezone.now()
        tz = ZoneInfo(sla.agreement_tz(a))
        if p.get("since"):
            try:
                since = _dt.datetime.combine(_dt.date.fromisoformat(p["since"]), _dt.time(0), tz)
                until_d = _dt.date.fromisoformat(p.get("until") or p["since"])
                end = _dt.datetime.combine(until_d + _dt.timedelta(days=1), _dt.time(0), tz)
            except ValueError:
                raise ValidationError({"since": "Dates as YYYY-MM-DD."}) from None
            if end <= since or (end - since).days > 400:
                raise ValidationError({"until": "After since, and at most 400 days."})
            key, start, rules = None, since, a.rules()
        else:
            key, res = _result_for(a, p.get("period") or "current")
            bounds = sla.period_by_key(a, key) if key else None
            if bounds is None:
                raise ValidationError({"period": "Unknown period."})
            key, start, end = bounds
            rules = sla.rules_for(a, res)
        filters = {k: [v for v in (p.get(k) or "").split(",") if v]
                   for k in ("group", "site", "member", "kind", "redundancy")}
        filters = {k: v for k, v in filters.items() if v}
        hidden = _hidden_objects(request, a, now)
        if hidden is not None:
            filters["visible"] = hidden
        bucket = "hour" if p.get("bucket") == "hour" else "day"
        if bucket == "hour" and (min(end, now) - start).days > 45:
            raise ValidationError({"bucket": "Hourly for at most 45 days."})
        body = analyse(a, start, end, rules=rules, filters=filters, bucket=bucket, now=now)
        # A slice prices nothing; the whole agreement only for a credit viewer.
        body["figures"] = _credit_gate(
            request, a, body["figures"], whole=not filters)
        # The same slice one period (or one range length) earlier, for deltas.
        if key is not None:
            prev = sla.previous_period(a, start)
            p_start, p_end = (prev[1], prev[2]) if prev else (start - (end - start), start)
        else:
            p_start, p_end = start - (end - start), start
        before = sla.compute(a, p_start, p_end, rules=rules, now=now, filters=filters)
        body["previous"] = {
            "since": p_start.isoformat(), "until": p_end.isoformat(),
            **{k: before["figures"].get(k) for k in (
                "availability", "coverage", "down_s", "incidents", "budget_spent_pct", "state",
            )},
        }
        body["forecast"] = sla.forecast(a, body["figures"], end, now, rules, filters)
        if body["forecast"] and bucket == "day":
            # The days still to come, for the chart's dashed continuation.
            from .sla_analysis import _bounds

            body["forecast"]["buckets"] = [
                lo.isoformat() for lo, _hi in _bounds(now, end, sla.agreement_tz(a), "day")[1:]
            ]
        body["period_key"] = key
        body["options"] = options(a, now)
        body["limited"] = hidden is not None
        return Response(body)

    @action(detail=True, methods=["get"])
    def report(self, request, pk=None):
        """The period's report: ``?period=`` as for figures, ``?file=pdf|csv``
        (not ``format``, which DRF keeps for its own renderers).
        A scoped viewer's report leaves out what they cannot see."""
        from django.http import HttpResponse

        from .sla_report import report_csv, report_pdf

        a = self.get_object()
        key, res = _result_for(a, request.query_params.get("period") or "current")
        if res is None:
            raise ValidationError({"period": "No figures for that period yet."})
        view = _viewer_figures(request, a, res, full=True)
        stem = f"sla-{a.name}-{res.period_key}".replace(" ", "-").lower()
        if request.query_params.get("file") == "csv":
            resp = HttpResponse(report_csv(a, res, view), content_type="text/csv")
            resp["Content-Disposition"] = f'attachment; filename="{stem}.csv"'
            return resp
        resp = HttpResponse(report_pdf(a, res, view), content_type="application/pdf")
        resp["Content-Disposition"] = f'attachment; filename="{stem}.pdf"'
        return resp

    @action(detail=True, methods=["post"], url_path="send-report")
    def send_report(self, request, pk=None):
        """Email a period's report now - to ``recipients`` or the agreement's."""
        from .sla_notify import send_report

        a = self.get_object()
        if not rbac.has_action(request.user, a.tenant, "slaagreement", "change"):
            raise PermissionDenied("slaagreement:change required.")
        key, res = _result_for(a, request.data.get("period") or "current")
        if res is None:
            raise ValidationError({"period": "No figures for that period yet."})
        recipients = request.data.get("recipients")
        if recipients is not None:
            try:
                recipients = SlaAgreementSerializer().validate_report_recipients(recipients)
            except ValidationError as e:
                raise ValidationError({"recipients": e.detail}) from None
        view = _viewer_figures(request, a, res, full=True)
        if not send_report(a, res, recipients=recipients, view=view, mark=False):
            raise ValidationError({"recipients": "No recipients, or the mail could not be sent."})
        return Response({"sent": True})

    @action(detail=False, methods=["get"], url_path="overview-report")
    def overview_report(self, request):
        """Every agreement's figure for one period: ``?period=current|previous``
        or a key ("2026-09"), ``?file=pdf|csv``."""
        from django.http import HttpResponse

        from .sla_report import overview_csv, overview_pdf

        want = request.query_params.get("period") or "current"
        rows = []
        for a in self.get_queryset().exclude(status="draft"):
            _key, res = _result_for(a, want)
            rows.append((a, res, _viewer_figures(request, a, res)["figures"] if res else None))
        stem = f"sla-overview-{want}"
        if request.query_params.get("file") == "csv":
            resp = HttpResponse(overview_csv(rows), content_type="text/csv")
            resp["Content-Disposition"] = f'attachment; filename="{stem}.csv"'
            return resp
        resp = HttpResponse(overview_pdf(rows, want), content_type="application/pdf")
        resp["Content-Disposition"] = f'attachment; filename="{stem}.pdf"'
        return resp

    @action(detail=True, methods=["get"])
    def periods(self, request, pk=None):
        """Every stored period, newest first - the history strip."""
        a = self.get_object()
        out = []
        for r in SlaPeriodResult.objects.filter(agreement=a).order_by("-period_start")[:60]:
            out.append({
                "period_key": r.period_key, "state": r.state, "revision": r.revision,
                "period_start": r.period_start, "period_end": r.period_end,
                **_viewer_figures(request, a, r),
            })
        return Response(out)

    @action(detail=True, methods=["get"])
    def revisions(self, request, pk=None):
        a = self.get_object()
        money = _may_see_credits(request, a)
        return Response([
            {"number": r.number,
             "rules": r.rules if money else {k: v for k, v in r.rules.items()
                                             if k not in CREDIT_FIELDS},
             "created_at": r.created_at,
             "created_by": getattr(r.created_by, "username", None)}
            for r in a.revisions.select_related("created_by")
        ])

    @action(detail=True, methods=["post"])
    def recompute(self, request, pk=None):
        """Recompute now instead of waiting for the next run."""
        a = self.get_object()
        if not rbac.has_action(request.user, a.tenant, "slaagreement", "change"):
            raise PermissionDenied("slaagreement:change required.")
        if a.status != "active":
            raise ValidationError({"status": "Only an active agreement is computed."})
        sla.refresh_agreement(a)
        return Response({"ok": True})


# ─── check groups ───────────────────────────────────────────────────────────


class SlaCheckItemSerializer(serializers.ModelSerializer):
    template = serializers.PrimaryKeyRelatedField(queryset=CheckTemplate.objects.all())
    template_name = serializers.CharField(source="template.name", read_only=True)
    template_kind = serializers.CharField(source="template.kind", read_only=True)

    class Meta:
        model = SlaCheckItem
        fields = ["id", "template", "template_name", "template_kind", "counts",
                  "weight", "required", "position"]
        read_only_fields = ["id"]


def _ref_list(model):
    return serializers.PrimaryKeyRelatedField(
        queryset=model.objects.all(), many=True, required=False
    )


class SlaCheckGroupSerializer(serializers.ModelSerializer):
    items = SlaCheckItemSerializer(many=True, required=False)
    match_sites = _ref_list(Site)
    match_roles = _ref_list(DeviceRole)
    match_device_types = _ref_list(DeviceType)
    match_platforms = _ref_list(Platform)
    member_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = SlaCheckGroup
        fields = [
            "id", "agreement", "name", "position", "target", "combine", "weight",
            "use_selector", "match_sites", "match_roles", "match_device_types",
            "match_platforms", "match_tags", "match_name", "items", "member_count",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]

    def validate_match_tags(self, value):
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise serializers.ValidationError("Expected a list of tag slugs.")
        return value

    def validate(self, attrs):
        tenant = _tenant_of(self)
        if tenant is None:
            return attrs
        if self.instance is not None and "agreement" in attrs and (
            attrs["agreement"] != self.instance.agreement
        ):
            raise ValidationError({"agreement": "A group can't move between agreements."})
        _same_tenant(tenant, agreement=attrs.get("agreement"))
        for field in ("match_sites", "match_roles", "match_device_types", "match_platforms"):
            for obj in attrs.get(field, []):
                _same_tenant(tenant, **{field: obj})
        for it in attrs.get("items", []):
            _same_tenant(tenant, items=it["template"])
        return attrs

    def _write_items(self, group, items):
        group.items.all().delete()
        SlaCheckItem.objects.bulk_create([
            SlaCheckItem(group=group, position=n, **{k: v for k, v in it.items() if k != "position"})
            for n, it in enumerate(items)
        ])

    def create(self, validated):
        items = validated.pop("items", [])
        group = super().create(validated)
        self._write_items(group, items)
        return group

    def update(self, instance, validated):
        items = validated.pop("items", None)
        group = super().update(instance, validated)
        if items is not None:
            self._write_items(group, items)
        return group


class SlaCheckGroupViewSet(TenantScopedViewSet):
    queryset = SlaCheckGroup.objects.prefetch_related(
        "items__template", "match_sites", "match_roles", "match_device_types",
        "match_platforms",
    )
    serializer_class = SlaCheckGroupSerializer
    rbac_object_type = "slaagreement"

    def get_queryset(self):
        qs = super().get_queryset().annotate(
            member_count=Count(
                "members", filter=Q(members__left_at__isnull=True, members__excluded=False)
            )
        )
        if self.request.query_params.get("agreement"):
            qs = qs.filter(agreement_id=self.request.query_params["agreement"])
        return qs.order_by("agreement", "position", "name")


# ─── members ────────────────────────────────────────────────────────────────


class SlaMemberSerializer(serializers.ModelSerializer):
    object = serializers.SerializerMethodField()
    monitor_ip_detail = serializers.SerializerMethodField()

    class Meta:
        model = SlaMember
        fields = [
            "id", "agreement", "group", "object_type", "object_id", "object",
            "object_site", "redundancy_group", "monitor_ip", "monitor_ip_detail",
            "excluded", "joined_at", "left_at", "created_at",
        ]
        read_only_fields = ["id", "object_site", "left_at", "created_at"]

    def get_object(self, obj):
        o = self.context.get("objects", {}).get((obj.object_type, obj.object_id))
        if o is None:
            return None
        name = sla._name(o, obj.object_type)
        return {"id": str(o.pk), "name": name}

    def get_monitor_ip_detail(self, obj):
        ip = obj.monitor_ip
        return {"id": str(ip.pk), "address": str(ip.ip_address)} if ip else None

    def validate_object_type(self, value):
        if value not in MEMBER_TYPES:
            raise serializers.ValidationError(f"One of: {', '.join(MEMBER_TYPES)}.")
        return value

    def validate(self, attrs):
        tenant = _tenant_of(self)
        otype = attrs.get("object_type") or getattr(self.instance, "object_type", None)
        if attrs.get("monitor_ip") is not None:
            if otype != "api.circuit":
                raise ValidationError({"monitor_ip": "Only a circuit takes a monitor address."})
            _same_tenant(tenant, monitor_ip=attrs["monitor_ip"])
        if self.instance is not None:
            for f in ("agreement", "group", "object_type", "object_id"):
                if f in attrs and attrs[f] != getattr(self.instance, f):
                    raise ValidationError({f: "A member can't be retargeted - remove and re-add."})
            return attrs
        agreement, group = attrs["agreement"], attrs["group"]
        _same_tenant(tenant, agreement=agreement)
        if group.agreement_id != agreement.id:
            raise ValidationError({"group": "Not a group of this agreement."})
        return attrs


def _check_member(request, tenant, object_type, object_id):
    """The object must exist in this tenant and be visible to the caller;
    returns its site id for the denormalised column."""
    from audit.api import _can_view_object, _object_site_id

    if object_type not in MEMBER_TYPES:
        raise ValidationError({"object_type": f"One of: {', '.join(MEMBER_TYPES)}."})
    from django.apps import apps

    model = apps.get_model(object_type)
    if not model.objects.filter(tenant=tenant, pk=object_id).exists():
        raise ValidationError({"object_id": "No such object in this tenant."})
    if not _can_view_object(request, object_type, str(object_id)):
        raise PermissionDenied("You can't add an object you can't view.")
    return _object_site_id(object_type, str(object_id))


class SlaMemberViewSet(TenantScopedViewSet):
    queryset = SlaMember.objects.select_related("group", "monitor_ip")
    serializer_class = SlaMemberSerializer
    rbac_object_type = "slaagreement"

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("agreement"):
            qs = qs.filter(agreement_id=p["agreement"])
        if p.get("group"):
            qs = qs.filter(group_id=p["group"])
        if p.get("object_type") and p.get("object_id"):
            qs = qs.filter(object_type=p["object_type"], object_id=p["object_id"])
        if p.get("current") == "1":
            qs = qs.filter(left_at__isnull=True)
        return qs.order_by("group__position", "object_type", "created_at")

    def get_serializer_context(self):
        return {**super().get_serializer_context(), "objects": getattr(self, "_objects", {})}

    def paginate_queryset(self, queryset):
        page = super().paginate_queryset(queryset)
        rows = page if page is not None else list(queryset)
        self._objects = sla._objects(
            [{"object_type": m.object_type, "object_id": m.object_id} for m in rows]
        )
        return page

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        vd = serializer.validated_data
        site = _check_member(self.request, tenant, vd["object_type"], vd["object_id"])
        serializer.save(tenant=tenant, object_site_id=site)

    def perform_destroy(self, instance):
        # Leaving keeps the row: the periods it was in still count it.
        if instance.left_at is None and not instance.excluded:
            instance.left_at = timezone.now()
            instance.save(update_fields=["left_at", "updated_at"])
        else:
            super().perform_destroy(instance)

    @action(detail=False, methods=["post"], url_path="bulk-add")
    def bulk_add(self, request):
        """``{agreement, group, objects: [{object_type, object_id}], redundancy_group?,
        monitor_ip?}`` - add many at once; ones already in the group are
        skipped. ``monitor_ip`` applies to circuits only."""
        tenant = self._tenant_or_403()
        if not rbac.has_action(request.user, tenant, "slaagreement", "add"):
            raise PermissionDenied("slaagreement:add required.")
        group = SlaCheckGroup.objects.filter(
            tenant=tenant, pk=request.data.get("group"), agreement_id=request.data.get("agreement")
        ).first()
        if group is None:
            raise ValidationError({"group": "Not a group of this agreement."})
        objs = request.data.get("objects") or []
        if not isinstance(objs, list) or len(objs) > 1000:
            raise ValidationError({"objects": "A list of up to 1000 objects."})
        monitor_ip = None
        if request.data.get("monitor_ip"):
            from api.models import IPAddress

            if any(o.get("object_type") != "api.circuit" for o in objs):
                raise ValidationError({"monitor_ip": "Only a circuit takes a monitor address."})
            try:
                monitor_ip = IPAddress.objects.filter(
                    tenant=tenant, pk=uuid.UUID(str(request.data["monitor_ip"]))
                ).first()
            except ValueError:
                monitor_ip = None
            if monitor_ip is None:
                raise ValidationError({"monitor_ip": "No such address in this tenant."})
        created = skipped = 0
        with transaction.atomic():
            for o in objs:
                otype, oid = o.get("object_type"), o.get("object_id")
                try:
                    oid = uuid.UUID(str(oid))
                except ValueError:
                    raise ValidationError({"objects": f"«{oid}» is not an id."}) from None
                site = _check_member(request, tenant, otype, oid)
                _m, made = SlaMember.objects.get_or_create(
                    agreement=group.agreement, group=group, object_type=otype, object_id=oid,
                    defaults={"tenant": tenant, "object_site_id": site, "monitor_ip": monitor_ip,
                              "redundancy_group": str(request.data.get("redundancy_group") or "")},
                )
                if not made and _m.left_at is not None:
                    # Rejoining: a fresh stay, the old one stays in the past.
                    _m.left_at, _m.joined_at = None, timezone.now()
                    _m.save(update_fields=["left_at", "joined_at", "updated_at"])
                    made = True
                created += made
                skipped += not made
        if created and group.agreement.status == "active":
            # So the object's page shows it in the figure straight away.
            sla.refresh_agreement(group.agreement)
        return Response({"created": created, "skipped": skipped})


# ─── exclusions ─────────────────────────────────────────────────────────────


class SlaExclusionSerializer(serializers.ModelSerializer):
    created_by_name = serializers.CharField(source="created_by.username", read_only=True, default=None)

    class Meta:
        model = SlaExclusion
        fields = ["id", "agreement", "member", "starts_at", "ends_at", "reason",
                  "created_by_name", "created_at"]
        read_only_fields = ["id", "created_at"]

    def validate(self, attrs):
        tenant = _tenant_of(self)
        agreement = attrs.get("agreement", getattr(self.instance, "agreement", None))
        member = attrs.get("member", getattr(self.instance, "member", None))
        starts = attrs.get("starts_at", getattr(self.instance, "starts_at", None))
        ends = attrs.get("ends_at", getattr(self.instance, "ends_at", None))
        _same_tenant(tenant, agreement=agreement)
        if member is not None and member.agreement_id != agreement.id:
            raise ValidationError({"member": "Not a member of this agreement."})
        if not (attrs.get("reason") or getattr(self.instance, "reason", "")).strip():
            raise ValidationError({"reason": "Say why this time does not count."})
        if ends <= starts:
            raise ValidationError({"ends_at": "Ends before it starts."})
        frozen = SlaPeriodResult.objects.filter(
            agreement=agreement, state="frozen", period_start__lt=ends, period_end__gt=starts,
        ).first()
        if frozen is not None:
            raise ValidationError(
                {"starts_at": f"{frozen.period_key} is frozen; its figure no longer changes."}
            )
        return attrs


class SlaExclusionViewSet(TenantScopedViewSet):
    queryset = SlaExclusion.objects.select_related("created_by")
    serializer_class = SlaExclusionSerializer
    rbac_object_type = "slaagreement"

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("agreement"):
            qs = qs.filter(agreement_id=self.request.query_params["agreement"])
        return qs.order_by("-starts_at")

    def perform_create(self, serializer):
        serializer.save(tenant=self._tenant_or_403(), created_by=self.request.user)

    def perform_destroy(self, instance):
        if SlaPeriodResult.objects.filter(
            agreement=instance.agreement, state="frozen",
            period_start__lt=instance.ends_at, period_end__gt=instance.starts_at,
        ).exists():
            raise ValidationError("It touches a frozen period; it stays.")
        super().perform_destroy(instance)


# ─── status for list columns ────────────────────────────────────────────────

#: List kinds → (member object type, RBAC slug, rollup field of the address
#: that ties a check to the object).
STATUS_KINDS = {
    "device": ("api.device", "device", "target_ip__assigned_device_id"),
    "vm": ("api.virtualmachine", "virtualmachine", "target_ip__assigned_vm_id"),
    "ip": ("api.ipaddress", "ipaddress", "target_ip_id"),
    "prefix": ("api.prefix", "prefix", "target_ip__prefix_id"),
    # A circuit's addresses come from a cable trace, not one lookup.
    "circuit": ("api.circuit", "circuit", None),
    # A site or cluster: over its devices (a cluster's hosts).
    "site": ("api.site", "site", "target_ip__assigned_device__site_id"),
    "cluster": ("api.cluster", "cluster", "target_ip__assigned_device__cluster_id"),
}
MAX_STATUS_IDS = 5000


def _sla_state(av, target, warning) -> str:
    return ("no_data" if av is None else "breached" if av < target
            else "at_risk" if warning is not None and av < warning else "ok")


def _sla_entry(res, u) -> dict:
    """One agreement's figure for one member unit, for a list cell."""
    a = res.agreement
    target = float(a.target_pct)
    warning = float(a.warning_pct) if a.warning_pct is not None else None
    av = u["availability"]
    return {
        "agreement": {"id": str(a.id), "name": a.name},
        "period_key": res.period_key, "target": target,
        "availability": av, "coverage": u["coverage"],
        "state": _sla_state(av, target, warning),
        "down_s": u["down_s"], "worst_item": u.get("worst_item"),
        "budget_left_s": round((1 - target / 100) * (res.figures.get(
            "full_service_s") or 0) - u["down_s"]),
    }


def _site_agreements(results, keep, out) -> None:
    """A site's SLA is every agreement provided for it - its whole figure."""
    by_agreement = {res.agreement_id: res for res in results}
    for agreement_id, site_id in SlaAgreement.sites.through.objects.filter(
        slaagreement_id__in=by_agreement, site_id__in=keep
    ).values_list("slaagreement_id", "site_id"):
        res = by_agreement[agreement_id]
        f = res.figures or {}
        a = res.agreement
        target = float(a.target_pct)
        out[str(site_id)]["sla"].append({
            "agreement": {"id": str(a.id), "name": a.name},
            "period_key": res.period_key, "target": target,
            "availability": f.get("availability"), "coverage": f.get("coverage"),
            "state": f.get("state") or "no_data", "down_s": f.get("down_s", 0),
            "worst_item": None, "budget_left_s": f.get("budget_left_s"),
        })


def _cluster_hosts(tenant, keep) -> dict:
    """``{device id: cluster id}`` for the hosts of these clusters."""
    from api.models import Device

    return {str(d): str(c) for d, c in Device.objects.filter(
        tenant=tenant, cluster_id__in=keep).values_list("pk", "cluster_id")}


def _circuit_sums(win, tenant, keep, sums) -> dict:
    """Rollup sums per circuit, over the addresses its ends are cabled to."""
    ip_map = sla._circuit_addresses(list(keep))
    # A circuit measured through a monitor address in an agreement is
    # measured there here too.
    for cid, ip in SlaMember.objects.filter(
        tenant=tenant, object_type="api.circuit", object_id__in=keep,
        monitor_ip__isnull=False, left_at__isnull=True,
    ).values_list("object_id", "monitor_ip_id"):
        ip_map.setdefault(cid, [])
        if ip not in ip_map[cid]:
            ip_map[cid].append(ip)
    ips = {ip for v in ip_map.values() for ip in v}
    if not ips:
        return {}
    per_ip = sums(win, lambda qs: qs.filter(tenant=tenant, target_ip_id__in=ips),
                  ("target_ip_id",))
    out: dict = {}
    for cid, cips in ip_map.items():
        acc: dict = {}
        for ip in cips:
            for k, v in (per_ip.get((ip,)) or {}).items():
                acc[k] = max(acc.get(k) or 0, v) if k == "lat_max" else acc.get(k, 0) + v
        if acc:
            out[(cid,)] = acc
    return out


@extend_schema(
    summary="SLA figures and availability for many objects - the list columns",
    tags=["monitoring"],
    request=OpenApiTypes.OBJECT,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def sla_status_view(request):
    """``{kind: device|vm|ip|prefix|circuit|site|cluster, ids: [...], frame?}`` → per id:

    * ``sla`` - each agreement the object is in, with its figure in the
      agreement's current period (read from the stored result, never
      recomputed here), and ``lowest``, the strictest of them;
    * ``availability`` - plain availability over ``frame`` from the rollups,
      every check on the object's addresses, SLA or not.

    Objects the caller cannot view are left out; agreements are only listed
    to a caller with view on SLA agreements."""
    from api.views import _get_active_tenant

    from .figures import FRAMES, figures, frame_window, sums
    from .models import MonitoringSettings

    tenant = _get_active_tenant(request)
    kind = request.data.get("kind")
    if kind not in STATUS_KINDS:
        raise ValidationError({"kind": f"One of: {', '.join(STATUS_KINDS)}."})
    ids = request.data.get("ids") or []
    if not isinstance(ids, list) or len(ids) > MAX_STATUS_IDS:
        raise ValidationError({"ids": f"A list of up to {MAX_STATUS_IDS} ids."})
    frame = request.data.get("frame")
    if tenant is None:
        return Response({"frame": frame, "results": {}})
    if frame not in FRAMES:
        s = MonitoringSettings.objects.filter(tenant=tenant).only("availability_frame").first()
        frame = s.availability_frame if s else "30d"
    otype, slug, field = STATUS_KINDS[kind]

    from django.apps import apps

    model = apps.get_model(otype)
    q = rbac.row_filter(request.user, tenant, slug, "view")
    if q is None:
        return Response({"frame": frame, "results": {}})
    valid = []
    for raw in ids:
        try:
            valid.append(uuid.UUID(str(raw)))
        except ValueError:
            continue
    visible = model.objects.filter(tenant=tenant, pk__in=valid)
    if q is not True:
        visible = visible.filter(q)
    keep = {str(pk) for pk in visible.values_list("pk", flat=True)}
    out = {i: {"sla": [], "lowest": None, "availability": None} for i in keep}
    if not keep:
        return Response({"frame": frame, "results": {}})

    win = frame_window(frame, sla.agreement_tz_for_tenant(tenant))
    if field is None:
        got = _circuit_sums(win, tenant, keep, sums)
    else:
        got = sums(
            win,
            lambda qs: qs.filter(tenant=tenant, **{f"{field}__in": keep}),
            (field,),
        )
    for (key,), row in got.items():
        f = figures(row)
        out[str(key)]["availability"] = {"availability": f["availability"],
                                         "coverage": f["coverage"]}

    if rbac.has_action(request.user, tenant, "slaagreement", "view"):
        results = SlaPeriodResult.objects.filter(
            tenant=tenant, state__in=("open", "rolling"), agreement__status="active",
        ).select_related("agreement")
        results = list(results)
        if kind == "site":
            _site_agreements(results, keep, out)
        else:
            owner = _cluster_hosts(tenant, keep) if kind == "cluster" else None
            member_type = "api.device" if kind == "cluster" else otype
            for res in results:
                for u in res.units:
                    if not u.get("member") or u["object_type"] != member_type:
                        continue
                    oid = owner.get(u["object_id"]) if owner is not None else u["object_id"]
                    if oid in keep:
                        out[oid]["sla"].append(_sla_entry(res, u))
        for entry in out.values():
            if entry["sla"]:
                # The strictest: furthest below (or least above) its target.
                entry["lowest"] = min(
                    entry["sla"],
                    key=lambda x: (x["availability"] is None, (x["availability"] or 0) - x["target"]),
                )
    return Response({"frame": frame, "results": out})
