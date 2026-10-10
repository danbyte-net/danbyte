"""End-of-life data sources (#8): a small registry, endoflife.date first.

A source turns its payload into normalised products::

    {"name", "label", "category", "aliases": [...], "releases": [
        {"name", "label", "release_date", "support_until", "eol_date",
         "eol", "lts", "latest"},
    ]}

Dates are ISO strings or ``None``; ``eol`` is the source's own flag (``None``
when it does not say). Fetching goes through :mod:`core.ssrf`, so a base URL
that resolves to a private address is refused unless a deployment admin has
allow-listed it. A source also parses the same payload from an uploaded file,
which is how an airgapped install gets the data.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

#: A catalog download is a few MB today; refuse anything far beyond that.
MAX_BYTES = 64 * 1024 * 1024
FETCH_TIMEOUT = 60

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class EolSourceError(ValueError):
    """The source could not be fetched or its payload is unusable."""


def _date(value) -> str | None:
    if isinstance(value, str) and _DATE.match(value[:10]):
        return value[:10]
    return None


def _flag(value) -> bool | None:
    return value if isinstance(value, bool) else None


@dataclass(frozen=True)
class EolSource:
    key: str
    label: str
    default_url: str
    homepage: str = ""

    def url(self, configured: str = "") -> str:
        return (configured or self.default_url).rstrip("/")

    def fetch(self, base_url: str = "") -> list[dict]:
        raise NotImplementedError

    def parse(self, payload) -> list[dict]:
        raise NotImplementedError


class EndOfLifeDate(EolSource):
    """https://endoflife.date - API v1. One request,
    ``/api/v1/products/full``, carries every product with its releases; the
    same JSON saved to a file is the offline import."""

    def fetch(self, base_url: str = "") -> list[dict]:
        from core.ssrf import safe_get

        url = f"{self.url(base_url)}/api/v1/products/full"
        resp = safe_get(
            url, timeout=FETCH_TIMEOUT, stream=True,
            headers={"Accept": "application/json"},
        )
        if resp.status_code != 200:
            raise EolSourceError(f"{url} answered HTTP {resp.status_code}.")
        chunks, size = [], 0
        for chunk in resp.iter_content(1024 * 256):
            size += len(chunk)
            if size > MAX_BYTES:
                raise EolSourceError("The catalog is larger than 64 MB.")
            chunks.append(chunk)
        return self.parse(load_json(b"".join(chunks)))

    def parse(self, payload) -> list[dict]:
        if isinstance(payload, dict):
            items = payload.get("result", payload)
        else:
            items = payload
        if isinstance(items, dict):
            items = [items]  # one product: /api/v1/products/<name>
        if not isinstance(items, list):
            raise EolSourceError("Expected an endoflife.date API v1 product list.")
        out = []
        for item in items:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()[:128]
            releases = item.get("releases")
            if not name or not isinstance(releases, list):
                continue
            out.append({
                "name": name,
                "label": str(item.get("label") or name)[:200],
                "category": str(item.get("category") or "")[:64],
                "aliases": [str(a)[:128] for a in item.get("aliases") or []
                            if isinstance(a, str)][:50],
                "releases": [r for r in map(self._release, releases) if r],
            })
        if not out:
            raise EolSourceError(
                "No products with releases found - expected the JSON of "
                "endoflife.date /api/v1/products/full."
            )
        return out

    @staticmethod
    def _release(r) -> dict | None:
        if not isinstance(r, dict) or not r.get("name"):
            return None
        latest = r.get("latest")
        latest_name = latest.get("name") if isinstance(latest, dict) else latest
        return {
            "name": str(r["name"])[:64],
            "label": str(r.get("label") or r["name"])[:200],
            "release_date": _date(r.get("releaseDate")),
            "support_until": _date(r.get("eoasFrom")),
            "eol_date": _date(r.get("eolFrom")),
            "eol": _flag(r.get("isEol")),
            "lts": bool(r.get("isLts")),
            "latest": str(latest_name or "")[:64],
        }


def load_json(raw: bytes):
    try:
        return json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise EolSourceError(f"Not valid JSON: {exc}") from exc


SOURCES: dict[str, EolSource] = {}


def register_source(source: EolSource) -> None:
    """Add a source. Plugins may call this from their registration module."""
    SOURCES[source.key] = source


def get_source(key: str) -> EolSource:
    try:
        return SOURCES[key]
    except KeyError:
        raise EolSourceError(f"Unknown end-of-life source '{key}'.") from None


register_source(EndOfLifeDate(
    key="endoflife_date",
    label="endoflife.date",
    default_url="https://endoflife.date",
    homepage="https://endoflife.date",
))
