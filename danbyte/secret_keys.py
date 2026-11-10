"""Parse ``MONITORING_SECRET_KEY`` into its list of keys (#493).

The setting may hold one key or a comma-separated list, newest first: new
values are encrypted under the first key, and every key is tried on read, so
an operator can add a new key, re-encrypt (``manage.py rotate_monitoring_key``)
and then drop the old one.

Django-free so ``settings.py`` can validate the list at start and the runtime
(``monitoring.secrets``, ``backups.archive``) reads it the same way.
"""
from __future__ import annotations


def parse_monitoring_keys(raw: str | None) -> list[str]:
    """The keys in ``raw``, newest first. ``[]`` when unset.

    Raises ``ValueError`` (never echoing a key) for an empty entry - a stray
    or trailing comma - or the same key listed twice; both are typos that
    would otherwise encrypt under something the operator did not mean.
    """
    if raw is None or not raw.strip():
        return []
    keys = [k.strip() for k in raw.split(",")]
    for i, key in enumerate(keys, 1):
        if not key:
            raise ValueError(
                f"MONITORING_SECRET_KEY entry {i} of {len(keys)} is empty - "
                "remove the stray comma."
            )
    if len(set(keys)) != len(keys):
        raise ValueError("MONITORING_SECRET_KEY lists the same key more than once.")
    return keys
