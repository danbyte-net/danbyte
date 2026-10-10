"""Confining a sandboxed script run with Landlock (#316).

A sandboxed run is a child process of the RQ worker under the same OS
account. Building its environment from scratch keeps secrets out of
``os.environ``, but on its own the child could still read whatever that
account can: ``/proc/<worker>/environ``, the ``.env`` beside the code,
media and backups. Landlock is an unprivileged Linux security module: a
process can drop its own filesystem access before ``exec`` and never get
it back, with no package, no root and no extra uid.

The child is allowed:

* read and execute the system (``/usr`` and friends), the Python install
  and its virtualenv, and a handful of ``/etc`` files name resolution and
  TLS need;
* read and write its own work directory, which holds the script, its
  outputs and a copy of the SDK;
* ``/dev/null`` and the random devices.

Everything else, including ``/proc``, ``/sys``, the Danbyte checkout and
other temporary files, is denied. On kernels that support it the child
also cannot signal or ``ptrace`` processes outside its own tree, cannot
reach abstract unix sockets, and cannot open TCP connections to the
Redis and database ports (Redis holds the RQ queues, whose jobs the worker
unpickles).

Where bubblewrap (``bwrap``) works, it is the outer layer (0.18): the run
gets its own user, pid, mount, ipc, uts and network namespaces. Its
filesystem holds only the system, the Python install and its own work
directory, with no ``/proc`` and no Danbyte directory at all, and its
network has nothing but a loopback port that the worker relays to the
Danbyte API. Landlock and the seccomp filter still apply inside it, so a
host without a working ``bwrap`` falls back to the Landlock-only
confinement above, never below it.

Trusted runs are not confined: they get the ORM and the worker's
environment on purpose.
"""
from __future__ import annotations

import ctypes
import ctypes.util
import hashlib
import ipaddress
import logging
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from django.conf import settings

logger = logging.getLogger(__name__)

# The newer syscalls share one number on every architecture Danbyte runs on.
_SYS_CREATE_RULESET = 444
_SYS_ADD_RULE = 445
_SYS_RESTRICT_SELF = 446
_CREATE_RULESET_VERSION = 1 << 0
_RULE_PATH_BENEATH = 1
_RULE_NET_PORT = 2
_PR_SET_NO_NEW_PRIVS = 38

# Filesystem rights, by the ABI version that introduced them.
FS_EXECUTE = 1 << 0
FS_WRITE_FILE = 1 << 1
FS_READ_FILE = 1 << 2
FS_READ_DIR = 1 << 3
FS_REMOVE_DIR = 1 << 4
FS_REMOVE_FILE = 1 << 5
FS_MAKE_CHAR = 1 << 6
FS_MAKE_DIR = 1 << 7
FS_MAKE_REG = 1 << 8
FS_MAKE_SOCK = 1 << 9
FS_MAKE_FIFO = 1 << 10
FS_MAKE_BLOCK = 1 << 11
FS_MAKE_SYM = 1 << 12
FS_REFER = 1 << 13  # ABI 2
FS_TRUNCATE = 1 << 14  # ABI 3
FS_IOCTL_DEV = 1 << 15  # ABI 5
NET_CONNECT_TCP = 1 << 1  # ABI 4
SCOPE_ABSTRACT_UNIX_SOCKET = 1 << 0  # ABI 6
SCOPE_SIGNAL = 1 << 1  # ABI 6

# Rights that apply to a file rather than a directory.
_FILE_RIGHTS = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV
_READ_EXEC = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR

# What the interpreter and the libraries a script may import need from the
# system. Paths that do not exist on a host are skipped.
SYSTEM_DIRS = ("/usr", "/lib", "/lib64", "/lib32", "/bin", "/sbin", "/etc/ssl",
               "/etc/ca-certificates", "/etc/pki", "/etc/alternatives")
SYSTEM_FILES = ("/etc/ld.so.cache", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf",
                "/etc/host.conf", "/etc/gai.conf", "/etc/services", "/etc/protocols",
                "/etc/localtime", "/etc/passwd", "/etc/group", "/etc/mime.types")
DEVICES = ("/dev/null", "/dev/zero", "/dev/random", "/dev/urandom")


# seccomp: refuse socket(AF_UNIX). Landlock does not yet govern connecting
# to a pathname unix socket, and the database's local socket may accept the
# service account by peer authentication. socketpair() stays allowed.
_PR_SET_SECCOMP = 22
_SECCOMP_MODE_FILTER = 2
_AF_UNIX = 1
_EPERM = 1
# machine -> (AUDIT_ARCH_*, socket syscall number)
_SECCOMP_ARCH = {"x86_64": (0xC000003E, 41), "aarch64": (0xC00000B7, 198)}


class SandboxUnavailable(RuntimeError):
    """The kernel cannot confine the run, and the deployment requires it."""


class _RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64),
                ("handled_access_net", ctypes.c_uint64),
                ("scoped", ctypes.c_uint64)]


class _PathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


class _NetPortAttr(ctypes.Structure):
    _fields_ = [("allowed_access", ctypes.c_uint64), ("port", ctypes.c_uint64)]


class _SockFilter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_uint16), ("jt", ctypes.c_uint8), ("jf", ctypes.c_uint8),
                ("k", ctypes.c_uint32)]


class _SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(_SockFilter))]


def _unix_socket_filter() -> _SockFprog | None:
    """A classic BPF program: a foreign syscall ABI kills the process,
    socket(AF_UNIX, ...) fails with EPERM, everything else is allowed."""
    arch = _SECCOMP_ARCH.get(platform.machine())
    if arch is None:
        return None
    audit_arch, nr_socket = arch
    ld_w_abs, jeq, jge, ret = 0x20, 0x15, 0x35, 0x06
    kill, allow, errno = 0x80000000, 0x7FFF0000, 0x00050000 | _EPERM
    prog = [
        (ld_w_abs, 0, 0, 4),            # 0: A = arch
        (jeq, 1, 0, audit_arch),        # 1: native ABI -> 3
        (ret, 0, 0, kill),              # 2
        (ld_w_abs, 0, 0, 0),            # 3: A = syscall number
        (jge, 5, 0, 0x40000000),        # 4: x32 ABI -> kill
        (jeq, 0, 3, nr_socket),         # 5: socket() -> 6, else allow
        (ld_w_abs, 0, 0, 16),           # 6: A = low word of the domain
        (jeq, 0, 1, _AF_UNIX),          # 7: AF_UNIX -> 8, else allow
        (ret, 0, 0, errno),             # 8
        (ret, 0, 0, allow),             # 9
        (ret, 0, 0, kill),              # 10
    ]
    filters = (_SockFilter * len(prog))(*[_SockFilter(*ins) for ins in prog])
    fprog = _SockFprog(len(prog), filters)
    fprog._keep = filters  # the array must outlive the struct
    return fprog


def _libc():
    return ctypes.CDLL(ctypes.util.find_library("c") or None, use_errno=True)


def abi_version() -> int:
    """The Landlock ABI the running kernel offers, or 0 without it (old
    kernel, not enabled at boot, or a seccomp profile that blocks it)."""
    if platform.system() != "Linux":
        return 0
    try:
        libc = _libc()
        libc.syscall.restype = ctypes.c_long
        version = libc.syscall(_SYS_CREATE_RULESET, None, ctypes.c_size_t(0),
                               ctypes.c_uint32(_CREATE_RULESET_VERSION))
    except (OSError, AttributeError):
        return 0
    return max(int(version), 0)


def _handled_fs(abi: int) -> int:
    rights = (1 << 13) - 1
    if abi >= 2:
        rights |= FS_REFER
    if abi >= 3:
        rights |= FS_TRUNCATE
    if abi >= 5:
        rights |= FS_IOCTL_DEV
    return rights


def mode() -> str:
    """How sandboxed runs are confined.

    * ``auto`` (the default): bubblewrap around Landlock where ``bwrap``
      works, Landlock alone where it does not.
    * ``bwrap``: bubblewrap around Landlock, or the run is refused.
    * ``landlock``: Landlock alone, the 0.17.2 behaviour.
    * ``none``: unconfined.

    Every mode but ``none`` refuses a run the kernel cannot Landlock. An
    unknown value means ``auto``, which is never weaker than ``landlock``.
    """
    value = str(getattr(settings, "SCRIPT_SANDBOX", "auto") or "auto").strip().lower()
    if value in ("none", "off", "0", "false"):
        return "none"
    return value if value in ("bwrap", "landlock") else "auto"


def blocked_ports() -> set[int]:
    """TCP ports a sandboxed run may not connect to: Redis and the database."""
    ports: set[int] = set()
    db = settings.DATABASES.get("default", {})
    ports.add(int(db.get("PORT") or 5432))
    redis = getattr(settings, "RQ_QUEUES", {}) or {}
    for conf in redis.values():
        if conf.get("PORT"):
            ports.add(int(conf["PORT"]))
        if conf.get("URL"):
            ports.add(urlsplit(conf["URL"]).port or 6379)
    cache = getattr(settings, "CACHES", {}).get("default", {}).get("LOCATION")
    for loc in [cache] if isinstance(cache, str) else (cache or []):
        if str(loc).startswith(("redis://", "rediss://")):
            ports.add(urlsplit(loc).port or 6379)
    ports.add(6379)
    return {p for p in ports if 0 < p < 65536}


def _python_dirs() -> set[str]:
    """The interpreter, its standard library and the virtualenv's packages."""
    dirs = {sys.prefix, sys.exec_prefix, sys.base_prefix, sys.base_exec_prefix,
            os.path.dirname(os.path.dirname(os.path.realpath(sys.executable)))}
    return {d for d in dirs if d and d != "/"}


def _restrict_outer(libc, seccomp) -> None:
    """no_new_privs and the unix-socket filter: what every layer starts
    with, applied between fork and exec."""
    if libc.prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "no_new_privs refused")
    if seccomp is not None and libc.prctl(
        _PR_SET_SECCOMP, _SECCOMP_MODE_FILTER, ctypes.byref(seccomp), 0, 0
    ) != 0:
        raise OSError(ctypes.get_errno(), "seccomp filter refused")


def granted_dirs(readable: tuple[str, ...] = ()) -> list[str]:
    """Directories a run may read and execute: the system, the Python
    install and ``readable``. Refuses one that contains the Danbyte
    directory, since granting it would hand over the checkout and its
    ``.env``."""
    base = os.path.realpath(str(settings.BASE_DIR))
    dirs = []
    for path in (*SYSTEM_DIRS, *sorted(_python_dirs()), *readable):
        real = os.path.realpath(path)
        if base == real or base.startswith(real.rstrip("/") + "/"):
            raise SandboxUnavailable(
                f"Cannot confine scripts: {path} contains the Danbyte directory {base}. "
                "Install Danbyte outside the Python and system directories."
            )
        dirs.append(path)
    return dirs


def interpreter() -> str:
    """The interpreter by a path that exists inside the bubblewrap
    sandbox: its directory resolved, the file name kept, so a virtualenv
    still finds its ``pyvenv.cfg``."""
    return os.path.join(os.path.realpath(os.path.dirname(sys.executable)),
                        os.path.basename(sys.executable))


# ── bubblewrap ──────────────────────────────────────────────────────────────

# Searched instead of $PATH: bwrap starts before any confinement.
BWRAP_SEARCH_PATH = "/usr/bin:/bin:/usr/local/bin"
# The uid and gid a run has inside its user namespace ("nobody"). Outside,
# it is still the worker's account: an unprivileged user namespace maps
# exactly one id.
SANDBOX_ID = 65534
SANDBOX_HOSTNAME = "danbyte-script"
NPROC_LIMIT = 256  # processes and threads per run
PROBE_TTL = 600  # seconds a probe result is shared between worker processes
_INNER_FALLBACK_PORT = 8080

_PROBE_CODE = (
    "import socket\n"
    "assert [n for _, n in socket.if_nameindex()] == ['lo'], socket.if_nameindex()\n"
    "server = socket.socket()\n"
    "server.bind(('127.0.0.1', 0))\n"
    "server.listen()\n"
    "socket.create_connection(server.getsockname(), 2).close()\n"
    "print('bwrap-ok')\n"
)

# Runs inside the sandbox, as the command bwrap starts. It listens on the
# loopback port the script's DANBYTE_URL names and hands every connection
# to the worker, which relays it to the API; then it starts the script
# under Landlock. It stays outside the script's Landlock domain, so the
# script cannot signal or trace it.
_LAUNCHER = """\
import ctypes, resource, socket, subprocess, sys, threading

ruleset, relay, port, nproc = (int(v) for v in sys.argv[1:5])
command = sys.argv[6:]
listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.bind(("127.0.0.1", port))
listener.listen(64)
link = socket.socket(fileno=relay)
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


def confine():
    resource.setrlimit(resource.RLIMIT_NPROC, (nproc, nproc))
    if libc.syscall(446, ruleset, 0) != 0:
        raise OSError(ctypes.get_errno(), "landlock_restrict_self refused")


def serve():
    while True:
        conn, _ = listener.accept()
        try:
            socket.send_fds(link, [b"c"], [conn.fileno()])
        except OSError:
            return
        finally:
            conn.close()


try:
    child = subprocess.Popen(command, preexec_fn=confine, close_fds=True)
except Exception as exc:
    print(f"sandbox: the script could not be confined: {exc}", file=sys.stderr, flush=True)
    sys.exit(126)
threading.Thread(target=serve, daemon=True).start()
code = child.wait()
sys.exit(code if code >= 0 else 128 - code)
"""


@dataclass(frozen=True)
class BwrapProbe:
    """Whether ``bwrap`` can build the sandbox on this host, and why not."""

    path: str = ""
    usable: bool = False
    reason: str = ""
    disable_userns: bool = False


_probe_memo: dict[str, BwrapProbe] = {}
_probe_lock = threading.Lock()


def find_bwrap() -> str:
    return shutil.which("bwrap", path=BWRAP_SEARCH_PATH) or ""


def bwrap_argv(probe: BwrapProbe, work: str, read_dirs: list[str], *,
               hosts: str = "") -> list[str]:
    """The bwrap command line up to ``--``. The run sees the system and
    the Python install read-only, its work directory read-write with the
    files Danbyte put there read-only, a minimal ``/dev``, and nothing
    else: no ``/proc``, no ``/tmp``, no Danbyte directory."""
    args = [
        probe.path,
        "--unshare-user", "--uid", str(SANDBOX_ID), "--gid", str(SANDBOX_ID),
        "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net",
        "--unshare-cgroup-try", "--hostname", SANDBOX_HOSTNAME,
        "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    ]
    if probe.disable_userns:
        args.append("--disable-userns")
    bound: list[str] = []
    links: list[str] = []

    def covered(path: str) -> bool:
        return any(path == b or path.startswith(b.rstrip("/") + "/") for b in bound)

    for path in read_dirs:
        if path in SYSTEM_DIRS and os.path.islink(path):
            args += ["--symlink", os.readlink(path), path]  # /lib -> usr/lib
            continue
        real = os.path.realpath(path)
        if not os.path.isdir(real):
            continue
        if not covered(real):
            args += ["--ro-bind", real, real]
            bound.append(real)
        if real != os.path.abspath(path):
            links.append(path)
    # A virtualenv or a versioned interpreter is often reached through a
    # symlink (pyvenv.cfg's home); recreate it, pointing at the bound copy.
    for path in links:
        if not covered(path) and not any(path.startswith(p.rstrip("/") + "/") for p in links):
            args += ["--symlink", os.path.realpath(path), path]
    for path in SYSTEM_FILES:
        if hosts and path == "/etc/hosts":
            continue
        if os.path.exists(path):
            args += ["--ro-bind", path, path]
    if hosts:
        args += ["--ro-bind", hosts, "/etc/hosts"]
    args += ["--dev", "/dev", "--bind", work, work]
    for name in sorted(os.listdir(work)):
        if name != "outputs":
            path = os.path.join(work, name)
            args += ["--ro-bind", path, path]
    args += ["--remount-ro", "/", "--chdir", work, "--"]
    return args


def _run_probe(path: str) -> BwrapProbe:
    """Start a throwaway sandbox exactly as a run would, minus Landlock."""
    try:
        dirs = granted_dirs()
    except SandboxUnavailable as exc:
        return BwrapProbe(path=path, reason=str(exc))
    libc = _libc()
    fprog = _unix_socket_filter()
    reason = ""
    with tempfile.TemporaryDirectory(prefix="bwrap-probe-") as work:
        # --disable-userns needs bubblewrap 0.8; an older one is retried without.
        for disable in (True, False):
            candidate = BwrapProbe(path=path, usable=True, disable_userns=disable)
            argv = bwrap_argv(candidate, work, dirs) + [interpreter(), "-I", "-B", "-c",
                                                         _PROBE_CODE]
            try:
                done = subprocess.run(  # noqa: S603 - argv list, fixed binary
                    argv, capture_output=True, text=True, timeout=20, cwd=work,
                    env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, close_fds=True,
                    preexec_fn=lambda: _restrict_outer(libc, fprog),
                )
            except (OSError, subprocess.SubprocessError) as exc:
                reason = str(exc)
                continue
            if done.returncode == 0 and "bwrap-ok" in done.stdout:
                return candidate
            lines = (done.stderr or "").strip().splitlines()
            reason = lines[-1] if lines else f"exit code {done.returncode}"
    # bwrap's first sentence says what failed; the rest points at distro docs.
    reason = reason.removeprefix("bwrap: ").split(". ", 1)[0].strip().rstrip(".")
    return BwrapProbe(path=path, reason=reason[:300] or "bubblewrap failed")


def _probe_key(path: str) -> str:
    try:
        st = os.stat(path)
        stamp = f"{st.st_ino}:{st.st_mtime_ns}"
    except OSError:
        stamp = ""
    raw = "|".join((socket.gethostname(), path, stamp, platform.release(),
                    str(os.getuid()), interpreter()))
    return "scripting:bwrap-probe:" + hashlib.sha256(raw.encode()).hexdigest()[:32]


def bwrap_probe(*, refresh: bool = False) -> BwrapProbe:
    """Whether bubblewrap works here. Probed once per worker process and
    shared through the cache for :data:`PROBE_TTL` seconds, keyed by host,
    binary, kernel and account, so RQ's per-job processes do not each pay
    for it. A host can lose the ability (an AppArmor or seccomp change),
    which is why the shared result expires."""
    path = find_bwrap()
    if not path:
        return BwrapProbe(reason="bubblewrap is not installed")
    key = _probe_key(path)
    with _probe_lock:
        if not refresh:
            hit = _probe_memo.get(key)
            if hit is None:
                try:
                    from django.core.cache import cache

                    raw = cache.get(key)
                    hit = BwrapProbe(**raw) if isinstance(raw, dict) else None
                except Exception:  # noqa: BLE001 - a cache outage means probing
                    hit = None
            if hit is not None and hit.path == path:
                _probe_memo[key] = hit
                return hit
        result = _run_probe(path)
        _probe_memo[key] = result
        try:
            from django.core.cache import cache

            cache.set(key, result.__dict__.copy(), PROBE_TTL)
        except Exception:  # noqa: BLE001
            pass
    if result.usable:
        logger.info("script sandbox: bubblewrap %s works on this host", path)
    else:
        logger.warning("script sandbox: bubblewrap %s cannot run here: %s", path, result.reason)
    return result


@dataclass(frozen=True)
class ApiRoute:
    """How a run inside its network namespace reaches the API."""

    url: str  # the run's DANBYTE_URL
    port: int  # the loopback port the launcher listens on
    alias: str  # a host name the sandbox's /etc/hosts points at 127.0.0.1
    target: tuple[str, int]  # where the worker relays each connection


def api_route(url: str) -> ApiRoute:
    """The URL keeps its scheme, path and host name, so TLS still checks
    the right name; an address becomes 127.0.0.1. A port below 1024
    cannot be bound in the sandbox, so the inside port may differ."""
    parts = urlsplit(url)
    scheme = parts.scheme or "http"
    host = parts.hostname or "127.0.0.1"
    port = parts.port or (443 if scheme == "https" else 80)
    inner = port if port >= 1024 and port not in blocked_ports() else _INNER_FALLBACK_PORT
    try:
        ipaddress.ip_address(host)
        literal = True
    except ValueError:
        literal = host == "localhost"
    inner_host, alias = ("127.0.0.1", "") if literal else (host, host)
    return ApiRoute(f"{scheme}://{inner_host}:{inner}{parts.path.rstrip('/')}", inner, alias,
                    (host, port))


def hosts_file(route: ApiRoute) -> str:
    names = " ".join(n for n in ("localhost", SANDBOX_HOSTNAME, route.alias) if n)
    return f"127.0.0.1\t{names}\n::1\tlocalhost\n"


class ApiRelay:
    """The worker's end of a run's only network path: each connection the
    launcher accepts arrives here as a file descriptor and is joined to a
    fresh connection to the API. No database access, so threads are fine."""

    MAX_CONNECTIONS = 32

    def __init__(self, target: tuple[str, int]):
        self.target = target
        self.parent, self.child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self._lock = threading.Lock()
        self._open: set[socket.socket] = set()
        self._stopped = False
        self._thread = threading.Thread(target=self._receive, daemon=True,
                                        name="script-api-relay")

    @property
    def child_fd(self) -> int:
        return self.child.fileno()

    def start(self) -> None:
        """Call once the sandbox has been started with :attr:`child_fd`."""
        self.child.close()
        self._thread.start()

    def _receive(self) -> None:
        while True:
            try:
                msg, fds, _, _ = socket.recv_fds(self.parent, 16, 8)
            except OSError:
                return
            if not msg and not fds:
                return  # the sandbox is gone
            for fd in fds:
                self._join(socket.socket(fileno=fd))

    def _join(self, inner: socket.socket) -> None:
        with self._lock:
            refuse = self._stopped or len(self._open) >= 2 * self.MAX_CONNECTIONS
        if refuse:
            inner.close()
            return
        try:
            outer = socket.create_connection(self.target, timeout=10)
            outer.settimeout(None)
        except OSError:
            inner.close()
            return
        with self._lock:
            if self._stopped:
                inner.close()
                outer.close()
                return
            self._open.update((inner, outer))
        left = [2]

        def pipe(src: socket.socket, dst: socket.socket) -> None:
            try:
                while data := src.recv(65536):
                    dst.sendall(data)
            except OSError:
                pass
            try:
                dst.shutdown(socket.SHUT_WR)
            except OSError:
                pass
            with self._lock:
                left[0] -= 1
                if left[0]:
                    return
                self._open.difference_update((inner, outer))
            inner.close()
            outer.close()

        for src, dst in ((inner, outer), (outer, inner)):
            threading.Thread(target=pipe, args=(src, dst), daemon=True,
                             name="script-api-pipe").start()

    def stop(self) -> None:
        with self._lock:
            self._stopped = True
            live = list(self._open)
        for sock in (self.parent, *live):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        if self._thread.is_alive():
            self._thread.join(timeout=2)
        self.parent.close()
        self.child.close()


# ── the confinement of one run ──────────────────────────────────────────────


@dataclass
class Confinement:
    """A prepared Landlock ruleset and, where it works, the bubblewrap
    sandbox around it."""

    abi: int
    ruleset_fd: int
    blocked: set[int] = field(default_factory=set)
    notes: list[str] = field(default_factory=list)
    libc: object = field(default_factory=_libc, repr=False)
    seccomp: object = field(default=None, repr=False)
    work: str = ""
    read_dirs: list[str] = field(default_factory=list)
    bwrap: BwrapProbe | None = None
    skipped: str = ""  # why bubblewrap is not used, when it is not

    @property
    def layers(self) -> list[str]:
        names = ["bubblewrap"] if self.bwrap is not None else []
        names.append("Landlock")
        if self.seccomp is not None:
            names.append("seccomp")
        return names

    def restrict_child(self) -> None:
        """Runs between fork and exec. Raises, so the launch fails, if the
        kernel refuses: a run is never started half-confined. Under
        bubblewrap, Landlock is applied inside the sandbox by the launcher,
        since a Landlocked process cannot set up mounts."""
        _restrict_outer(self.libc, self.seccomp)
        if self.bwrap is None and self.libc.syscall(_SYS_RESTRICT_SELF, self.ruleset_fd, 0) != 0:
            raise OSError(ctypes.get_errno(), "landlock_restrict_self refused")

    def wrap(self, cmd: list[str], route: ApiRoute, relay_fd: int) -> tuple[list[str], tuple]:
        """The bubblewrap command for ``cmd``, and the descriptors it must
        inherit. Writes the launcher and the hosts file into the work
        directory first, so they are bound read-only."""
        launcher = os.path.join(self.work, "_danbyte_launch.py")
        with open(launcher, "w") as fh:
            fh.write(_LAUNCHER)
        hosts = os.path.join(self.work, "_hosts")
        with open(hosts, "w") as fh:
            fh.write(hosts_file(route))
        exe = interpreter()
        inner = [exe if part == sys.executable else part for part in cmd]
        argv = bwrap_argv(self.bwrap, self.work, self.read_dirs, hosts=hosts) + [
            exe, "-I", "-B", launcher, str(self.ruleset_fd), str(relay_fd), str(route.port),
            str(NPROC_LIMIT), "--", *inner,
        ]
        return argv, (self.ruleset_fd, relay_fd)

    def close(self) -> None:
        if self.ruleset_fd >= 0:
            os.close(self.ruleset_fd)
            self.ruleset_fd = -1


def prepare(work: str, *, readable: tuple[str, ...] = ()) -> Confinement:
    """Build the Landlock ruleset for one run, whose only writable place is
    ``work``. The caller adds the bubblewrap layer (:func:`with_bwrap`).

    Raises :class:`SandboxUnavailable` when the kernel has no Landlock.
    """
    abi = abi_version()
    if abi < 1:
        raise SandboxUnavailable(
            "This host cannot confine sandboxed scripts: the kernel has no Landlock "
            "(Linux 5.13 or later with landlock enabled), or a seccomp profile blocks it."
        )
    read_dirs = granted_dirs(readable)
    libc = _libc()
    libc.syscall.restype = ctypes.c_long
    handled_fs = _handled_fs(abi)
    attr = _RulesetAttr(handled_access_fs=handled_fs)
    size = 8
    notes: list[str] = []
    if abi >= 4:
        attr.handled_access_net = NET_CONNECT_TCP
        size = 16
    else:
        notes.append("the kernel cannot block TCP connections to Redis and the database")
    if abi >= 6:
        attr.scoped = SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL
        size = 24
    else:
        notes.append("the kernel cannot stop signals to processes outside the run")
    fd = libc.syscall(_SYS_CREATE_RULESET, ctypes.byref(attr), ctypes.c_size_t(size),
                      ctypes.c_uint32(0))
    if fd < 0:
        raise SandboxUnavailable(f"landlock_create_ruleset failed: {os.strerror(ctypes.get_errno())}")
    conf = Confinement(abi=abi, ruleset_fd=int(fd), notes=notes, libc=libc,
                       seccomp=_unix_socket_filter(), work=work, read_dirs=read_dirs)
    if conf.seccomp is None:
        notes.append(f"unix sockets are not blocked on {platform.machine()}")
    try:
        def allow(path: str, rights: int) -> None:
            try:
                pfd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            except OSError:
                return  # absent on this host
            try:
                if not os.path.isdir(path):
                    rights &= _FILE_RIGHTS
                rule = _PathBeneathAttr(allowed_access=rights & handled_fs, parent_fd=pfd)
                if libc.syscall(_SYS_ADD_RULE, conf.ruleset_fd, _RULE_PATH_BENEATH,
                                ctypes.byref(rule), 0) != 0:
                    raise SandboxUnavailable(
                        f"landlock_add_rule({path}) failed: {os.strerror(ctypes.get_errno())}"
                    )
            finally:
                os.close(pfd)

        for path in read_dirs:
            allow(path, _READ_EXEC)
        for path in SYSTEM_FILES:
            allow(path, FS_READ_FILE)
        for path in DEVICES:
            allow(path, FS_READ_FILE | FS_WRITE_FILE | FS_TRUNCATE)
        allow(work, handled_fs)

        if abi >= 4:
            # Landlock only allows: every port is opened except the blocked ones.
            conf.blocked = blocked_ports()
            for port in range(1, 65536):
                if port in conf.blocked:
                    continue
                rule = _NetPortAttr(allowed_access=NET_CONNECT_TCP, port=port)
                if libc.syscall(_SYS_ADD_RULE, conf.ruleset_fd, _RULE_NET_PORT,
                                ctypes.byref(rule), 0) != 0:
                    raise SandboxUnavailable(
                        f"landlock_add_rule(port {port}) failed: "
                        f"{os.strerror(ctypes.get_errno())}"
                    )
    except BaseException:
        conf.close()
        raise
    return conf


def with_bwrap(conf: Confinement, want: str) -> None:
    """Add the bubblewrap layer for mode ``want`` (``auto`` or ``bwrap``).
    ``bwrap`` refuses the run when bubblewrap cannot run here; ``auto``
    goes ahead under Landlock alone and says why in the run log."""
    probe = bwrap_probe()
    if probe.usable:
        conf.bwrap = probe
        return
    if want == "bwrap":
        raise SandboxUnavailable(
            f"This host cannot run sandboxed scripts under bubblewrap: {probe.reason}. "
            "Set DANBYTE_SCRIPT_SANDBOX=auto to fall back to Landlock alone."
        )
    conf.skipped = probe.reason


