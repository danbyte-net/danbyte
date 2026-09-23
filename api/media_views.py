"""Uploaded files, served only to someone who may see the object they hang on.

Everything under ``/media/`` used to go straight from disk: the production
nginx template aliased the folder, so a document's original filename was
enough to download it without a session, from any tenant (#227). nginx now
hands ``/media/`` to this view, which serves:

* ``branding/`` and ``device-type-images/`` to anyone - the login page needs
  the logo, and a device type's front panel is catalog art;
* ``documents/``, ``image-attachments/`` and ``floor-plans/`` only when the
  signed-in user can view the object the file belongs to, in the active
  tenant;
* nothing else. Outpost releases, OUI imports and script outputs have their
  own authenticated routes.

It also fixes the other half of the same route: with DEBUG off Django never
served media at all, so behind the proxying nginx template an image
attachment or a floor-plan background simply 404ed.
"""
from __future__ import annotations

import mimetypes
import posixpath

from django.conf import settings
from django.db.models import Q
from django.http import FileResponse, Http404
from django.utils._os import safe_join
from django.views.decorators.http import require_safe

#: Folders any visitor may read.
PUBLIC_PREFIXES = ("branding/", "device-type-images/")
#: Served inline; anything else downloads. An uploaded HTML or SVG file shown
#: inline on this origin would run script as the viewer.
INLINE_TYPES = {
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/avif",
}


def _clean(path: str) -> str:
    """The media-relative path, or 404 for anything that tries to leave it."""
    if not path or "\\" in path or "\x00" in path:
        raise Http404
    norm = posixpath.normpath(path).lstrip("/")
    if norm in ("", ".") or norm.startswith("..") or norm != path.lstrip("/"):
        raise Http404
    return norm


def _may_view(request, path: str) -> bool:
    """Can this user see the object that owns ``path``, in the active tenant?"""
    from audit.api import _can_view_object
    from auth_api import rbac

    from .models import Document, FloorPlan, ImageAttachment
    from .views import _get_active_tenant

    if not request.user.is_authenticated:
        return False
    tenant = _get_active_tenant(request)
    if tenant is None:
        return False
    if path.startswith("documents/"):
        doc = Document.objects.filter(tenant=tenant, file=path).first()
        return doc is not None and _can_view_object(
            request, doc.object_type, str(doc.object_id)
        )
    if path.startswith("image-attachments/"):
        img = (
            ImageAttachment.objects.filter(tenant=tenant)
            .filter(Q(image=path) | Q(thumbnail=path))
            .select_related("content_type").first()
        )
        if img is None:
            return False
        label = f"{img.content_type.app_label}.{img.content_type.model}"
        return _can_view_object(request, label, str(img.object_id))
    if path.startswith("floor-plans/"):
        plans = FloorPlan.objects.filter(tenant=tenant, background_image=path)
        return rbac.restrict_queryset(
            plans, request.user, tenant, "floorplan", "view"
        ).exists()
    return False


@require_safe
def serve_media(request, path):
    path = _clean(path)
    public = path.startswith(PUBLIC_PREFIXES)
    # 404 rather than 403 either way: a missing file and one you may not see
    # look the same, so a name cannot be probed for.
    if not public and not _may_view(request, path):
        raise Http404
    try:
        full = safe_join(str(settings.MEDIA_ROOT), path)
        fh = open(full, "rb")  # noqa: SIM115 - FileResponse closes it
    except (OSError, ValueError) as exc:
        raise Http404 from exc
    ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
    inline = ctype in INLINE_TYPES
    resp = FileResponse(
        fh, content_type=ctype, as_attachment=not inline,
        filename=posixpath.basename(path),
    )
    resp["X-Content-Type-Options"] = "nosniff"
    resp["Content-Security-Policy"] = "sandbox; default-src 'none'"
    # A private file must not sit in a shared cache.
    resp["Cache-Control"] = "public, max-age=86400" if public else "private, max-age=3600"
    return resp
