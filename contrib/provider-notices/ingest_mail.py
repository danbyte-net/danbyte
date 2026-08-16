#!/usr/bin/env python3
"""Reference parser: provider notification mail → Danbyte maintenance event.

The netbox-notices pattern: parsing lives OUTSIDE Danbyte, next to the people
who know their carriers' formats, and talks to one stable endpoint:

    POST /api/monitoring/maintenance-events/ingest/

This script is the working starting point, stdlib only. Two modes:

    # One-shot, for developing a parser (also great in CI):
    ingest_mail.py --file examples/carrierone.eml

    # Poll a mailbox (run from cron / a systemd timer):
    ingest_mail.py --imap imap.example.com --user notices@example.com \
        --folder INBOX

Configuration via environment:
    DANBYTE_URL     e.g. https://danbyte.example.com
    DANBYTE_TOKEN   an API token with maintenanceevent add+change
    IMAP_PASSWORD   only for --imap mode

Add a provider by writing one function and registering it in PARSERS below.
A parser gets the email.message.Message and returns the ingest payload dict,
or None when the mail isn't one of its notifications. `external_ref` is the
upsert key: re-delivered revisions update the event instead of duplicating it.
"""
from __future__ import annotations

import argparse
import email
import email.policy
import imaplib
import json
import os
import re
import ssl
import sys
import urllib.request

DANBYTE_URL = os.environ.get("DANBYTE_URL", "").rstrip("/")
DANBYTE_TOKEN = os.environ.get("DANBYTE_TOKEN", "")


# ── Danbyte API helpers ─────────────────────────────────────────────────────

def api(method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(
        f"{DANBYTE_URL}{path}",
        method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={
            "Authorization": f"Token {DANBYTE_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    ctx = ssl.create_default_context()
    if os.environ.get("DANBYTE_INSECURE") == "1":  # lab/self-signed only
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(req, context=ctx) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def circuit_impact(cid: str, level: str = "outage") -> dict | None:
    """Map a carrier's circuit id to a Danbyte circuit → one impact row.
    Returns None (and the event still ingests) when the cid is unknown."""
    _, data = api("GET", f"/api/circuits/?search={urllib.parse.quote(cid)}")
    for row in data.get("results", []):
        if row.get("cid") == cid:
            return {"object_type": "circuit", "object_id": row["id"],
                    "level": level, "note": f"carrier circuit {cid}"}
    return None


# ── Per-provider parsers ────────────────────────────────────────────────────
# One function per provider format. Return the ingest payload, or None when
# the mail isn't a notification this parser understands.

def parse_carrierone(msg: email.message.Message) -> dict | None:
    """CarrierOne: "Planned Work Notification [CARR1-…]" with a key: value body.

        Reference:   CARR1-2026-08421
        Type:        maintenance | outage
        Status:      confirmed
        Start:       2026-08-19 22:00 UTC
        End:         2026-08-20 04:00 UTC
        Circuit ID:  DK-31-0042
        Summary:     Fiber splice work — metro ring west
    """
    subject = msg.get("Subject", "")
    m = re.search(r"\[(CARR1-[A-Z0-9-]+)\]", subject)
    if not m:
        return None
    body = msg.get_body(preferencelist=("plain",))
    text = body.get_content() if body else ""
    field = lambda name: (  # noqa: E731 — tiny, local
        re.search(rf"^{name}:\s*(.+)$", text, re.M | re.I) or [None, ""]
    )[1].strip()

    def when(name):
        raw = field(name)
        m2 = re.match(r"(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC", raw)
        return f"{m2.group(1)}T{m2.group(2)}:00Z" if m2 else None

    payload = {
        "provider": "carrierone",
        "external_ref": m.group(1),
        "kind": field("Type") or "maintenance",
        "status": field("Status") or "tentative",
        "name": field("Summary") or subject,
        "description": text.strip(),
        "starts_at": when("Start"),
        "ends_at": when("End"),
        "raw_email": msg.as_string(),
    }
    cid = field("Circuit ID")
    if cid:
        impact = circuit_impact(cid)
        if impact:
            payload["impacts"] = [impact]
    return {k: v for k, v in payload.items() if v is not None}


PARSERS = {
    "carrierone": parse_carrierone,
    # "acme_telecom": parse_acme_telecom,
}


# ── Drivers ─────────────────────────────────────────────────────────────────

def ingest(msg: email.message.Message) -> bool:
    for name, parse in PARSERS.items():
        payload = parse(msg)
        if payload is None:
            continue
        code, data = api(
            "POST", "/api/monitoring/maintenance-events/ingest/", payload
        )
        verb = {200: "updated", 201: "created"}.get(code, f"HTTP {code}")
        print(f"[{name}] {payload['external_ref']}: {verb}"
              + ("" if code in (200, 201) else f" — {data}"))
        return code in (200, 201)
    print(f"skipped (no parser matched): {msg.get('Subject', '')!r}")
    return False


def run_file(path: str) -> int:
    with open(path, "rb") as f:
        msg = email.message_from_binary_file(f, policy=email.policy.default)
    return 0 if ingest(msg) else 1


def run_imap(host: str, user: str, folder: str) -> int:
    password = os.environ["IMAP_PASSWORD"]
    box = imaplib.IMAP4_SSL(host)
    box.login(user, password)
    box.select(folder)
    _, data = box.search(None, "UNSEEN")
    failures = 0
    for num in data[0].split():
        _, raw = box.fetch(num, "(RFC822)")
        msg = email.message_from_bytes(raw[0][1], policy=email.policy.default)
        if not ingest(msg):
            failures += 1
            box.store(num, "-FLAGS", "\\Seen")  # retry next run
    box.logout()
    return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--file", help="Parse one .eml file and exit")
    ap.add_argument("--imap", help="IMAP host to poll")
    ap.add_argument("--user", help="IMAP username")
    ap.add_argument("--folder", default="INBOX")
    args = ap.parse_args()
    if not DANBYTE_URL or not DANBYTE_TOKEN:
        ap.error("set DANBYTE_URL and DANBYTE_TOKEN")
    if args.file:
        return run_file(args.file)
    if args.imap and args.user:
        return run_imap(args.imap, args.user, args.folder)
    ap.error("pass --file or --imap + --user")
    return 2


if __name__ == "__main__":
    sys.exit(main())
