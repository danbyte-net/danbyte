"""SFTP backup target (#319).

Archives go to a directory on any SSH server over SFTP, through ``asyncssh``.
The rest of the backup code is synchronous (RQ worker, request threads), so
each operation runs its coroutine on a private event loop in a helper thread;
an open archive keeps its connection and loop until it is closed.

Safety rules:

- The host passes the outbound address policy (``core.ssrf``) and the
  connection goes to the checked address, never to a fresh lookup.
- Nothing authenticates until the server's host key matches the stored
  fingerprint. With no fingerprint stored every operation is refused;
  ``host_key()`` reads the key without logging in so an admin can confirm it.
- No ``~/.ssh`` config, agent, default keys or known_hosts of the worker's
  user are consulted: only what the target stores.
- Uploads land as ``<name>.part`` and are renamed when complete, so an
  interrupted transfer never looks like an archive (listing shows ``.dbk``
  only).
"""
from __future__ import annotations

import asyncio
import io
import posixpath
import threading
from datetime import UTC, datetime
from typing import BinaryIO

from .storage import _MARKER, StorageError

DEFAULT_PORT = 22
CONNECT_TIMEOUT = 20
READ_BLOCK = 1024 * 1024

#: Host key algorithms in a fixed order, plain keys only (no certificates),
#: so the key read by ``host_key()`` is the key every later connection sees.
#: Ed25519 first: it is the fingerprint ``ssh-keygen -lf`` shows by default.
HOST_KEY_ALGS = [
    "ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521",
    "rsa-sha2-512", "rsa-sha2-256",
]


def normalize_fingerprint(value: str) -> str:
    """``SHA256:<base64>`` as ``ssh-keygen -lf`` prints it; a bare base64
    value gets the prefix. Empty stays empty."""
    v = str(value or "").strip()
    if not v:
        return ""
    if v.upper().startswith("SHA256:"):
        v = v[7:]
    v = v.rstrip("=")
    if not v or any(c not in _B64 for c in v):
        raise StorageError("Host key fingerprint must look like SHA256:… (ssh-keygen -lf).")
    return f"SHA256:{v}"


_B64 = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")


def location_for(host, port, username, path) -> str:
    """``sftp://user@host:port/abs/dir``; a directory relative to the login
    home shows as ``/~/dir``."""
    p = (str(path or "").strip() or ".").rstrip("/") or "/"
    if p == ".":
        p = "/~"
    elif not p.startswith("/"):
        p = "/~/" + p.removeprefix("./")
    return f"sftp://{username or ''}@{host or ''}:{port or DEFAULT_PORT}{p}"


class HostKeyChanged(StorageError):
    pass


class _Loop:
    """An event loop on its own daemon thread."""

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, name="sftp-backup", daemon=True)
        self.thread.start()

    def run(self, awaitable, timeout: float | None = None):
        async def _await():
            # some asyncssh entry points return awaitables, not coroutines
            return await awaitable

        return asyncio.run_coroutine_threadsafe(_await(), self.loop).result(timeout)

    def stop(self) -> None:
        if self.loop.is_closed():
            return
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=10)
        self.loop.close()


def _describe(exc: BaseException) -> str:
    import asyncssh

    if isinstance(exc, asyncssh.PermissionDenied):
        return "authentication failed"
    if isinstance(exc, TimeoutError):
        return "timed out"
    if isinstance(exc, asyncssh.SFTPError):
        return exc.reason or type(exc).__name__
    if isinstance(exc, asyncssh.Error):
        return exc.reason or type(exc).__name__
    if isinstance(exc, OSError):
        return exc.strerror or str(exc)
    return str(exc) or type(exc).__name__


class _RemoteRaw(io.RawIOBase):
    """Synchronous read side of an open remote file. Owns its connection."""

    def __init__(self, loop: _Loop, conn, sftp, fh):
        super().__init__()
        self._loop, self._conn, self._sftp, self._fh = loop, conn, sftp, fh

    def readable(self) -> bool:
        return True

    def readinto(self, b) -> int:  # type: ignore[override]
        try:
            data = self._loop.run(self._fh.read(len(b)))
        except Exception as exc:  # noqa: BLE001 - surface one error type
            raise StorageError(f"SFTP read failed: {_describe(exc)}") from exc
        n = len(data)
        b[:n] = data
        return n

    def close(self) -> None:
        if self.closed:
            return
        try:
            async def _close():
                try:
                    await self._fh.close()
                finally:
                    self._sftp.exit()
                    self._conn.close()
                    await self._conn.wait_closed()

            self._loop.run(_close(), timeout=CONNECT_TIMEOUT)
        except Exception:  # noqa: BLE001 - closing is best effort
            pass
        finally:
            self._loop.stop()
            super().close()


class SFTPBackend:
    kind = "sftp"

    def __init__(
        self,
        host: str,
        username: str,
        path: str = "",
        port: int | str = DEFAULT_PORT,
        host_key_fingerprint: str = "",
        password: str = "",
        private_key: str = "",
        passphrase: str = "",
    ):
        if not str(host or "").strip():
            raise StorageError("An SFTP target needs a host.")
        if not str(username or "").strip():
            raise StorageError("An SFTP target needs a username.")
        try:
            self.port = int(port or DEFAULT_PORT)
        except (TypeError, ValueError) as exc:
            raise StorageError("Port must be a number.") from exc
        if not 1 <= self.port <= 65535:
            raise StorageError("Port must be between 1 and 65535.")
        self.host = str(host).strip()
        self.username = str(username).strip()
        self.path = (str(path or "").strip() or ".").rstrip("/") or "/"
        self.fingerprint = normalize_fingerprint(host_key_fingerprint)
        self.password = password or ""
        self.private_key = private_key or ""
        self.passphrase = passphrase or ""

    # ─── plumbing ─────────────────────────────────────────────────────────
    @property
    def location(self) -> str:
        return location_for(self.host, self.port, self.username, self.path)

    def _p(self, name: str) -> str:
        if "/" in name or name in (".", "..", "") or "\x00" in name:
            raise StorageError("bad archive name")
        return posixpath.join(self.path, name)

    def _address(self) -> str:
        from core.ssrf import SSRFError, resolve_public_host

        try:
            return resolve_public_host(self.host, self.port)[0]
        except SSRFError as exc:
            raise StorageError(str(exc)) from exc

    def _client_keys(self):
        if not self.private_key:
            return None
        import asyncssh

        try:
            return [asyncssh.import_private_key(self.private_key, self.passphrase or None)]
        except (asyncssh.KeyImportError, ValueError) as exc:
            raise StorageError(f"The private key could not be read: {exc}.") from exc

    async def _connect(self, addr: str):
        """Runs on the helper loop. ``addr`` comes from :meth:`_address`, which
        must run on the calling thread: it reads the allow-list through the
        ORM."""
        import asyncssh

        if not self.fingerprint:
            raise StorageError("No host key is trusted yet. Run Test and confirm the key first.")
        if not (self.password or self.private_key):
            raise StorageError("An SFTP target needs a password or a private key.")
        expected = self.fingerprint
        seen: dict[str, str] = {}

        class _Client(asyncssh.SSHClient):
            def validate_host_public_key(self, host, addr, port, key) -> bool:
                seen["fp"] = key.get_fingerprint("sha256")
                return seen["fp"] == expected

        try:
            conn, _ = await asyncssh.create_connection(
                _Client, addr, self.port,
                username=self.username,
                password=self.password or None,
                client_keys=self._client_keys(),
                known_hosts=([], [], []),
                server_host_key_algs=HOST_KEY_ALGS,
                x509_trusted_certs=None,
                agent_path=None,
                config=None,
                preferred_auth="publickey,keyboard-interactive,password",
                connect_timeout=CONNECT_TIMEOUT,
                login_timeout=CONNECT_TIMEOUT,
                keepalive_interval=30,
            )
        except Exception as exc:  # noqa: BLE001 - asyncssh, OS and timeout errors
            if seen.get("fp") and seen["fp"] != expected:
                raise HostKeyChanged(
                    f"{self.host}: the host key changed (now {seen['fp']}, trusted {expected}). "
                    "Connection refused. Clear the fingerprint and Test again only if the "
                    "server's key was replaced on purpose."
                ) from exc
            raise StorageError(f"{self.host}:{self.port}: {_describe(exc)}") from exc
        try:
            sftp = await conn.start_sftp_client()
        except Exception as exc:  # noqa: BLE001
            conn.close()
            raise StorageError(f"{self.host}: SFTP is not available: {_describe(exc)}") from exc
        return conn, sftp

    def _run(self, op):
        """Connect, run ``await op(sftp)``, disconnect."""
        addr = self._address()
        loop = _Loop()

        async def _go():
            conn, sftp = await self._connect(addr)
            try:
                return await op(sftp)
            finally:
                sftp.exit()
                conn.close()
                await conn.wait_closed()

        try:
            return loop.run(_go())
        except StorageError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise StorageError(f"{self.location}: {_describe(exc)}") from exc
        finally:
            loop.stop()

    # ─── host key ─────────────────────────────────────────────────────────
    def host_key(self) -> dict:
        """The key the server presents, read without logging in."""
        import asyncssh

        addr = self._address()
        loop = _Loop()
        try:
            key = loop.run(asyncssh.get_server_host_key(
                addr, self.port, server_host_key_algs=HOST_KEY_ALGS, config=None,
            ), timeout=CONNECT_TIMEOUT * 2)
        except Exception as exc:  # noqa: BLE001
            raise StorageError(f"{self.host}:{self.port}: {_describe(exc)}") from exc
        finally:
            loop.stop()
        if key is None:
            raise StorageError(f"{self.host}:{self.port}: the server presented no host key.")
        return {"fingerprint": key.get_fingerprint("sha256"), "algorithm": key.get_algorithm()}

    # ─── storage protocol ─────────────────────────────────────────────────
    def put(self, local_path: str, name: str) -> str:
        dest = self._p(name)
        part = dest + ".part"

        async def op(sftp):
            await sftp.makedirs(self.path, exist_ok=True)
            try:
                await sftp.put(local_path, part)
                if await sftp.exists(dest):
                    await sftp.remove(dest)
                await sftp.rename(part, dest)
            except BaseException:
                try:
                    await sftp.remove(part)
                except Exception:  # noqa: BLE001 - the connection may be gone
                    pass
                raise

        self._run(op)
        return f"{self.location.rstrip('/')}/{name}"

    def open(self, name: str) -> BinaryIO:
        path = self._p(name)
        addr = self._address()
        loop = _Loop()

        async def _go():
            conn, sftp = await self._connect(addr)
            try:
                fh = await sftp.open(path, "rb")
            except BaseException:
                sftp.exit()
                conn.close()
                raise
            return conn, sftp, fh

        try:
            conn, sftp, fh = loop.run(_go())
        except StorageError:
            loop.stop()
            raise
        except Exception as exc:  # noqa: BLE001
            loop.stop()
            raise StorageError(f"{self.location}/{name}: {_describe(exc)}") from exc
        return io.BufferedReader(_RemoteRaw(loop, conn, sftp, fh), buffer_size=READ_BLOCK)

    def size(self, name: str) -> int:
        path = self._p(name)

        async def op(sftp):
            return int((await sftp.stat(path)).size or 0)

        return self._run(op)

    def list(self) -> list[dict]:
        import asyncssh

        async def op(sftp):
            try:
                entries = await sftp.readdir(self.path)
            except asyncssh.SFTPNoSuchFile:
                return []
            out = []
            for e in entries:
                if not e.filename.endswith(".dbk") or e.attrs.type != asyncssh.FILEXFER_TYPE_REGULAR:
                    continue
                out.append({
                    "name": e.filename,
                    "size": int(e.attrs.size or 0),
                    "modified": datetime.fromtimestamp(e.attrs.mtime or 0, UTC),
                })
            return out

        return sorted(self._run(op), key=lambda e: e["modified"], reverse=True)

    def delete(self, name: str) -> None:
        import asyncssh

        path = self._p(name)

        async def op(sftp):
            try:
                await sftp.remove(path)
            except asyncssh.SFTPNoSuchFile:
                pass

        self._run(op)

    def probe(self) -> None:
        marker = self._p(_MARKER)

        async def op(sftp):
            await sftp.makedirs(self.path, exist_ok=True)
            async with sftp.open(marker, "wb") as fh:
                await fh.write(b"ok")
            await sftp.remove(marker)

        self._run(op)


def clean_config(cfg: dict) -> dict:
    """Validate and normalise a target's ``config``; raises StorageError."""
    b = SFTPBackend(
        host=cfg.get("host", ""), port=cfg.get("port") or DEFAULT_PORT,
        username=cfg.get("username", ""), path=cfg.get("path", ""),
        host_key_fingerprint=cfg.get("host_key_fingerprint", ""),
    )
    return {
        "host": b.host, "port": b.port, "username": b.username,
        "path": str(cfg.get("path") or "").strip(), "host_key_fingerprint": b.fingerprint,
    }


def check_credentials(cred: dict) -> None:
    """At least one way in, and a private key that opens."""
    if not (cred.get("password") or cred.get("private_key")):
        raise StorageError("Give a password or a private key.")
    if cred.get("private_key"):
        SFTPBackend(host="-", username="-", private_key=cred["private_key"],
                    passphrase=cred.get("passphrase", ""))._client_keys()


def factory(cfg: dict, cred: dict) -> SFTPBackend:
    return SFTPBackend(
        host=cfg.get("host", ""), port=cfg.get("port") or DEFAULT_PORT,
        username=cfg.get("username", ""), path=cfg.get("path", ""),
        host_key_fingerprint=cfg.get("host_key_fingerprint", ""),
        password=cred.get("password", ""), private_key=cred.get("private_key", ""),
        passphrase=cred.get("passphrase", ""),
    )
