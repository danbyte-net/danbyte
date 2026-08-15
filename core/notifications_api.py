"""The topbar bell's endpoints — a user's own notifications, nothing else.

Deliberately not an RBAC-registered object type: rows are personal (always
filtered to ``request.user``), so the only gate that matters is being signed
in — the same stance as ``/api/me/prefs/``.
"""
from __future__ import annotations

from django.utils import timezone
from rest_framework import permissions
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from .models import Notification


def _payload(user):
    qs = Notification.objects.filter(user=user)
    rows = [
        {
            "id": str(n.id),
            "kind": n.kind,
            "title": n.title,
            "body": n.body,
            "url": n.url,
            "actor_name": n.actor_name,
            "read_at": n.read_at.isoformat() if n.read_at else None,
            "created_at": n.created_at.isoformat(),
        }
        for n in qs[:30]
    ]
    return {"unread": qs.filter(read_at__isnull=True).count(), "results": rows}


@api_view(["GET"])
@permission_classes([permissions.IsAuthenticated])
def notifications(request):
    """The 30 newest notifications for the signed-in user + unread count."""
    return Response(_payload(request.user))


@api_view(["POST"])
@permission_classes([permissions.IsAuthenticated])
def notifications_read(request):
    """Mark ``{"ids": [...]}`` — or ``{"all": true}`` — as read."""
    qs = Notification.objects.filter(user=request.user, read_at__isnull=True)
    if not request.data.get("all"):
        ids = [str(i) for i in request.data.get("ids", []) if i]
        qs = qs.filter(pk__in=ids[:200])
    qs.update(read_at=timezone.now())
    return Response(_payload(request.user))
