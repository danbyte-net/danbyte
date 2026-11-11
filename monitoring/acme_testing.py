"""Test helpers for the ACME engine: a throwaway PKI and a tiny local ACME
directory over real TLS on 127.0.0.1, so trust, hostname, expiry, refusal and
timeouts are exercised against a real socket and never a real CA.

Imported by tests only.
"""
from __future__ import annotations

import base64
import json
import os
import secrets
import socket
import ssl
import tempfile
import threading
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import ip_address
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


def pem(cert: x509.Certificate) -> str:
    return cert.public_bytes(serialization.Encoding.PEM).decode("ascii")


def key_pem(key) -> str:
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption()).decode("ascii")


def make_ca(cn: str = "Throwaway Test Root", *, ca: bool = True, days: int = 30):
    """A self-signed certificate and key; ``ca=False`` for a non-CA one."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    now = datetime.now(UTC)
    builder = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name)
        .public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=days))
        .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()),
                       critical=False)
    )
    if ca:
        builder = builder.add_extension(
            x509.KeyUsage(digital_signature=True, content_commitment=False,
                          key_encipherment=False, data_encipherment=False,
                          key_agreement=False, key_cert_sign=True, crl_sign=True,
                          encipher_only=False, decipher_only=False), critical=True)
    return builder.sign(key, hashes.SHA256()), key


def make_server_cert(ca_cert, ca_key, names=("localhost", "127.0.0.1"), *, expired=False):
    """A server certificate signed by ``ca`` for ``names`` (DNS or IP)."""
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.now(UTC)
    if expired:
        nb, na = now - timedelta(days=10), now - timedelta(days=1)
    else:
        nb, na = now - timedelta(days=1), now + timedelta(days=10)
    san = []
    for n in names:
        try:
            san.append(x509.IPAddress(ip_address(n)))
        except ValueError:
            san.append(x509.DNSName(n))
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, names[0])]))
        .issuer_name(ca_cert.subject).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(nb).not_valid_after(na)
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
                       critical=False)
        .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]),
                       critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    return cert, key


def _nonce() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(16)).rstrip(b"=").decode()


class _Handler(BaseHTTPRequestHandler):
    server_version = "fake-acme"

    def log_message(self, *args):  # quiet
        return None

    def _send(self, status, body=b"", ctype="application/json", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Replay-Nonce", _nonce())
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _base(self):
        host = self.headers.get("Host") or "localhost"
        return f"https://{host}"

    def do_HEAD(self):
        self._send(200)

    def do_GET(self):
        if self.path == "/directory":
            b = self._base()
            body = json.dumps({"newNonce": f"{b}/nonce", "newAccount": f"{b}/acct",
                               "newOrder": f"{b}/order"}).encode()
            return self._send(200, body)
        if self.path == "/not-a-directory":
            return self._send(200, json.dumps({"hello": "world"}).encode())
        self._send(404, b"<html>not found</html>", ctype="text/html")

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        if self.path == "/acct":
            body = json.dumps({"status": "valid", "contact": []}).encode()
            return self._send(201, body, headers={"Location": f"{self._base()}/acct/1"})
        self._send(404, b"<html>not found</html>", ctype="text/html")


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):  # a refused handshake is expected
        return None


class FakeAcme:
    """A local ACME directory over TLS. Use as a context manager::

        with FakeAcme(cert_pem, key_pem) as ca:
            ca.url("/directory")
    """

    def __init__(self, cert_pem: str, key_pem_text: str):
        self._dir = tempfile.mkdtemp(prefix="fake-acme-")
        cert_file = Path(self._dir) / "cert.pem"
        key_file = Path(self._dir) / "key.pem"
        cert_file.write_text(cert_pem)
        fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(key_pem_text)
        self._ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self._ctx.load_cert_chain(cert_file, key_file)

    def __enter__(self):
        self.httpd = _Server(("127.0.0.1", 0), _Handler)
        self.httpd.socket = self._ctx.wrap_socket(self.httpd.socket, server_side=True)
        self.port = self.httpd.server_address[1]
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self._thread.start()
        return self

    def url(self, path: str = "/directory", host: str = "localhost") -> str:
        return f"https://{host}:{self.port}{path}"

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()
        import shutil

        shutil.rmtree(self._dir, ignore_errors=True)


def closed_port() -> int:
    """A local port nothing listens on."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class SilentListener:
    """Accepts TCP connections (via the backlog) and never answers - a CA
    that hangs. Context manager; ``port`` is where it listens."""

    def __enter__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        return self

    def __exit__(self, *exc):
        self.sock.close()
