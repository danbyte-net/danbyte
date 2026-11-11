"""Windows inventory over WinRM - HTTPS with a client certificate only.

The third transport (#451 B2-win), off by default, tried after SSH key and
SSH password. What it offers, and what it never does:

* **HTTPS only** (``https://<address>:<port>/wsman``, port 5986 unless the
  credential names one). There is no code path for plain HTTP.
* **The server certificate is verified** against the server's trust store
  (``DANBYTE_DISCOVERY_WINRM_CA_BUNDLE``, else the system bundle), and the
  name checked is the address's DNS name in IPAM when it has one, else the
  address itself. There is no switch to skip it.
* **Client-certificate authentication** (WS-Management's HTTPS mutual
  profile), from a ``winrm_cert`` credential: certificate and private key
  in PEM. **Kerberos is not available in this build**: pywinrm needs
  ``pykerberos`` (or ``pyspnego`` with ``gssapi``) and a system Kerberos
  library for it, none of which is installed. NTLM, Basic and CredSSP are
  never used: this module only ever asks pywinrm for ``certificate``.
* The certificate and key are handed to the TLS library through anonymous
  in-memory files (``memfd_create``), never written to disk, and closed when
  the connection ends.
* No redirects are followed, no proxy from the environment is used, and the
  connection goes to the address the scope checked, never to a name looked
  up again.
* The command is the fixed PowerShell inventory of
  :mod:`danbyte_checks.inventory_windows`; nothing from the user is placed
  in it.
"""
from __future__ import annotations

import asyncio
import os
import ssl
from contextlib import contextmanager

from danbyte_checks import inventory as inv
from danbyte_checks import inventory_windows as win

DEFAULT_PORT = 5986
TRANSPORT = "certificate"


def ca_bundle() -> str | None:
    """The CA bundle server certificates are checked against."""
    from django.conf import settings

    configured = (getattr(settings, "DISCOVERY_WINRM_CA_BUNDLE", "") or "").strip()
    if configured:
        return configured
    paths = ssl.get_default_verify_paths()
    return paths.cafile or paths.openssl_cafile or None


def kerberos_available() -> bool:
    """Whether pywinrm could speak Kerberos here (it cannot in this build)."""
    try:
        from winrm import transport

        return bool(transport.HAVE_KERBEROS)
    except Exception:  # noqa: BLE001 - no pywinrm at all
        return False


def available() -> tuple[bool, str]:
    """Whether the WinRM transport can run on this server: pywinrm and
    in-memory files are there. ``(ok, reason)``."""
    try:
        import winrm  # noqa: F401
    except ImportError:
        return False, "pywinrm is not installed."
    if not hasattr(os, "memfd_create"):
        return False, "This platform has no in-memory files for the client certificate."
    return True, ""


def _plain_key(private_key: str, passphrase: str | None) -> bytes:
    """The private key as unencrypted PEM, in memory only (requests cannot
    pass a passphrase to the TLS library)."""
    from cryptography.hazmat.primitives import serialization

    try:
        key = serialization.load_pem_private_key(
            private_key.encode(), password=passphrase.encode() if passphrase else None)
    except (ValueError, TypeError):
        raise inv.InventoryError(inv.AUTH_FAILED,
                                 "The stored client key could not be loaded.") from None
    return key.private_bytes(serialization.Encoding.PEM,
                             serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption())


@contextmanager
def _memfiles(*blobs: bytes):
    """Paths of anonymous in-memory files holding ``blobs``."""
    fds = []
    try:
        for blob in blobs:
            fd = os.memfd_create("danbyte-winrm")
            fds.append(fd)
            os.write(fd, blob)
        yield [f"/proc/self/fd/{fd}" for fd in fds]
    finally:
        for fd in fds:
            try:
                os.close(fd)
            except OSError:
                pass


def protocol_for(address: str, *, port: int, server_name: str, cert_path: str,
                 key_path: str, timeout: float):
    """A pywinrm ``Protocol`` for HTTPS client-certificate auth to
    ``address``, TLS checked against ``server_name``."""
    from winrm.protocol import Protocol

    from core.ssrf import mount_pinned_adapter

    host = f"[{address}]" if ":" in address else address
    endpoint = f"https://{host}:{port}/wsman"
    read = max(10, int(timeout))
    p = Protocol(endpoint, transport=TRANSPORT, cert_pem=cert_path, cert_key_pem=key_path,
                 server_cert_validation="validate", ca_trust_path=ca_bundle() or True,
                 read_timeout_sec=read + 5, operation_timeout_sec=read, proxy=None,
                 message_encryption="never")
    session = p.transport.build_session()
    session.trust_env = False
    session.max_redirects = 0
    if server_name and server_name != address:
        mount_pinned_adapter(session, endpoint, server_name)
    return p


def _run(protocol) -> tuple[int, bytes]:
    shell = protocol.open_shell()
    try:
        command = protocol.run_command(shell, "powershell", list(win.POWERSHELL_ARGS))
        try:
            out, _err, code = protocol.get_command_output(shell, command)
        finally:
            protocol.cleanup_command(shell, command)
    finally:
        protocol.close_shell(shell)
    return code, out


def collect_sync(address: str, *, port: int | None = None, timeout: float = 60.0,
                 certificate: str = "", private_key: str = "",
                 passphrase: str | None = None, server_name: str = "") -> inv.InventoryResult:
    """Read one Windows host over WinRM HTTPS. Never raises; the result's
    message never holds a secret."""
    import requests
    from winrm import exceptions as wexc

    ok, why = available()
    if not ok:
        return inv.InventoryResult(inv.UNSUPPORTED, why)
    if not certificate or not private_key:
        return inv.InventoryResult(inv.AUTH_FAILED,
                                   "The credential holds no client certificate and key.")
    try:
        key = _plain_key(private_key, passphrase)
    except inv.InventoryError as exc:
        return inv.InventoryResult(exc.status, exc.message)
    try:
        with _memfiles(certificate.encode(), key) as (cert_path, key_path):
            protocol = protocol_for(address, port=port or DEFAULT_PORT,
                                    server_name=server_name or address, cert_path=cert_path,
                                    key_path=key_path, timeout=timeout)
            code, out = _run(protocol)
    except wexc.InvalidCredentialsError:
        return inv.InventoryResult(inv.AUTH_FAILED, "The host refused the client certificate.")
    except requests.exceptions.SSLError:
        return inv.InventoryResult(TLS_REFUSED, "The host's TLS certificate is not trusted "
                                                "for its name.")
    except requests.exceptions.Timeout:
        return inv.InventoryResult(inv.TIMEOUT, f"No answer within {int(timeout)} s.")
    except (requests.exceptions.ConnectionError, OSError):
        return inv.InventoryResult(inv.UNREACHABLE, "WinRM over HTTPS is not reachable.")
    except requests.exceptions.TooManyRedirects:
        return inv.InventoryResult(inv.FAILED, "The host answered with a redirect.")
    except (wexc.WinRMError, wexc.WinRMTransportError, requests.exceptions.RequestException):
        return inv.InventoryResult(inv.FAILED, "WinRM refused the request.")
    if len(out or b"") > inv.MAX_OUTPUT:
        return inv.InventoryResult(inv.FAILED, "The host's answer is larger than "
                                               f"{inv.MAX_OUTPUT // (1024 * 1024)} MB.")
    if code != 0 or not (out or b"").strip():
        return inv.InventoryResult(inv.FAILED, "PowerShell could not read the inventory.",
                                   os={"id": "windows"}, manager="windows")
    return inv.windows_result(out.decode("utf-8", errors="replace"))


#: A host whose TLS certificate does not verify (WinRM).
TLS_REFUSED = "tls_refused"


async def collect(address: str, *, timeout: float = 60.0, **credential) -> inv.InventoryResult:
    """:func:`collect_sync` off the event loop, bounded by ``timeout``."""
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(collect_sync, address, timeout=timeout, **credential),
            timeout + 10)
    except TimeoutError:
        return inv.InventoryResult(inv.TIMEOUT, f"No answer within {int(timeout)} s.")
