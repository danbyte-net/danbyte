"""Vendor links written into a type's description as Markdown.

The community device type library (and the model packs built from it) put a
type's vendor links in its ``comments`` as Markdown - ``[Data Sheet](https://…)``
- and the importers store ``comments`` as the description. :func:`split`
takes those links out: the description keeps the plain text, the links
become link Documents on the type (``api.model_pack_update.apply_links``).

Pure text work: no database, no network. A link is an inline Markdown link
``[label](http(s)://…)`` (balanced parentheses in the URL, an optional
``"title"``) or an autolink ``<https://…>``; an image ``![…](…)`` and any
other scheme are left as they are, and so is a link whose URL is not one a
pack may attach (``link_url``: a public http(s) host, no credentials, at
most 2048 characters) - its text stays, nothing is lost. The frontend twin
of the text part is ``frontend/src/lib/description-links.ts``.
"""
from __future__ import annotations

import re

from .model_pack_update import LINK_KINDS, link_url

URL_CAP = 2048
TITLE_CAP = 255

# What may surround the links in a description that is "only links": list
# bullets, numbering, separators.
_NUMBERING = re.compile(r"(?m)^\s*\d+[.)]\s+")
_ONLY_SEPARATORS = re.compile(r"[\s\-*+•·|,;/.]*")
_SPACES = re.compile(r"[ \t]+")
_BLANK_LINES = re.compile(r"\n{3,}")

# Title words -> a meta.links kind; first match wins, else "other".
_KIND_WORDS = (
    ("datasheet", re.compile(r"\bdata[\s-]?sheet\b", re.I)),
    ("install-guide", re.compile(r"\binstall(ation)?\s+guide\b", re.I)),
    ("config-guide", re.compile(r"\bconfig(uration)?\s+guide\b", re.I)),
    ("eol-notice", re.compile(r"\bend[\s-]of[\s-](life|sale)\b|\beol\b", re.I)),
)


def _url_end(text: str, i: int) -> int | None:
    """Index just past the ``)`` closing an inline link's destination that
    starts at ``i`` (just after the ``(``), or None. Parentheses inside the
    URL must balance; an optional ``"title"`` may follow it."""
    n = len(text)
    depth = 0
    j = i
    while j < n and text[j] not in " \t\n":
        c = text[j]
        if c == "(":
            depth += 1
        elif c == ")":
            if depth == 0:
                return j + 1
            depth -= 1
        j += 1
    # Whitespace: an optional "title" or 'title', then ")".
    while j < n and text[j] in " \t":
        j += 1
    if j < n and text[j] in "\"'":
        close = text.find(text[j], j + 1)
        if close < 0 or "\n" in text[j:close]:
            return None
        j = close + 1
        while j < n and text[j] in " \t":
            j += 1
    return j + 1 if j < n and text[j] == ")" else None


def _destination(raw: str) -> str:
    """The URL of an inline link's ``(…)`` contents, without its title."""
    return raw.split(None, 1)[0] if raw.strip() else ""


def _label_end(text: str, i: int) -> int | None:
    """Index of the ``]`` closing a label opened at ``i`` (the ``[``)."""
    depth = 0
    for j in range(i, len(text)):
        c = text[j]
        if c == "\n" and j + 1 < len(text) and text[j + 1] == "\n":
            return None  # a label never spans a paragraph
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return j
    return None


def _http(url: str) -> bool:
    return url.lower().startswith(("http://", "https://"))


def split(text) -> tuple[str, list[tuple[str, str]]]:
    """``(plain_text, [(title, url), …])`` of a description.

    Plain text: nothing but links (and bullets, separators, whitespace) is
    ``""``; otherwise each link becomes its label (an autolink its URL) and
    the whitespace is tidied. Text with no link comes back unchanged. Links
    are unique by URL, in order."""
    text = "" if text is None else str(text)
    out: list[str] = []  # the text, each link swapped for its label
    bare: list[str] = []  # the text without the links at all
    links: list[tuple[str, str]] = []
    seen: set[str] = set()
    found = False
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "!" and i + 1 < n and text[i + 1] == "[":
            # An image: kept as written, its link not taken.
            end = _label_end(text, i + 1)
            if end is not None and end + 1 < n and text[end + 1] == "(":
                close = _url_end(text, end + 2)
                if close is not None:
                    out.append(text[i:close])
                    bare.append(text[i:close])
                    i = close
                    continue
            out.append(c)
            bare.append(c)
            i += 1
            continue
        if c == "[":
            end = _label_end(text, i)
            if end is not None and end + 1 < n and text[end + 1] == "(":
                close = _url_end(text, end + 2)
                if close is not None:
                    url = _destination(text[end + 2:close - 1])
                    good = link_url(url, URL_CAP) if _http(url) else None
                    if good:
                        label = " ".join(text[i + 1:end].split())
                        found = True
                        out.append(label)
                        if good not in seen:
                            seen.add(good)
                            links.append(((label or good)[:TITLE_CAP], good))
                    else:
                        out.append(text[i:close])
                        bare.append(text[i:close])
                    i = close
                    continue
        if c == "<":
            close = text.find(">", i + 1)
            url = text[i + 1:close] if close > 0 else ""
            if url and _http(url) and not any(ch.isspace() for ch in url):
                good = link_url(url, URL_CAP)
                if good:
                    found = True
                    out.append(good)
                    if good not in seen:
                        seen.add(good)
                        links.append((good[:TITLE_CAP], good))
                    i = close + 1
                    continue
        out.append(c)
        bare.append(c)
        i += 1
    if not found:
        return text, []
    if _ONLY_SEPARATORS.fullmatch(_NUMBERING.sub("", "".join(bare))):
        return "", links
    return tidy("".join(out)), links


def tidy(text: str) -> str:
    """Runs of spaces and tabs as one, lines trimmed, at most one blank line."""
    lines = [_SPACES.sub(" ", line).strip() for line in text.split("\n")]
    return _BLANK_LINES.sub("\n\n", "\n".join(lines)).strip()


def link_kind(title: str) -> str:
    """The ``meta.links`` kind a link title suggests, else ``"other"``."""
    for kind, words in _KIND_WORDS:
        if kind in LINK_KINDS and words.search(title or ""):
            return kind
    return "other"


def link_rows(links) -> list[dict]:
    """``(title, url)`` pairs as ``meta.links`` rows for ``apply_links``."""
    return [{"kind": link_kind(title), "title": title, "url": url} for title, url in links]
