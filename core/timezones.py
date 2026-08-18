"""Timezone names the deployment actually accepts, and legacy aliases.

The picker used to be built from the *browser's* tz database
(``Intl.supportedValuesOf("timeZone")``) while the value was validated against
the *server's*. Those two disagree: many builds of the tz database ship only
canonical zone names, so a browser offering ``Europe/Kiev`` (renamed to
``Europe/Kyiv`` in tzdata 2022b) produced "not a valid IANA timezone" for a
value the app itself had listed — issue #31.

So: the API serves the list, and writes canonicalise the legacy names that
browsers and older stored settings still carry.
"""
from __future__ import annotations

from functools import lru_cache
from zoneinfo import ZoneInfo, available_timezones

#: Legacy IANA names → their current canonical zone. Only entries that a
#: browser may still emit, or that an older Danbyte install may have stored,
#: are worth carrying; anything the local tz database resolves needs no entry.
LEGACY_ALIASES: dict[str, str] = {
    # Renamed zones (tzdata "backward" links).
    "Europe/Kiev": "Europe/Kyiv",
    "Europe/Uzhgorod": "Europe/Kyiv",
    "Europe/Zaporozhye": "Europe/Kyiv",
    "Asia/Calcutta": "Asia/Kolkata",
    "Asia/Saigon": "Asia/Ho_Chi_Minh",
    "Asia/Rangoon": "Asia/Yangon",
    "Asia/Katmandu": "Asia/Kathmandu",
    "Asia/Thimbu": "Asia/Thimphu",
    "Asia/Dacca": "Asia/Dhaka",
    "Asia/Chongqing": "Asia/Shanghai",
    "Asia/Harbin": "Asia/Shanghai",
    "Asia/Istanbul": "Europe/Istanbul",
    "America/Godthab": "America/Nuuk",
    "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
    "America/Argentina/ComodRivadavia": "America/Argentina/Catamarca",
    "Pacific/Ponape": "Pacific/Pohnpei",
    "Pacific/Truk": "Pacific/Chuuk",
    "Pacific/Samoa": "Pacific/Pago_Pago",
    "Atlantic/Faeroe": "Atlantic/Faroe",
    "Australia/Canberra": "Australia/Sydney",
    "Africa/Asmera": "Africa/Asmara",
    "Africa/Timbuktu": "Africa/Bamako",
    # Country-prefixed legacy names.
    "US/Eastern": "America/New_York",
    "US/Central": "America/Chicago",
    "US/Mountain": "America/Denver",
    "US/Pacific": "America/Los_Angeles",
    "US/Alaska": "America/Anchorage",
    "US/Hawaii": "Pacific/Honolulu",
    "US/Arizona": "America/Phoenix",
    "Canada/Eastern": "America/Toronto",
    "Canada/Central": "America/Winnipeg",
    "Canada/Mountain": "America/Edmonton",
    "Canada/Pacific": "America/Vancouver",
    "Canada/Atlantic": "America/Halifax",
    "Brazil/East": "America/Sao_Paulo",
    "Mexico/General": "America/Mexico_City",
    "Japan": "Asia/Tokyo",
    "Singapore": "Asia/Singapore",
    "Hongkong": "Asia/Hong_Kong",
    "Israel": "Asia/Jerusalem",
    "Egypt": "Africa/Cairo",
    "Poland": "Europe/Warsaw",
    "Portugal": "Europe/Lisbon",
    "Turkey": "Europe/Istanbul",
    "Iceland": "Atlantic/Reykjavik",
    "Eire": "Europe/Dublin",
    "GB": "Europe/London",
    "GB-Eire": "Europe/London",
    "NZ": "Pacific/Auckland",
    "PRC": "Asia/Shanghai",
    "ROK": "Asia/Seoul",
    "ROC": "Asia/Taipei",
    "Greenwich": "UTC",
    "Universal": "UTC",
    "Zulu": "UTC",
    "GMT": "UTC",
    "UCT": "UTC",
}


@lru_cache(maxsize=1)
def supported_timezones() -> list[str]:
    """Sorted zone names this deployment resolves — the picker's source."""
    return sorted(available_timezones())


def resolve_timezone(value: str) -> str | None:
    """Canonical zone name for ``value``, or None when it isn't a real zone.

    Accepts anything the local tz database resolves, then falls back to the
    legacy-alias table so a browser (or a settings row written before a zone
    was renamed) doesn't hit a dead end.
    """
    name = (value or "").strip()
    if not name:
        return ""
    try:
        ZoneInfo(name)
        return name
    except (ValueError, KeyError, OSError):
        pass
    canonical = LEGACY_ALIASES.get(name)
    if canonical:
        try:
            ZoneInfo(canonical)
            return canonical
        except (ValueError, KeyError, OSError):
            return None
    return None
