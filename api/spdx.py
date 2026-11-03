"""SPDX licence expressions, checked loosely.

A licence on an application, an install or a platform is an SPDX licence
expression: ``MIT``, ``Apache-2.0``, ``GPL-2.0-or-later WITH
Classpath-exception-2.0``, ``(MIT OR Apache-2.0) AND BSD-3-Clause``,
``LicenseRef-acme-eula``. The check is the grammar only - identifiers,
``AND`` / ``OR`` / ``WITH`` and parentheses - not the SPDX licence list, so
a new identifier never needs a release.

``license_entry`` turns a stored value into its CycloneDX form: a single
identifier as ``{"license": {"id": …}}``, anything else as
``{"expression": …}``.
"""
from __future__ import annotations

import re

from django.core.exceptions import ValidationError

MAX_LENGTH = 255

#: An SPDX short identifier (``GPL-2.0+`` included), a ``LicenseRef-`` or a
#: ``DocumentRef-…:LicenseRef-…``.
_ID = re.compile(
    r"(?:DocumentRef-[A-Za-z0-9.\-]+:)?LicenseRef-[A-Za-z0-9.\-]+"
    r"|[A-Za-z0-9][A-Za-z0-9.\-]*\+?"
)
_TOKEN = re.compile(r"\s*(\(|\)|[^\s()]+)")
_OPERATORS = {"AND", "OR", "WITH"}


def _tokens(value: str) -> list[str]:
    out, pos = [], 0
    while pos < len(value):
        m = _TOKEN.match(value, pos)
        if m is None:  # trailing whitespace only
            break
        out.append(m.group(1))
        pos = m.end()
    return out


class _Parser:
    def __init__(self, tokens: list[str]):
        self.tokens, self.pos = tokens, 0

    def peek(self) -> str | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def take(self) -> str | None:
        tok = self.peek()
        self.pos += 1
        return tok

    def identifier(self, what: str) -> None:
        tok = self.take()
        if tok is None:
            raise ValidationError(f"The expression ends where {what} should be.")
        if tok in _OPERATORS or tok in "()":
            raise ValidationError(f"Expected {what}, found “{tok}”.")
        if tok.upper() in _OPERATORS:
            raise ValidationError(f"Write the operator in capitals: {tok.upper()}.")
        if not _ID.fullmatch(tok):
            raise ValidationError(f"“{tok}” is not an SPDX licence identifier.")

    def term(self) -> None:
        if self.peek() == "(":
            self.take()
            self.expression()
            if self.take() != ")":
                raise ValidationError("A parenthesis is not closed.")
            return
        self.identifier("a licence")
        if self.peek() == "WITH":
            self.take()
            self.identifier("an exception")

    def expression(self) -> None:
        self.term()
        while self.peek() in ("AND", "OR"):
            self.take()
            self.term()


def validate_license_expression(value: str) -> None:
    """Raise ``ValidationError`` unless ``value`` is blank or reads as an SPDX
    licence expression."""
    value = (value or "").strip()
    if not value:
        return
    if len(value) > MAX_LENGTH:
        raise ValidationError(f"At most {MAX_LENGTH} characters.")
    parser = _Parser(_tokens(value))
    parser.expression()
    rest = parser.peek()
    if rest is not None:
        if rest == ")":
            raise ValidationError("A closing parenthesis has no opening one.")
        if rest.upper() in _OPERATORS:
            raise ValidationError(f"Write the operator in capitals: {rest.upper()}.")
        raise ValidationError("Join licences with AND, OR or WITH.")


def is_single_id(value: str) -> bool:
    """One SPDX list identifier - not an expression, not a ``LicenseRef-``
    (the CycloneDX ``license.id`` takes list identifiers only)."""
    value = (value or "").strip()
    return (
        bool(value) and _ID.fullmatch(value) is not None
        and not value.endswith("+") and "LicenseRef-" not in value
    )


def license_entry(value: str) -> dict | None:
    """The CycloneDX ``licenses`` entry for a stored value; ``None`` for a
    blank one."""
    value = (value or "").strip()
    if not value:
        return None
    if is_single_id(value):
        return {"license": {"id": value}}
    return {"expression": value}
