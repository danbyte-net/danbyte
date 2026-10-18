"""Turning a caught exception into text a client may see.

``str(exc)`` of an exception nobody planned for can carry a database error,
a file path, a library's internals or a chained cause - detail that belongs
in the server log, not in a toast. Every API that answers with an exception's
message goes through :func:`public_error`:

- an exception the caller names as *expected* - a transport error from a
  server the operator configured, or a domain error written for operators -
  keeps the message it was raised with: its first line, bounded in length,
  an ``OSError``'s reason without the file name it names;
- anything else is logged here with its traceback and answered with the
  caller's fixed ``fallback``.

Validation messages raised as DRF/Django ``ValidationError`` never come
through here; they are already written for the user.
"""
from __future__ import annotations

import logging

logger = logging.getLogger("danbyte.errors")

#: The answer for an exception the caller did not expect.
GENERIC_ERROR = "Something went wrong on the server. The details are in the server log."

#: Transport-level failures talking to a server the operator configured:
#: sockets, DNS, TLS, timeouts, SMTP and every ``requests`` error are
#: ``OSError``; ``ValueError`` covers the SSRF guard's refusal and a reply
#: that does not parse.
NETWORK_ERRORS: tuple[type[BaseException], ...] = (OSError, ValueError)

MAX_LENGTH = 300
_MAX_DEPTH = 3


def exception_text(exc: BaseException) -> str:
    """The message ``exc`` was raised with, or ``""`` when it has none.

    That is its first argument when it is text (for an exception that wraps
    another - ``requests`` does - the wrapped one's), or an ``OSError``'s
    reason. Only the first line, at most :data:`MAX_LENGTH` characters; never
    a repr, a traceback, a chained cause or an ``OSError``'s file name.
    """
    text = ""
    for _ in range(_MAX_DEPTH):
        reason = getattr(exc, "strerror", None) if isinstance(exc, OSError) else None
        if isinstance(reason, str) and reason:
            text = reason
            break
        args = getattr(exc, "args", ())
        first = args[0] if args else None
        if isinstance(first, str):
            text = first
            break
        if not isinstance(first, BaseException):
            break
        exc = first
    lines = text.strip().splitlines()
    line = lines[0].strip() if lines else ""
    if len(line) > MAX_LENGTH:
        line = line[: MAX_LENGTH - 1].rstrip() + "…"
    return line


def public_error(
    exc: BaseException,
    fallback: str = GENERIC_ERROR,
    *,
    expected: type[BaseException] | tuple[type[BaseException], ...] = (),
    log: bool = True,
) -> str:
    """Text about ``exc`` that is safe to return to a client.

    ``expected`` exceptions answer with their own message
    (:func:`exception_text`), or ``fallback`` when they carry none. Any other
    exception is logged with its traceback (unless ``log=False``, for a
    caller that already logged it) and answers ``fallback``.
    """
    if expected and isinstance(exc, expected):
        text = exception_text(exc)
        if text:
            return text
        logger.debug("%s without a message; answered %r", type(exc).__name__, fallback)
        return fallback
    if not log:
        return fallback
    logger.error(
        "Unexpected %s; the client was told %r", type(exc).__name__, fallback,
        exc_info=(type(exc), exc, exc.__traceback__),
    )
    return fallback
