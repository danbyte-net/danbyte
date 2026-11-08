"""Keep credentials out of error text (#459).

An integration's error message can quote the request it failed on: a
transport error names the URL, and a proxy, WAF or server error page often
repeats it, or the headers. When the credential travels in the query string
(PRTG's classic ``?apitoken=``) or a header, that text would carry it into
``last_error``, API answers, toasts, logs and the change log. Every message
built from a remote answer goes through :func:`redact_secrets` first.
"""
from __future__ import annotations

import re
from urllib.parse import quote, quote_plus

REDACTED = "REDACTED"

# Query parameters that carry a credential in the integrations we talk to.
_QUERY_SECRET = re.compile(
    r"(?i)(?<![a-z0-9_])("
    r"apitoken|api_token|apikey|api_key|access_token|auth_token|token|"
    r"passhash|password|passwd|secret"
    r")=[^&\s'\"<>]+"
)
# A bearer credential quoted from request headers; long enough that it is a
# key, not the word in a sentence.
_BEARER = re.compile(r"(?i)(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}")


def redact_secrets(text, *secrets: str) -> str:
    """``text`` with each of ``secrets`` (also URL-encoded) and every
    credential-looking query parameter or bearer token replaced."""
    text = str(text or "")
    for secret in secrets:
        secret = str(secret or "")
        if len(secret) < 4:
            continue  # too short to tell apart from ordinary text
        for form in {secret, quote(secret, safe=""), quote_plus(secret)}:
            text = text.replace(form, REDACTED)
    text = _QUERY_SECRET.sub(lambda m: f"{m.group(1)}={REDACTED}", text)
    return _BEARER.sub(rf"\g<1>{REDACTED}", text)


def redact_value(value, *secrets: str):
    """:func:`redact_secrets` through every string of a JSON-shaped value;
    returns ``(value, changed)``."""
    if isinstance(value, str):
        out = redact_secrets(value, *secrets)
        return out, out != value
    if isinstance(value, list):
        changed = False
        out = []
        for item in value:
            item, c = redact_value(item, *secrets)
            out.append(item)
            changed |= c
        return out, changed
    if isinstance(value, dict):
        changed = False
        out = {}
        for k, item in value.items():
            item, c = redact_value(item, *secrets)
            out[k] = item
            changed |= c
        return out, changed
    return value, False
