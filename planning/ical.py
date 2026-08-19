"""The calendar as an iCalendar feed - subscribe from Outlook/Google/Apple.

Calendar clients cannot send an ``Authorization`` header, so the feed accepts a
Danbyte **API token** as ``?token=`` - the same revocable, tenant-scoped tokens
scripts use, validated identically (hash lookup, expiry, active user). Use a
dedicated token for a subscription: it rides in a URL, and revoking it kills
just the feed.

The data is :func:`planning.calendar.calendar_payload` - the exact rows the
on-screen calendar shows that token's user, RBAC and all.
"""
from __future__ import annotations

from datetime import UTC, date, timedelta

from django.http import HttpResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET

from auth_api import rbac


def _escape(value: str) -> str:
    """RFC 5545 TEXT escaping."""
    return (
        value.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
    )


def _fold(line: str) -> str:
    """RFC 5545 folds lines at 75 octets with a leading space."""
    out = []
    while len(line.encode()) > 73:
        cut = 73
        while len(line[:cut].encode()) > 73:
            cut -= 1
        out.append(line[:cut])
        line = " " + line[cut:]
    out.append(line)
    return "\r\n".join(out)


def _all_day(uid: str, summary: str, start: str, end_exclusive: str,
             description: str = "") -> list[str]:
    lines = [
        "BEGIN:VEVENT",
        f"UID:{uid}@danbyte",
        f"DTSTART;VALUE=DATE:{start.replace('-', '')}",
        f"DTEND;VALUE=DATE:{end_exclusive.replace('-', '')}",
        f"SUMMARY:{_escape(summary)}",
    ]
    if description:
        lines.append(f"DESCRIPTION:{_escape(description)}")
    lines.append("END:VEVENT")
    return lines


def _stamp(iso: str) -> str:
    """ISO datetime → iCal UTC form (``20260814T220000Z``)."""
    from datetime import datetime

    d = datetime.fromisoformat(iso)
    if timezone.is_naive(d):
        d = timezone.make_aware(d)
    return d.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def _next_day(day: str) -> str:
    return (date.fromisoformat(day) + timedelta(days=1)).isoformat()


def _resolve_token(request):
    """The (user, token) behind ``?token=`` - mirroring the header auth's
    checks so a feed token is not a weaker class of credential."""
    key = request.GET.get("token", "")
    if not key:
        return None
    from auth_api.models import ApiToken, hash_api_key

    token = (
        ApiToken.objects.select_related("user", "tenant")
        .filter(key_hash=hash_api_key(key))
        .first()
    )
    if token is None or token.is_expired or not token.user.is_active:
        return None
    return token


@require_GET
def calendar_ics(request):
    """``?token=<api token>[&days=60][&board=<id>]`` - an iCal feed of the
    same window the calendar page shows."""
    token = _resolve_token(request)
    if token is None:
        return JsonResponse({"detail": "A valid API token is required."}, status=401)

    # The scoped querysets read the user, the token's tenant and
    # ``query_params`` off the request, exactly as the JSON endpoint would -
    # this is a plain Django view, so provide DRF's alias explicitly.
    request.user = token.user
    request.auth = token
    request.query_params = request.GET
    if not rbac.has_action(token.user, token.tenant, "task", "view"):
        return JsonResponse({"detail": "task:view required."}, status=403)

    try:
        days = min(max(int(request.GET.get("days", "60")), 7), 366)
    except ValueError:
        days = 60
    today = timezone.localdate()
    start, end = today - timedelta(days=7), today + timedelta(days=days)

    from .calendar import calendar_payload

    data = calendar_payload(request, start, end, request.GET.get("board"))

    lines: list[str] = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Danbyte//Planning//EN",
        f"X-WR-CALNAME:Danbyte - {_escape(token.tenant.name)}",
    ]
    for t in data["tasks"]:
        s = t["start_date"] or t["due_date"]
        e = t["due_date"] or t["start_date"]
        lines += _all_day(
            f"task-{t['id']}",
            t["title"],
            s,
            _next_day(e),
            f"{t['board_name']} · {t['status_name']}",
        )
    for m in data["milestones"]:
        lines += _all_day(
            f"milestone-{m['id']}",
            f"Milestone: {m['name']}",
            m["due_date"],
            _next_day(m["due_date"]),
            m["board_name"],
        )
    for c in data["changes"]:
        lines += _all_day(
            f"change-{c['id']}",
            f"Planned change: {', '.join(c['fields']) or 'fields'}",
            c["effective_date"],
            _next_day(c["effective_date"]),
            f"Task: {c['task_title']}",
        )
    for e in data["events"]:
        kind = "Outage" if e["kind"] == "outage" else "Maintenance"
        lines += [
            "BEGIN:VEVENT",
            f"UID:event-{e['id']}@danbyte",
            f"DTSTART:{_stamp(e['starts_at'])}",
            f"DTEND:{_stamp(e['ends_at'] or e['etr'] or e['starts_at'])}",
            f"SUMMARY:{_escape(f'{kind}: {e['name']}')}",
            f"DESCRIPTION:{_escape((e['provider_name'] or 'Internal') + ' · ' + e['status_name'])}",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")

    body = "\r\n".join(_fold(line) for line in lines) + "\r\n"
    return HttpResponse(body, content_type="text/calendar; charset=utf-8")
