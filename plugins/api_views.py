"""Plugin framework API — the installed-plugin listing.

Per-tenant enable/disable + config management land here in a later phase; for
now this is a read-only inventory of what the deployment has installed.
"""
from __future__ import annotations

from rest_framework.decorators import api_view, parser_classes, permission_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .registry import loaded_configs, plugin_report


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def plugins_list(request):
    """Installed plugins and their load state (loaded / incompatible / error),
    each annotated with any unapplied migrations so the UI can offer "Apply".

    Readable by any authenticated user — it's inventory, not a secret. It does
    not expose per-tenant enablement (that arrives with the config endpoints).
    """
    from core.services import pending_migrations_by_app

    from .install import uploaded_names

    pending = pending_migrations_by_app()
    uploaded = set(uploaded_names())
    # Map plugin module → its Django app_label (last dotted component).
    app_labels = {cfg.name: cfg.label for cfg in loaded_configs()}
    report = plugin_report()
    for entry in report:
        label = app_labels.get(entry["module"])
        entry["unapplied_migrations"] = pending.get(label, []) if label else []
        # Installed via upload (offline) → the UI offers Uninstall.
        entry["uploaded"] = entry["module"] in uploaded
    return Response(
        {
            "plugins": report,
            # Any pending migration across the whole install (plugins or core) —
            # the signal for the "Apply changes" action.
            "has_pending_migrations": bool(pending),
        }
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
@parser_classes([MultiPartParser, FormParser])
def plugin_upload(request):
    """Install a plugin from an uploaded archive (superuser only).

    Offline/airgapped alternative to pip: extract a .tar.gz/.zip of the plugin
    into the import path. Uploading a plugin runs its code on restart — remote
    code execution by design — so this is superuser-gated. Activate with Apply
    (migrate + restart).
    """
    if not getattr(request.user, "is_superuser", False):
        return Response({"detail": "Superuser required."}, status=403)
    upload = request.FILES.get("archive")
    if not upload:
        return Response({"detail": "No archive uploaded (field 'archive')."}, status=400)

    from .install import PluginInstallError, install_archive

    try:
        result = install_archive(upload)
    except PluginInstallError as exc:
        return Response({"detail": str(exc)}, status=400)
    return Response(
        {
            "installed": result["name"],
            "detail": f"Installed '{result['name']}'. Apply changes to activate.",
        }
    )


@api_view(["DELETE"])
@permission_classes([IsAuthenticated])
def plugin_uninstall(request, slug: str):
    """Remove an uploaded plugin by its module name (superuser only). Takes
    effect on the next restart."""
    if not getattr(request.user, "is_superuser", False):
        return Response({"detail": "Superuser required."}, status=403)
    from .install import uninstall

    if not uninstall(slug):
        return Response(
            {"detail": "Not an uploaded plugin (or already removed)."}, status=404
        )
    return Response({"removed": slug, "detail": "Removed. Apply changes to finish."})


@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticated])
def plugin_config(request, slug: str):
    """Read or set a plugin's enablement.

    GET returns the effective state for the caller's active tenant plus the raw
    tenant/deployment rows. PATCH ``{enabled, scope}`` upserts a row: scope
    ``"tenant"`` (default) needs tenant-admin (``can_manage_admin``); scope
    ``"deployment"`` needs deployment-admin (``can_manage_deployment``).
    """
    from auth_api.permissions import can_manage_admin, can_manage_deployment

    from api.views import _get_active_tenant
    from .models import PluginConfig
    from .registry import get_plugin
    from .resolve import plugin_enabled

    if get_plugin(slug) is None:
        return Response({"detail": "Unknown or not-loaded plugin."}, status=404)

    tenant = _get_active_tenant(request)

    def _row(t):
        return PluginConfig.objects.filter(plugin_slug=slug, tenant=t).first()

    if request.method == "GET":
        tenant_row = _row(tenant) if tenant is not None else None
        dep_row = _row(None)
        return Response(
            {
                "slug": slug,
                "enabled": plugin_enabled(slug, tenant),
                "tenant_enabled": tenant_row.enabled if tenant_row else None,
                "deployment_enabled": dep_row.enabled if dep_row else None,
                "default_enabled": bool(
                    getattr(get_plugin(slug), "default_enabled", True)
                ),
            }
        )

    scope = request.data.get("scope", "tenant")
    enabled = request.data.get("enabled")
    if not isinstance(enabled, bool):
        return Response({"detail": "`enabled` must be a boolean."}, status=400)

    if scope == "deployment":
        if not can_manage_deployment(request.user):
            return Response({"detail": "Deployment admin required."}, status=403)
        target_tenant = None
    else:
        if tenant is None:
            return Response({"detail": "No active tenant."}, status=400)
        if not can_manage_admin(request.user, tenant):
            return Response({"detail": "Tenant admin required."}, status=403)
        target_tenant = tenant

    PluginConfig.objects.update_or_create(
        plugin_slug=slug, tenant=target_tenant, defaults={"enabled": enabled}
    )
    return Response({"slug": slug, "enabled": plugin_enabled(slug, tenant)})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def plugins_apply(request):
    """Apply plugin changes: run migrations then restart Danbyte (superuser).

    The install model is "package + restart": an operator pip-installs a plugin
    and adds it to PLUGINS; this is the smart in-UI equivalent of the manual
    ``migrate`` + service restart, run detached so a long migration can't time
    out the request.
    """
    if not getattr(request.user, "is_superuser", False):
        return Response({"detail": "Superuser required."}, status=403)
    from core.services import apply_plugins

    result = apply_plugins()
    return Response(result, status=200 if result["ok"] else 400)
