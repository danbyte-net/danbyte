"""CRUD viewsets for monitoring templates + assignments.

Both are tenant-scoped via the shared ``TenantScopedViewSet`` base (active
tenant stamped on create, cross-tenant rows hidden). Assignments validate that
every referenced IP/prefix belongs to the active tenant.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from secrets import token_urlsafe

from django.core.exceptions import FieldError
from django.db.models import Exists, OuterRef, Q
from rest_framework import permissions, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response

from api.views import _get_active_tenant
from api.viewsets import TenantScopedReadViewSet, TenantScopedViewSet
from auth_api import rbac
from auth_api.permissions import can_manage_admin

from .models import (
    AlertRule,
    Certificate,
    AcmeOrder,
    CertificateAssignment,
    CertificateRequest,
    ConnectProtocol,
    DeviceCredential,
    Issuer,
    SSHHostKey,
    CertificateBinding,
    CheckAssignment,
    CheckTemplate,
    MonitoringDenySubnet,
    MonitoringEngine,
    MonitoringPolicy,
    MonitoringProfile,
    NotificationChannel,
    NotificationSubscription,
    OutpostRelease,
    Silence,
    SnmpProfile,
    SnmpSensor,
    WatchedEndpoint,
)
from .serializers import (
    AlertRuleSerializer,
    AcmeOrderSerializer,
    CertificateAssignmentSerializer,
    CertificateRequestSerializer,
    ConnectProtocolSerializer,
    DeviceCredentialSerializer,
    IssuerSerializer,
    CertificateBindingSerializer,
    CertificateSerializer,
    SSHHostKeySerializer,
    CertificateUploadSerializer,
    CheckAssignmentSerializer,
    CheckTemplateSerializer,
    MonitoringDenySubnetSerializer,
    MonitoringEngineSerializer,
    MonitoringPolicySerializer,
    MonitoringProfileSerializer,
    NotificationChannelSerializer,
    NotificationSubscriptionSerializer,
    OutpostReleaseSerializer,
    SilenceSerializer,
    SnmpProfileSerializer,
    SnmpSensorSerializer,
    WatchedEndpointSerializer,
)

logger = logging.getLogger("monitoring.viewsets")


class _EnginePermission(permissions.BasePermission):
    """Anyone signed into the tenant may *read* the engine list (the site /
    location forms need it for the assignment dropdown); only admins may create,
    edit, enroll, or delete — a deployment-admin surface like Users / Email."""

    message = "Admin access required."

    def has_permission(self, request, view):
        if not (request.user and request.user.is_authenticated):
            return False
        if request.method in permissions.SAFE_METHODS:
            return True
        return can_manage_admin(request.user, _get_active_tenant(request))


class MonitoringEngineViewSet(viewsets.ModelViewSet):
    """Monitoring engines (Outposts) — admin-gated, tenant-scoped. The built-in
    local engine is ensured on read; it can't be created or deleted here."""

    serializer_class = MonitoringEngineSerializer
    permission_classes = [_EnginePermission]

    def get_queryset(self):
        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return MonitoringEngine.objects.none()
        MonitoringEngine.local_for(tenant)  # ensure the built-in row exists
        return MonitoringEngine.objects.filter(tenant=tenant)

    def perform_create(self, serializer):
        # Only remote Outposts are created here; ``kind`` is read-only.
        serializer.save(
            tenant=_get_active_tenant(self.request), kind=MonitoringEngine.REMOTE
        )

    def perform_destroy(self, instance):
        if instance.is_local:
            raise ValidationError("The built-in local engine can't be deleted.")
        instance.delete()

    @action(detail=True, methods=["post"])
    def enroll(self, request, pk=None):
        """(Re)generate this Outpost's token — returned **once**; afterwards the
        API exposes only ``token_set``."""
        engine = self.get_object()
        if engine.is_local:
            raise ValidationError("The local engine has no token.")
        token = token_urlsafe(32)
        engine.token = {"secret": token}
        engine.save(update_fields=["token", "updated_at"])
        return Response({"token": token, "engine_id": str(engine.id)})

    @action(detail=True, methods=["get"])
    def stats(self, request, pk=None):
        """Detail-page stats for one engine: what it monitors + how it's doing."""
        from django.db.models import Count

        from api.models import Location, Site
        from auth_api import rbac

        from .models import (
            CheckState,
            MonitoringEngineBinding,
            MonitoringSettings,
            StateTransition,
        )
        from .views import _scope_ip_keyed

        engine = self.get_object()
        tenant = engine.tenant
        default_id = MonitoringSettings.for_tenant(tenant).default_engine_id
        # Row/site scope: an engine spans every site in the tenant. Without this
        # a Site-A viewer read Site-B IP addresses (via `recent`) plus site /
        # location names off any engine id. Restrict the check data to IPs the
        # caller may view, and the bound site/location names to their scope.
        states = _scope_ip_keyed(
            request, tenant, CheckState.objects.filter(engine=engine)
        )
        by_status = {
            r["status"]: r["n"]
            for r in states.values("status").annotate(n=Count("id"))
        }
        bindings = list(
            MonitoringEngineBinding.objects.filter(engine=engine)
        )
        site_ids = [b.object_id for b in bindings if b.scope == "site"]
        loc_ids = [b.object_id for b in bindings if b.scope == "location"]
        sites = list(
            rbac.restrict_queryset(
                Site.objects.filter(id__in=site_ids), request.user, tenant,
                "site", "view",
            ).values("id", "name")
        )
        locations = list(
            rbac.restrict_queryset(
                Location.objects.filter(id__in=loc_ids), request.user, tenant,
                "location", "view",
            ).values("id", "name")
        )
        recent = (
            StateTransition.objects.filter(
                target_ip_id__in=states.values("target_ip_id")
            )
            .select_related("target_ip")
            .order_by("-at")[:12]
        )
        return Response({
            "total_checks": states.count(),
            "is_default": str(default_id) == str(engine.id),
            "by_status": by_status,
            "sites": [{"id": str(s["id"]), "name": s["name"]} for s in sites],
            "locations": [
                {"id": str(l["id"]), "name": l["name"]} for l in locations
            ],
            "recent": [
                {
                    "ip": t.target_ip.ip_address if t.target_ip_id else None,
                    "from_status": t.from_status,
                    "to_status": t.to_status,
                    "at": t.at,
                }
                for t in recent
            ],
        })


class SnmpProfileViewSet(TenantScopedViewSet):
    queryset = SnmpProfile.objects.all().order_by("name")
    serializer_class = SnmpProfileSerializer


class CertificateViewSet(TenantScopedViewSet):
    """Certificates — tenant-scoped, authenticated, and authored-or-observed.

    Observed rows are written by the collector; uploaded rows are authored by an
    operator (source of truth). The write surface is deliberately narrow:

    * **create** is *upload only* — POST a public PEM (see ``CertificateUpload``);
      the facts are extracted from the bytes, and a private key is a clean 400.
      There is no way to POST fact fields directly.
    * **update** touches only ``name`` / ``notes`` — every intrinsic fact is
      ``read_only`` on the serializer, so a PATCH can never rewrite the bytes'
      properties.
    * **delete** removes the tenant's row. An *observed* certificate that is
      still being served will simply be re-created on the next poll (identity is
      the fingerprint); an *uploaded-only* row is gone. Deleting is thus safe and
      non-destructive to reality, so it is allowed for either origin.

    Filters: ``?expiring_in_days=N`` (expiring within N days, expired included),
    ``?expired=1|0``, ``?self_signed=1|0``, ``?origin=observed|uploaded|both``,
    ``?assigned=1|0``, ``?search=`` over subject / issuer / fingerprint.
    """

    queryset = Certificate.objects.all()
    serializer_class = CertificateSerializer
    parser_classes = [JSONParser, FormParser, MultiPartParser]
    # Importing a bundle creates rows, so it needs an ``add`` grant, not the
    # ``change`` a custom mutating action defaults to.
    rbac_action_map = {"import_bundle": "add"}

    def get_queryset(self):
        from django.db.models import Count
        from django.utils import timezone

        # Aggregation drops Meta.ordering (Django ≥3.1), so restate it — an
        # unordered paginated list silently reshuffles between pages.
        qs = (
            super().get_queryset()
            .annotate(
                binding_count=Count("bindings", distinct=True),
                assignment_count=Count("assignments", distinct=True),
            )
            .order_by("not_after", "subject_cn")
        )
        params = self.request.query_params
        now = timezone.now()

        days = params.get("expiring_in_days")
        if days:
            try:
                qs = qs.filter(not_after__lte=now + timedelta(days=float(days)))
            except ValueError:
                pass
        expired = params.get("expired")
        if expired in ("1", "true"):
            qs = qs.filter(not_after__lte=now)
        elif expired in ("0", "false"):
            qs = qs.filter(not_after__gt=now)
        self_signed = params.get("self_signed")
        if self_signed in ("1", "true"):
            qs = qs.filter(self_signed=True)
        elif self_signed in ("0", "false"):
            qs = qs.filter(self_signed=False)
        is_ca = params.get("is_ca")
        if is_ca in ("1", "true"):
            qs = qs.filter(is_ca=True)
        elif is_ca in ("0", "false"):
            qs = qs.filter(is_ca=False)
        issued_by = params.get("issued_by")
        if issued_by:
            qs = qs.filter(issuer_certificate_id=issued_by)
        origin = params.get("origin")
        if origin == "observed":
            qs = qs.filter(observed=True)
        elif origin == "uploaded":
            qs = qs.filter(uploaded=True)
        elif origin == "both":
            qs = qs.filter(observed=True, uploaded=True)
        assigned = params.get("assigned")
        if assigned in ("1", "true"):
            qs = qs.filter(assignments__isnull=False).distinct()
        elif assigned in ("0", "false"):
            qs = qs.filter(assignments__isnull=True)
        search = (params.get("search") or "").strip()
        if search:
            qs = qs.filter(
                Q(subject__icontains=search)
                | Q(issuer__icontains=search)
                | Q(name__icontains=search)
                | Q(fingerprint_sha256__istartswith=search)
            )
        return qs

    @action(detail=False, methods=["get"])
    def health(self, request):
        """At-a-glance certificate + key health for the monitoring overview.

        Expiry buckets against the tenant's own thresholds, the self-signed
        count, SSH host-key drift, and the tenant's firing-alert total — one
        tenant-scoped read instead of a fistful of list calls the client would
        have to bucket itself. Each count maps to an existing filtered list view.
        """
        from django.utils import timezone

        from .cert_expiry import thresholds
        from .models import Alert, AlertStatus, MonitoringSettings

        tenant = self._tenant_or_403()
        now = timezone.now()
        limits = thresholds(MonitoringSettings.objects.filter(tenant=tenant).first())
        warn = now + timedelta(days=limits["warning_days"])
        crit = now + timedelta(days=limits["critical_days"])

        certs = Certificate.objects.filter(tenant=tenant)
        firing = Alert.objects.filter(tenant=tenant, status=AlertStatus.FIRING)
        return Response(
            {
                "total": certs.count(),
                "expired": certs.filter(not_after__lte=now).count(),
                "expiring_critical": certs.filter(
                    not_after__gt=now, not_after__lte=crit
                ).count(),
                "expiring_warning": certs.filter(
                    not_after__gt=crit, not_after__lte=warn
                ).count(),
                "healthy": certs.filter(not_after__gt=warn).count(),
                "self_signed": certs.filter(self_signed=True).count(),
                "warning_days": limits["warning_days"],
                "critical_days": limits["critical_days"],
                "ssh_host_key_drift": firing.filter(kind="ssh").count(),
                "firing_alerts": firing.count(),
            }
        )

    @action(detail=True, methods=["get"])
    def chain(self, request, pk=None):
        """The issuer chain for this certificate — leaf → intermediate → root.

        Walks ``issuer_certificate`` up from this row within the tenant, capped
        and cycle-guarded. Each hop is the full certificate serialisation so the
        UI can show CN + expiry per link.
        """
        leaf = self.get_object()
        chain, seen, node = [], set(), leaf
        while node is not None and node.pk not in seen and len(chain) < 16:
            seen.add(node.pk)
            chain.append(node)
            node = node.issuer_certificate
        return Response({"chain": self.get_serializer(chain, many=True).data})

    @action(detail=False)
    def authorities(self, request):
        """The tenant's Certificate Authorities — every CA certificate with how
        many certs it has issued and its own expiry, soonest-expiring first."""
        from django.db.models import Count

        tenant = self._tenant_or_403()
        cas = (
            Certificate.objects.filter(tenant=tenant, is_ca=True)
            .annotate(
                binding_count=Count("bindings", distinct=True),
                assignment_count=Count("assignments", distinct=True),
                issued_count=Count("issued_certificates", distinct=True),
            )
            .order_by("not_after", "subject_cn")
        )
        page = self.paginate_queryset(cas)
        data = self.get_serializer(page if page is not None else cas, many=True).data
        # Splice the issued-cert count onto each row (not a model field).
        for row, obj in zip(data, page if page is not None else cas):
            row["issued_count"] = obj.issued_count
        if page is not None:
            return self.get_paginated_response(data)
        return Response(data)

    @action(detail=False, methods=["post"], url_path="import-bundle")
    def import_bundle(self, request):
        """Import every certificate in a PEM bundle — leaf, intermediates, root
        — as its own row, so a whole chain lands at once and its issuer links
        resolve. Body: ``{"pem": "<concatenated PEM>", "name"?, "notes"?}``.
        Public-only: a private-key block anywhere is a clean 400.
        """
        from .certificates import CertificateUploadError
        from .certificates import import_bundle as run_import

        tenant = self._tenant_or_403()
        try:
            result = run_import(
                tenant,
                request.data.get("pem") or "",
                name=(request.data.get("name") or "")[:255],
                notes=request.data.get("notes") or "",
            )
        except CertificateUploadError as exc:
            raise ValidationError({"pem": str(exc)}) from exc
        return Response(
            {
                "created": result.created,
                "existing": result.existing,
                "total": result.total,
                "errors": result.errors,
            }
        )

    def create(self, request, *args, **kwargs):
        """Author a certificate from an uploaded public PEM (dedups by
        fingerprint; refuses a private key with a 400)."""
        from .certificates import CertificateUploadError, upload_certificate

        tenant = self._tenant_or_403()
        upload = CertificateUploadSerializer(data=request.data)
        upload.is_valid(raise_exception=True)
        try:
            row, created = upload_certificate(
                tenant,
                upload.validated_data["pem"],
                name=upload.validated_data.get("name", ""),
                notes=upload.validated_data.get("notes", ""),
            )
        except CertificateUploadError as exc:
            raise ValidationError({"pem": str(exc)}) from exc

        # Re-fetch through the annotated, tenant-scoped queryset so the response
        # carries binding_count / assignment_count like every other read.
        row = self.get_queryset().get(pk=row.pk)
        data = self.get_serializer(row).data
        return Response(data, status=201 if created else 200)


class SSHHostKeyViewSet(TenantScopedViewSet):
    """A device's SSH host keys — tenant-scoped, public data only.

    * **create** is *upload only* — POST ``{device, public_key_line}`` with an
      OpenSSH public-key line; the type/blob/fingerprint are parsed from it, a
      private key or PEM cert is a clean 400, and an existing fingerprint dedups
      (marked uploaded, 200) rather than duplicating.
    * **delete** removes the row (an observed key re-appears on the next poll).
    * **accept-observed** declares an observed key as the expected one, clearing
      any ``ssh_host_key_mismatch`` for that device+type.

    Filters: ``?device=<id>``, ``?origin=observed|uploaded|both``, ``?key_type=``.
    """

    queryset = SSHHostKey.objects.select_related("device").all()
    serializer_class = SSHHostKeySerializer
    parser_classes = [JSONParser, FormParser, MultiPartParser]

    def get_queryset(self):
        qs = super().get_queryset().order_by("device_id", "key_type")
        p = self.request.query_params
        if p.get("device"):
            qs = qs.filter(device_id=p["device"])
        if p.get("key_type"):
            qs = qs.filter(key_type=p["key_type"])
        origin = p.get("origin")
        if origin == "observed":
            qs = qs.filter(observed=True)
        elif origin == "uploaded":
            qs = qs.filter(uploaded=True)
        elif origin == "both":
            qs = qs.filter(observed=True, uploaded=True)
        return qs

    def create(self, request, *args, **kwargs):
        from api.models import Device

        from .ssh_host_keys import HostKeyUploadError, upload_host_key

        tenant = self._tenant_or_403()
        device_id = request.data.get("device")
        line = request.data.get("public_key_line")
        if not device_id:
            raise ValidationError({"device": "This field is required."})
        if not line:
            raise ValidationError({"public_key_line": "This field is required."})
        device = Device.objects.filter(pk=device_id, tenant=tenant).first()
        if device is None:
            raise ValidationError({"device": "Not found in this tenant."})
        try:
            row, created = upload_host_key(tenant, device, line)
        except HostKeyUploadError as exc:
            raise ValidationError({"public_key_line": str(exc)}) from exc
        data = self.get_serializer(row).data
        return Response(data, status=201 if created else 200)

    @action(detail=True, methods=["post"], url_path="accept-observed")
    def accept_observed(self, request, pk=None):
        """Declare this observed host key as expected; clears its mismatch."""
        from .ssh_host_keys import accept_observed

        key = self.get_object()
        accept_observed(key)
        return Response(self.get_serializer(key).data)


class DeviceCredentialViewSet(TenantScopedViewSet):
    """A device's login credentials — each references an externally-stored secret.

    Standard tenant-scoped CRUD (the secret value is never serialised, only its
    provider + path). The extra **reveal** action fetches the actual secret from
    the configured store at call-time — gated on the ``reveal`` RBAC verb (which
    is independent of ``change``: a user who can edit a credential still can't
    reveal it without the verb), re-checks that the caller may view the target
    device, audits the disclosure, and fails closed when no store is enabled.

    Filter: ``?device=<id>``.
    """

    queryset = DeviceCredential.objects.select_related("device").all()
    serializer_class = DeviceCredentialSerializer
    # reveal is its own capability verb; everything else uses the CRUD defaults.
    rbac_action_map = {"reveal": "reveal"}

    def get_queryset(self):
        qs = super().get_queryset()
        device_id = self.request.query_params.get("device")
        if device_id:
            qs = qs.filter(device_id=device_id)
        return qs

    def _validate_device(self, serializer):
        """A credential's device must belong to the active tenant — never trust a
        posted device UUID to be in-tenant (the picker is only a convenience)."""
        tenant = self._tenant_or_403()
        device = serializer.validated_data.get("device")
        if device is not None and device.tenant_id != tenant.id:
            raise ValidationError({"device": "Not found in this tenant."})

    def _pop_secret(self, serializer):
        """Pull the write-only secret material out of validated_data (it is not
        model fields) and return the assembled value dict, or None if nothing was
        supplied. Blanks are dropped so a plain edit doesn't wipe the stored
        secret."""
        vd = serializer.validated_data
        password = vd.pop("password", None)
        private_key = vd.pop("private_key", None)
        passphrase = vd.pop("passphrase", None)
        value = {}
        if password:
            value["password"] = password
        if private_key:
            value["private_key"] = private_key
        if passphrase:
            value["passphrase"] = passphrase
        return value or None

    def _store_secret(self, cred, value):
        """Persist a managed credential's secret, surfacing store errors as 400."""
        from .secret_store import SecretStoreDisabled, SecretStoreError

        if value is None or not cred.secret_managed:
            return
        try:
            cred.store_managed_secret(value)
        except SecretStoreDisabled as exc:
            raise ValidationError({"detail": str(exc)}) from exc
        except SecretStoreError as exc:
            raise ValidationError({"detail": str(exc)}) from exc
        cred.save(update_fields=["secret_path", "secret_provider"])

    def perform_create(self, serializer):
        from django.db import transaction

        self._validate_device(serializer)
        value = self._pop_secret(serializer)
        # Atomic: if writing the managed secret fails (e.g. no store enabled),
        # roll back the row so no orphaned credential is left behind — otherwise
        # a retry collides on the (tenant, device, name) unique constraint.
        with transaction.atomic():
            super().perform_create(serializer)
            self._store_secret(serializer.instance, value)

    def perform_update(self, serializer):
        from django.db import transaction

        self._validate_device(serializer)
        value = self._pop_secret(serializer)
        with transaction.atomic():
            super().perform_update(serializer)
            self._store_secret(serializer.instance, value)

    def _audit_reveal(self, cred):
        """Record who revealed which credential's secret, when — revealing a
        secret writes no model change, so nothing else logs it (mirrors the
        certificate-request key-reveal trail)."""
        from audit.context import current_request_id
        from audit.models import ChangeAction, ChangeLogEntry
        from audit.site_capture import entry_site_id

        u = getattr(self.request, "user", None)
        authed = bool(u and u.is_authenticated)
        ChangeLogEntry.objects.create(
            tenant_id=getattr(cred, "tenant_id", None),
            user=u if authed else None,
            user_name=(u.get_username() if authed else ""),
            action=ChangeAction.REVEAL,
            object_type=cred._meta.label_lower,
            object_label="Device credential",
            object_id=str(cred.pk),
            object_repr=str(cred),
            object_site_id=entry_site_id(cred),
            changes={"revealed": "secret"},
            request_id=current_request_id(),
        )

    @action(detail=True, methods=["post"], url_path="reveal")
    def reveal(self, request, pk=None):
        """Fetch and return the referenced secret. Requires the ``reveal`` verb
        (enforced by ``rbac_action_map`` at both the type and row gates) plus
        view access to the credential's device; audited; fail-closed when no
        secret store is enabled."""
        from .secret_store import SecretStoreDisabled, SecretStoreError

        cred = self.get_object()  # tenant- + reveal-row-scoped already
        tenant = self._tenant_or_403()
        if not rbac.can_act_on(request.user, tenant, "device", "view", cred.device):
            raise PermissionDenied("You do not have access to this credential's device.")
        try:
            secret = cred.resolve_secret()
        except SecretStoreDisabled as exc:
            # No store configured — fail closed with an actionable message.
            raise ValidationError({"detail": str(exc)}) from exc
        except SecretStoreError as exc:
            raise ValidationError({"detail": str(exc)}) from exc
        self._audit_reveal(cred)
        return Response({"secret": secret})


class ConnectProtocolViewSet(TenantScopedViewSet):
    """A tenant's Connect launch templates — plain tenant-scoped CRUD.

    No secret is involved: a protocol is a URL template the Connect menu renders
    client-side. Managing them uses the CRUD verbs; *using* one (the device
    Connect menu) is gated separately on the device ``connect`` verb.

    Filter: ``?enabled=1`` to list only enabled protocols (what a menu shows).
    """

    queryset = ConnectProtocol.objects.prefetch_related("device_types", "roles")
    serializer_class = ConnectProtocolSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        enabled = self.request.query_params.get("enabled")
        if enabled in ("1", "true", "True"):
            qs = qs.filter(enabled=True)
        device_id = self.request.query_params.get("device")
        if device_id:
            qs = self._scope_to_device(qs, device_id)
        return qs

    def _scope_to_device(self, qs, device_id):
        """Only protocols applicable to this device: untargeted ones, plus any
        whose ``device_types`` includes the device's type OR whose ``roles``
        includes its role. The device is tenant-checked; an out-of-tenant or
        missing id yields nothing rather than leaking the whole catalog."""
        from api.models import Device

        tenant = self._tenant_or_403()
        device = Device.objects.filter(pk=device_id, tenant_id=tenant.id).first()
        if device is None:
            return qs.none()
        untargeted = Q(device_types__isnull=True) & Q(roles__isnull=True)
        clauses = untargeted
        if device.device_type_id:
            clauses |= Q(device_types=device.device_type_id)
        if device.role_id:
            clauses |= Q(roles=device.role_id)
        return qs.filter(clauses).distinct()


class CertificateBindingViewSet(TenantScopedReadViewSet):
    """Which endpoints served which certificate — tenant-scoped and read-only.

    This is the "what breaks when it expires" surface: filter by
    ``?certificate=<id>`` for a certificate's blast radius, or by
    ``?target_ip=<id>`` for everything one address has ever presented.

    Bindings are history, so nothing here is deleted when an endpoint stops
    serving a certificate — use ``?stale=1`` / ``?stale=0`` to separate what is
    still being observed from what used to be.
    """

    queryset = CertificateBinding.objects.select_related("certificate", "target_ip")
    serializer_class = CertificateBindingSerializer

    def get_queryset(self):
        from django.utils import timezone

        from .cert_expiry import DEFAULTS

        qs = super().get_queryset()
        params = self.request.query_params

        certificate = params.get("certificate")
        if certificate:
            qs = qs.filter(certificate_id=certificate)
        target_ip = params.get("target_ip")
        if target_ip:
            qs = qs.filter(target_ip_id=target_ip)
        endpoint_key = params.get("endpoint_key")
        if endpoint_key:
            qs = qs.filter(endpoint_key=endpoint_key)
        leaf = params.get("leaf")
        if leaf in ("1", "true"):
            qs = qs.filter(chain_depth=0)
        elif leaf in ("0", "false"):
            qs = qs.filter(chain_depth__gt=0)

        stale = params.get("stale")
        if stale in ("1", "true", "0", "false"):
            tenant = _get_active_tenant(self.request)
            row = None
            if tenant is not None:
                from .models import MonitoringSettings

                row = MonitoringSettings.objects.filter(tenant=tenant).first()
            days = (
                int(row.cert_binding_stale_days) if row else DEFAULTS["stale_days"]
            )
            cutoff = timezone.now() - timedelta(days=days)
            qs = (
                qs.filter(last_seen__lt=cutoff)
                if stale in ("1", "true")
                else qs.filter(last_seen__gte=cutoff)
            )
        return qs


class CertificateAssignmentViewSet(TenantScopedViewSet):
    """Declare which object should present a certificate — the intent a drift
    check compares against. Writable, tenant-scoped, default-closed.

    Filter by ``?certificate=<id>`` (a certificate's declared objects),
    ``?object_type=&?object_id=`` (an object's declared certificates), so a
    device/IP detail page can list what it's supposed to serve.

    The generic ``(object_type, object_id)`` target is validated to exist **in
    the active tenant** on create and update — mirroring ``ContactAssignment`` —
    so a certificate can never be attached to another tenant's object.
    """

    queryset = CertificateAssignment.objects.select_related("certificate")
    serializer_class = CertificateAssignmentSerializer
    # accept_served creates/replaces an assignment, so it needs an `add` grant —
    # not the default `change` a custom action would otherwise demand.
    rbac_action_map = {"accept_served": "add"}

    def get_queryset(self):
        qs = super().get_queryset()
        params = self.request.query_params if self.request else {}
        certificate = params.get("certificate")
        if certificate:
            qs = qs.filter(certificate_id=certificate)
        ot = params.get("object_type")
        if ot:
            qs = qs.filter(object_type=ot.strip().lower())
        oid = params.get("object_id")
        if oid:
            qs = qs.filter(object_id=str(oid))
        return qs

    def _check_certificate_tenant(self, serializer):
        """The referenced certificate must belong to the active tenant."""
        cert = serializer.validated_data.get("certificate") or (
            serializer.instance.certificate if serializer.instance else None
        )
        if cert is not None and cert.tenant_id != self._tenant_or_403().id:
            raise ValidationError({"certificate": "Not found in this tenant."})

    def _check_target(self, serializer):
        """The generic ``(object_type, object_id)`` target must belong to the
        active tenant — otherwise a certificate could be declared on another
        tenant's object (cross-tenant reference)."""
        from django.apps import apps

        ot = serializer.validated_data.get("object_type") or (
            serializer.instance.object_type if serializer.instance else None
        )
        oid = serializer.validated_data.get("object_id") or (
            serializer.instance.object_id if serializer.instance else None
        )
        if not ot or not oid:
            return
        tenant = self._tenant_or_403()
        if ot == "core.tenant":
            if str(oid) != str(tenant.id):
                raise ValidationError({"object_id": "Not found in this tenant."})
            return
        # Stored as "app.model"; the app label may be omitted for api models.
        parts = ot.split(".")
        app_label, model_name = ("api", parts[0]) if len(parts) == 1 else parts
        try:
            model = apps.get_model(app_label, model_name)
        except (LookupError, ValueError):
            raise ValidationError({"object_type": "Unknown object type."}) from None
        if not model.objects.filter(pk=oid, tenant=tenant).exists():
            raise ValidationError({"object_id": "Not found in this tenant."})

    def perform_create(self, serializer):
        self._check_certificate_tenant(serializer)
        self._check_target(serializer)
        super().perform_create(serializer)
        self._reevaluate_sot_expiry()

    def perform_update(self, serializer):
        self._check_certificate_tenant(serializer)
        self._check_target(serializer)
        super().perform_update(serializer)
        self._reevaluate_sot_expiry()

    def perform_destroy(self, instance):
        super().perform_destroy(instance)
        self._reevaluate_sot_expiry()

    def _reevaluate_sot_expiry(self):
        """Fire the source-of-truth expiry pass now, so assigning/unassigning a
        declared cert opens or resolves its expiry alert immediately instead of
        waiting for the nightly sweep. Best-effort — never breaks the write."""
        from .cert_expiry import evaluate_sot_expiry

        try:
            tenant = self._tenant_or_403()
            evaluate_sot_expiry(tenant_ids=[tenant.id])
        except Exception:  # noqa: BLE001
            logger.exception("reactive SoT cert expiry evaluation failed")

    @action(detail=False, methods=["post"], url_path="accept-served")
    def accept_served(self, request):
        """Accept a ``cert_mismatch`` drift: declare the served certificate on
        the endpoint's IP, so intent matches reality (the observe→accept pattern).

        Body: ``{"binding": "<CertificateBinding id>"}``. Creates/replaces the
        IP-level assignment and re-evaluates the endpoint (the alert clears at
        once). Requires an ``add`` grant on certificate assignments.
        """
        from .cert_drift import accept_cert_mismatch

        tenant = self._tenant_or_403()
        binding_id = request.data.get("binding")
        if not binding_id:
            raise ValidationError({"binding": "This field is required."})
        binding = (
            CertificateBinding.objects.filter(tenant=tenant, pk=binding_id)
            .select_related("certificate", "target_ip")
            .first()
        )
        if binding is None:
            raise ValidationError({"binding": "Not found in this tenant."})
        try:
            assignment = accept_cert_mismatch(
                tenant, binding, notes=request.data.get("notes", "")[:255]
            )
        except ValueError as exc:
            raise ValidationError({"binding": str(exc)}) from exc
        return Response(self.get_serializer(assignment).data, status=201)


class CertificateRequestViewSet(TenantScopedViewSet):
    """Certificate signing requests — Danbyte generates the key + CSR.

    * **create** generates a key pair and CSR from the posted subject/SANs/key
      spec, stores the private key in the secret store, and returns the CSR plus
      the private key **once** (the caller's only chance to receive it inline).
      Disabled with a 400 when no secret store is enabled (fail closed).
    * **csr** downloads the public CSR; **private-key** re-fetches the stored key
      (change grant); **import-issued** attaches the CA-signed certificate.
    * **delete** removes the request and its stored private key.
    """

    queryset = CertificateRequest.objects.select_related(
        "issued_certificate", "created_by"
    )
    serializer_class = CertificateRequestSerializer
    # create defaults to `add`; the key-revealing + issue actions need `change`,
    # and downloading the public CSR is a read.
    rbac_action_map = {
        "csr": "view",
        "private_key": "change",
        "import_issued": "change",
        "acme_order": "change",
        "acme_finalize": "change",
        "acme_issue": "change",
    }

    def get_queryset(self):
        qs = super().get_queryset()
        status_f = self.request.query_params.get("status")
        if status_f:
            qs = qs.filter(status=status_f)
        return qs

    def _audit_key_reveal(self, req):
        """Leave a trail whenever stored private-key material is handed out —
        who, which request, when (revealing a secret writes no model change, so
        nothing else logs it)."""
        from audit.context import current_request_id
        from audit.models import ChangeAction, ChangeLogEntry
        from audit.site_capture import entry_site_id

        u = getattr(self.request, "user", None)
        authed = bool(u and u.is_authenticated)
        ChangeLogEntry.objects.create(
            tenant_id=getattr(req, "tenant_id", None),
            user=u if authed else None,
            user_name=(u.get_username() if authed else ""),
            action=ChangeAction.REVEAL,
            object_type=req._meta.label_lower,
            object_label="Certificate request",
            object_id=str(req.pk),
            object_repr=str(req),
            object_site_id=entry_site_id(req),
            changes={"revealed": "private_key"},
            request_id=current_request_id(),
        )

    def create(self, request, *args, **kwargs):
        from .csr import CsrError, generate
        from .secret_store import SecretStoreDisabled, SecretStoreError

        tenant = self._tenant_or_403()
        d = request.data
        try:
            req, private_key = generate(
                tenant=tenant,
                user=request.user,
                common_name=d.get("common_name") or "",
                organization=d.get("organization") or "",
                organizational_unit=d.get("organizational_unit") or "",
                country=d.get("country") or "",
                state=d.get("state") or "",
                locality=d.get("locality") or "",
                san_dns=d.get("san_dns") or [],
                san_ip=d.get("san_ip") or [],
                key_spec=d.get("key_spec") or "rsa-2048",
                notes=d.get("notes") or "",
            )
        except SecretStoreDisabled as exc:
            raise ValidationError({"detail": str(exc)}) from exc
        except SecretStoreError as exc:
            # Store enabled but the write failed (e.g. Vault unreachable). The
            # row rolled back in generate(); surface an actionable 400, not a 500.
            raise ValidationError({"detail": str(exc)}) from exc
        except CsrError as exc:
            raise ValidationError({"detail": str(exc)}) from exc
        data = self.get_serializer(req).data
        # The private key is returned exactly once — it is not stored on the row
        # and this response is the operator's chance to save it locally.
        data["private_key"] = private_key
        self._audit_key_reveal(req)
        return Response(data, status=201)

    @action(detail=True, methods=["get"])
    def csr(self, request, pk=None):
        req = self.get_object()
        return Response({"csr_pem": req.csr_pem})

    @action(detail=True, methods=["get"], url_path="private-key")
    def private_key(self, request, pk=None):
        from .csr import get_private_key
        from .secret_store import SecretStoreDisabled

        req = self.get_object()
        try:
            key = get_private_key(req)
        except SecretStoreDisabled as exc:
            raise ValidationError({"detail": str(exc)}) from exc
        if not key:
            raise ValidationError(
                {"detail": "The private key is no longer available for this request."}
            )
        self._audit_key_reveal(req)
        return Response({"private_key": key})

    @action(detail=True, methods=["post"], url_path="import-issued")
    def import_issued(self, request, pk=None):
        from .csr import CsrError, import_issued

        req = self.get_object()
        try:
            cert = import_issued(req, request.data.get("pem") or "")
        except CsrError as exc:
            raise ValidationError({"pem": str(exc)}) from exc
        req.refresh_from_db()
        data = self.get_serializer(req).data
        data["issued_certificate_id"] = str(cert.id)
        return Response(data, status=201)

    @action(detail=True, methods=["post"], url_path="acme-order")
    def acme_order(self, request, pk=None):
        """Open an ACME order for this request against an issuer.

        Creates the :class:`AcmeOrder`, calls the CA's newOrder, and returns the
        order with the challenges the operator (or a publisher) must satisfy. The
        issuer is looked up scoped to the active tenant — a cross-tenant issuer id
        can't be used.
        """
        from .acme_engine import AcmeError, create_order
        from .secret_store import SecretStoreDisabled

        req = self.get_object()
        tenant = self._tenant_or_403()
        issuer = Issuer.objects.filter(
            tenant=tenant, id=request.data.get("issuer")
        ).first()
        if issuer is None:
            raise ValidationError({"issuer": "Unknown issuer for this tenant."})
        challenge_type = request.data.get("challenge_type") or AcmeOrder.Challenge.DNS01
        if challenge_type not in AcmeOrder.Challenge.values:
            raise ValidationError({"challenge_type": "Unknown challenge type."})

        order = AcmeOrder(
            tenant=tenant,
            issuer=issuer,
            request=req,
            challenge_type=challenge_type,
            created_by=(
                request.user
                if getattr(request.user, "is_authenticated", False)
                else None
            ),
        )
        order.save()
        try:
            create_order(order)
        except SecretStoreDisabled as exc:
            order.delete()
            raise ValidationError({"detail": str(exc)}) from exc
        except AcmeError as exc:
            order.status = AcmeOrder.Status.ERRORED
            order.error = str(exc)
            order.save(update_fields=["status", "error", "updated_at"])
            raise ValidationError({"detail": str(exc)}) from exc
        return Response(AcmeOrderSerializer(order).data, status=201)

    @action(detail=True, methods=["post"], url_path="acme-finalize")
    def acme_finalize(self, request, pk=None):
        """Finalize a previously opened ACME order (challenges now published).

        Runs asynchronously (it polls the CA) — enqueues the finalize job and
        returns the order at its current state. The order must belong to this
        request and tenant.
        """
        import django_rq

        req = self.get_object()
        tenant = self._tenant_or_403()
        order = AcmeOrder.objects.filter(
            tenant=tenant, request=req, id=request.data.get("order")
        ).first()
        if order is None:
            raise ValidationError({"order": "Unknown order for this request."})
        if not order.order_url:
            raise ValidationError(
                {"order": "This order was never opened — create it first."}
            )
        order.status = AcmeOrder.Status.PROCESSING
        order.error = ""
        order.save(update_fields=["status", "error", "updated_at"])
        try:
            django_rq.get_queue("default").enqueue(
                "monitoring.acme_engine.finalize_order_job", str(order.id)
            )
        except Exception as exc:  # noqa: BLE001 — Redis down: report, don't 500
            raise ValidationError(
                {"detail": f"Could not enqueue the issuance job: {exc}"}
            ) from exc
        return Response(AcmeOrderSerializer(order).data, status=202)

    @action(detail=True, methods=["post"], url_path="acme-issue")
    def acme_issue(self, request, pk=None):
        """Fully-automated issuance: open the order, auto-publish the DNS-01
        challenge, finalize, and import — all on the worker queue.

        Requires the issuer to have a DNS-01 auto-publisher configured; without
        one, use ``acme-order`` + ``acme-finalize`` (operator-published).
        """
        import django_rq

        req = self.get_object()
        tenant = self._tenant_or_403()
        issuer = Issuer.objects.filter(
            tenant=tenant, id=request.data.get("issuer")
        ).first()
        if issuer is None:
            raise ValidationError({"issuer": "Unknown issuer for this tenant."})
        if not issuer.dns_provider:
            raise ValidationError(
                {
                    "issuer": "This issuer has no DNS-01 auto-publisher configured. "
                    "Use an order + manual publish, or configure DNS auto-publish."
                }
            )
        order = AcmeOrder(
            tenant=tenant,
            issuer=issuer,
            request=req,
            challenge_type=AcmeOrder.Challenge.DNS01,
            status=AcmeOrder.Status.PROCESSING,
            created_by=(
                request.user
                if getattr(request.user, "is_authenticated", False)
                else None
            ),
        )
        order.save()
        try:
            django_rq.get_queue("default").enqueue(
                "monitoring.acme_engine.issue_order_job", str(order.id)
            )
        except Exception as exc:  # noqa: BLE001 — Redis down: report, don't 500
            order.delete()
            raise ValidationError(
                {"detail": f"Could not enqueue the issuance job: {exc}"}
            ) from exc
        return Response(AcmeOrderSerializer(order).data, status=202)

    def perform_destroy(self, instance):
        from .csr import delete_key

        delete_key(instance)
        super().perform_destroy(instance)


class IssuerViewSet(TenantScopedViewSet):
    """External CA connectors (ACME directories). The EAB HMAC is write-only and
    stored encrypted; the ACME account key never leaves the secret store."""

    queryset = Issuer.objects.all()
    serializer_class = IssuerSerializer
    # Registering the ACME account mutates the issuer (stores the account key +
    # URI), so it needs `change`, not the default read.
    rbac_action_map = {"register_account": "change"}

    def perform_create(self, serializer):
        serializer.save(
            tenant=self._tenant_or_403(),
            created_by=(
                self.request.user
                if getattr(self.request.user, "is_authenticated", False)
                else None
            ),
        )

    @action(detail=True, methods=["post"], url_path="register-account")
    def register_account(self, request, pk=None):
        """Create (or re-register) the issuer's ACME account and store its key.

        Synchronous — it is a handful of round trips and the operator wants the
        success/failure immediately. Fail-closed if no secret store is enabled.
        """
        from .acme_engine import AcmeError, register_account
        from .secret_store import SecretStoreDisabled

        issuer = self.get_object()
        try:
            uri = register_account(issuer)
        except SecretStoreDisabled as exc:
            raise ValidationError({"detail": str(exc)}) from exc
        except AcmeError as exc:
            raise ValidationError({"detail": str(exc)}) from exc
        return Response({"account_uri": uri, **self.get_serializer(issuer).data})


class AcmeOrderViewSet(TenantScopedReadViewSet):
    """ACME issuance orders — read-only here; created and driven by the ACME
    engine. Filter with ``?issuer=`` / ``?request=`` / ``?status=``."""

    queryset = AcmeOrder.objects.select_related(
        "issuer", "request", "issued_certificate"
    )
    serializer_class = AcmeOrderSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        for field in ("issuer", "request", "status"):
            if p.get(field):
                qs = qs.filter(**{field: p[field]})
        return qs


class SnmpSensorViewSet(TenantScopedViewSet):
    queryset = SnmpSensor.objects.select_related("device_type").order_by("name")
    serializer_class = SnmpSensorSerializer

    # A sensor is a portable definition — an OID, a value map, a naming rule —
    # with no secrets and no per-device state, which is exactly what makes it
    # worth moving between deployments. Version the envelope so a future shape
    # change can be detected rather than silently mis-imported.
    PACK_VERSION = 1
    # Importing creates sensors, so it demands `add`; overwriting an existing
    # one is a change and checked separately below. Without this the shared
    # mapping would let an add-only grant replace a tuned definition.
    rbac_action_map = {"import_pack": "add"}
    PACK_FIELDS = (
        "name", "slug", "description", "oid", "walk", "item_kind",
        "name_template", "value_map", "absent_status", "apply_mode", "enabled",
    )

    def get_queryset(self):
        qs = super().get_queryset()
        dt = self.request.query_params.get("device_type")
        if dt:
            # A device's applicable sensors: this type or all-types.
            from django.db.models import Q

            if dt == "none":
                qs = qs.filter(device_type__isnull=True)
            else:
                qs = qs.filter(Q(device_type__isnull=True) | Q(device_type_id=dt))
        # `only=1` narrows to sensors bound to exactly this type — the device
        # TYPE page manages its own, where inheriting the all-types rows would
        # invite editing a shared definition by accident.
        only = self.request.query_params.get("device_type_only")
        if only:
            qs = qs.filter(device_type_id=only)
        return qs

    @action(detail=False, methods=["get"])
    def export(self, request):
        """The tenant's sensors as a portable JSON pack.

        Device types travel as their NAME, not their id: ids are per-deployment,
        names are what a human recognises on the far side. A sensor bound to a
        type Danbyte doesn't have on import stays unbound rather than failing the
        whole pack.
        """
        qs = self.filter_queryset(self.get_queryset())
        sensors = []
        for s in qs:
            row = {f: getattr(s, f) for f in self.PACK_FIELDS}
            row["device_type_name"] = s.device_type.name if s.device_type_id else None
            sensors.append(row)
        return Response({
            "danbyte_snmp_sensor_pack": self.PACK_VERSION,
            "count": len(sensors),
            "sensors": sensors,
        })

    @action(detail=False, methods=["post"], url_path="import")
    def import_pack(self, request, *args, **kwargs):
        """Load a pack exported here or hand-written.

        Matched by `slug` within the tenant: re-importing updates in place
        instead of piling up duplicates. `?replace=0` (the default) skips a slug
        that already exists so an import can't quietly rewrite a sensor someone
        tuned; `?replace=1` updates it.
        """
        from api.models import DeviceType

        tenant = self._tenant_or_403()
        payload = request.data if isinstance(request.data, dict) else {}
        version = payload.get("danbyte_snmp_sensor_pack")
        if version is None:
            raise ValidationError(
                {"danbyte_snmp_sensor_pack": "Not a sensor pack — the key is missing."}
            )
        if version != self.PACK_VERSION:
            raise ValidationError({
                "danbyte_snmp_sensor_pack":
                    f"Pack version {version} isn't supported (this build reads "
                    f"{self.PACK_VERSION}).",
            })
        rows = payload.get("sensors")
        if not isinstance(rows, list):
            raise ValidationError({"sensors": "Expected a list of sensors."})

        replace = str(request.query_params.get("replace", "")).lower() in (
            "1", "true", "yes",
        )
        if replace and not (
            request.user.is_superuser
            or rbac.has_action(request.user, tenant, "snmpsensor", "change")
        ):
            raise PermissionDenied(
                "Overwriting existing sensors needs change access; import "
                "without ?replace=1 to add only the new ones."
            )
        # Resolved once, and only within this tenant — a pack naming another
        # tenant's device type must not reach across.
        types = {
            name.strip().lower(): pk
            for pk, name in DeviceType.objects.filter(tenant=tenant).values_list(
                "id", "name"
            )
        }
        created, updated, skipped, unbound, errors = 0, 0, 0, [], []
        for i, row in enumerate(rows):
            if not isinstance(row, dict):
                errors.append({"index": i, "error": "Not an object."})
                continue
            data = {f: row.get(f) for f in self.PACK_FIELDS if f in row}
            dt_name = row.get("device_type_name")
            if dt_name:
                pk = types.get(str(dt_name).strip().lower())
                if pk is None:
                    # Keep the sensor, lose the binding, say so — better than
                    # dropping a definition the user can rebind in one click.
                    unbound.append(dt_name)
                data["device_type"] = pk
            else:
                data["device_type"] = None

            slug = (data.get("slug") or "").strip()
            existing = (
                SnmpSensor.objects.filter(tenant=tenant, slug=slug).first()
                if slug else None
            )
            if existing and not replace:
                skipped += 1
                continue
            ser = self.get_serializer(existing, data=data, partial=bool(existing))
            if not ser.is_valid():
                errors.append({
                    "index": i, "name": row.get("name"), "error": ser.errors,
                })
                continue
            ser.save(tenant=tenant)
            if existing:
                updated += 1
            else:
                created += 1
        return Response({
            "created": created, "updated": updated, "skipped": skipped,
            "unbound_device_types": sorted(set(unbound)),
            "errors": errors,
        })


class CheckTemplateViewSet(TenantScopedViewSet):
    queryset = CheckTemplate.objects.all().order_by("name")
    serializer_class = CheckTemplateSerializer

    def get_queryset(self):
        from django.db.models import Count

        qs = super().get_queryset().annotate(assignment_count=Count("assignments"))
        kind = self.request.query_params.get("kind")
        if kind:
            qs = qs.filter(kind=kind)
        return qs


class _TargetScopedConfigurationMixin:
    """Scope polymorphic monitoring configuration through its inventory target.

    These models have no single ORM site path, so their ObjectPermission site
    scope cannot be expressed in ``SITE_PATHS``. Compose each granting
    permission's constraints with a model-specific target-site predicate here,
    then intersect it with the target rows the caller may view.
    """

    def _site_target_q(self, site_ids) -> Q:
        raise NotImplementedError

    def _filter_visible_targets(self, qs, tenant, user):
        raise NotImplementedError

    def _scope_configuration_queryset(self, qs, action: str | None = None):
        from auth_api import rbac
        from auth_api.drf import _action_for

        tenant = _get_active_tenant(self.request)
        if tenant is None:
            return qs.none()
        user = self.request.user
        action = action or _action_for(self, self.request)

        if not user.is_superuser:
            slug = qs.model._meta.model_name
            grant_q = None
            grant_opens_all = False
            for perm in rbac._granting_perms(user, tenant, slug, action):
                # Reuse the canonical constraint parser, but map the permission's
                # sites through this configuration model's effective target.
                permission_q = rbac._perm_q(perm, None, action)
                site_ids = [site.pk for site in perm.sites.all()]
                if site_ids:
                    permission_q &= self._site_target_q(site_ids)
                if not permission_q:
                    grant_opens_all = True
                    break
                grant_q = permission_q if grant_q is None else grant_q | permission_q
            if not grant_opens_all:
                if grant_q is None:
                    return qs.none()
                try:
                    qs = qs.filter(grant_q)
                except FieldError:
                    return qs.none()

        return self._filter_visible_targets(qs, tenant, user).distinct()

    def _assert_saved_configuration_scope(self, instance, action: str):
        tenant = self._tenant_or_403()
        base = type(instance)._default_manager.filter(pk=instance.pk, tenant=tenant)
        if not self._scope_configuration_queryset(base, action=action).exists():
            raise PermissionDenied(
                "The configuration target is outside your tenant or site scope."
            )

    @staticmethod
    def _effective_value(serializer, field_name, *, many=False):
        if field_name in serializer.validated_data:
            return serializer.validated_data[field_name]
        instance = serializer.instance
        if instance is None:
            return [] if many else None
        value = getattr(instance, field_name)
        return list(value.all()) if many else value


class CheckAssignmentViewSet(_TargetScopedConfigurationMixin, TenantScopedViewSet):
    queryset = (
        CheckAssignment.objects.select_related("template", "ip_address", "prefix")
        .prefetch_related("exclusions")
        .all()
    )
    serializer_class = CheckAssignmentSerializer

    def _site_target_q(self, site_ids):
        return Q(ip_address__site_id__in=site_ids) | Q(prefix__site_id__in=site_ids)

    def _filter_visible_targets(self, qs, tenant, user):
        from api.models import IPAddress, Prefix
        from auth_api import rbac

        visible_ips = rbac.restrict_queryset(
            IPAddress.objects.filter(tenant=tenant), user, tenant, "ipaddress", "view"
        ).values("pk")
        visible_prefixes = rbac.restrict_queryset(
            Prefix.objects.filter(tenant=tenant), user, tenant, "prefix", "view"
        ).values("pk")
        inaccessible_exclusion = IPAddress.objects.filter(
            check_assignment_exclusions=OuterRef("pk")
        ).exclude(pk__in=visible_ips)
        return (
            qs.filter(
                Q(ip_address_id__in=visible_ips) | Q(prefix_id__in=visible_prefixes)
            )
            .annotate(_has_inaccessible_exclusion=Exists(inaccessible_exclusion))
            .filter(_has_inaccessible_exclusion=False)
        )

    def get_queryset(self):
        qs = self._scope_configuration_queryset(super().get_queryset())
        for key, field in (("ip", "ip_address_id"), ("prefix", "prefix_id"),
                           ("template", "template_id")):
            v = self.request.query_params.get(key)
            if v:
                qs = qs.filter(**{field: v})
        return qs

    def _validate_targets(self, serializer):
        """Every target the assignment references — the IP/prefix it monitors,
        its template, and each exclusion IP — must be in the caller's row/site
        VIEW scope, not merely the same tenant. Otherwise a Site-A user could
        attach a check to a Site-B IP/prefix, and the ``exclusions`` list (which
        was queryset=IPAddress.objects.all()) could pull in a foreign-tenant IP
        by id entirely unchecked."""
        from auth_api import rbac

        tenant = self._tenant_or_403()
        user = self.request.user
        ip = self._effective_value(serializer, "ip_address")
        prefix = self._effective_value(serializer, "prefix")
        template = self._effective_value(serializer, "template")
        exclusions = self._effective_value(serializer, "exclusions", many=True) or []
        if template is not None and template.tenant_id != tenant.id:
            raise ValidationError({"template": "Not in the active tenant."})
        # Tenant ownership is absolute (rejected even for superusers); site scope
        # is the extra row-level gate for non-superusers.
        if ip is not None:
            if ip.tenant_id != tenant.id:
                raise ValidationError({"ip_address": "Not in the active tenant."})
            if not rbac.can_act_on(user, tenant, "ipaddress", "view", ip):
                raise ValidationError({"ip_address": "Not in your scope."})
        if prefix is not None:
            if prefix.tenant_id != tenant.id:
                raise ValidationError({"prefix": "Not in the active tenant."})
            if not rbac.can_act_on(user, tenant, "prefix", "view", prefix):
                raise ValidationError({"prefix": "Not in your scope."})
        for ex in exclusions:
            if ex.tenant_id != tenant.id:
                raise ValidationError(
                    {"exclusions": "Contains an IP from another tenant."}
                )
            if not rbac.can_act_on(user, tenant, "ipaddress", "view", ex):
                raise ValidationError(
                    {"exclusions": "Contains an IP outside your scope."}
                )

    def perform_create(self, serializer):
        self._validate_targets(serializer)
        super().perform_create(serializer)
        self._assert_saved_configuration_scope(serializer.instance, "add")

    def perform_update(self, serializer):
        self._validate_targets(serializer)
        super().perform_update(serializer)
        self._assert_saved_configuration_scope(serializer.instance, "change")


def _assert_tenant_objects(tenant, **objects):
    for name, value in objects.items():
        if value is None:
            continue
        values = value if isinstance(value, (list, tuple)) else [value]
        for obj in values:
            if hasattr(obj, "tenant_id") and obj.tenant_id != tenant.id:
                raise ValidationError({name: "Not in the active tenant."})


class MonitoringProfileViewSet(TenantScopedViewSet):
    queryset = MonitoringProfile.objects.prefetch_related("templates").all().order_by("name")
    serializer_class = MonitoringProfileSerializer

    def _validate_tenant(self, serializer):
        tenant = self._tenant_or_403()
        _assert_tenant_objects(
            tenant,
            templates=list(serializer.validated_data.get("templates", [])),
        )

    def perform_create(self, serializer):
        self._validate_tenant(serializer)
        super().perform_create(serializer)

    def perform_update(self, serializer):
        self._validate_tenant(serializer)
        serializer.save()


class MonitoringPolicyViewSet(_TargetScopedConfigurationMixin, TenantScopedViewSet):
    queryset = (
        MonitoringPolicy.objects.select_related(
            "vrf", "device_type", "device_role", "device", "prefix"
        )
        .prefetch_related("profiles", "templates")
        .all()
    )
    serializer_class = MonitoringPolicySerializer

    _TARGET_FIELDS = ("vrf", "device_type", "device_role", "device", "prefix")

    def _site_target_q(self, site_ids):
        from core.effective_settings import separation_enabled

        q = (
            Q(scope=MonitoringPolicy.SCOPE_DEVICE, device__site_id__in=site_ids)
            | Q(scope=MonitoringPolicy.SCOPE_PREFIX, prefix__site_id__in=site_ids)
        )
        if separation_enabled(_get_active_tenant(self.request)):
            q |= Q(
                scope=MonitoringPolicy.SCOPE_VRF,
                vrf__owning_site_id__in=site_ids,
            ) | Q(
                scope=MonitoringPolicy.SCOPE_DEVICE_TYPE,
                device_type__owning_site_id__in=site_ids,
            )
        # Global and device-role policies, plus policies on global catalog rows,
        # can affect every site and therefore require a site-unscoped grant.
        return q

    def _filter_visible_targets(self, qs, tenant, user):
        from api.models import Device, DeviceRole, DeviceType, Prefix, VRF
        from auth_api import rbac

        target_models = {
            "vrf": (VRF, "vrf"),
            "device_type": (DeviceType, "devicetype"),
            "device_role": (DeviceRole, "devicerole"),
            "device": (Device, "device"),
            "prefix": (Prefix, "prefix"),
        }
        visible = {
            field: rbac.restrict_queryset(
                model.objects.filter(tenant=tenant), user, tenant, slug, "view"
            ).values("pk")
            for field, (model, slug) in target_models.items()
        }

        global_q = Q(scope=MonitoringPolicy.SCOPE_GLOBAL)
        for field in self._TARGET_FIELDS:
            global_q &= Q(**{f"{field}__isnull": True})
        visibility_q = global_q
        for field in self._TARGET_FIELDS:
            scope_q = Q(scope=field, **{f"{field}_id__in": visible[field]})
            for other in self._TARGET_FIELDS:
                if other != field:
                    scope_q &= Q(**{f"{other}__isnull": True})
            visibility_q |= scope_q
        return qs.filter(visibility_q)

    def get_queryset(self):
        qs = self._scope_configuration_queryset(super().get_queryset())
        scope = self.request.query_params.get("scope")
        if scope:
            qs = qs.filter(scope=scope)
        for key in ("vrf", "device_type", "device_role", "device", "prefix"):
            value = self.request.query_params.get(key)
            if value:
                qs = qs.filter(**{f"{key}_id": value})
        return qs

    def _validate_tenant(self, serializer):
        from auth_api import rbac

        tenant = self._tenant_or_403()
        _assert_tenant_objects(
            tenant,
            vrf=self._effective_value(serializer, "vrf"),
            device_type=self._effective_value(serializer, "device_type"),
            device_role=self._effective_value(serializer, "device_role"),
            device=self._effective_value(serializer, "device"),
            prefix=self._effective_value(serializer, "prefix"),
            profiles=list(serializer.validated_data.get("profiles", [])),
            templates=list(serializer.validated_data.get("templates", [])),
        )
        targets = {
            "vrf": ("vrf", self._effective_value(serializer, "vrf")),
            "device_type": (
                "devicetype",
                self._effective_value(serializer, "device_type"),
            ),
            "device_role": (
                "devicerole",
                self._effective_value(serializer, "device_role"),
            ),
            "device": ("device", self._effective_value(serializer, "device")),
            "prefix": ("prefix", self._effective_value(serializer, "prefix")),
        }
        for field, (slug, target) in targets.items():
            if target is not None and not rbac.can_act_on(
                self.request.user, tenant, slug, "view", target
            ):
                raise ValidationError({field: "Not in your scope."})

    def perform_create(self, serializer):
        self._validate_tenant(serializer)
        super().perform_create(serializer)
        self._assert_saved_configuration_scope(serializer.instance, "add")

    def perform_update(self, serializer):
        self._validate_tenant(serializer)
        serializer.save()
        self._assert_saved_configuration_scope(serializer.instance, "change")


class MonitoringDenySubnetViewSet(TenantScopedViewSet):
    queryset = MonitoringDenySubnet.objects.select_related("vrf").all().order_by("cidr")
    serializer_class = MonitoringDenySubnetSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        vrf = self.request.query_params.get("vrf")
        if vrf:
            qs = qs.filter(vrf_id=vrf)
        return qs

    def _validate_tenant(self, serializer):
        tenant = self._tenant_or_403()
        _assert_tenant_objects(tenant, vrf=serializer.validated_data.get("vrf"))

    def perform_create(self, serializer):
        self._validate_tenant(serializer)
        super().perform_create(serializer)

    def perform_update(self, serializer):
        self._validate_tenant(serializer)
        serializer.save()


class NotificationChannelViewSet(TenantScopedViewSet):
    queryset = NotificationChannel.objects.all().order_by("name")
    serializer_class = NotificationChannelSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        # Auto-created per-prefix/IP watch channels are managed from the
        # prefix/IP page + the Notifications "for you" view — keep them out of
        # the manual channel list unless explicitly asked for.
        if self.request.query_params.get("auto") != "1":
            qs = qs.filter(auto_created=False)
        return qs

    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        """Send a synthetic test alert through this channel."""
        from rest_framework.response import Response

        from .notify import send_test

        channel = self.get_object()
        try:
            send_test(channel)
        except Exception as exc:  # noqa: BLE001 — surface the transport error
            return Response({"ok": False, "error": str(exc)}, status=502)
        return Response({"ok": True})


class NotificationSubscriptionViewSet(TenantScopedViewSet):
    """Admin CRUD for channel subscriptions — a user or a group attached to a
    channel. Tenant-scoped + RBAC via the registered object type. Ordinary users
    manage their own via the self-service endpoints below, not this viewset."""

    queryset = NotificationSubscription.objects.select_related(
        "channel", "user", "group"
    ).order_by("channel__name")
    serializer_class = NotificationSubscriptionSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        channel = self.request.query_params.get("channel")
        if channel:
            qs = qs.filter(channel_id=channel)
        # Per-prefix/IP watch subscriptions (on auto channels) are personal and
        # numerous — keep them out of the admin overview unless asked for.
        elif self.request.query_params.get("auto") != "1":
            qs = qs.filter(channel__auto_created=False)
        return qs

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        channel = serializer.validated_data.get("channel")
        if channel is None or channel.tenant_id != tenant.id:
            raise ValidationError({"channel": "Channel is not in this tenant."})
        serializer.save(tenant=tenant, created_by=self.request.user)


def _channel_summary(ch) -> dict:
    """The compact channel shape the Notifications page shows for each row —
    including the monitored object so the UI can deep-link to it."""
    scope_kind = scope_id = scope_label = None
    if ch.match_ip_id:
        scope_kind, scope_id = "ip", str(ch.match_ip_id)
        scope_label = str(ch.match_ip.ip_address)
    elif ch.match_prefix_id:
        scope_kind, scope_id = "prefix", str(ch.match_prefix_id)
        scope_label = ch.match_prefix.cidr
    return {
        "id": str(ch.id),
        "name": ch.name,
        "kind": ch.kind,
        "min_severity": ch.min_severity,
        "on_statuses": ch.on_statuses or [],
        "send_status_changes": ch.send_status_changes,
        "status_change_mode": ch.status_change_mode,
        "match_prefix_cidr": scope_label if scope_kind == "prefix" else None,
        "scope_kind": scope_kind,
        "scope_id": scope_id,
        "scope_label": scope_label,
    }


def _can_subscribe(user, tenant) -> bool:
    return rbac.has_action(user, tenant, "notificationchannel", "subscribe")


@api_view(["GET"])
@permission_classes([permissions.IsAuthenticated])
def notifications_me(request):
    """What the current user is signed up for (their own + their groups'
    subscriptions, plus any channel that lists their address directly), and the
    self-subscribable channels they could join. Visible to any signed-in user;
    the ``subscribe`` permission only gates whether they can act."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")
    user = request.user
    can_sub = _can_subscribe(user, tenant)
    group_ids = list(user.groups.values_list("id", flat=True))
    subs = (
        NotificationSubscription.objects.filter(tenant=tenant)
        .select_related(
            "channel", "channel__match_prefix", "channel__match_ip", "group"
        )
        .filter(Q(user=user) | Q(group_id__in=group_ids))
    )
    rows, subscribed_ids = [], set()
    for s in subs:
        subscribed_ids.add(s.channel_id)
        if s.user_id == user.id:
            source = "assigned" if s.mandatory else "self"
        else:
            source = f"group:{s.group.name}"
        rows.append({
            "channel": _channel_summary(s.channel),
            "source": source,
            "mandatory": s.mandatory,
            "can_unsubscribe": source == "self" and can_sub,
        })
    # Channels that list the user's address directly in config.recipients — shown
    # read-only (admin-managed), not a subscription row.
    email = (user.email or "").strip().lower()
    if email:
        for ch in NotificationChannel.objects.filter(
            tenant=tenant, kind="email", enabled=True
        ).select_related("match_prefix", "match_ip"):
            if ch.id in subscribed_ids:
                continue
            recips = [r.lower() for r in (ch.config or {}).get("recipients") or []]
            if email in recips:
                rows.append({
                    "channel": _channel_summary(ch),
                    "source": "direct",
                    "mandatory": True,
                    "can_unsubscribe": False,
                })
                subscribed_ids.add(ch.id)
    available = [
        _channel_summary(ch)
        for ch in NotificationChannel.objects.filter(
            tenant=tenant, self_subscribable=True, enabled=True
        ).select_related("match_prefix", "match_ip")
        if ch.id not in subscribed_ids
    ]
    return Response(
        {"subscriptions": rows, "available": available, "can_subscribe": can_sub}
    )


@api_view(["POST"])
@permission_classes([permissions.IsAuthenticated])
def notifications_subscribe(request):
    """Opt myself into a self-subscribable channel. Gated by the ``subscribe``
    verb on notification channels."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")
    if not _can_subscribe(request.user, tenant):
        return Response({"detail": "notificationchannel:subscribe required."},
                        status=403)
    channel = NotificationChannel.objects.filter(
        tenant=tenant, id=(request.data or {}).get("channel"),
        self_subscribable=True, enabled=True,
    ).first()
    if channel is None:
        raise ValidationError(
            {"channel": "Channel is not available for self-subscription."}
        )
    _, created = NotificationSubscription.objects.get_or_create(
        tenant=tenant, channel=channel, user=request.user,
        defaults={"mandatory": False, "created_by": request.user},
    )
    return Response({"ok": True, "created": created})


@api_view(["POST"])
@permission_classes([permissions.IsAuthenticated])
def notifications_unsubscribe(request):
    """Drop my own self-assigned subscription. Admin/group-assigned ones cannot
    be self-removed — they return a clear 400."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")
    if not _can_subscribe(request.user, tenant):
        return Response({"detail": "notificationchannel:subscribe required."},
                        status=403)
    sub = NotificationSubscription.objects.filter(
        tenant=tenant, channel_id=(request.data or {}).get("channel"),
        user=request.user, mandatory=False,
    ).first()
    if sub is None:
        raise ValidationError({
            "detail": "No self-assigned subscription to remove. Group or "
            "admin-assigned subscriptions can't be removed here."
        })
    sub.delete()
    return Response({"ok": True})


# ─── per-prefix / per-IP "Notify me" shortcut ────────────────────────────────
# The simple case: "email me when this prefix/IP changes". Backed by a shared,
# auto-created email channel scoped to that prefix/IP (one per scope, reused by
# every watcher) plus a self subscription — so channels stay invisible here.


def _watch_scope(request, create=False):
    """Resolve the (prefix, ip) target from the request and the auto channel for
    it. Returns (tenant, prefix, ip, channel|None). ``create`` makes the channel."""
    from api.models import IPAddress, Prefix

    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")
    data = request.data if request.method == "POST" else request.query_params
    prefix_id = data.get("prefix")
    ip_id = data.get("ip")
    if bool(prefix_id) == bool(ip_id):
        raise ValidationError({"detail": "Provide exactly one of prefix or ip."})

    prefix = ip = None
    if prefix_id:
        prefix = Prefix.objects.filter(tenant=tenant, id=prefix_id).first()
        if prefix is None:
            raise ValidationError({"prefix": "Not found."})
        scope_q = {"match_prefix": prefix}
        name = f"Prefix {prefix.cidr}"
    else:
        ip = IPAddress.objects.filter(tenant=tenant, id=ip_id).first()
        if ip is None:
            raise ValidationError({"ip": "Not found."})
        scope_q = {"match_ip": ip}
        name = f"IP {ip.ip_address}"

    channel = NotificationChannel.objects.filter(
        tenant=tenant, auto_created=True, kind="email", **scope_q
    ).first()
    if channel is None and create:
        channel = NotificationChannel.objects.create(
            tenant=tenant, name=name, kind="email", config={},
            auto_created=True, send_status_changes=True,
            status_change_mode="instant", created_by=request.user, **scope_q,
        )
    return tenant, prefix, ip, channel


@api_view(["GET"])
@permission_classes([permissions.IsAuthenticated])
def notifications_watch_state(request):
    """Whether the current user is watching a given prefix/IP, and whether they
    may (needs the subscribe verb + an account email)."""
    tenant, _prefix, _ip, channel = _watch_scope(request)
    watching = bool(channel) and NotificationSubscription.objects.filter(
        channel=channel, user=request.user
    ).exists()
    return Response({
        "watching": watching,
        "can_watch": _can_subscribe(request.user, tenant)
        and bool((request.user.email or "").strip()),
    })


@api_view(["POST"])
@permission_classes([permissions.IsAuthenticated])
def notifications_watch(request):
    """Start emailing the current user about a prefix/IP's status changes."""
    tenant, _prefix, _ip, _channel = _watch_scope(request)
    if not _can_subscribe(request.user, tenant):
        return Response({"detail": "notificationchannel:subscribe required."},
                        status=403)
    if not (request.user.email or "").strip():
        raise ValidationError(
            {"detail": "Your account has no email address to notify."}
        )
    _tenant, _p, _i, channel = _watch_scope(request, create=True)
    NotificationSubscription.objects.get_or_create(
        tenant=tenant, channel=channel, user=request.user,
        defaults={"mandatory": False, "created_by": request.user},
    )
    return Response({"ok": True, "watching": True})


@api_view(["POST"])
@permission_classes([permissions.IsAuthenticated])
def notifications_unwatch(request):
    """Stop the current user's per-prefix/IP watch (only their own self row)."""
    tenant, _prefix, _ip, channel = _watch_scope(request)
    if not _can_subscribe(request.user, tenant):
        return Response({"detail": "notificationchannel:subscribe required."},
                        status=403)
    if channel is None:
        return Response({"ok": True, "watching": False})
    NotificationSubscription.objects.filter(
        channel=channel, user=request.user, mandatory=False
    ).delete()
    # Tidy up: an auto channel with no subscribers left and no direct recipients
    # serves nobody — remove it so it doesn't linger.
    if (
        channel.auto_created
        and not channel.subscriptions.exists()
        and not (channel.config or {}).get("recipients")
    ):
        channel.delete()
    return Response({"ok": True, "watching": False})


class AlertRuleViewSet(_TargetScopedConfigurationMixin, TenantScopedViewSet):
    queryset = (
        AlertRule.objects.select_related("match_prefix")
        .all()
        .order_by("weight", "name")
    )
    serializer_class = AlertRuleSerializer

    def _site_target_q(self, site_ids):
        return Q(match_prefix__site_id__in=site_ids)

    def _filter_visible_targets(self, qs, tenant, user):
        from api.models import Prefix
        from auth_api import rbac

        visible_prefixes = rbac.restrict_queryset(
            Prefix.objects.filter(tenant=tenant), user, tenant, "prefix", "view"
        ).values("pk")
        return qs.filter(
            Q(match_prefix__isnull=True) | Q(match_prefix_id__in=visible_prefixes)
        )

    def get_queryset(self):
        return self._scope_configuration_queryset(super().get_queryset())

    def _check_prefix(self, serializer):
        from auth_api import rbac

        tenant = self._tenant_or_403()
        prefix = self._effective_value(serializer, "match_prefix")
        # Tenant ownership (absolute) + row/site scope (a Site-A user must not
        # target a Site-B prefix in an alert rule).
        if prefix is not None:
            if prefix.tenant_id != tenant.id:
                raise ValidationError({"match_prefix": "Not in the active tenant."})
            if not rbac.can_act_on(self.request.user, tenant, "prefix", "view", prefix):
                raise ValidationError({"match_prefix": "Not in your scope."})

    def perform_create(self, serializer):
        self._check_prefix(serializer)
        super().perform_create(serializer)
        self._assert_saved_configuration_scope(serializer.instance, "add")

    def perform_update(self, serializer):
        self._check_prefix(serializer)
        serializer.save()
        self._assert_saved_configuration_scope(serializer.instance, "change")


class SilenceViewSet(_TargetScopedConfigurationMixin, TenantScopedViewSet):
    queryset = (
        Silence.objects.select_related("match_prefix", "match_ip", "created_by")
        .all()
        .order_by("-starts_at")
    )
    serializer_class = SilenceSerializer

    def _site_target_q(self, site_ids):
        return (
            (Q(match_prefix__isnull=True) | Q(match_prefix__site_id__in=site_ids))
            & (Q(match_ip__isnull=True) | Q(match_ip__site_id__in=site_ids))
            & (Q(match_prefix__isnull=False) | Q(match_ip__isnull=False))
        )

    def _filter_visible_targets(self, qs, tenant, user):
        from api.models import IPAddress, Prefix
        from auth_api import rbac

        visible_prefixes = rbac.restrict_queryset(
            Prefix.objects.filter(tenant=tenant), user, tenant, "prefix", "view"
        ).values("pk")
        visible_ips = rbac.restrict_queryset(
            IPAddress.objects.filter(tenant=tenant), user, tenant, "ipaddress", "view"
        ).values("pk")
        return qs.filter(
            (Q(match_prefix__isnull=True) | Q(match_prefix_id__in=visible_prefixes))
            & (Q(match_ip__isnull=True) | Q(match_ip_id__in=visible_ips))
        )

    def get_queryset(self):
        qs = self._scope_configuration_queryset(super().get_queryset())
        when = self.request.query_params.get("active")
        if when == "true":
            from django.utils import timezone

            now = timezone.now()
            qs = qs.filter(starts_at__lte=now, ends_at__gt=now)
        return qs

    def _check_targets(self, serializer):
        from auth_api import rbac

        tenant = self._tenant_or_403()
        prefix = self._effective_value(serializer, "match_prefix")
        ip = self._effective_value(serializer, "match_ip")
        # Tenant ownership (absolute) + row/site scope (no Site-B targets).
        if prefix is not None:
            if prefix.tenant_id != tenant.id:
                raise ValidationError({"match_prefix": "Not in the active tenant."})
            if not rbac.can_act_on(self.request.user, tenant, "prefix", "view", prefix):
                raise ValidationError({"match_prefix": "Not in your scope."})
        if ip is not None:
            if ip.tenant_id != tenant.id:
                raise ValidationError({"match_ip": "Not in the active tenant."})
            if not rbac.can_act_on(self.request.user, tenant, "ipaddress", "view", ip):
                raise ValidationError({"match_ip": "Not in your scope."})

    def perform_create(self, serializer):
        self._check_targets(serializer)
        user = self.request.user if self.request.user.is_authenticated else None
        # TenantScopedViewSet stamps tenant; add the creator.
        super().perform_create(serializer)
        if user is not None and serializer.instance.created_by_id is None:
            serializer.instance.created_by = user
            serializer.instance.save(update_fields=["created_by"])
        self._assert_saved_configuration_scope(serializer.instance, "add")

    def perform_update(self, serializer):
        self._check_targets(serializer)
        serializer.save()
        self._assert_saved_configuration_scope(serializer.instance, "change")


class _IsAdminOnly(permissions.BasePermission):
    message = "Admin access required."

    def has_permission(self, request, view):
        return bool(
            request.user
            and request.user.is_authenticated
            and can_manage_admin(request.user, _get_active_tenant(request))
        )


class _IsDeploymentAdminOnly(permissions.BasePermission):
    """Deployment-wide admin, for GLOBAL (tenant-less) resources. A
    tenant-scoped ``change-user`` grant does NOT pass — otherwise a tenant
    admin could upload/select the software distributed to every outpost
    (fleet RCE / supply-chain escalation)."""

    message = "Deployment admin required."

    def has_permission(self, request, view):
        from auth_api.permissions import can_manage_deployment

        return bool(
            request.user
            and request.user.is_authenticated
            and can_manage_deployment(request.user)
        )


def _fetch_github_binary(git_url, ref, token="", asset_name="danbyte-outpost"):
    """Download a release asset (the CI-built binary) from a GitHub repo's
    release for ``ref``. Returns ``(filename, bytes)``. Works for private repos
    with a token. Factored out (module-level) so it's mockable in tests."""
    import re

    import httpx

    m = re.search(r"github\.com[/:]([^/]+)/([^/.]+)", git_url or "")
    if not m:
        raise ValidationError("Only github.com repositories are supported here.")
    owner, repo = m.group(1), m.group(2)
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    api = f"https://api.github.com/repos/{owner}/{repo}/releases/tags/{ref}"
    with httpx.Client(timeout=30, follow_redirects=True) as client:
        r = client.get(api, headers=headers)
        if r.status_code == 404:
            raise ValidationError(f"No release tagged '{ref}' (or repo is private — add a token).")
        r.raise_for_status()
        assets = r.json().get("assets", [])
        # Prefer the named binary; else the first non-source-archive asset.
        asset = next((a for a in assets if a["name"] == asset_name), None)
        if asset is None:
            asset = next(
                (a for a in assets
                 if not a["name"].endswith((".tar.gz", ".zip", ".whl"))),
                None,
            )
        if asset is None:
            raise ValidationError("That release has no binary asset to fetch.")
        # httpx strips Authorization on the cross-host redirect to storage.
        dl = client.get(
            asset["url"],
            headers={**headers, "Accept": "application/octet-stream"},
        )
        dl.raise_for_status()
        return asset["name"], dl.content


def _list_github_releases(git_url, token=""):
    """A repo's releases (newest first) — thin wrapper over the shared helper."""
    from core.github import list_releases

    return list_releases(git_url, token)


class OutpostReleaseViewSet(viewsets.ModelViewSet):
    """Deployment-wide Outpost builds (admin) — the package store. Upload a
    build file, point at a git repo + ref, or fetch the repo's built binary."""

    queryset = OutpostRelease.objects.all()
    serializer_class = OutpostReleaseSerializer
    # Global resource: DEPLOYMENT admin only. A tenant-scoped change-user
    # grant must not let a tenant admin push software to every outpost.
    permission_classes = [_IsDeploymentAdminOnly]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def perform_create(self, serializer):
        self._stamp_size(serializer.save())

    def perform_update(self, serializer):
        self._stamp_size(serializer.save())

    def _stamp_size(self, obj):
        size = obj.artifact.size if obj.artifact else 0
        if obj.size_bytes != size:
            obj.size_bytes = size
            obj.save(update_fields=["size_bytes"])

    @action(detail=False, methods=["get"])
    def available(self, request):
        """Releases in the tenant's configured Outpost repo — for the version
        dropdown. Marks which tags are already imported."""
        from .models import MonitoringSettings

        s = MonitoringSettings.for_tenant(_get_active_tenant(request))
        if not s.outpost_repo_url:
            return Response({"repo_url": "", "versions": []})
        token = (s.outpost_repo_token or {}).get("token", "")
        try:
            rels = _list_github_releases(s.outpost_repo_url, token)
        except Exception as e:  # noqa: BLE001 — surface a friendly reason
            return Response(
                {"repo_url": s.outpost_repo_url, "versions": [], "error": str(e)}
            )
        imported = set(OutpostRelease.objects.values_list("version", flat=True))
        for r in rels:
            r["imported"] = r["tag"] in imported or r["tag"].lstrip("v") in imported
        return Response({"repo_url": s.outpost_repo_url, "versions": rels})

    @action(detail=False, methods=["post"])
    def fetch_binary(self, request):
        """Grab the CI-built binary from a GitHub release and store it as a
        version — so a repo link becomes a served binary, no manual download.
        The git URL + token default to the tenant's configured Outpost repo."""
        from django.core.files.base import ContentFile

        from .models import MonitoringSettings

        git_url = (request.data.get("git_url") or "").strip()
        ref = (request.data.get("ref") or "").strip()
        token = (request.data.get("token") or "").strip()
        if not git_url:  # fall back to the configured repo
            s = MonitoringSettings.for_tenant(_get_active_tenant(request))
            git_url = s.outpost_repo_url
            token = token or (s.outpost_repo_token or {}).get("token", "")
        if not git_url or not ref:
            raise ValidationError("A git URL and a ref (tag) are required.")
        version = request.data.get("version") or ref
        if OutpostRelease.objects.filter(version=version).exists():
            raise ValidationError(f"Version '{version}' already exists.")
        name, content = _fetch_github_binary(git_url, ref, token)
        release = OutpostRelease(
            version=version, source=OutpostRelease.FILE,
            git_url=git_url, git_ref=ref,
            is_default=not OutpostRelease.objects.exists(),
        )
        release.artifact.save(name, ContentFile(content), save=False)
        release.size_bytes = len(content)
        release.save()
        return Response(
            OutpostReleaseSerializer(release).data, status=201
        )


class WatchedEndpointViewSet(TenantScopedViewSet):
    """CRUD for bare TLS endpoints watched on a schedule (host:port + SNI, no
    device). Tenant-scoped + RBAC via the registered object type. A ``check
    now`` action reads the certificate immediately."""

    queryset = WatchedEndpoint.objects.select_related("last_certificate").order_by(
        "host", "port"
    )
    serializer_class = WatchedEndpointSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        cert = self.request.query_params.get("certificate")
        if cert:
            qs = qs.filter(last_certificate_id=cert)
        return qs

    @action(detail=True, methods=["post"], url_path="check-now")
    def check_now(self, request, pk=None):
        ep = self.get_object()  # tenant + RBAC scoped by get_queryset
        from .watched_endpoints import run_watched_endpoint

        try:
            run_watched_endpoint(ep)
        except Exception as exc:  # noqa: BLE001
            raise ValidationError({"detail": f"Check failed: {exc}"}) from exc
        ep.refresh_from_db()
        return Response(self.get_serializer(ep).data)

    @action(detail=False, methods=["post"], url_path="bulk-delete")
    def bulk_delete(self, request):
        ids = request.data.get("ids") or []
        if not isinstance(ids, list) or not ids:
            raise ValidationError({"ids": "Provide a non-empty list of ids."})
        # get_queryset already scopes to the tenant + RBAC, so this can only
        # ever delete the caller's own endpoints.
        deleted, _ = self.get_queryset().filter(id__in=ids).delete()
        return Response({"deleted": deleted})
