"""Plugin framework API — the installed-plugin listing.

Per-tenant enable/disable + config management land here in a later phase; for
now this is a read-only inventory of what the deployment has installed.
"""
from __future__ import annotations

from rest_framework.decorators import api_view, permission_classes
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

    pending = pending_migrations_by_app()
    # Map plugin module → its Django app_label (last dotted component).
    app_labels = {cfg.name: cfg.label for cfg in loaded_configs()}
    report = plugin_report()
    for entry in report:
        label = app_labels.get(entry["module"])
        entry["unapplied_migrations"] = pending.get(label, []) if label else []
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
