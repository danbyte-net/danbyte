"""CLI check on a rendered config (#465): warnings, never a block.

A device template renders text a device will parse. This looks at the leading
keywords of each top-level line of a render and warns about ones the
platform's vocabulary does not know, with a "did you mean" from ``difflib``:
``snmp-server comunity public RO`` → *did you mean ``community``?*

The vocabulary is

- a short bundled seed per platform family (:data:`SEED`) - top-level
  commands only, and for a few of them the words that may follow. It is a
  starting point, not a command reference; anything it lacks is learned or
  ignored;
- plus every top-level command found in the configs this tenant already
  holds for the template's platform: what push tools reported pushing
  (:class:`integrations.models.ConfigPush`) and the intended and running
  configs drift reports carry (:class:`integrations.models.DeviceConfigState`).
  Only configs of devices the caller may view, and never another tenant's.

Only top-level lines (no leading whitespace) are checked: sub-mode lines
depend on the mode they sit in, which the seed does not model. Comments
(``!``, ``#``), banners and blank lines are skipped, a leading ``no`` or
``default`` is looked past, and an unambiguous abbreviation of a known keyword
passes, as the device itself would take it.

Ignores live on the template: ``ignore_lint_patterns`` (``fnmatch`` patterns
matched against the stripped line, case-insensitive; a pattern without a
wildcard ignores lines starting with it), and an inline marker - a template
line holding ``{# lint: ignore #}`` ignores rendered lines that start with
that template line's literal text.
"""
from __future__ import annotations

import difflib
import fnmatch
import re

#: Families the check knows, as the template's ``lint_family`` stores them.
FAMILIES = {"ios": "Cisco IOS / IOS-XE"}

#: Top-level commands per family. A set value lists words that may follow;
#: ``None`` leaves the rest of the line alone. A seed - deliberately short.
SEED: dict[str, dict[str, set[str] | None]] = {
    "ios": {
        "aaa": {"new-model", "authentication", "authorization", "accounting",
                "group", "session-id", "server"},
        "access-list": None,
        "alias": None,
        "archive": None,
        "banner": {"motd", "login", "exec", "incoming", "slip-ppp"},
        "boot": None,
        "cdp": {"run", "timer", "holdtime", "advertise-v2"},
        "class-map": None,
        "clock": {"timezone", "summer-time", "calendar-valid"},
        "control-plane": None,
        "crypto": None,
        "enable": {"secret", "password"},
        "end": None,
        "errdisable": None,
        "event": None,
        "exit": None,
        "hostname": None,
        "interface": None,
        "ip": {"access-list", "address", "cef", "default-gateway", "dhcp",
               "domain", "domain-name", "domain-lookup", "forward-protocol",
               "ftp", "http", "multicast-routing", "name-server", "nat",
               "prefix-list", "route", "routing", "scp", "sla", "ssh", "tacacs",
               "tftp", "vrf", "igmp", "arp", "community-list", "as-path",
               "radius", "flow-export", "source-route", "classless", "bgp-community"},
        "ipv6": {"unicast-routing", "route", "prefix-list", "access-list",
                 "dhcp", "cef", "nd", "multicast-routing", "general-prefix"},
        "key": {"chain"},
        "license": None,
        "line": {"con", "console", "vty", "aux"},
        "lldp": {"run", "timer", "holdtime", "reinit", "tlv-select"},
        "logging": {"buffered", "console", "host", "monitor", "trap", "source-interface",
                    "facility", "on", "origin-id", "discriminator", "event", "rate-limit"},
        "mac": {"address-table"},
        "monitor": {"session"},
        "ntp": {"server", "peer", "source", "authenticate", "authentication-key",
                "trusted-key", "master", "update-calendar", "access-group"},
        "policy-map": None,
        "port-channel": {"load-balance"},
        "radius": {"server"},
        "radius-server": None,
        "route-map": None,
        "router": {"bgp", "ospf", "ospfv3", "eigrp", "isis", "rip"},
        "service": {"timestamps", "password-encryption", "tcp-keepalives-in",
                    "tcp-keepalives-out", "compress-config", "sequence-numbers",
                    "dhcp", "pad", "config", "call-home", "internal", "nagle"},
        "snmp-server": {"community", "location", "contact", "host", "enable",
                        "group", "user", "view", "trap-source", "source-interface",
                        "engineID", "ifindex", "chassis-id", "system-shutdown"},
        "spanning-tree": {"mode", "vlan", "portfast", "extend", "loopguard",
                          "etherchannel", "mst", "pathcost", "uplinkfast",
                          "backbonefast", "bridge"},
        "tacacs": {"server"},
        "tacacs-server": None,
        "username": None,
        "version": None,
        "vlan": None,
        "vrf": {"definition", "context"},
        "vtp": {"mode", "domain", "version", "password", "pruning"},
    },
}

#: The inline ignore marker, as a Jinja comment so it never renders.
INLINE_MARKER = re.compile(r"\{#-?\s*lint\s*:\s*ignore\s*-?#\}", re.IGNORECASE)
#: Text that starts a Jinja construct - the end of a line's literal prefix.
_JINJA_START = re.compile(r"\{[{%#]")
_FAMILY_HINTS = (("ios", re.compile(r"\bios(?:[\s_-]?xe)?\b|\biosxe\b", re.IGNORECASE)),)

#: What a scan reads at most: rows per source and characters per config.
MAX_CONFIGS = 200
MAX_CONFIG_CHARS = 500_000
#: Warnings returned at most for one render.
MAX_WARNINGS = 500
#: Ignore patterns a template may hold, and each one's length.
MAX_PATTERNS = 100
MAX_PATTERN_CHARS = 200


# ── vocabulary ─────────────────────────────────────────────────────────────
def _platforms(tmpl, tenant):
    from .models import Platform

    return Platform.objects.filter(tenant=tenant, config_template=tmpl)


def family_for(tmpl, tenant) -> str:
    """The family to check against: the template's own choice, or for
    ``""`` (auto) the first platform using it as its config template whose
    name or slug reads as a known family. ``""`` = no check."""
    chosen = getattr(tmpl, "lint_family", "") or ""
    if chosen == "off":
        return ""
    if chosen in FAMILIES:
        return chosen
    for name, slug in _platforms(tmpl, tenant).values_list("name", "slug"):
        for family, pattern in _FAMILY_HINTS:
            if pattern.search(name or "") or pattern.search(slug or ""):
                return family
    return ""


def _top_level(text: str):
    """``(tokens, lineno)`` for every checkable top-level line of a config:
    no indent, not a comment, not inside a banner. ``tokens`` are lower-case
    with a leading ``no``/``default`` dropped."""
    banner_end: str | None = None
    for lineno, raw in enumerate(text.splitlines(), start=1):
        if banner_end is not None:
            if banner_end in raw:
                banner_end = None
            continue
        if not raw.strip() or raw[:1].isspace():
            continue
        stripped = raw.strip()
        if stripped[0] in "!#":
            continue
        words = stripped.split()
        low = [w.lower() for w in words]
        if low[0] == "banner" and len(words) >= 3:
            # ``banner motd ^C text… ^C``: the delimiter is the first character
            # of the third word, and the banner runs until it shows up again.
            delim = words[2][:2] if words[2].startswith("^") else words[2][:1]
            rest = stripped.split(None, 2)[2][len(delim):]
            if delim and delim not in rest:
                banner_end = delim
            yield low[:2], lineno
            continue
        if low[0] in ("no", "default") and len(low) > 1:
            low = low[1:]
        yield low, lineno


def learn(text: str, into: dict[str, set[str]]) -> None:
    """Add the top-level commands of ``text`` (and their second word) to
    ``into``."""
    for tokens, _ in _top_level(text[:MAX_CONFIG_CHARS]):
        follow = into.setdefault(tokens[0], set())
        if len(tokens) > 1:
            follow.add(tokens[1])


def learned_vocabulary(tmpl, tenant, user) -> dict[str, set[str]]:
    """Commands from the configs this tenant holds for the template's
    platform (or rendered from this template), on devices ``user`` may
    view."""
    from auth_api import rbac
    from integrations.models import ConfigPush, DeviceConfigState

    from .models import Device

    plats = list(_platforms(tmpl, tenant).values_list("pk", flat=True))
    devices = rbac.restrict_queryset(
        Device.objects.filter(tenant=tenant), user, tenant, "device", "view"
    )
    which = {"template": tmpl}
    into: dict[str, set[str]] = {}

    def rows(model, fields):
        qs = model.objects.filter(tenant=tenant, device__in=devices)
        if plats:
            from django.db.models import Q

            qs = qs.filter(Q(**which) | Q(device__platform__in=plats))
        else:
            qs = qs.filter(**which)
        return qs.order_by("-updated_at").values_list(*fields)[:MAX_CONFIGS]

    for (output,) in rows(ConfigPush, ("output",)):
        learn(output or "", into)
    for intended, actual in rows(DeviceConfigState, ("intended_config", "actual_config")):
        learn(actual or "", into)
        learn(intended or "", into)
    return into


def vocabulary(family: str, learned: dict[str, set[str]]) -> dict[str, set[str] | None]:
    """The seed merged with what was learned. A learned command keeps the
    seed's follow-up words and adds its own; a seed ``None`` stays open."""
    out: dict[str, set[str] | None] = {}
    for cmd, follow in SEED.get(family, {}).items():
        out[cmd] = None if follow is None else set(follow)
    for cmd, follow in learned.items():
        if cmd not in out:
            # A command only seen in configs: its follow-ups are not known
            # well enough to warn about.
            out[cmd] = None
        elif out[cmd] is not None:
            out[cmd] |= follow
    return out


# ── ignores ────────────────────────────────────────────────────────────────
def inline_ignores(template_code: str) -> list[str]:
    """Literal prefixes of template lines carrying the inline marker,
    lower-case and whitespace-normalised."""
    out = []
    for line in (template_code or "").splitlines():
        if not INLINE_MARKER.search(line):
            continue
        literal = _JINJA_START.split(line, 1)[0]
        prefix = " ".join(literal.split()).lower()
        if prefix:
            out.append(prefix)
    return out


def _ignored(line: str, patterns: list[str], prefixes: list[str]) -> bool:
    norm = " ".join(line.split()).lower()
    if any(norm.startswith(prefix) for prefix in prefixes):
        return True
    for pattern in patterns:
        p = pattern.strip().lower()
        if not p:
            continue
        if any(c in p for c in "*?["):
            if fnmatch.fnmatchcase(norm, p):
                return True
        elif norm == p or norm.startswith(p + " "):
            return True
    return False


def clean_patterns(value) -> list[str]:
    """``ignore_lint_patterns`` as stored: a list of short strings."""
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise ValueError("A list of patterns.")
    if len(value) > MAX_PATTERNS:
        raise ValueError(f"At most {MAX_PATTERNS} patterns.")
    out = []
    for item in value:
        if not isinstance(item, str):
            raise ValueError("Each pattern is text.")
        item = item.strip()
        if len(item) > MAX_PATTERN_CHARS:
            raise ValueError(f"A pattern is at most {MAX_PATTERN_CHARS} characters.")
        if item and item not in out:
            out.append(item)
    return out


# ── the check ──────────────────────────────────────────────────────────────
def _known(word: str, words) -> bool:
    """``word`` is a keyword, or an abbreviation only one keyword starts
    with (``int`` → ``interface``)."""
    if word in words:
        return True
    if len(word) < 2:
        return False
    return sum(1 for w in words if w.startswith(word)) == 1


def _hint(word: str, words) -> str | None:
    match = difflib.get_close_matches(word, list(words), n=1, cutoff=0.75)
    return match[0] if match else None


def check_text(text: str, vocab: dict[str, set[str] | None], *, patterns=(),
               prefixes=()) -> list[dict]:
    """Warnings for ``text`` against ``vocab``: ``{line, keyword, message,
    suggestion}``."""
    warnings: list[dict] = []
    lines = text.splitlines()
    for tokens, lineno in _top_level(text):
        if len(warnings) >= MAX_WARNINGS:
            break
        if _ignored(lines[lineno - 1], list(patterns), list(prefixes)):
            continue
        first = tokens[0]
        if not _known(first, vocab):
            hint = _hint(first, vocab)
            warnings.append({
                "line": lineno, "keyword": first, "suggestion": hint,
                "message": f"Unknown command {first!r}"
                + (f" - did you mean {hint!r}?" if hint else "."),
            })
            continue
        cmd = first if first in vocab else next(w for w in vocab if w.startswith(first))
        follow = vocab.get(cmd)
        if not follow or len(tokens) < 2:
            continue
        second = tokens[1]
        if _known(second, follow):
            continue
        hint = _hint(second, follow)
        warnings.append({
            "line": lineno, "keyword": f"{cmd} {second}", "suggestion": hint,
            "message": f"Unknown {cmd!r} option {second!r}"
            + (f" - did you mean {hint!r}?" if hint else "."),
        })
    return warnings


def lint_render(tmpl, tenant, user, output: str) -> dict:
    """The check's answer for one render of ``tmpl``."""
    family = family_for(tmpl, tenant)
    if not family:
        return {"family": "", "family_label": "", "warnings": [], "learned": 0}
    learned = learned_vocabulary(tmpl, tenant, user)
    vocab = vocabulary(family, learned)
    warnings = check_text(
        output, vocab,
        patterns=getattr(tmpl, "ignore_lint_patterns", None) or [],
        prefixes=inline_ignores(tmpl.template_code),
    )
    return {
        "family": family,
        "family_label": FAMILIES[family],
        "warnings": warnings,
        "learned": len(learned),
    }
