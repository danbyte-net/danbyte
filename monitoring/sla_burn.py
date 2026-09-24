"""Multi-window burn-rate alerts for SLA agreements.

A period-long pace (``SlaAgreement.alert_burn_rate``) hides a sharp outage
until much of the budget is gone. These rules follow the SRE workbook: a rule
fires while the error budget burns at or above ``burn`` times the sustainable
rate over BOTH a long window and a short one. The long window proves the burn
is real; the short one proves it is still happening, so the alert clears
minutes after the outage ends instead of hours.

    burn = (100 - availability over the window) / (100 - target)

1.0 spends the budget exactly by the period's end. The defaults - 14.4 over
1 h and 5 min, 6 over 6 h and 30 min - page on 2 % of a 30-day budget gone in
an hour and ticket on 5 % in six hours.

Run every minute by ``manage.py sla_burn`` (danbyte-sla-burn.timer). Each
rule notifies once as it starts firing and once as it resolves; a rule that
flaps back within ``REFIRE_AFTER`` of its last message fires silently.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from django.utils import timezone

log = logging.getLogger("monitoring.sla")

#: No second "firing" message for the same rule inside this long.
REFIRE_AFTER = timedelta(hours=1)
#: Bounds on a rule's windows, in minutes.
MIN_WINDOW, MAX_WINDOW = 1, 7 * 24 * 60
MAX_RULES = 4


def validate_rules(value) -> list[dict]:
    """Normalise ``burn_alerts``; raises ValueError with a readable message."""
    if not isinstance(value, list) or len(value) > MAX_RULES:
        raise ValueError(f"A list of up to {MAX_RULES} rules.")
    out, names = [], set()
    for raw in value:
        if not isinstance(raw, dict):
            raise ValueError("Each rule is an object.")
        name = str(raw.get("name") or "").strip()[:20]
        if not name or name in names:
            raise ValueError("Each rule needs a unique name.")
        names.add(name)
        try:
            long_min, short_min = int(raw.get("long_min")), int(raw.get("short_min"))
            burn = float(raw.get("burn"))
        except (TypeError, ValueError):
            raise ValueError(f"{name}: windows are whole minutes and burn a number.") from None
        if not MIN_WINDOW <= short_min < long_min <= MAX_WINDOW:
            raise ValueError(f"{name}: the short window must be shorter than the long one, "
                             "and both between 1 minute and 7 days.")
        if burn <= 0:
            raise ValueError(f"{name}: burn must be above 0.")
        out.append({"name": name, "long_min": long_min, "short_min": short_min,
                     "burn": burn, "on": bool(raw.get("on", True))})
    return out


def burn_over(agreement, minutes: int, now: datetime, rules: dict) -> float | None:
    """Burn over the last ``minutes``; None when nothing in it was measured
    (outside service hours, no members, no checks)."""
    from . import sla

    f = sla.compute(agreement, now - timedelta(minutes=minutes), now, rules=rules,
                    now=now)["figures"]
    av = f.get("availability")
    if av is None:
        return None
    allowed = 100 - float(agreement.target_pct)
    if allowed <= 0:  # a 100 % target has no budget: any down time is infinite burn
        return 0.0 if av >= 100 else float("inf")
    return round((100 - av) / allowed, 2)


def _fmt_burn(b) -> str:
    return "-" if b is None else "∞" if b >= 1e9 else f"{b:g}x"


def _fmt_window(minutes: int) -> str:
    return f"{minutes // 60} h" if minutes % 60 == 0 else f"{minutes} min"


def _lasts(agreement, burn, now) -> str:
    """How long a whole period's budget lasts at this burn."""
    from . import sla

    if not burn or burn >= 1e9:
        return ""
    _key, start, end = sla.period_for(agreement, now)
    hours = (end - start).total_seconds() / 3600 / burn
    span = f"{hours:.1f} hours" if hours < 48 else f"{hours / 24:.1f} days"
    return f" At this pace the whole period's budget lasts {span}."


def evaluate(agreement, now: datetime | None = None, *, send: bool = True) -> dict:
    """Compute every rule of one agreement, notify on changes, and store the
    new state. Returns the state."""
    now = now or timezone.now()
    rules = agreement.rules()
    cache: dict[int, float | None] = {}

    def burn(minutes):
        if minutes not in cache:
            cache[minutes] = burn_over(agreement, minutes, now, rules)
        return cache[minutes]

    before = agreement.burn_state or {}
    state = {}
    channels = None
    for rule in agreement.burn_alerts or []:
        if not rule.get("on"):
            continue
        name = rule["name"]
        long_b, short_b = burn(rule["long_min"]), burn(rule["short_min"])
        hot = (long_b is not None and short_b is not None
               and long_b >= rule["burn"] and short_b >= rule["burn"])
        prev = before.get(name) or {}
        entry = {
            "long": _json_burn(long_b), "short": _json_burn(short_b), "at": now.isoformat(),
            "long_min": rule["long_min"], "short_min": rule["short_min"],
            "threshold": rule["burn"], "firing": hot,
            "since": prev.get("since") if hot and prev.get("firing") else
                     now.isoformat() if hot else None,
            "notified": bool(prev.get("notified")) if hot and prev.get("firing") else False,
            "sent_at": prev.get("sent_at"),
        }
        event = None
        if hot and not prev.get("firing"):
            last = prev.get("sent_at")
            if not last or now - datetime.fromisoformat(last) >= REFIRE_AFTER:
                event = "firing"
        elif not hot and prev.get("firing") and prev.get("notified"):
            event = "resolved"
        if event and send:
            if channels is None:
                channels = list(agreement.notify_channels.filter(enabled=True))
            if channels:
                _send(agreement, rule, entry, prev, event, channels, now)
                entry["sent_at"] = now.isoformat()
                if event == "firing":
                    entry["notified"] = True
        state[name] = entry

    from .models import SlaAgreement

    SlaAgreement.objects.filter(pk=agreement.pk).update(burn_state=state)
    agreement.burn_state = state
    return state


def _json_burn(b):
    return None if b is None else 1e9 if b == float("inf") else b


def _send(agreement, rule, entry, prev, event, channels, now) -> None:
    from .notify import notify_plain

    name = agreement.name
    windows = (f"{_fmt_window(rule['long_min'])} at {_fmt_burn(entry['long'])}, "
               f"{_fmt_window(rule['short_min'])} at {_fmt_burn(entry['short'])}")
    since = entry["since"] if event == "firing" else prev.get("since")
    if event == "firing":
        subject = f"SLA budget burning fast: {name}"
        text = (f"{name} is spending its error budget at {_fmt_burn(entry['short'])} the "
                f"sustainable rate ({windows}; alert at {rule['burn']:g}x)."
                + _lasts(agreement, entry["short"], now))
        severity = "critical" if rule["name"] == "fast" else "warning"
    else:
        subject = f"SLA budget burn resolved: {name}"
        text = f"{name} is back under {rule['burn']:g}x ({windows})."
        severity = "info"
    for ch in channels:
        notify_plain(ch, subject, text, {
            "severity": severity, "kind": "sla", "kicker": "SLA",
            # One key per firing episode, so PagerDuty resolves what it opened.
            "dedup_key": f"sla:{agreement.id}:burn:{rule['name']}:{since}",
            "resolved": event == "resolved",
            "agreement": str(agreement.id), "event": f"burn_{rule['name']}",
            "burn": {"long": entry["long"], "short": entry["short"],
                     "long_min": rule["long_min"], "short_min": rule["short_min"],
                     "threshold": rule["burn"]},
        })


def run(now=None) -> dict:
    """Every active agreement with a rule switched on."""
    from .models import SlaAgreement

    now = now or timezone.now()
    n = failed = 0
    for agreement in SlaAgreement.objects.filter(status="active").select_related("tenant"):
        if not any(r.get("on") for r in agreement.burn_alerts or []):
            if agreement.burn_state:
                SlaAgreement.objects.filter(pk=agreement.pk).update(burn_state={})
            continue
        try:
            evaluate(agreement, now)
            n += 1
        except Exception:  # noqa: BLE001 - one broken agreement must not stop the rest
            failed += 1
            log.exception("SLA burn check failed for agreement %s", agreement.pk)
    return {"agreements": n, "failed": failed}
