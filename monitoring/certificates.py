"""Certificate inventory — fold observed TLS chains into :class:`Certificate`.

The collector lives in the Django-free :mod:`danbyte_checks.tls_cert` (shared
verbatim with the Outpost agent). This module is the Django half: it takes the
JSON observation the collector produced — locally, or uploaded by an Outpost —
and reconciles it into tenant-scoped rows.

Reconcile rules, deliberately narrow:

* **The fingerprint is the identity.** A certificate is looked up by
  ``(tenant, fingerprint_sha256)``. The same certificate served by ten endpoints
  is one row.
* **Renewal is a new row, never an overwrite.** A renewed certificate has
  different bytes and so a different fingerprint; it is created alongside the
  old one, which stays untouched as history.
* **Immutable facts are written once.** Subject, issuer, SANs, serial, validity
  window, key and signature algorithm are properties *of those exact bytes* —
  if they differed it would be a different certificate. Only observation-scoped
  fields (``last_seen``, ``chain_depth``, ``chain_verified``) are refreshed.
* **Fail closed.** An observation that produced no chain (``validity`` is
  ``unknown``) writes nothing at all. An unreachable endpoint can never create
  or refresh a certificate, and so never reads as valid.

No private key is ever handled here. The observation carries none, the model has
no field for one, and :meth:`Certificate.save` refuses key material outright.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from django.utils import timezone

from danbyte_checks import tls_cert

from .models import Certificate, PublicKeyAlgorithm

logger = logging.getLogger(__name__)

# Fields written only when the row is created — properties of the exact DER
# bytes the fingerprint covers, so they cannot legitimately change.
_IMMUTABLE_FIELDS = (
    "subject", "subject_cn", "issuer", "issuer_cn", "serial", "san_dns",
    "san_ip", "not_before", "not_after", "public_key_algorithm",
    "public_key_bits", "signature_algorithm", "self_signed",
)

_ALGORITHMS = {choice.value for choice in PublicKeyAlgorithm}


def _clean(value: Any, limit: int) -> str:
    return (value or "")[:limit] if isinstance(value, str) else ""


def _strings(value: Any) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return [str(v)[:255] for v in value][:200]


def _defaults(cert: dict, verified: bool | None) -> dict:
    algorithm = cert.get("public_key_algorithm")
    bits = cert.get("public_key_bits")
    return {
        "subject": _clean(cert.get("subject"), 1024),
        "subject_cn": _clean(cert.get("subject_cn"), 255),
        "issuer": _clean(cert.get("issuer"), 1024),
        "issuer_cn": _clean(cert.get("issuer_cn"), 255),
        "serial": _clean(cert.get("serial"), 128),
        "san_dns": _strings(cert.get("san_dns")),
        "san_ip": _strings(cert.get("san_ip")),
        "not_before": _parse_dt(cert.get("not_before")),
        "not_after": _parse_dt(cert.get("not_after")),
        "public_key_algorithm": (
            algorithm if algorithm in _ALGORITHMS else PublicKeyAlgorithm.UNKNOWN
        ),
        "public_key_bits": int(bits) if isinstance(bits, int) and bits > 0 else None,
        "signature_algorithm": _clean(cert.get("signature_algorithm"), 64),
        "chain_depth": max(0, min(int(cert.get("chain_depth") or 0), 32767)),
        "self_signed": bool(cert.get("self_signed")),
        "chain_verified": verified,
    }


def _parse_dt(raw: Any) -> datetime | None:
    if isinstance(raw, datetime):
        return raw
    if not isinstance(raw, str):
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def record_chain(tenant, observation: dict, *, now=None) -> list[Certificate]:
    """Upsert every certificate in one observed chain for ``tenant``.

    Returns the rows touched, leaf first. An observation with no readable chain
    returns ``[]`` and writes nothing (fail closed).
    """
    if not isinstance(observation, dict):
        return []
    validity = observation.get("validity")
    chain = observation.get("chain") or []
    if validity == tls_cert.UNKNOWN or not chain:
        return []

    verified = validity == tls_cert.VERIFIED
    now = now or timezone.now()
    rows: list[Certificate] = []
    for cert in chain:
        fingerprint = cert.get("fingerprint_sha256")
        if not isinstance(fingerprint, str) or len(fingerprint) != 64:
            continue
        defaults = _defaults(cert, verified)
        if defaults["not_before"] is None or defaults["not_after"] is None:
            continue  # a certificate with no validity window is unusable
        row, created = Certificate.objects.get_or_create(
            tenant=tenant,
            fingerprint_sha256=fingerprint.lower(),
            defaults={**defaults, "last_seen": now},
        )
        if not created:
            # Never rewrite the immutable facts — different facts would mean
            # different bytes, which would be a different fingerprint. Only the
            # observation-scoped fields move.
            row.last_seen = now
            row.chain_depth = defaults["chain_depth"]
            row.chain_verified = verified
            row.save(update_fields=["last_seen", "chain_depth", "chain_verified",
                                    "updated_at"])
        rows.append(row)
    return rows


def record_check_results(results) -> int:
    """Fold any ``tls_cert`` check results into the inventory.

    Called from both result-persistence seams (``runner.record_results`` for
    *Check now*, ``worker._finalise`` for the scheduled path), so a certificate
    check populates the inventory however it was triggered. A no-op for every
    other check kind. Never raises into the check pipeline — a reconcile problem
    must not lose a check result.
    """
    touched = 0
    for result in results:
        if result.kind != "tls_cert":
            continue
        try:
            touched += len(record_chain(result.tenant, result.detail or {}))
        except Exception:  # noqa: BLE001 — inventory must not break monitoring
            logger.exception("certificate reconcile failed for result %s", result.pk)
    return touched


def observe_endpoint(
    tenant,
    host: str,
    port: int = tls_cert.DEFAULT_PORT,
    *,
    server_name: str | None = None,
    timeout_ms: int = 8000,
    allow_private: bool = False,
) -> tuple[dict, list[Certificate]]:
    """Collect ``host:port`` once and record what it presented.

    ``allow_private`` is the scoped private-address allowance described in
    :func:`danbyte_checks.tls_cert.target_allowed` — internal PKI lives on
    RFC1918 space, so an **admin-configured** endpoint may reach it, exactly as
    a Redfish endpoint does. It defaults to off; a caller acting on
    user-supplied input must leave it off.

    Returns ``(observation, rows)``.
    """
    observation = tls_cert.collect_chain(
        host,
        port,
        server_name=server_name,
        timeout_ms=timeout_ms,
        allow_private=allow_private,
    )
    return observation, record_chain(tenant, observation)
