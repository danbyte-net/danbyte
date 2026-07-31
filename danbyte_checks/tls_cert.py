"""TLS certificate collector.

Opens a TLS connection to ``host:port``, completes the handshake, and reads the
chain the server **presents**. Everything extracted is public X.509 data — the
exact bytes every client receives when it connects.

**No private key. Ever.** This module never reads, requests, accepts, or emits
key material: it holds no client certificate, ``secret_params`` is ignored, and
the only bytes it touches are the peer's public chain. A certificate inventory
is safe *by construction*; adding a field that could hold a key would destroy
that property, so there is none.

Reading an untrusted cert without weakening verification
--------------------------------------------------------
An expired or self-signed certificate is precisely what an inventory most needs
to record, so the read must not abort when verification fails. It also must not
"just turn verification off" — an unverified read would then be
indistinguishable from a verified one.

So the collector makes two clearly separated passes:

1. a **verifying** handshake against the system trust store
   (``ssl.create_default_context()``, hostname checking on). If it succeeds,
   ``validity`` is ``verified``;
2. only on :class:`ssl.SSLCertVerificationError`, a second handshake using a
   **fresh, local, single-use** context with verification off, purely to read
   the chain. That result is tagged ``validity="unverified"`` and carries the
   verifier's own reason in ``verify_error``.

No global/default context is mutated, the permissive context never escapes this
module, and "unverified" is a recorded fact rather than a silent default.

Fail closed
-----------
If the chain cannot be read at all, ``validity`` is ``unknown`` and ``chain`` is
empty. An unreachable endpoint never reads as a healthy or valid certificate.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
import ssl
from datetime import UTC, datetime
from typing import Any

from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import dsa, ec, ed448, ed25519, rsa

from . import netguard
from .base import CheckConfigError, CheckOutcome, register, require_port

DEFAULT_PORT = 443

# ``validity`` — the trust outcome of the read, recorded as data.
VERIFIED = "verified"
UNVERIFIED = "unverified"
UNKNOWN = "unknown"

# ``error_kind`` — why a read produced no chain.
ERR_POLICY = "policy"  # refused by the target-address policy / unresolvable
ERR_CONNECT = "connect"  # no TCP connection (refused, timeout, unreachable)
ERR_TLS = "tls"  # TCP up, TLS handshake unusable


# ─── Target-address policy ────────────────────────────────────────────────


def target_allowed(host: str, *, allow_private: bool = False) -> tuple[bool, str]:
    """Whether this collector may dial ``host``.

    Default (``allow_private=False``) defers to the process-wide check-engine
    policy in :mod:`danbyte_checks.netguard` — a user-defined check must not
    become a scanner for internal services.

    ``allow_private=True`` is the **explicitly scoped** allowance an
    admin-configured endpoint gets, mirroring the Redfish collector's precedent:
    internal PKI lives on RFC1918 addresses, so an operator-configured
    certificate endpoint may reach them. It is a per-call argument, never a
    weakened default and never a mutation of the global policy. Loopback,
    link-local (cloud metadata), multicast and the unspecified address stay
    refused either way — they are never a legitimate inventory target.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError as exc:
        return False, f"cannot resolve {host}: {exc}"
    for info in infos:
        addr = ipaddress.ip_address(info[4][0])
        if addr.is_loopback or addr.is_link_local or addr.is_unspecified or addr.is_multicast:
            return False, f"{addr} is loopback/link-local/multicast — not an inventory target"
        if not allow_private and netguard.address_blocked(addr):
            return False, "target address not permitted"
    return True, ""


# ─── Handshake ────────────────────────────────────────────────────────────


def _verifying_context() -> ssl.SSLContext:
    """The normal, fully verifying client context (system trust store)."""
    return ssl.create_default_context()


def _reading_context() -> ssl.SSLContext:
    """A fresh, single-use context used **only** to re-read a chain the
    verifying pass already rejected. Never reused, never returned to a caller,
    and every result obtained through it is tagged ``unverified``."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _handshake(
    host: str, port: int, server_name: str, timeout_s: float, ctx: ssl.SSLContext
) -> tuple[list[bytes], str, str]:
    """Connect, handshake, return (chain DER list, tls version, cipher name)."""
    with socket.create_connection((host, port), timeout=timeout_s) as raw:
        with ctx.wrap_socket(raw, server_hostname=server_name) as tls:
            # ``get_unverified_chain`` is what the peer actually presented — the
            # right thing for an inventory, since a chain "completed" from the
            # local trust store would hide a server that omits its intermediate.
            # It landed in CPython 3.13; on an older Outpost we degrade to the
            # leaf (still the certificate that matters) rather than failing.
            getter = getattr(tls, "get_unverified_chain", None)
            chain = list(getter() or []) if getter is not None else []
            if not chain:
                leaf = tls.getpeercert(binary_form=True)
                chain = [leaf] if leaf else []
            cipher = tls.cipher()
            return chain, tls.version() or "", (cipher[0] if cipher else "")


# ─── X.509 parsing (public fields only) ───────────────────────────────────


def _cn(name: x509.Name) -> str:
    attrs = name.get_attributes_for_oid(x509.oid.NameOID.COMMON_NAME)
    if not attrs:
        return ""
    value = attrs[0].value
    return value if isinstance(value, str) else value.decode("utf-8", "replace")


def _public_key_info(cert: x509.Certificate) -> tuple[str, int | None]:
    key = cert.public_key()
    if isinstance(key, rsa.RSAPublicKey):
        return "rsa", key.key_size
    if isinstance(key, ec.EllipticCurvePublicKey):
        return "ec", key.curve.key_size
    if isinstance(key, ed25519.Ed25519PublicKey):
        return "ed25519", 256
    if isinstance(key, ed448.Ed448PublicKey):
        return "ed448", 456
    if isinstance(key, dsa.DSAPublicKey):
        return "dsa", key.key_size
    return "unknown", None


def _self_signed(cert: x509.Certificate) -> bool:
    """Subject == issuer *and* the signature checks out under its own key.
    Falls back to the name comparison if the algorithm can't be verified."""
    if cert.subject != cert.issuer:
        return False
    try:
        cert.verify_directly_issued_by(cert)
        return True
    except (ValueError, TypeError):
        return False
    except Exception:  # noqa: BLE001 — unsupported algorithm → name match only
        return True


def parse_certificate(der: bytes, depth: int) -> dict[str, Any]:
    """One presented certificate → its public fields, JSON-safe.

    ``depth`` is the position in the presented chain (0 = the end-entity leaf,
    1 = its issuer, …), the same numbering OpenSSL's verify callback uses.
    """
    cert = x509.load_der_x509_certificate(der)
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        san_dns = list(san.get_values_for_type(x509.DNSName))
        san_ip = [str(v) for v in san.get_values_for_type(x509.IPAddress)]
    except x509.ExtensionNotFound:
        san_dns, san_ip = [], []
    algorithm, bits = _public_key_info(cert)
    sig_oid = cert.signature_algorithm_oid
    serial = format(cert.serial_number, "x")
    return {
        "fingerprint_sha256": cert.fingerprint(hashes.SHA256()).hex(),
        "subject": cert.subject.rfc4514_string(),
        "subject_cn": _cn(cert.subject),
        "issuer": cert.issuer.rfc4514_string(),
        "issuer_cn": _cn(cert.issuer),
        "serial": serial if len(serial) % 2 == 0 else "0" + serial,
        "san_dns": san_dns,
        "san_ip": san_ip,
        "not_before": cert.not_valid_before_utc.isoformat(),
        "not_after": cert.not_valid_after_utc.isoformat(),
        "public_key_algorithm": algorithm,
        "public_key_bits": bits,
        "signature_algorithm": getattr(sig_oid, "_name", "") or sig_oid.dotted_string,
        "chain_depth": depth,
        "self_signed": _self_signed(cert),
        # CA modelling: is this a CA cert, and the key identifiers that let a
        # leaf be tied to its issuer (AKI → the issuer's SKI) without trusting
        # the DN strings alone.
        "is_ca": _is_ca(cert),
        "subject_key_id": _subject_key_id(cert),
        "authority_key_id": _authority_key_id(cert),
    }


def _is_ca(cert) -> bool:
    """basicConstraints CA:TRUE — the cert may sign other certs."""
    try:
        bc = cert.extensions.get_extension_for_class(x509.BasicConstraints).value
        return bool(bc.ca)
    except x509.ExtensionNotFound:
        return False


def _subject_key_id(cert) -> str:
    """This cert's Subject Key Identifier, lowercase hex, or ""."""
    try:
        ski = cert.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value
        return ski.digest.hex()
    except x509.ExtensionNotFound:
        return ""


def _authority_key_id(cert) -> str:
    """The issuer's key identifier this cert points at, lowercase hex, or ""."""
    try:
        aki = cert.extensions.get_extension_for_class(
            x509.AuthorityKeyIdentifier
        ).value
        return aki.key_identifier.hex() if aki.key_identifier else ""
    except x509.ExtensionNotFound:
        return ""


# ─── Collection ───────────────────────────────────────────────────────────


def _empty(host: str, port: int, server_name: str, kind: str, error: str) -> dict[str, Any]:
    """A read that produced no chain: unknown, never valid. Fail closed."""
    return {
        "host": host,
        "port": port,
        "server_name": server_name,
        "validity": UNKNOWN,
        "verify_error": "",
        "error_kind": kind,
        "error": error,
        "chain": [],
        "chain_length": 0,
    }


def collect_chain(
    host: str,
    port: int = DEFAULT_PORT,
    *,
    server_name: str | None = None,
    timeout_ms: int = 8000,
    allow_private: bool = False,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Read the certificate chain ``host:port`` presents.

    Returns a JSON-safe observation dict — it travels in a ``CheckOutcome``
    detail, through an Outpost's result upload, and into JSONB unchanged::

        {host, port, server_name, validity, verify_error, error_kind, error,
         chain: [<parse_certificate>, …], chain_length, expired, self_signed,
         expires_in_days, tls_version, cipher}

    Never raises for a reachability or trust problem — those are the data.
    """
    server_name = server_name or host
    timeout_s = max(timeout_ms / 1000, 0.1)

    ok, reason = target_allowed(host, allow_private=allow_private)
    if not ok:
        return _empty(host, port, server_name, ERR_POLICY, reason)

    verify_error = ""
    try:
        chain, tls_version, cipher = _handshake(
            host, port, server_name, timeout_s, _verifying_context()
        )
        validity = VERIFIED
    except ssl.SSLCertVerificationError as exc:
        # The interesting case: the cert is untrusted/expired/self-signed. Read
        # it anyway — as an explicitly unverified second pass, so the outcome is
        # recorded rather than assumed.
        verify_error = str(exc.verify_message or exc) or exc.__class__.__name__
        try:
            chain, tls_version, cipher = _handshake(
                host, port, server_name, timeout_s, _reading_context()
            )
        except (OSError, ssl.SSLError) as exc2:
            return _empty(host, port, server_name, ERR_TLS, str(exc2) or type(exc2).__name__)
        validity = UNVERIFIED
    except ssl.SSLError as exc:
        return _empty(host, port, server_name, ERR_TLS, str(exc) or type(exc).__name__)
    except OSError as exc:  # includes TimeoutError / ConnectionRefusedError
        return _empty(host, port, server_name, ERR_CONNECT, str(exc) or type(exc).__name__)

    certs = []
    for depth, der in enumerate(chain):
        try:
            certs.append(parse_certificate(der, depth))
        except ValueError:
            continue  # an unparsable chain member must not lose the rest
    if not certs:
        return _empty(host, port, server_name, ERR_TLS, "no parsable certificate presented")

    leaf = certs[0]
    moment = now or datetime.now(UTC)
    not_after = datetime.fromisoformat(leaf["not_after"])
    not_before = datetime.fromisoformat(leaf["not_before"])
    return {
        "host": host,
        "port": port,
        "server_name": server_name,
        "validity": validity,
        "verify_error": verify_error,
        "error_kind": "",
        "error": "",
        "chain": certs,
        "chain_length": len(certs),
        "expired": not_after <= moment,
        "not_yet_valid": not_before > moment,
        "self_signed": leaf["self_signed"],
        "expires_in_days": round((not_after - moment).total_seconds() / 86400, 2),
        "tls_version": tls_version,
        "cipher": cipher,
    }


# ─── Checker ──────────────────────────────────────────────────────────────


@register
class TlsCertChecker:
    """``tls_cert`` — read the certificate an endpoint serves.

    ``up`` = a chain that verified against the trust store and is inside its
    validity window. ``degraded`` = the endpoint answered but the certificate is
    untrusted, self-signed, expired, or not yet valid — reachable, impaired.
    ``down`` = no usable TLS at all. ``unknown`` = policy/config error.

    ``secret_params`` is deliberately unused: reading a public certificate needs
    no credential, and this checker accepts no key material.
    """

    kind = "tls_cert"

    def validate_params(self, params: dict) -> None:
        if params.get("port") is not None:
            require_port(params)
        server_name = params.get("server_name")
        if server_name is not None and not isinstance(server_name, str):
            raise CheckConfigError("'server_name' must be a string")

    async def run(
        self, target: str, params: dict, secret_params: dict, timeout_ms: int
    ) -> CheckOutcome:
        port = params.get("port") or DEFAULT_PORT
        server_name = params.get("server_name") or None
        timeout_s = max(timeout_ms / 1000, 0.1)
        try:
            # Blocking stdlib ssl in a worker thread; the outer wait_for keeps
            # the checker's timeout contract even if a socket layer ignores it.
            obs = await asyncio.wait_for(
                asyncio.to_thread(
                    collect_chain,
                    target,
                    int(port),
                    server_name=server_name,
                    timeout_ms=timeout_ms,
                ),
                timeout=timeout_s + 5,
            )
        except TimeoutError:
            return CheckOutcome(
                "down", None, _empty(target, int(port), server_name or target,
                                     ERR_CONNECT, "timeout"),
            )
        except Exception as exc:  # noqa: BLE001 — unexpected → unknown, never down
            return CheckOutcome.unknown(f"tls_cert error: {exc}", host=target, port=int(port))

        if obs["validity"] == UNKNOWN:
            if obs["error_kind"] == ERR_POLICY:
                # Misconfiguration must not masquerade as an outage (base.py).
                return CheckOutcome("unknown", None, obs)
            return CheckOutcome("down", None, obs)
        if obs["validity"] != VERIFIED or obs["expired"] or obs["not_yet_valid"]:
            return CheckOutcome("degraded", None, obs)
        return CheckOutcome("up", None, obs)
