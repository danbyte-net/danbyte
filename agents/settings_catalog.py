"""Where a setting lives, for the assistant.

The SPA declares every settings page and card in
``frontend/src/lib/settings-catalog.json`` - one file, because two languages
read it. The sidebar, the hub grid and the settings search are built from it
there; this module reads the same file so "where do I turn on LDAP sync?"
answers with the page a person can actually open, rather than a URL an
assistant guessed at.

Reading the SPA's file rather than keeping a Python copy is the whole point:
a copy drifts, and a wrong path is worse than no answer.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from django.conf import settings

CATALOG = Path(settings.BASE_DIR) / "frontend" / "src" / "lib" / "settings-catalog.json"


@lru_cache(maxsize=1)
def _catalog() -> dict:
    """The catalog, or an empty one where the SPA source is not deployed.

    A packaged install ships the built assets, not `src/`, so this must
    degrade rather than raise - the tool then says it cannot look settings
    up, which is honest, instead of 500ing a whole conversation.
    """
    try:
        return json.loads(CATALOG.read_text())
    except (OSError, ValueError):
        return {"groups": [], "pages": [], "cards": []}


def available() -> bool:
    return bool(_catalog()["pages"])


# Words that carry no signal in "where do I set the timezone".
_NOISE = {
    "the", "a", "an", "is", "are", "do", "does", "how", "where", "what",
    "can", "set", "change", "turn", "for", "of", "to", "in", "on", "my",
    "this", "that", "and", "with", "settings", "setting", "danbyte",
}


def _words(text: str) -> list[str]:
    return [
        w
        for w in "".join(c if c.isalnum() else " " for c in text.lower()).split()
        if len(w) > 1 and w not in _NOISE
    ]


def _score(query: str, *fields: str) -> int:
    """How well a query matches, best-first.

    Every word mattering was too strict for a question: "where do I set the
    timezone" and "ldap sync" both scored nothing because one word was
    missing. So noise words are dropped and the rest are counted - a match
    on more of them ranks higher, and a hit on the label beats a hit buried
    in the keywords.
    """
    words = _words(query)
    if not words:
        return 0
    label = (fields[0] or "").lower()
    haystack = " ".join(f or "" for f in fields).lower()
    matched = [w for w in words if w in haystack]
    if not matched:
        return 0

    score = 10 * len(matched)
    if len(matched) == len(words):
        score += 15
    if label == " ".join(words):
        score += 60
    elif any(w in label for w in matched):
        score += 25
    return score


def find(query: str, limit: int = 8) -> list[dict]:
    """Settings matching ``query``, best first.

    Cards come back with the page they sit on and the anchor that scrolls to
    them, so an answer can hand over a link a person can click.
    """
    data = _catalog()
    pages = {p["key"]: p for p in data["pages"]}
    hits: list[tuple[int, dict]] = []

    for card in data["cards"]:
        page = pages.get(card["page"])
        if page is None:
            continue
        score = _score(
            query, card["label"], card["description"], " ".join(card["keywords"])
        )
        if score:
            hits.append((score + 5, {  # a card is more specific than its page
                "setting": card["label"],
                "what": card["description"],
                "page": page["label"],
                "url": f"{page['to']}#{anchor(card['label'])}",
                "scopes": page["scopes"],
            }))

    for page in data["pages"]:
        score = _score(
            query, page["label"], page["description"], " ".join(page["keywords"])
        )
        if score:
            hits.append((score, {
                "setting": page["label"],
                "what": page["description"],
                "page": page["label"],
                "url": page["to"],
                "scopes": page["scopes"],
            }))

    hits.sort(key=lambda h: -h[0])
    return [h[1] for h in hits[:limit]]


def anchor(label: str) -> str:
    """The id a card renders with - mirrors `cardAnchor` in settings-card.tsx."""
    out = []
    for ch in label.lower().replace("&", " and "):
        out.append(ch if ch.isalnum() else "-")
    slug = "".join(out)
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug.strip("-")
