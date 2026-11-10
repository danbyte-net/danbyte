"""Saved versions of a text body (#465), read back from the change log.

Every audited save writes the whole row to ``ChangeLogEntry.post_change``, and
template bodies round-trip byte for byte, so the change log already holds each
saved text. A version is one create entry, or one update entry whose
``changes`` name the field; its id is the entry's id. Nothing new is stored.

What the log cannot give back:

- entries past ``CHANGELOG_RETENTION_DAYS`` are pruned, so the oldest versions
  of a long-lived body go (``history_complete`` is false when no create entry
  is left);
- a body saved while auditing was suspended, or by a bulk queryset write, has
  no entry; the live text then differs from the newest version and the list
  says so through ``current``;
- an entry whose snapshot holds no string for the field (rows from before
  snapshots, or a redacted field) lists with ``text_kept: false``.

Restore saves the old text through the viewset's own serializer as a partial
update: the same validators, the change permission the POST maps to, and an
ordinary change-log entry with the cause "Restored version from <date>". The
history is never rewritten.
"""
from __future__ import annotations

import difflib
import hashlib
import uuid

from django.db import transaction
from django.db.models import Q
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status as drf_status
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound
from rest_framework.response import Response

CURRENT = "current"


def text_facts(text: str | None) -> dict:
    """``sha256``, ``size`` (UTF-8 bytes) and ``lines`` of ``text``; nulls
    when the text was not kept."""
    if not isinstance(text, str):
        return {"sha256": None, "size": None, "lines": None}
    data = text.encode("utf-8")
    return {
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data),
        "lines": len(text.splitlines()),
    }


def unified_diff(old: str, new: str, old_label: str, new_label: str) -> str:
    """The diff the file viewer reads: ``difflib.unified_diff`` with
    ``lineterm=""``, as the config renders write it."""
    return "\n".join(difflib.unified_diff(
        old.splitlines(), new.splitlines(),
        fromfile=old_label, tofile=new_label, lineterm="",
    ))


def _stamp(at) -> str:
    return at.strftime("%Y-%m-%d %H:%M UTC")


_VID = OpenApiParameter(
    "vid", str, OpenApiParameter.PATH,
    description="A change-log entry id, or `current` for the live text.",
)


class TextVersionsMixin:
    """Adds ``versions/``, ``versions/<vid>/`` and ``versions/<vid>/restore/``
    to a tenant-scoped model viewset. ``versions_field`` names the text field.

    Reads go through ``get_object()``, so the tenant filter and the caller's
    view rights on the object apply; restore is a POST and needs ``change``.
    """

    versions_field: str = ""

    # ── reading the log ─────────────────────────────────────────────────────
    def _version_entries(self, obj):
        from audit.models import ChangeAction, ChangeLogEntry

        field = self.versions_field
        return ChangeLogEntry.objects.filter(
            object_type=obj._meta.label_lower,
            object_id=str(obj.pk),
            tenant_id=getattr(obj, "tenant_id", None),
        ).filter(
            Q(action=ChangeAction.CREATE)
            | Q(action=ChangeAction.UPDATE, changes__has_key=field)
        ).order_by("-timestamp", "-id")

    def _entry_text(self, entry) -> str | None:
        post = entry.post_change if isinstance(entry.post_change, dict) else {}
        text = post.get(self.versions_field)
        if isinstance(text, str):
            return text
        change = (entry.changes or {}).get(self.versions_field)
        if isinstance(change, dict) and isinstance(change.get("new"), str):
            return change["new"]
        return None

    def _version_row(self, entry) -> dict:
        text = self._entry_text(entry)
        return {
            "id": str(entry.id),
            "at": entry.timestamp.isoformat(),
            "by": entry.user_name or "",
            "action": entry.action,
            "cause": entry.cause or "",
            "text_kept": text is not None,
            **text_facts(text),
        }

    def _current_row(self, obj) -> dict:
        text = getattr(obj, self.versions_field) or ""
        updated = getattr(obj, "updated_at", None)
        return {
            "id": CURRENT,
            "at": updated.isoformat() if updated else None,
            "by": "",
            "action": "current",
            "cause": "",
            "text_kept": True,
            **text_facts(text),
        }

    def _version(self, obj, vid: str):
        """``(row, text)`` for one version id, or 404. ``current`` is the live
        text."""
        if vid == CURRENT:
            return self._current_row(obj), getattr(obj, self.versions_field) or ""
        try:
            uuid.UUID(str(vid))
        except ValueError:
            raise NotFound("Unknown version.") from None
        entry = self._version_entries(obj).filter(pk=vid).first()
        if entry is None:
            raise NotFound("Unknown version.")
        return self._version_row(entry), self._entry_text(entry)

    # ── endpoints ───────────────────────────────────────────────────────────
    @extend_schema(responses={200: dict})
    @action(detail=True, methods=["get"], url_path="versions", url_name="versions")
    def versions(self, request, pk=None):
        """Every saved version of the body, newest first (paged)."""
        from audit.models import ChangeAction

        obj = self.get_object()
        entries = self._version_entries(obj)
        page = self.paginate_queryset(entries)
        rows = [self._version_row(e) for e in (page if page is not None else entries)]
        current = self._current_row(obj)
        newest = entries.first()
        extra = {
            "current": current,
            # The live text is not the newest logged one: saved by a path the
            # change log does not see (a bulk write, a suspended log).
            "current_logged": bool(
                newest and self._entry_text(newest) is not None
                and text_facts(self._entry_text(newest))["sha256"] == current["sha256"]
            ),
            # The create entry is still there: nothing was pruned.
            "history_complete": entries.filter(action=ChangeAction.CREATE).exists(),
        }
        if page is not None:
            resp = self.get_paginated_response(rows)
            resp.data.update(extra)
            return resp
        return Response({"count": len(rows), "results": rows, **extra})

    @extend_schema(parameters=[_VID], responses={200: dict})
    @action(
        detail=True, methods=["get"],
        url_path=r"versions/(?P<vid>[^/.]+)", url_name="version",
    )
    def version(self, request, pk=None, vid=None):
        """One version's text. ``?against=<vid|current>`` adds a unified diff
        from that version to this one."""
        obj = self.get_object()
        row, text = self._version(obj, vid)
        out = {**row, "text": text}
        against = request.query_params.get("against")
        if against:
            other_row, other = self._version(obj, against)
            if text is None or other is None:
                out["diff"] = None
            else:
                out["diff"] = unified_diff(
                    other, text,
                    f"{other_row['at'] or ''} {other_row['by']}".strip(),
                    f"{row['at'] or ''} {row['by']}".strip(),
                )
            out["against"] = other_row
        return Response(out)

    @extend_schema(parameters=[_VID], request=None, responses={200: dict})
    @action(
        detail=True, methods=["post"],
        url_path=r"versions/(?P<vid>[^/.]+)/restore", url_name="version-restore",
    )
    def restore_version(self, request, pk=None, vid=None):
        """Save an old version's text as a new version - through the normal
        update path, logged with the cause "Restored version from <date>"."""
        from audit.context import cause

        obj = self.get_object()
        if vid == CURRENT:
            raise NotFound("Unknown version.")
        row, text = self._version(obj, vid)
        if text is None:
            return Response(
                {"detail": "The change log did not keep this version's text."},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )
        if text == (getattr(obj, self.versions_field) or ""):
            return Response(
                {"detail": "This version is the current text."},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )
        from django.utils.dateparse import parse_datetime

        when = parse_datetime(row["at"])
        with transaction.atomic(), cause(f"Restored version from {_stamp(when)}"):
            serializer = self.get_serializer(
                obj, data={self.versions_field: text}, partial=True
            )
            serializer.is_valid(raise_exception=True)
            self.perform_update(serializer)
            check = getattr(self, "_assert_write_in_site_scope", None)
            if check is not None:
                check(Response(serializer.data), "change")
        # The serializer's view of the object, re-read for annotations.
        return Response(self.get_serializer(self.get_object()).data)


# ── Check while typing (#465) ───────────────────────────────────────────────
#: Calls per user per window: an editor debounces, so this is far above what
#: typing needs and still bounds a script hammering the parser.
CHECK_LIMIT = 120
CHECK_WINDOW = 60
#: Bigger than any template body worth editing in a browser.
CHECK_MAX_CHARS = 1_000_000


def check_rate_limited(user, scope: str = "template-check") -> bool:
    """A per-user counter on the cache, the shape the assistant's limit uses.
    A missing cache means no limit, never a refusal."""
    from django.core.cache import cache

    key = f"{scope}:{getattr(user, 'pk', 'anon')}"
    try:
        count = cache.incr(key)
    except ValueError:
        cache.set(key, 1, CHECK_WINDOW)
        return False
    except Exception:  # noqa: BLE001 - cache down: keep the editor working
        return False
    return count > CHECK_LIMIT


def syntax_check(env, text: str) -> dict:
    """``{"ok": True}`` or ``{"ok": False, "error": {"message", "line"}}``:
    a parse in ``env``, nothing rendered. The message is what save says."""
    from jinja2 import TemplateError, TemplateSyntaxError

    try:
        env.from_string(text or "")
    except TemplateSyntaxError as exc:
        return {"ok": False, "error": {"message": exc.message or str(exc), "line": exc.lineno}}
    except TemplateError as exc:
        return {"ok": False, "error": {"message": str(exc), "line": None}}
    return {"ok": True, "error": None}


class TemplateCheckMixin:
    """``POST validate/`` - the save-time Jinja syntax check on a draft, for
    the editor to underline errors while typing. Parses in the sandboxed
    environment the template renders in; no data is loaded or rendered.

    Map ``validate_template`` to ``view`` in the viewset's ``rbac_action_map``:
    it reads and writes nothing, and a new template's author may hold ``add``
    only."""

    check_field: str = "template_code"

    def check_environment(self):
        raise NotImplementedError

    @extend_schema(request=dict, responses={200: dict})
    @action(detail=False, methods=["post"], url_path="validate", url_name="validate")
    def validate_template(self, request):
        data = request.data if hasattr(request.data, "get") else {}
        text = data.get(self.check_field, "")
        if not isinstance(text, str):
            return Response(
                {self.check_field: ["A string."]}, status=drf_status.HTTP_400_BAD_REQUEST
            )
        if len(text) > CHECK_MAX_CHARS:
            return Response(
                {self.check_field: ["Too long to check."]},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )
        if check_rate_limited(request.user):
            return Response(
                {"detail": "Too many checks. Try again in a minute."},
                status=drf_status.HTTP_429_TOO_MANY_REQUESTS,
            )
        return Response(syntax_check(self.check_environment(), text))
