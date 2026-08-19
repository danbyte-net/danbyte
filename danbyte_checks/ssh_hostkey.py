"""SSH host-key parsing + fingerprinting - Django-free, shared by the collector
(``danbyte_checks.ssh``) and the Django upload serializer, so an uploaded key
and an observed one fingerprint **identically**.

The fingerprint is the OpenSSH ``SHA256:<base64-no-pad>`` form: base64 of the
SHA-256 of the raw public-key blob (the same bytes asyncssh hashes in
``SSHKey.get_fingerprint()``). Computing it here from the base64 middle field of
an OpenSSH line yields the exact string asyncssh reports for the same key - the
equivalence the drift comparison depends on.
"""
from __future__ import annotations

import base64
import hashlib

# Public SSH key algorithms we accept on upload. `sk-` are FIDO/U2F-backed keys.
KNOWN_KEY_TYPES = frozenset({
    "ssh-ed25519",
    "ssh-rsa",
    "ssh-dss",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ssh-ed25519@openssh.com",
    "sk-ecdsa-sha2-nistp256@openssh.com",
})

# Fixed key sizes by type; RSA/DSS vary, so left None (bits stay unknown).
_FIXED_BITS = {
    "ssh-ed25519": 256,
    "sk-ssh-ed25519@openssh.com": 256,
    "ecdsa-sha2-nistp256": 256,
    "sk-ecdsa-sha2-nistp256@openssh.com": 256,
    "ecdsa-sha2-nistp384": 384,
    "ecdsa-sha2-nistp521": 521,
}


class SSHKeyParseError(ValueError):
    """The pasted text is not a usable SSH public key."""


def fingerprint_from_blob(blob_b64: str) -> str:
    """OpenSSH ``SHA256:…`` fingerprint from a base64 public-key blob."""
    raw = base64.b64decode(blob_b64, validate=True)
    digest = hashlib.sha256(raw).digest()
    return "SHA256:" + base64.b64encode(digest).decode("ascii").rstrip("=")


def _rsa_bits(blob_b64: str) -> int | None:
    """RSA modulus length in bits, read from the SSH wire encoding
    (``string "ssh-rsa"`` · ``mpint e`` · ``mpint n``). Best-effort; None on any
    surprise so a parse quirk never blocks an upload."""
    try:
        raw = base64.b64decode(blob_b64, validate=True)
        off = 0

        def _field() -> bytes:
            nonlocal off
            n = int.from_bytes(raw[off:off + 4], "big")
            off += 4
            v = raw[off:off + n]
            off += n
            return v

        _field()          # algorithm name
        _field()          # e
        n = _field()      # modulus
        n = n.lstrip(b"\x00")
        return len(n) * 8 or None
    except Exception:  # noqa: BLE001 - bits are cosmetic
        return None


def parse_public_key_line(text: str) -> dict:
    """Parse one OpenSSH public-key line → dict with ``key_type``,
    ``public_key`` (base64 blob), ``comment``, ``fingerprint``, ``bits``.

    Raises :class:`SSHKeyParseError` with an actionable message for a private
    key, a PEM certificate, or anything that isn't a public SSH key.
    """
    if not text or not text.strip():
        raise SSHKeyParseError("Paste an SSH public key.")
    body = text.strip()

    if "PRIVATE KEY" in body.upper():
        raise SSHKeyParseError(
            "Remove the private key; only the public key is stored."
        )
    if "BEGIN CERTIFICATE" in body.upper():
        raise SSHKeyParseError(
            "That's a TLS certificate - add it under Certificates, not SSH host keys."
        )

    parts = body.split(None, 2)
    if len(parts) < 2:
        raise SSHKeyParseError(
            "Not an SSH public key. Expected a line like "
            "'ssh-ed25519 AAAA… comment'."
        )
    key_type, blob = parts[0], parts[1]
    comment = parts[2].strip() if len(parts) == 3 else ""

    if key_type not in KNOWN_KEY_TYPES:
        raise SSHKeyParseError(
            f"Unknown SSH key type '{key_type[:40]}'. Expected one of: "
            "ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256/384/521, …"
        )
    try:
        raw = base64.b64decode(blob, validate=True)
    except Exception as e:  # noqa: BLE001
        raise SSHKeyParseError("The key data isn't valid base64.") from e
    # The blob's first field must name the same algorithm - catches a mangled
    # paste where the type and body disagree.
    try:
        named_len = int.from_bytes(raw[:4], "big")
        named = raw[4:4 + named_len].decode("ascii", "replace")
    except Exception:  # noqa: BLE001
        named = ""
    if named and named != key_type and not key_type.startswith("sk-"):
        raise SSHKeyParseError(
            f"Key type '{key_type}' doesn't match the key data ('{named[:40]}')."
        )

    bits = _FIXED_BITS.get(key_type)
    if bits is None and key_type == "ssh-rsa":
        bits = _rsa_bits(blob)

    return {
        "key_type": key_type,
        "public_key": blob,
        "comment": comment,
        "fingerprint": fingerprint_from_blob(blob),
        "bits": bits,
    }
