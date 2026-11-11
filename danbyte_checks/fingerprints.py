"""Service fingerprints for the service scan (#451 B3). Django-free.

Two sources, tried in this order for each piece of evidence:

1. ``danbyte`` - a short list of our own rules (:data:`RULES`) for the
   servers seen most;
2. ``recog`` - Rapid7 Recog's fingerprint data (BSD-2-Clause), converted at
   build time to ``data/recog.json`` by ``scripts/recog_build.py``. Pinned
   by tag and commit; every source file's SHA-256 is in the JSON's ``meta``
   and in ``data/RECOG-NOTICE``. No XML parser runs here.

Every pattern is applied to at most :data:`INPUT_CAP` characters of text the
host sent (control characters already stripped by the caller), and every
Recog pattern was timed against hostile inputs of that length at build time
(slow ones are not in the file). Nothing here is ever evaluated, only
matched.

A match gives ``{vendor, product, version, cpe, os, source, rule}``; the
CPE is CPE 2.3 (Recog writes CPE 2.2 URIs, converted here).
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

INPUT_CAP = 512
DATA = Path(__file__).resolve().parent / "data" / "recog.json"
#: Evidence kinds, and the text they match.
KINDS = ("ssh.banner", "ftp.banner", "smtp.banner", "imap.banner", "pop.banner",
         "telnet.banner", "http.server", "http.x_powered_by", "http.title")

# (kind, pattern, vendor, product, version group or None, CPE 2.3 vendor:product)
_R = [
    ("ssh.banner", r"^OpenSSH_([0-9][0-9A-Za-z.]{0,20})", "OpenBSD", "OpenSSH", 1,
     "openbsd:openssh"),
    ("ssh.banner", r"^dropbear_([0-9][0-9.]{0,20})", "Matt Johnston", "Dropbear SSH", 1,
     "dropbear_ssh_project:dropbear_ssh"),
    ("http.server", r"^nginx(?:/([0-9][0-9.]{0,20}))?", "F5", "nginx", 1, "f5:nginx"),
    ("http.server", r"^Apache(?:/([0-9][0-9.]{0,20}))?", "Apache", "HTTP Server", 1,
     "apache:http_server"),
    ("http.server", r"^Microsoft-IIS/([0-9][0-9.]{0,10})", "Microsoft", "IIS", 1,
     "microsoft:internet_information_services"),
    ("http.server", r"^lighttpd(?:/([0-9][0-9.]{0,20}))?", "lighttpd", "lighttpd", 1,
     "lighttpd:lighttpd"),
    ("http.server", r"^Caddy$", "Caddy", "Caddy", None, "caddyserver:caddy"),
    ("ftp.banner", r"^\(vsFTPd ([0-9][0-9.]{0,20})\)", "vsftpd", "vsftpd", 1,
     "vsftpd_project:vsftpd"),
    ("ftp.banner", r"ProFTPD(?: ([0-9][0-9A-Za-z.]{0,20}))? Server", "ProFTPD", "ProFTPD", 1,
     "proftpd:proftpd"),
    ("smtp.banner", r"\bESMTP Postfix\b", "Postfix", "Postfix", None, "postfix:postfix"),
    ("smtp.banner", r"\bESMTP Exim ([0-9][0-9.]{0,20})", "Exim", "Exim", 1, "exim:exim"),
    ("imap.banner", r"\bDovecot\b", "Dovecot", "Dovecot", None, "dovecot:dovecot"),
    ("pop.banner", r"\bDovecot\b", "Dovecot", "Dovecot", None, "dovecot:dovecot"),
]
RULES = [(k, re.compile(p), v, pr, g, c) for k, p, v, pr, g, c in _R]

_CPE_CHARS = re.compile(r"[^a-z0-9._\-~%*]")


def cpe23(uri: str, version: str = "") -> str:
    """``cpe:/a:vendor:product:version`` (CPE 2.2 URI) or a CPE 2.3 name ->
    a CPE 2.3 formatted string; "" when it is not one."""
    uri = (uri or "").strip()
    if uri.startswith("cpe:2.3:"):
        parts = uri.split(":")
    elif uri.startswith("cpe:/"):
        parts = ["cpe", "2.3", *uri[5:].split(":")]
    else:
        return ""
    if len(parts) < 5 or parts[2] not in ("a", "o", "h"):
        return ""
    out = [_CPE_CHARS.sub("_", p.lower())[:100] for p in parts[2:5]]
    ver = parts[5] if len(parts) > 5 else (version or "*")
    ver = _CPE_CHARS.sub("_", (ver or "*").lower())[:60] or "*"
    if ver == "-" and version:
        ver = _CPE_CHARS.sub("_", version.lower())[:60]
    if not out[1] or not out[2]:
        return ""
    return ":".join(["cpe", "2.3", *out, ver, *["*"] * 7])


@lru_cache(maxsize=1)
def _recog() -> dict[str, list]:
    """``{kind: [(compiled, params)]}``, loaded once."""
    try:
        raw = json.loads(DATA.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    out: dict[str, list] = {}
    for kind, rows in (raw.get("databases") or {}).items():
        compiled = []
        for row in rows:
            try:
                compiled.append((re.compile(row["p"], int(row.get("f") or 0)),
                                 row.get("params") or [], row.get("d") or ""))
            except (re.error, KeyError, TypeError, ValueError):
                continue
        out[kind] = compiled
    return out


def recog_meta() -> dict:
    try:
        return json.loads(DATA.read_text(encoding="utf-8")).get("meta") or {}
    except (OSError, ValueError):
        return {}


def _interp(params, m) -> dict:
    out = {}
    for pos, name, value in params:
        if pos == 0:
            out[name] = value
        else:
            try:
                got = m.group(pos)
            except (IndexError, re.error):
                got = None
            if got:
                out[name] = got
    for name, value in list(out.items()):
        if "{" in value:
            out[name] = re.sub(r"\{([a-z0-9_.]+)\}", lambda g: out.get(g.group(1), "-"), value)
    return out


def _clip(value, n=128) -> str:
    return str(value or "").strip()[:n]


def match(kind: str, text: str) -> dict | None:
    """The first fingerprint of ``kind`` that ``text`` matches."""
    if kind not in KINDS or not text:
        return None
    text = text[:INPUT_CAP]
    for k, rx, vendor, product, group, cpe in RULES:
        if k != kind:
            continue
        m = rx.search(text)
        if m is None:
            continue
        version = _clip(m.group(group)) if group and m.group(group) else ""
        part = "a"
        return {"vendor": vendor, "product": product, "version": version,
                "cpe": cpe23(f"cpe:/{part}:{cpe}:{version or '-'}"),
                "os": "", "source": "danbyte", "rule": f"{product}"}
    for rx, params, desc in _recog().get(kind, []):
        m = rx.search(text)
        if m is None:
            continue
        got = _interp(params, m)
        product = got.get("service.product") or got.get("service.family") or ""
        if not product:
            continue
        version = _clip(got.get("service.version"), 64)
        os_bits = " ".join(x for x in (got.get("os.product"), got.get("os.version")) if x)
        return {"vendor": _clip(got.get("service.vendor")), "product": _clip(product),
                "version": version, "cpe": cpe23(got.get("service.cpe23") or "", version),
                "os": _clip(os_bits), "source": "recog", "rule": _clip(desc, 200)}
    return None
