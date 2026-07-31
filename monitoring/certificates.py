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
  if they differed it would be a different certificate. Only ``last_seen`` (the
  roll-up "still in service somewhere") is refreshed on the certificate row.
* **Where it was seen is a binding, not a certificate field.** Given an
  endpoint, each chain member also gets a :class:`CertificateBinding` carrying
  the per-handshake facts — ``chain_depth``, ``chain_verified``, and its own
  ``first_seen``/``last_seen``. One certificate on ten endpoints is one
  certificate row and ten bindings.
* **Bindings are never deleted.** An endpoint that stops serving a certificate
  leaves a binding whose ``last_seen`` goes stale. Deleting it would throw away
  the answer to "what used to serve this?".
* **Fail closed.** An observation that produced no chain (``validity`` is
  ``unknown``) writes nothing at all — no certificate, no binding, no refreshed
  timestamp. An unreachable endpoint can never make an old row look fresh.

No private key is ever handled here. The observation carries none, the model has
no field for one, and :meth:`Certificate.save` refuses key material outright.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding
from django.utils import timezone

from danbyte_checks import tls_cert

from .models import (
    Certificate,
    CertificateBinding,
    PublicKeyAlgorithm,
    certificate_endpoint_key,
    contains_private_key_material,
)

logger = logging.getLogger(__name__)


class CertificateUploadError(ValueError):
    """An uploaded PEM could not be turned into a certificate row.

    Carries an operator-facing ``message`` the viewset returns verbatim as a
    400 — private key present, unparseable PEM, or nothing certificate-shaped.
    """


def upload_certificate(tenant, pem_text, *, name="", notes="", now=None):
    """Author a :class:`Certificate` from an uploaded **public** PEM.

    Parsing reuses :func:`danbyte_checks.tls_cert.parse_certificate` and the same
    field extraction the collector uses, so an uploaded certificate that is later
    observed on the wire (or was already observed) **dedups to one row** by its
    ``(tenant, fingerprint)`` identity — the upload just flips ``uploaded`` on and
    attaches the PEM.

    Rules, all raising :class:`CertificateUploadError` (→ 400) rather than 500:

    * a PEM carrying **any** private-key block is refused outright, before the
      model guard, with a clear message — only the public certificate is stored;
    * an unparseable PEM is refused;
    * a bundle with several certificates uses the **first** block as the leaf
      (the end-entity certificate being declared), and re-serialises *only* that
      one to canonical PEM, so no chain member or stray key can be stored.

    Returns ``(row, created)``.
    """
    if not isinstance(pem_text, str) or not pem_text.strip():
        raise CertificateUploadError("Provide a certificate in PEM format.")
    # Reject key material on the *input*, before parsing or the model guard, so
    # the operator gets a precise 400 instead of a generic failure.
    if contains_private_key_material(pem_text):
        raise CertificateUploadError(
            "Remove the private key; only the public certificate is stored."
        )

    raw = pem_text.encode("utf-8", "replace")
    certs = []
    loader = getattr(x509, "load_pem_x509_certificates", None)
    if loader is not None:
        try:
            certs = list(loader(raw))
        except (ValueError, TypeError):
            certs = []
    if not certs:
        try:
            certs = [x509.load_pem_x509_certificate(raw)]
        except (ValueError, TypeError):
            certs = []
    if not certs:
        stripped = (pem_text or "").strip()
        if stripped.startswith(("ssh-", "ecdsa-", "sk-")):
            raise CertificateUploadError(
                "This looks like an SSH public key — add it under SSH host "
                "keys, not Certificates."
            )
        raise CertificateUploadError(
            "Could not parse an X.509 certificate. Paste the public certificate "
            "in PEM form (-----BEGIN CERTIFICATE-----) — not a private key or "
            "an SSH key."
        )

    leaf = certs[0]
    fields = tls_cert.parse_certificate(leaf.public_bytes(Encoding.DER), 0)
    fingerprint = fields["fingerprint_sha256"].lower()
    canonical_pem = leaf.public_bytes(Encoding.PEM).decode("ascii")

    now = now or timezone.now()
    defaults = _defaults(fields)
    if defaults["not_before"] is None or defaults["not_after"] is None:
        raise CertificateUploadError(
            "The certificate has no usable validity window."
        )

    row, created = Certificate.objects.get_or_create(
        tenant=tenant,
        fingerprint_sha256=fingerprint,
        defaults={
            **defaults,
            "uploaded": True,
            "pem": canonical_pem,
            "name": name[:255],
            "notes": notes,
        },
    )
    if not created:
        # Already on file (commonly: already observed). Converge rather than
        # duplicate — mark it uploaded and attach the PEM, never touching the
        # immutable facts.
        row.uploaded = True
        row.pem = canonical_pem
        update_fields = ["uploaded", "pem", "updated_at"]
        if name:
            row.name = name[:255]
            update_fields.append("name")
        if notes:
            row.notes = notes
            update_fields.append("notes")
        row.save(update_fields=update_fields)
    return row, created

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


def _defaults(cert: dict) -> dict:
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
        "self_signed": bool(cert.get("self_signed")),
    }


def _depth(cert: dict) -> int:
    try:
        return max(0, min(int(cert.get("chain_depth") or 0), 32767))
    except (TypeError, ValueError):
        return 0


def _parse_dt(raw: Any) -> datetime | None:
    if isinstance(raw, datetime):
        return raw
    if not isinstance(raw, str):
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


@dataclass(frozen=True)
class Endpoint:
    """The thing that served a chain: an IP, a port, and the name requested.

    Deliberately *not* a certificate. This tuple is what survives a renewal, so
    it is what bindings group by and what expiry alerts are keyed on.
    """

    target_ip: Any  # api.IPAddress
    port: int = tls_cert.DEFAULT_PORT
    server_name: str = ""

    @property
    def key(self) -> str:
        return certificate_endpoint_key(self.target_ip.id, self.port, self.server_name)


def endpoint_from_result(result) -> Endpoint | None:
    """The endpoint a ``tls_cert`` :class:`CheckResult` observed.

    The IP comes from the check's own target (never from the payload — a
    detail blob must not be able to point a binding at someone else's IP); the
    port and SNI come from the observation, since that is what was dialled.
    """
    if result.target_ip_id is None:
        return None
    detail = result.detail or {}
    try:
        port = int(detail.get("port") or tls_cert.DEFAULT_PORT)
    except (TypeError, ValueError):
        port = tls_cert.DEFAULT_PORT
    server_name = detail.get("server_name")
    return Endpoint(
        target_ip=result.target_ip,
        port=max(1, min(port, 65535)),
        server_name=(server_name or "")[:255] if isinstance(server_name, str) else "",
    )


def _record_binding(tenant, certificate, endpoint: Endpoint, cert: dict,
                    verified: bool | None, now) -> None:
    """Create or refresh this endpoint's binding to ``certificate``.

    ``chain_depth`` / ``chain_verified`` are re-stamped every time because they
    describe *this* handshake — a server that stops sending its intermediate
    changes them without changing any certificate.
    """
    binding, created = CertificateBinding.objects.get_or_create(
        tenant=tenant,
        certificate=certificate,
        target_ip=endpoint.target_ip,
        port=endpoint.port,
        server_name=endpoint.server_name,
        defaults={
            "endpoint_key": endpoint.key,
            "chain_depth": _depth(cert),
            "chain_verified": verified,
            "first_seen": now,
            "last_seen": now,
        },
    )
    if created:
        return
    binding.last_seen = now
    binding.chain_depth = _depth(cert)
    binding.chain_verified = verified
    binding.save(update_fields=["last_seen", "chain_depth", "chain_verified",
                                "updated_at"])


def record_chain(
    tenant, observation: dict, *, endpoint: Endpoint | None = None, now=None,
    evaluate: bool = True,
) -> list[Certificate]:
    """Upsert every certificate in one observed chain for ``tenant``.

    With an ``endpoint``, each chain member also gets a binding to it, and the
    endpoint's expiry alert is reconciled — so recording an observation is
    always enough to open, update or **resolve** the alert, whichever path the
    observation arrived by. Without an endpoint (an ad-hoc read not tied to a
    monitored IP) only the certificate rows are written: the per-handshake facts
    have nowhere honest to live, and there is nothing to alert about.

    ``evaluate=False`` defers the alert pass so a caller handling many results
    can do one batched evaluation instead of one per chain.

    Returns the rows touched, leaf first. An observation with no readable chain
    returns ``[]`` and writes nothing (fail closed).
    """
    if not isinstance(observation, dict):
        return []
    validity = observation.get("validity")
    chain = observation.get("chain") or []
    if validity == tls_cert.UNKNOWN or not chain:
        return []
    if endpoint is not None and endpoint.target_ip.tenant_id != tenant.id:
        # Hard boundary, not a filter: a binding may never cross tenants.
        raise ValueError("endpoint IP belongs to a different tenant")

    verified = validity == tls_cert.VERIFIED
    now = now or timezone.now()
    rows: list[Certificate] = []
    for cert in chain:
        fingerprint = cert.get("fingerprint_sha256")
        if not isinstance(fingerprint, str) or len(fingerprint) != 64:
            continue
        defaults = _defaults(cert)
        if defaults["not_before"] is None or defaults["not_after"] is None:
            continue  # a certificate with no validity window is unusable
        row, created = Certificate.objects.get_or_create(
            tenant=tenant,
            fingerprint_sha256=fingerprint.lower(),
            defaults={**defaults, "last_seen": now, "observed": True},
        )
        if not created:
            # Never rewrite the immutable facts — different facts would mean
            # different bytes, which would be a different fingerprint. Only the
            # roll-up "seen somewhere" timestamp moves — and the ``observed``
            # flag flips on if this row had only been uploaded until now (that
            # convergence is the whole point: the declared cert is being served).
            row.last_seen = now
            update_fields = ["last_seen", "updated_at"]
            if not row.observed:
                row.observed = True
                update_fields.append("observed")
            row.save(update_fields=update_fields)
        if endpoint is not None:
            _record_binding(tenant, row, endpoint, cert, verified, now)
        rows.append(row)
    if rows and endpoint is not None and evaluate:
        evaluate_expiry({tenant.id}, {endpoint.key})
    return rows


def evaluate_expiry(tenant_ids, endpoint_keys) -> None:
    """Reconcile the expiry alerts for the endpoints just observed.

    Isolated and swallowing: a problem raising alerts must never lose the
    inventory write or break the check pipeline that called it.
    """
    if not endpoint_keys:
        return
    from .cert_expiry import evaluate_endpoints

    try:
        evaluate_endpoints(tenant_ids=tenant_ids, endpoint_keys=endpoint_keys)
    except Exception:  # noqa: BLE001 — alerting must not break monitoring
        logger.exception("certificate expiry evaluation failed")


def record_check_results(results) -> int:
    """Fold any ``tls_cert`` check results into the inventory.

    Called from both result-persistence seams (``runner.record_results`` for
    *Check now*, ``worker._finalise`` for the scheduled path), so a certificate
    check populates the inventory however it was triggered. A no-op for every
    other check kind. Never raises into the check pipeline — a reconcile problem
    must not lose a check result.

    Every endpoint touched is then re-evaluated for expiry, so a renewal
    observed by a scan opens/updates/**resolves** its alert in the same pass
    rather than waiting for the nightly sweep.
    """
    touched = 0
    endpoint_keys: set[str] = set()
    tenant_ids: set = set()
    for result in results:
        if result.kind != "tls_cert":
            continue
        try:
            endpoint = endpoint_from_result(result)
            rows = record_chain(
                result.tenant, result.detail or {}, endpoint=endpoint,
                evaluate=False,  # batched below — one pass for the whole run
            )
            touched += len(rows)
            if rows and endpoint is not None:
                endpoint_keys.add(endpoint.key)
                tenant_ids.add(result.tenant_id)
        except Exception:  # noqa: BLE001 — inventory must not break monitoring
            logger.exception("certificate reconcile failed for result %s", result.pk)
    evaluate_expiry(tenant_ids, endpoint_keys)
    return touched


def observe_endpoint(
    tenant,
    host: str,
    port: int = tls_cert.DEFAULT_PORT,
    *,
    server_name: str | None = None,
    timeout_ms: int = 8000,
    allow_private: bool = False,
    target_ip=None,
) -> tuple[dict, list[Certificate]]:
    """Collect ``host:port`` once and record what it presented.

    ``allow_private`` is the scoped private-address allowance described in
    :func:`danbyte_checks.tls_cert.target_allowed` — internal PKI lives on
    RFC1918 space, so an **admin-configured** endpoint may reach it, exactly as
    a Redfish endpoint does. It defaults to off; a caller acting on
    user-supplied input must leave it off.

    ``target_ip`` is the monitored ``api.IPAddress`` this read belongs to. Given
    one, the read produces bindings as well as certificates; without one it is
    an anonymous read and only the certificates are recorded.

    Returns ``(observation, rows)``.
    """
    observation = tls_cert.collect_chain(
        host,
        port,
        server_name=server_name,
        timeout_ms=timeout_ms,
        allow_private=allow_private,
    )
    endpoint = (
        Endpoint(target_ip=target_ip, port=port, server_name=server_name or "")
        if target_ip is not None
        else None
    )
    return observation, record_chain(tenant, observation, endpoint=endpoint)
