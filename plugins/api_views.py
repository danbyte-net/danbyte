"""Plugin framework API — the installed-plugin listing.

Per-tenant enable/disable + config management land here in a later phase; for
now this is a read-only inventory of what the deployment has installed.
"""
from __future__ import annotations

from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .registry import plugin_report


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def plugins_list(request):
    """Installed plugins and their load state (loaded / incompatible / error).

    Readable by any authenticated user — it's inventory, not a secret. It does
    not expose per-tenant enablement (that arrives with the config endpoints).
    """
    return Response({"plugins": plugin_report()})
