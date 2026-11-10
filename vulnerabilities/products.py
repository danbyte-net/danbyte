"""Which products the store keeps records for (#451).

An NVD year feed names tens of thousands of products and an OSV ecosystem
zip every package in it; Danbyte keeps only the records that name a product
someone has mapped (decision 20). The mapped products come from providers:
the tenant product mappings (Phase 3) register one here. With no provider, or
none mapped, nothing is tracked and an import stores nothing.

A product key is ``(kind, part, vendor, product)`` as
:mod:`vulnerabilities.identifiers` builds it.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass, field

ProductKey = tuple[str, str, str, str]

_PROVIDERS: list[Callable[[], Iterable[ProductKey]]] = []


def register_provider(fn: Callable[[], Iterable[ProductKey]]) -> None:
    """Add a source of tracked product keys (idempotent)."""
    if fn not in _PROVIDERS:
        _PROVIDERS.append(fn)


def unregister_provider(fn: Callable[[], Iterable[ProductKey]]) -> None:
    if fn in _PROVIDERS:
        _PROVIDERS.remove(fn)


@dataclass
class TrackedProducts:
    keys: set[ProductKey] = field(default_factory=set)

    def __bool__(self) -> bool:
        return bool(self.keys)

    def wants(self, products: Iterable[ProductKey]) -> bool:
        return any(p in self.keys for p in products)

    def kinds(self) -> set[str]:
        return {k[0] for k in self.keys}


def tracked() -> TrackedProducts:
    """Every product key some provider tracks, read now (a job calls this
    when it runs, not when it was queued)."""
    keys: set[ProductKey] = set()
    for fn in list(_PROVIDERS):
        for key in fn():
            kind, part, vendor, product = key
            keys.add((kind, part or "", vendor.lower(), product
                      if kind == "purl" else product.lower()))
    return TrackedProducts(keys)
