"""The in-browser SSH terminal - a Channels consumer bridging a browser to a
device shell over asyncssh.

Security model (every point re-checked here, never trusted from the URL):

* **Opt-in, fail-closed.** Disabled unless a deployment admin turns on
  ``DeploymentSettings.ssh_terminal_enabled``.
* **Authz at connect time.** The session user must be authenticated, have an
  active tenant, and hold the device ``connect`` verb *and* ``view`` on the
  target device in that tenant - checked now, not at enqueue.
* **Credential stays server-side.** The secret is fetched through the
  tenant-scoped, audited :meth:`DeviceCredential.resolve_secret` and used only to
  authenticate the outbound SSH; it is never sent to the browser.
* **No SSRF pivot.** The host is the device's *own* recorded management IP, never
  a client-supplied host.
* **Host identity verified.** The device's recorded :class:`SSHHostKey` rows are
  handed to asyncssh as known-hosts, so a mismatched key aborts **before**
  authentication (no password reaches a spoofed host). A device with no recorded
  key requires an explicit ``accept_new=1`` (the UI's "accept new host" - TOFU
  with human confirmation), mirroring a normal SSH client.
* **Audited.** Opening a session writes a ``connect`` audit entry.

The socket protocol is small JSON frames both ways:
  client→server: ``{"t":"i","d":"keystrokes"}`` · ``{"t":"r","cols":C,"rows":R}``
  server→client: ``{"t":"o","d":"output"}`` · ``{"t":"ready"}`` ·
                 ``{"t":"error","m":msg}`` · ``{"t":"exit","code":n}``
"""
from __future__ import annotations

import asyncio
import json
import logging
from urllib.parse import parse_qs

import asyncssh
from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer

log = logging.getLogger(__name__)

# Guard rails. Connect must be quick; a session and an idle client are bounded so
# a forgotten tab can't hold a device shell open forever.
CONNECT_TIMEOUT = 12  # seconds to establish the SSH connection
MAX_SESSION_SECONDS = 60 * 60  # hard cap on one terminal session
IDLE_SECONDS = 15 * 60  # close after this long with no client input
READ_CHUNK = 4096

# WebSocket close codes (4000-4999 = application-defined).
CLOSE_UNAUTH = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_BADREQ = 4400


class SshTerminalConsumer(AsyncWebsocketConsumer):
    # This is a point-to-point bridge - it never uses groups or channel-layer
    # sends. Point at an unconfigured alias so ``get_channel_layer`` returns
    # None and Channels doesn't run the Redis ``receive`` loop, whose ~5s socket
    # timeout on an idle channel would otherwise kill the session.
    channel_layer_alias = "ssh-terminal-none"

    _conn = None
    _proc = None
    _reader_task = None
    _guard_task = None
    _awaiting_auth = False
    _ctx = None

    async def connect(self):
        self.device_id = self.scope["url_route"]["kwargs"]["device_id"]
        user = self.scope.get("user")
        if user is None or not getattr(user, "is_authenticated", False):
            await self.close(code=CLOSE_UNAUTH)
            return
        session = self.scope.get("session")
        qs = parse_qs(self.scope.get("query_string", b"").decode())
        credential_id = (qs.get("credential", [""])[0]).strip()
        self._accept_new = qs.get("accept_new", ["0"])[0] in ("1", "true")
        self._cols = _int(qs.get("cols", ["80"])[0], 80)
        self._rows = _int(qs.get("rows", ["24"])[0], 24)
        interactive = qs.get("mode", [""])[0] == "interactive"

        ctx = await self._load_context(
            user.id, session, self.device_id, credential_id, interactive=interactive
        )
        # Accept the socket so we can deliver a readable error before closing.
        await self.accept()
        if ctx.get("error"):
            await self._fail(ctx["error"])
            return

        self._last_input = asyncio.get_event_loop().time()
        self._ctx = ctx
        if ctx.get("interactive"):
            # The operator supplies their own login; wait for it before touching
            # the device, so no shared credential is involved.
            self._awaiting_auth = True
            await self.send(
                json.dumps({"t": "need_auth", "username": ctx.get("username", "")})
            )
            return
        await self._start_session()

    async def _start_session(self):
        """Open SSH with the resolved context and start the PTY pumps."""
        ctx = self._ctx
        try:
            await self._open_ssh(ctx, self._cols, self._rows, self._accept_new)
        except _HostKeyUnknown:
            await self._fail(
                "First connection to this device - its SSH host key isn't on "
                "record yet. Click “Accept new host & retry” to trust the "
                "key it presents; it's recorded so future connections are "
                "verified automatically.",
                code="hostkey_unknown",
            )
            return
        except (asyncssh.HostKeyNotVerifiable, asyncssh.PermissionDenied) as exc:
            # PermissionDenied here is host-key verification failing before auth,
            # or auth itself; either way, do not leak which.
            await self._fail(
                "Host key verification failed - the key the device presented does "
                f"not match the recorded key. Possible interception. ({exc})",
                code="hostkey_mismatch",
            )
            return
        except (asyncssh.Error, OSError, TimeoutError) as exc:
            await self._fail(f"Could not connect: {exc}")
            return

        await self._audit_connect(ctx)
        await self.send(json.dumps({"t": "ready"}))
        self._reader_task = asyncio.create_task(self._pump_output())
        self._guard_task = asyncio.create_task(self._watchdog())

    async def _open_ssh(self, ctx, cols, rows, accept_new):
        """Establish the SSH connection with host-key verification, then start an
        interactive shell with a PTY. Raises on any failure (handled by caller)."""
        known_hosts = ctx["known_hosts_bytes"]  # bytes, or None when no keys on file
        if known_hosts is None and not accept_new:
            raise _HostKeyUnknown()

        connect_kwargs = dict(
            host=ctx["host"],
            port=ctx["port"],
            username=ctx["username"],
            known_hosts=known_hosts,  # bytes → verify+abort before auth; None → TOFU
            connect_timeout=CONNECT_TIMEOUT,
        )
        if ctx["auth_kind"] == "password":
            connect_kwargs["password"] = ctx["password"]
            # Don't fall through to agent/key probing when a password is intended.
            connect_kwargs["client_keys"] = None
        else:
            connect_kwargs["client_keys"] = [ctx["client_key"]]

        self._conn = await asyncio.wait_for(
            asyncssh.connect(**connect_kwargs), timeout=CONNECT_TIMEOUT
        )
        # Record the host key the device presented, so the next connect is
        # verified against it (TOFU on first accept) and it appears in the SSH
        # host-key inventory. Best-effort - never break the session over it.
        try:
            key = self._conn.get_server_host_key()
            if key is not None:
                line = key.export_public_key()
                if isinstance(line, (bytes, bytearray)):
                    line = line.decode()
                await self._record_host_key(ctx, line)
        except Exception:  # noqa: BLE001
            pass
        self._proc = await self._conn.create_process(
            term_type="xterm-256color", term_size=(cols, rows), encoding=None
        )

    async def _pump_output(self):
        """Device stdout → browser, until EOF or the process exits."""
        try:
            while True:
                data = await self._proc.stdout.read(READ_CHUNK)
                if not data:
                    break
                await self.send(
                    json.dumps({"t": "o", "d": data.decode("utf-8", "replace")})
                )
        except (asyncssh.Error, OSError, asyncio.CancelledError):
            pass
        finally:
            code = getattr(self._proc, "returncode", None)
            try:
                await self.send(json.dumps({"t": "exit", "code": code}))
            except Exception:  # noqa: BLE001 - socket may already be gone
                pass
            await self.close()

    async def _watchdog(self):
        """Enforce the max-session and idle caps."""
        loop = asyncio.get_event_loop()
        start = loop.time()
        try:
            while True:
                await asyncio.sleep(30)
                now = loop.time()
                if now - start > MAX_SESSION_SECONDS:
                    await self._fail("Session time limit reached.", code="timeout")
                    return
                if now - self._last_input > IDLE_SECONDS:
                    await self._fail("Disconnected due to inactivity.", code="idle")
                    return
        except asyncio.CancelledError:
            pass

    async def receive(self, text_data=None, bytes_data=None):
        if not text_data:
            return
        try:
            msg = json.loads(text_data)
        except (ValueError, TypeError):
            return
        t = msg.get("t")
        # Interactive login: the operator's own username/password arrive once,
        # here, and are used only for this session - never stored or audited.
        if self._awaiting_auth and t == "auth":
            self._awaiting_auth = False
            username = (msg.get("username") or self._ctx.get("username") or "").strip()
            if not username:
                await self._fail("A username is required.")
                return
            self._ctx["username"] = username
            self._ctx["auth_kind"] = "password"
            self._ctx["password"] = msg.get("password") or ""
            await self._start_session()
            return
        if self._proc is None:
            return
        if t == "i":
            self._last_input = asyncio.get_event_loop().time()
            data = msg.get("d")
            if isinstance(data, str):
                self._proc.stdin.write(data.encode("utf-8"))
        elif t == "r":
            cols = _int(msg.get("cols"), 80)
            rows = _int(msg.get("rows"), 24)
            try:
                self._proc.change_terminal_size(cols, rows)
            except (asyncssh.Error, OSError):
                pass

    async def disconnect(self, code):
        for task in (self._reader_task, self._guard_task):
            if task is not None:
                task.cancel()
        if self._proc is not None:
            try:
                self._proc.close()
            except Exception:  # noqa: BLE001
                pass
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:  # noqa: BLE001
                pass

    async def _fail(self, message, code=None):
        try:
            await self.send(json.dumps({"t": "error", "m": message, "code": code}))
        except Exception:  # noqa: BLE001
            pass
        await self.close()

    # ── DB / authz (all sync work runs in the DB thread) ─────────────────────

    @database_sync_to_async
    def _load_context(self, user_id, session, device_id, credential_id,
                      *, interactive=False):
        """Resolve + authorize everything the SSH connection needs, or return
        ``{"error": msg}``. Runs in a DB thread (no async ORM here)."""
        from django.contrib.auth.models import User

        from api.models import Device
        from api.views import _get_active_tenant
        from auth_api import rbac
        from core.models import DeploymentSettings

        from .models import DeviceCredential, SSHHostKey
        from .secret_store import SecretStoreDisabled, SecretStoreError

        if not DeploymentSettings.load().ssh_terminal_enabled:
            return {"error": "The in-browser SSH terminal is disabled."}
        try:
            user = User.objects.get(pk=user_id)
        except User.DoesNotExist:
            return {"error": "Not authorized."}
        # Resolve the active tenant the same way the HTTP layer does - session
        # choice, else the profile's home tenant, else the first allowed - so a
        # fresh login with no explicit tenant switch still resolves one.
        tenant = _get_active_tenant(_ShimRequest(user, session))
        if tenant is None:
            return {"error": "No active tenant."}

        device = Device.objects.filter(pk=device_id, tenant_id=tenant.id).first()
        if device is None:
            return {"error": "Device not found."}
        # The capability verb AND plain view, both re-checked on this row.
        if not rbac.can_act_on(user, tenant, "device", "connect", device):
            return {"error": "You do not have the connect permission for this device."}
        if not rbac.can_act_on(user, tenant, "device", "view", device):
            return {"error": "You do not have access to this device."}

        from audit.site_capture import entry_site_id

        host = _device_host(device)
        if not host:
            return {"error": "This device has no management IP to connect to."}

        # Everything except the auth material - shared by both modes.
        ctx = {
            "user_id": user.id,
            "user_name": user.get_username(),
            "tenant_id": tenant.id,
            "device_id": str(device.id),
            "device_repr": str(device),
            "site_id": entry_site_id(device),
            "host": host,
            "known_hosts_bytes": _known_hosts_bytes(
                host, SSHHostKey.objects.filter(tenant_id=tenant.id, device_id=device.id)
            ),
        }

        if interactive:
            # No stored credential: the operator authenticates with their own
            # login, supplied over the socket after connect. Default the username
            # to their Danbyte account, but let them override it.
            ctx["interactive"] = True
            ctx["port"] = 22
            ctx["username"] = user.get_username()
            return ctx

        if not _is_uuid(credential_id):
            return {"error": "Pick an SSH credential for this device."}
        cred = DeviceCredential.objects.filter(
            pk=credential_id, tenant_id=tenant.id, device_id=device.id
        ).first()
        if cred is None:
            return {"error": "Pick an SSH credential for this device."}
        if cred.kind not in (
            DeviceCredential.Kind.SSH_PASSWORD,
            DeviceCredential.Kind.SSH_KEY,
        ):
            return {"error": "That credential is not an SSH credential."}

        try:
            secret = cred.resolve_secret()  # tenant-scoped + audited (reveal)
        except SecretStoreDisabled as exc:
            return {"error": str(exc)}
        except SecretStoreError as exc:
            return {"error": str(exc)}

        ctx["port"] = cred.port or 22
        ctx["username"] = cred.username or "root"
        if cred.kind == DeviceCredential.Kind.SSH_PASSWORD:
            ctx["auth_kind"] = "password"
            ctx["password"] = (secret or {}).get("password", "")
        else:
            ctx["auth_kind"] = "key"
            try:
                ctx["client_key"] = asyncssh.import_private_key(
                    (secret or {}).get("private_key", ""),
                    passphrase=(secret or {}).get("passphrase") or None,
                )
            except (asyncssh.KeyImportError, ValueError):
                return {"error": "The stored SSH key could not be loaded."}
        return ctx

    @database_sync_to_async
    def _record_host_key(self, ctx, line):
        """Fold the presented host key into the SSH host-key inventory (observed).
        Idempotent per (device, fingerprint); refreshes last_seen otherwise."""
        from api.models import Device
        from core.models import Tenant
        from danbyte_checks.ssh_hostkey import SSHKeyParseError, parse_public_key_line

        from .ssh_host_keys import record_host_key

        try:
            parsed = parse_public_key_line(line)
        except SSHKeyParseError:
            return
        device = Device.objects.filter(
            pk=ctx["device_id"], tenant_id=ctx["tenant_id"]
        ).first()
        tenant = Tenant.objects.filter(pk=ctx["tenant_id"]).first()
        if device is not None and tenant is not None:
            record_host_key(
                tenant, device,
                {
                    "fingerprint": parsed["fingerprint"],
                    "key_type": parsed["key_type"],
                    "public_key": parsed["public_key"],
                },
            )

    @database_sync_to_async
    def _audit_connect(self, ctx):
        from audit.context import current_request_id, current_via
        from audit.models import ChangeAction, ChangeLogEntry

        ChangeLogEntry.objects.create(
            tenant_id=ctx["tenant_id"],
            user_id=ctx["user_id"],
            user_name=ctx["user_name"],
            action=ChangeAction.CONNECT,
            object_type="api.device",
            object_label="Device",
            object_id=ctx["device_id"],
            object_repr=ctx["device_repr"],
            object_site_id=ctx.get("site_id"),
            changes={"connected": "ssh_terminal", "host": ctx["host"]},
            request_id=current_request_id(),
            via=current_via() or "system",
        )


class _ShimRequest:
    """A minimal request-like object so the WS consumer can reuse the HTTP
    layer's ``_get_active_tenant`` (which reads ``.user``, ``.session``,
    ``.auth``). WS sessions have no DRF token, so ``auth`` is always None."""

    auth = None

    def __init__(self, user, session):
        self.user = user
        self.session = session or {}


class _HostKeyUnknown(Exception):
    """No recorded host key and the client did not opt into trust-on-first-use."""


def _is_uuid(value) -> bool:
    import uuid

    try:
        uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return False
    return True


def _int(value, default):
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return n if 0 < n <= 1000 else default


def _device_host(device) -> str:
    """The device's own recorded management IP - never client-supplied. Primary,
    then OOB. Returns the bare address (GenericIPAddressField has no mask)."""
    for ip in (device.primary_ip, device.oob_ip):
        if ip is not None and ip.ip_address:
            return ip.ip_address
    return ""


def _known_hosts_bytes(host, keys) -> bytes | None:
    """An OpenSSH known_hosts blob pinning ``host`` to the device's recorded keys,
    or ``None`` when none are on file (caller then requires explicit TOFU).

    asyncssh verifies the server key against this **before** authenticating, so a
    mismatch aborts before the credential is ever sent."""
    lines = [
        f"{host} {k.key_type} {k.public_key}"
        for k in keys
        if k.key_type and k.public_key
    ]
    return ("\n".join(lines) + "\n").encode() if lines else None
