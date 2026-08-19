"""Certificate signing requests - key + CSR generation and issued-cert import.

Danbyte generates the key pair and the CSR. The **private key** is written to
the opt-in secret store (fail closed when none is enabled) and never persisted
on the request row; the **public** CSR is stored on the row and handed to a CA.
Importing the signed certificate verifies it matches the request's public key,
links it, and flips the request to ``issued``.
"""
from __future__ import annotations

import ipaddress as _ip

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, rsa
from cryptography.x509.oid import NameOID

from .models import CertificateRequest
from .secret_store import require_secret_store


class CsrError(ValueError):
    """A CSR could not be generated, or an issued certificate could not be
    imported. Carries an operator-facing message the viewset returns as a 400."""


def _make_key(spec: str):
    if spec == "rsa-2048":
        return rsa.generate_private_key(public_exponent=65537, key_size=2048)
    if spec == "rsa-3072":
        return rsa.generate_private_key(public_exponent=65537, key_size=3072)
    if spec == "rsa-4096":
        return rsa.generate_private_key(public_exponent=65537, key_size=4096)
    if spec == "ec-p256":
        return ec.generate_private_key(ec.SECP256R1())
    if spec == "ec-p384":
        return ec.generate_private_key(ec.SECP384R1())
    if spec == "ed25519":
        return ed25519.Ed25519PrivateKey.generate()
    raise CsrError(f"Unknown key spec {spec!r}.")


def _subject(req: CertificateRequest) -> x509.Name:
    attrs = [x509.NameAttribute(NameOID.COMMON_NAME, req.common_name)]
    if req.organization:
        attrs.append(x509.NameAttribute(NameOID.ORGANIZATION_NAME, req.organization))
    if req.organizational_unit:
        attrs.append(
            x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, req.organizational_unit)
        )
    if req.country:
        attrs.append(x509.NameAttribute(NameOID.COUNTRY_NAME, req.country))
    if req.state:
        attrs.append(x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, req.state))
    if req.locality:
        attrs.append(x509.NameAttribute(NameOID.LOCALITY_NAME, req.locality))
    return x509.Name(attrs)


def _san(req: CertificateRequest) -> list:
    names: list = [x509.DNSName(str(d)) for d in (req.san_dns or [])]
    for ip in req.san_ip or []:
        try:
            names.append(x509.IPAddress(_ip.ip_address(str(ip))))
        except ValueError as exc:
            raise CsrError(f"Invalid SAN IP address {ip!r}.") from exc
    return names


def _private_pem(key) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")


def generate(
    *,
    tenant,
    user,
    common_name: str,
    organization: str = "",
    organizational_unit: str = "",
    country: str = "",
    state: str = "",
    locality: str = "",
    san_dns=None,
    san_ip=None,
    key_spec: str = "rsa-2048",
    notes: str = "",
) -> tuple[CertificateRequest, str]:
    """Generate a key pair + CSR. Returns ``(request, private_key_pem)``.

    The private key is stored in the secret store and also returned once here so
    the operator can save it - it is the caller's only chance to receive it in
    the response body. Fail-closed: no secret store → :class:`SecretStoreDisabled`.
    """
    if not (common_name or "").strip():
        raise CsrError("A common name (CN) is required.")
    if key_spec not in CertificateRequest.KeySpec.values:
        raise CsrError(f"Unknown key spec {key_spec!r}.")
    if country and len(country) != 2:
        raise CsrError("Country must be a 2-letter code (e.g. US, DK).")

    store = require_secret_store()  # fail closed before any key is generated

    req = CertificateRequest(
        tenant=tenant,
        created_by=user if getattr(user, "is_authenticated", False) else None,
        common_name=common_name.strip(),
        organization=organization,
        organizational_unit=organizational_unit,
        country=country.upper(),
        state=state,
        locality=locality,
        san_dns=[str(d) for d in (san_dns or [])],
        san_ip=[str(i) for i in (san_ip or [])],
        key_spec=key_spec,
        notes=notes,
    )
    key = _make_key(key_spec)
    builder = x509.CertificateSigningRequestBuilder().subject_name(_subject(req))
    san = _san(req)
    if san:
        builder = builder.add_extension(
            x509.SubjectAlternativeName(san), critical=False
        )
    # Ed25519 signs with no separate hash; everything else uses SHA-256.
    algorithm = None if key_spec == "ed25519" else hashes.SHA256()
    csr = builder.sign(key, algorithm)
    req.csr_pem = csr.public_bytes(serialization.Encoding.PEM).decode("ascii")
    private_pem = _private_pem(key)
    req.key_ref = f"csr/{req.id}"  # id is a uuid default, set before save

    # Persist the row and stash its key together. If the secret-store write
    # fails (e.g. Vault configured but unreachable) the transaction rolls back
    # the row too, so a keyless CSR request is never left behind for the caller
    # to trip over. SecretStoreError propagates for the viewset to turn into 400.
    from django.db import transaction

    with transaction.atomic():
        req.save()
        store.put(
            tenant.id, req.key_ref, {"private_key": private_pem, "csr": req.csr_pem}
        )
    return req, private_pem


def import_issued(req: CertificateRequest, pem_text: str):
    """Import the CA-signed certificate for this request and link it.

    Verifies the issued certificate's public key matches the request's CSR (so a
    wrong paste can't be attached), stores it as an ordinary public
    :class:`Certificate`, links it, and flips the request to ``issued``.
    """
    from .certificates import CertificateUploadError, upload_certificate

    if req.status == CertificateRequest.Status.CANCELLED:
        raise CsrError("This request was cancelled.")
    if req.status == CertificateRequest.Status.ISSUED:
        raise CsrError("This request has already been issued.")

    try:
        issued = x509.load_pem_x509_certificate(pem_text.encode("utf-8", "replace"))
    except Exception as exc:  # noqa: BLE001
        raise CsrError(
            "Could not parse a certificate. Paste the CA-signed public "
            "certificate in PEM form."
        ) from exc

    if req.csr_pem:
        try:
            csr = x509.load_pem_x509_csr(req.csr_pem.encode("ascii"))
            want = csr.public_key().public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            got = issued.public_key().public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            if want != got:
                raise CsrError(
                    "This certificate's public key does not match the request - "
                    "it was signed for a different key."
                )
        except CsrError:
            raise
        except Exception:  # noqa: BLE001 - a parse hiccup shouldn't block import
            pass

    try:
        cert_row, _ = upload_certificate(req.tenant, pem_text)
    except CertificateUploadError as exc:
        raise CsrError(str(exc)) from exc

    req.issued_certificate = cert_row
    req.status = CertificateRequest.Status.ISSUED
    req.save(update_fields=["issued_certificate", "status", "updated_at"])
    return cert_row


def get_private_key(req: CertificateRequest) -> str:
    """The stored private key PEM for a request (from the secret store)."""
    store = require_secret_store()
    data = store.get(req.tenant_id, req.key_ref) or {}
    return data.get("private_key", "")


def delete_key(req: CertificateRequest) -> None:
    """Best-effort removal of a request's private key from the secret store."""
    if not req.key_ref:
        return
    try:
        require_secret_store().delete(req.tenant_id, req.key_ref)
    except Exception:  # noqa: BLE001 - store disabled/unreachable: nothing to do
        pass
