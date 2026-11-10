"""Package inventory over SSH - Django-free, shared by the core and Outposts.

Discovery phase B2 (#451): read a Linux host's installed packages with the
SSH credential the tenant already keeps, so vulnerability matching sees the
exact distro package versions (backported fixes included) instead of
guessing from banners.

What runs on the host is fixed. :data:`COMMANDS` holds every command string
this module can send; none of them takes any part of a user's input, so
nothing is ever interpolated into a command line. An SSH exec request runs
through the remote account's login shell - that is how SSH works - and the
strings are written so that shell has nothing to expand (single-quoted
format strings). No ``sudo``: every read works for an unprivileged account.

Safety on the wire:

* the server's host key must match one of the keys passed in
  ``known_hosts`` (the keys a person accepted); asyncssh checks it before any
  credential is sent, so a host with no accepted key is never logged in to;
* no ssh-agent, no ``~/.ssh`` keys or config, no GSS/host-based auth: only
  the one credential handed in;
* each command's output is capped (:data:`MAX_OUTPUT`) and the whole host
  is bounded by ``timeout``;
* stdin is closed and stderr discarded; nothing the host sends is executed
  or evaluated, only parsed by the strict parsers below.

The parsers are pure functions over text, tested on recorded outputs.
"""
from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field

#: Every command this module sends. Constants only.
COMMANDS: dict[str, str] = {
    "os_release": "cat /etc/os-release",
    "os_release_fallback": "cat /usr/lib/os-release",
    "dpkg": (
        "dpkg-query -W -f='${binary:Package}\\t${Version}\\t${source:Package}"
        "\\t${source:Version}\\t${Architecture}\\t${db:Status-Abbrev}\\n'"
    ),
    "rpm": (
        "rpm -qa --qf '%{NAME}\\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\\t%{ARCH}"
        "\\t%{SOURCERPM}\\n'"
    ),
    "apk": "cat /lib/apk/db/installed",
}

#: Bytes read from one command before the host is given up on.
MAX_OUTPUT = 16 * 1024 * 1024
#: Packages kept from one host; the rest are dropped and the result says so.
MAX_PACKAGES = 20_000
MAX_FIELD = 128
#: os-release keys read; everything else in the file is ignored.
OS_KEYS = ("ID", "ID_LIKE", "VERSION_ID", "VERSION_CODENAME", "PRETTY_NAME", "NAME")

# Result statuses (the core's InventoryHostResult uses the same words).
OK = "ok"
AUTH_FAILED = "auth_failed"
HOST_KEY_REFUSED = "host_key_refused"
UNREACHABLE = "unreachable"
TIMEOUT = "timeout"
UNSUPPORTED = "unsupported"
FAILED = "failed"

_DEB_NAME = re.compile(r"^[a-z0-9][a-z0-9+.-]{0,127}$")
_RPM_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._+-]{0,127}$")
_VERSION = re.compile(r"^[A-Za-z0-9.+~:_-]{1,128}$")
_ARCH = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
_OS_ID = re.compile(r"^[a-z0-9._-]{1,64}$")


class InventoryError(Exception):
    """A host could not be read; ``status`` is one of the result words."""

    def __init__(self, status: str, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class Package:
    #: ``deb`` / ``rpm`` / ``apk``
    type: str
    name: str
    version: str
    arch: str = ""
    source_name: str = ""
    source_version: str = ""


@dataclass
class ParseResult:
    packages: list[Package] = field(default_factory=list)
    #: Lines or records that did not parse (not installed, malformed).
    skipped: int = 0
    truncated: bool = False


@dataclass
class InventoryResult:
    status: str
    message: str = ""
    os: dict = field(default_factory=dict)
    manager: str = ""
    packages: list[Package] = field(default_factory=list)
    skipped: int = 0
    truncated: bool = False


# ─── os-release ──────────────────────────────────────────────────────────────


def _unquote(raw: str) -> str | None:
    """A shell-style os-release value: bare, "double" (with \\ escapes) or
    'single' quoted. ``None`` when it is not one."""
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] == "'":
        inner = raw[1:-1]
        return None if "'" in inner else inner
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        out, esc = [], False
        for ch in raw[1:-1]:
            if esc:
                out.append(ch if ch in '"\\$`' else "\\" + ch)
                esc = False
            elif ch == "\\":
                esc = True
            elif ch in '"`$':
                return None
            else:
                out.append(ch)
        return None if esc else "".join(out)
    if re.fullmatch(r"[A-Za-z0-9._+:/,~ -]*", raw) and " " not in raw:
        return raw
    return None


def parse_os_release(text: str) -> dict:
    """The keys of :data:`OS_KEYS` from an os-release file, lowercase keys,
    values capped; ``id_like`` is a list. Unknown or malformed lines are
    ignored. Raises :class:`InventoryError` when there is no usable ``ID``."""
    values: dict[str, str] = {}
    for line in (text or "").splitlines()[:200]:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, raw = line.partition("=")
        if key not in OS_KEYS:
            continue
        value = _unquote(raw)
        if value is None:
            continue
        values[key] = value[:MAX_FIELD]
    os_id = values.get("ID", "").strip().lower()
    if not _OS_ID.match(os_id):
        raise InventoryError(UNSUPPORTED, "The host's os-release names no ID.")
    like = [w for w in values.get("ID_LIKE", "").lower().split() if _OS_ID.match(w)][:8]
    return {
        "id": os_id,
        "id_like": like,
        "version_id": values.get("VERSION_ID", "").strip()[:32],
        "version_codename": values.get("VERSION_CODENAME", "").strip().lower()[:32],
        "pretty_name": values.get("PRETTY_NAME", "").strip(),
        "name": values.get("NAME", "").strip(),
    }


_FAMILIES = {
    "dpkg": {"debian", "ubuntu"},
    "rpm": {"rhel", "fedora", "centos", "rocky", "almalinux", "ol", "suse", "sles",
            "opensuse", "opensuse-leap", "amzn"},
    "apk": {"alpine"},
}


def package_manager(os_facts: dict) -> str | None:
    """``dpkg`` / ``rpm`` / ``apk`` for the host's distro (its ``ID``, then
    ``ID_LIKE``); ``None`` when it is none of those."""
    for word in [os_facts.get("id", ""), *(os_facts.get("id_like") or [])]:
        for manager, ids in _FAMILIES.items():
            if word in ids:
                return manager
    return None


# ─── package lists ───────────────────────────────────────────────────────────


def _finish(packages: dict, skipped: int) -> ParseResult:
    rows = list(packages.values())
    truncated = len(rows) > MAX_PACKAGES
    return ParseResult(packages=rows[:MAX_PACKAGES], skipped=skipped, truncated=truncated)


def parse_dpkg(text: str) -> ParseResult:
    """``dpkg-query`` output in the :data:`COMMANDS` format. Only installed
    packages (status ``?i?``) are kept; ``name:arch`` loses its suffix."""
    out: dict[tuple, Package] = {}
    skipped = 0
    for line in (text or "").splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) != 6:
            skipped += 1
            continue
        name, version, src, src_version, arch, status = (p.strip() for p in parts)
        if len(status) < 2 or status[1] != "i":
            skipped += 1  # removed with config left, half-installed, …
            continue
        name = name.split(":", 1)[0]
        if not _DEB_NAME.match(name) or not _VERSION.match(version) \
                or (arch and not _ARCH.match(arch)):
            skipped += 1
            continue
        src = src if _DEB_NAME.match(src or "") else name
        src_version = src_version if _VERSION.match(src_version or "") else version
        out[(name, arch)] = Package("deb", name, version, arch, src, src_version)
    return _finish(out, skipped)


def _srpm_name(srpm: str) -> str:
    """``openssl-3.0.7-27.el9.src.rpm`` -> ``openssl``."""
    if not srpm.endswith(".src.rpm") and not srpm.endswith(".nosrc.rpm"):
        return ""
    base = srpm.rsplit(".", 2)[0]
    head = base.rsplit("-", 2)
    return head[0] if len(head) == 3 and _RPM_NAME.match(head[0]) else ""


def parse_rpm(text: str) -> ParseResult:
    """``rpm -qa`` output in the :data:`COMMANDS` query format. The version
    is ``epoch:version-release`` (epoch 0 when the package has none);
    ``gpg-pubkey`` pseudo-packages are dropped."""
    out: dict[tuple, Package] = {}
    skipped = 0
    for line in (text or "").splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) != 4:
            skipped += 1
            continue
        name, evr, arch, srpm = (p.strip() for p in parts)
        if name == "gpg-pubkey":
            continue
        arch = "" if arch == "(none)" else arch
        epoch, sep, vr = evr.partition(":")
        if not sep or not epoch.isdigit():
            vr, epoch = evr, "0"
        version = f"{int(epoch)}:{vr}"
        if not _RPM_NAME.match(name) or not _VERSION.match(version) or "-" not in vr \
                or (arch and not _ARCH.match(arch)):
            skipped += 1
            continue
        src = _srpm_name(srpm) or name
        out[(name, arch)] = Package("rpm", name, version, arch, src, version)
    return _finish(out, skipped)


def parse_apk_installed(text: str) -> ParseResult:
    """``/lib/apk/db/installed``: one record per package, blank-line
    separated, ``P:`` name, ``V:`` version, ``A:`` arch, ``o:`` origin (the
    source package). File lists and checksums are ignored."""
    out: dict[tuple, Package] = {}
    skipped = 0
    rec: dict[str, str] = {}

    def flush():
        nonlocal skipped
        if not rec:
            return
        name, version = rec.get("P", ""), rec.get("V", "")
        arch, origin = rec.get("A", ""), rec.get("o", "")
        if not _RPM_NAME.match(name) or not _VERSION.match(version) \
                or (arch and not _ARCH.match(arch)):
            skipped += 1
        else:
            src = origin if _RPM_NAME.match(origin) else name
            out[(name.lower(), arch)] = Package("apk", name.lower(), version, arch,
                                                 src.lower(), version)
        rec.clear()

    for line in (text or "").splitlines():
        if not line.strip():
            flush()
            continue
        if len(line) >= 2 and line[1] == ":" and line[0] in "PVAo" and line[0] not in rec:
            rec[line[0]] = line[2:].strip()
    flush()
    return _finish(out, skipped)


PARSERS = {"dpkg": parse_dpkg, "rpm": parse_rpm, "apk": parse_apk_installed}


# ─── SSH ─────────────────────────────────────────────────────────────────────


def connect_options(*, username: str, password: str | None = None,
                    private_key: str | None = None, passphrase: str | None = None,
                    known_hosts: bytes) -> dict:
    """asyncssh.connect keyword arguments: the one credential, the pinned
    host keys, nothing from the local account. Raises
    :class:`InventoryError` for an unusable credential or no pinned key."""
    import asyncssh

    if not known_hosts:
        raise InventoryError(HOST_KEY_REFUSED, "No accepted host key for this host.")
    opts: dict = {
        "username": username,
        "known_hosts": known_hosts,
        "agent_path": None,
        "config": None,
        "gss_auth": False,
        "host_based_auth": False,
        "kbdint_auth": False,
        "x509_trusted_certs": None,
        "x509_trusted_cert_paths": None,
    }
    if private_key:
        try:
            key = asyncssh.import_private_key(private_key, passphrase=passphrase or None)
        except (asyncssh.KeyImportError, ValueError, TypeError):
            raise InventoryError(AUTH_FAILED, "The stored SSH key could not be loaded.") \
                from None
        opts.update(client_keys=[key], password=None, password_auth=False)
    elif password:
        opts.update(client_keys=None, public_key_auth=False, password=password)
    else:
        raise InventoryError(AUTH_FAILED, "The credential holds no password or key.")
    return opts


async def _run(conn, command: str, timeout: float) -> tuple[int | None, bytes]:
    """Run one constant command; stdin closed, stderr discarded, stdout
    capped at :data:`MAX_OUTPUT`."""
    import asyncssh

    if command not in COMMANDS.values():
        raise InventoryError(FAILED, "Not an inventory command.")
    proc = await conn.create_process(command, encoding=None, stdin=asyncssh.DEVNULL,
                                     stderr=asyncssh.DEVNULL)
    chunks, total = [], 0

    async def read():
        nonlocal total
        while True:
            data = await proc.stdout.read(65536)
            if not data:
                return
            total += len(data)
            if total > MAX_OUTPUT:
                proc.close()
                raise InventoryError(FAILED, "The host's answer is larger than "
                                             f"{MAX_OUTPUT // (1024 * 1024)} MB.")
            chunks.append(data)

    await asyncio.wait_for(read(), timeout)
    await asyncio.wait_for(proc.wait_closed(), max(1.0, timeout))
    return proc.exit_status, b"".join(chunks)


def _text(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")


async def read_host(conn, timeout: float) -> InventoryResult:
    """os-release, then the package list of the host's package manager."""
    status, out = await _run(conn, COMMANDS["os_release"], timeout)
    if status != 0 or not out.strip():
        status, out = await _run(conn, COMMANDS["os_release_fallback"], timeout)
    if status != 0:
        raise InventoryError(UNSUPPORTED, "The host has no readable os-release.")
    os_facts = parse_os_release(_text(out))
    manager = package_manager(os_facts)
    if manager is None:
        return InventoryResult(UNSUPPORTED, f"No package reader for {os_facts['id']}.",
                               os=os_facts)
    status, out = await _run(conn, COMMANDS[manager], timeout)
    if status != 0:
        return InventoryResult(FAILED, f"The {manager} package list could not be read.",
                               os=os_facts, manager=manager)
    parsed = PARSERS[manager](_text(out))
    return InventoryResult(OK, "", os=os_facts, manager=manager, packages=parsed.packages,
                           skipped=parsed.skipped, truncated=parsed.truncated)


async def collect(host: str, *, port: int = 22, timeout: float = 60.0,
                  **credential) -> InventoryResult:
    """Read one host. ``credential``: ``username`` and ``password`` or
    ``private_key`` (+ ``passphrase``), and ``known_hosts`` (bytes, the
    accepted keys). Never raises; the result's ``status`` says what
    happened and ``message`` never holds a secret."""
    import asyncssh

    try:
        opts = connect_options(**credential)
    except InventoryError as exc:
        return InventoryResult(exc.status, exc.message)

    async def go():
        async with asyncssh.connect(host, port=port, connect_timeout=min(timeout, 15),
                                    login_timeout=min(timeout, 30), **opts) as conn:
            return await read_host(conn, timeout)

    try:
        return await asyncio.wait_for(go(), timeout)
    except InventoryError as exc:
        return InventoryResult(exc.status, exc.message)
    except asyncssh.HostKeyNotVerifiable:
        return InventoryResult(HOST_KEY_REFUSED,
                               "The host key does not match an accepted key.")
    except asyncssh.PermissionDenied:
        return InventoryResult(AUTH_FAILED, "The host refused the credential.")
    except TimeoutError:
        return InventoryResult(TIMEOUT, f"No answer within {int(timeout)} s.")
    except (OSError, asyncssh.Error) as exc:
        return InventoryResult(UNREACHABLE, _safe_reason(exc))


def _safe_reason(exc) -> str:
    """A short, secret-free reason for a connection error."""
    name = type(exc).__name__
    reason = getattr(exc, "reason", "") or getattr(exc, "strerror", "") or ""
    text = f"{name}: {reason}" if reason else name
    return text[:200]


async def observe_host_key(host: str, *, port: int = 22, timeout: float = 10.0) -> dict | None:
    """The host key the server presents, read with a key exchange only (no
    authentication, nothing sent but the handshake), as ``{key_type,
    public_key, fingerprint}``; ``None`` when it cannot be read."""
    import base64

    import asyncssh

    try:
        key = await asyncio.wait_for(
            asyncssh.get_server_host_key(host, port, config=None), timeout)
    except (OSError, asyncssh.Error, TimeoutError):
        return None
    if key is None:
        return None
    try:
        return {"key_type": key.get_algorithm(),
                "public_key": base64.b64encode(key.public_data).decode("ascii"),
                "fingerprint": key.get_fingerprint()}
    except Exception:  # noqa: BLE001 - an asyncssh surprise is "not read"
        return None
