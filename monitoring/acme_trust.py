"""What an issuer's ACME calls trust: the server's trust store plus the
issuer's own CA certificate.

The rule, for an issuer with *Verify TLS* on:

1. ``REQUESTS_CA_BUNDLE`` (or ``CURL_CA_BUNDLE``) when the environment sets
   it to a file - the operator's explicit choice wins, as it does for every
   other ``requests`` call;
2. else the operating system's bundle - what ``update-ca-certificates`` /
   ``update-ca-trust`` maintain, found through
   :func:`ssl.get_default_verify_paths` and the usual distribution paths;
3. else certifi's bundle (the public roots ``requests`` ships with);

**plus** the PEM in ``Issuer.ca_certificate``, when there is one. The
issuer's certificate is added to that base, never a replacement for it: a
private root pasted on an issuer that is later pointed at a public CA keeps
working, and pasting a root cannot silently drop the public ones. (Pinning
an issuer to only its own root would also refuse a public certificate for
the CA's name; none can be issued for an internal name anyway, so the
additive rule costs nothing in practice.)

``requests`` takes a CA bundle *path*, so the combined bundle is written to
a file named by its content's SHA-256 in a private per-user directory
(``0700``, owned by the service user, checked before use, never a symlink).
The file is written to a temporary name and renamed into place, so workers
racing to write the same bundle never see a partial file; files unused for a
day are pruned.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import ssl
import stat
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding

log = logging.getLogger(__name__)

#: Caps on what an issuer's CA certificate field accepts.
MAX_PEM_CHARS = 64 * 1024
MAX_CERTIFICATES = 10
#: Bundles idle longer than this are removed from the cache directory.
_PRUNE_AFTER = 24 * 3600

#: Where distributions keep the system bundle, when OpenSSL's default is not it.
SYSTEM_BUNDLES = (
    "/etc/ssl/certs/ca-certificates.crt",  # Debian, Ubuntu, Alpine, Arch
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",  # RHEL, Fedora
    "/etc/pki/tls/certs/ca-bundle.crt",  # RHEL, CentOS (older)
    "/etc/ssl/ca-bundle.pem",  # SUSE
    "/etc/ssl/cert.pem",  # Alpine, BSDs, macOS
)

_PEM_LABEL = re.compile(r"-----BEGIN ([A-Z0-9 ]+)-----")


class CaCertificateError(ValueError):
    """What is wrong with a pasted CA certificate - shown on the field."""


# ─── the field ───────────────────────────────────────────────────────────────

def parse_ca_certificates(text: str) -> list[x509.Certificate]:
    """The certificates in ``text``, each checked to be usable as a trust
    anchor, or :class:`CaCertificateError`. Empty text is no certificates.

    Each must be a CA certificate - basicConstraints ``CA:TRUE``, or an old
    v1 self-signed root that has no extensions at all - and in date. A
    server's own (leaf) certificate is refused: trusting it would break at
    the CA's next certificate renewal.
    """
    from .models import contains_private_key_material

    text = (text or "").strip()
    if not text:
        return []
    if len(text) > MAX_PEM_CHARS:
        raise CaCertificateError(
            f"Too long - at most {MAX_PEM_CHARS // 1024} KB of PEM.")
    if contains_private_key_material(text):
        raise CaCertificateError(
            "This contains a private key. Paste only the CA's certificate "
            "(-----BEGIN CERTIFICATE-----), and treat that key as exposed.")
    labels = set(_PEM_LABEL.findall(text))
    if not labels:
        raise CaCertificateError(
            "Not a PEM certificate. Paste the CA's root certificate, starting "
            "with -----BEGIN CERTIFICATE-----.")
    other = sorted(labels - {"CERTIFICATE"})
    if other:
        raise CaCertificateError(
            f"Only certificates belong here, not {other[0].lower()} blocks.")
    try:
        certs = list(x509.load_pem_x509_certificates(text.encode("ascii", "replace")))
    except ValueError as exc:
        raise CaCertificateError(f"Could not read the certificate: {exc}") from exc
    if not certs:
        raise CaCertificateError("No certificate found in the PEM.")
    if len(certs) > MAX_CERTIFICATES:
        raise CaCertificateError(f"At most {MAX_CERTIFICATES} certificates.")
    now = datetime.now(UTC)
    for cert in certs:
        name = _name(cert)
        if not _is_ca(cert):
            raise CaCertificateError(
                f"{name} is not a CA certificate. Paste the root (or intermediate) "
                "that signed the CA's TLS certificate, not the server's own.")
        if cert.not_valid_after_utc <= now:
            raise CaCertificateError(
                f"{name} expired on {cert.not_valid_after_utc:%Y-%m-%d}.")
    return certs


def normalize(text: str) -> str:
    """The field's canonical form: each certificate re-encoded as PEM,
    nothing else kept (comments, text dumps, whitespace)."""
    return "".join(c.public_bytes(Encoding.PEM).decode("ascii")
                   for c in parse_ca_certificates(text))


def describe(text: str) -> list[dict]:
    """What is stored, for the issuer page: subject, expiry, fingerprint.
    Reuses the certificate inventory's parser."""
    from danbyte_checks import tls_cert

    try:
        certs = list(x509.load_pem_x509_certificates((text or "").encode("ascii", "replace")))
    except ValueError:
        return []
    out = []
    now = datetime.now(UTC)
    for cert in certs[:MAX_CERTIFICATES]:
        f = tls_cert.parse_certificate(cert.public_bytes(Encoding.DER), 0)
        out.append({
            "subject": f["subject"],
            "subject_cn": f["subject_cn"],
            "issuer": f["issuer"],
            "not_after": f["not_after"],
            "days_left": (cert.not_valid_after_utc - now).days,
            "fingerprint_sha256": f["fingerprint_sha256"],
            "self_signed": f["self_signed"],
        })
    return out


def _name(cert: x509.Certificate) -> str:
    cn = cert.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)
    return f"“{cn[0].value}”" if cn else "A certificate"


def _is_ca(cert: x509.Certificate) -> bool:
    try:
        return bool(cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca)
    except x509.ExtensionNotFound:
        return cert.version == x509.Version.v1 and cert.subject == cert.issuer


# ─── the base bundle ──────────────────────────────────────────────────────────

def _has_certificates(path: str) -> bool:
    try:
        with open(path, "rb") as fh:
            return b"-----BEGIN CERTIFICATE-----" in fh.read(1 << 20)
    except OSError:
        return False


def base_bundle() -> tuple[str, str]:
    """``(path, source)`` of the bundle an issuer starts from; ``source`` is
    ``environment``, ``system`` or ``certifi``."""
    for var in ("REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
        value = (os.environ.get(var) or "").strip()
        if value and os.path.isfile(value):
            return value, "environment"
    paths = ssl.get_default_verify_paths()
    for cand in (paths.cafile, paths.openssl_cafile, *SYSTEM_BUNDLES):
        if cand and os.path.isfile(cand) and _has_certificates(cand):
            return cand, "system"
    import certifi

    return certifi.where(), "certifi"


# ─── the combined bundle ──────────────────────────────────────────────────────

def _cache_root() -> Path:
    return Path(tempfile.gettempdir()) / f"danbyte-acme-trust-{os.getuid()}"


_private_fallback: Path | None = None


def _cache_dir() -> Path:
    """A directory only this user can write, made if missing. A path that
    exists but is not ours (or is a link, or is open to others) is never
    used; a fresh private directory is made instead."""
    global _private_fallback
    root = _cache_root()
    try:
        os.mkdir(root, 0o700)
    except FileExistsError:
        pass
    st = os.lstat(root)
    if stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and not st.st_mode & 0o077:
        return root
    log.warning("ACME trust cache %s is not a private directory of this user; "
                "using a private one instead", root)
    if _private_fallback is None or not _private_fallback.is_dir():
        _private_fallback = Path(tempfile.mkdtemp(prefix="danbyte-acme-trust-"))
    return _private_fallback


def _prune(directory: Path, keep: Path) -> None:
    cutoff = time.time() - _PRUNE_AFTER
    for entry in directory.iterdir():
        if entry == keep or not entry.name.endswith(".pem"):
            continue
        try:
            if entry.lstat().st_mtime < cutoff:
                entry.unlink()
        except OSError:
            pass


def combined_bundle(base_path: str, extra_pem: str) -> str:
    """The path of a file holding ``base_path``'s certificates and
    ``extra_pem``; the same content always gives the same file."""
    with open(base_path, "rb") as fh:
        data = fh.read().rstrip(b"\n") + b"\n" + extra_pem.strip().encode("ascii") + b"\n"
    directory = _cache_dir()
    path = directory / f"{hashlib.sha256(data).hexdigest()}.pem"
    try:
        st = os.lstat(path)
        if stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid():
            os.utime(path)
            return str(path)
    except FileNotFoundError:
        pass
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".part")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    _prune(directory, path)
    return str(path)


def verify_for(issuer) -> bool | str:
    """The ``verify`` value for ``requests`` on this issuer's calls: False
    with *Verify TLS* off, else the bundle path described above."""
    if not issuer.verify_tls:
        return False
    base, _ = base_bundle()
    extra = (issuer.ca_certificate or "").strip()
    if not extra:
        return base
    parse_ca_certificates(extra)  # stored text is validated on save; re-check
    return combined_bundle(base, extra)
