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

Trusted runs are not confined: they get the ORM and the worker's
environment on purpose.
"""
from __future__ import annotations

import ctypes
import ctypes.util
import logging
import os
import platform
import sys
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
    """``landlock`` (the default) confines every sandboxed run and refuses
    one the kernel cannot confine. ``none`` runs them unconfined."""
    value = str(getattr(settings, "SCRIPT_SANDBOX", "landlock") or "landlock").lower()
    return "none" if value in ("none", "off", "0", "false") else "landlock"


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


@dataclass
class Confinement:
    """A prepared Landlock ruleset, applied in the child before ``exec``."""

    abi: int
    ruleset_fd: int
    blocked: set[int] = field(default_factory=set)
    notes: list[str] = field(default_factory=list)
    libc: object = field(default_factory=_libc, repr=False)
    seccomp: object = field(default=None, repr=False)

    def restrict_child(self) -> None:
        """Runs between fork and exec. Raises, so the launch fails, if the
        kernel refuses: a run is never started half-confined."""
        libc = self.libc
        if libc.prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "no_new_privs refused")
        if self.seccomp is not None and libc.prctl(
            _PR_SET_SECCOMP, _SECCOMP_MODE_FILTER, ctypes.byref(self.seccomp), 0, 0
        ) != 0:
            raise OSError(ctypes.get_errno(), "seccomp filter refused")
        if libc.syscall(_SYS_RESTRICT_SELF, self.ruleset_fd, 0) != 0:
            raise OSError(ctypes.get_errno(), "landlock_restrict_self refused")

    def close(self) -> None:
        if self.ruleset_fd >= 0:
            os.close(self.ruleset_fd)
            self.ruleset_fd = -1


def prepare(work: str, *, readable: tuple[str, ...] = ()) -> Confinement:
    """Build the ruleset for one run, whose only writable place is ``work``.

    Raises :class:`SandboxUnavailable` when the kernel has no Landlock.
    """
    abi = abi_version()
    if abi < 1:
        raise SandboxUnavailable(
            "This host cannot confine sandboxed scripts: the kernel has no Landlock "
            "(Linux 5.13 or later with landlock enabled), or a seccomp profile blocks it."
        )
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
                       seccomp=_unix_socket_filter())
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

        base = os.path.realpath(str(settings.BASE_DIR))
        for path in (*SYSTEM_DIRS, *sorted(_python_dirs()), *readable):
            real = os.path.realpath(path)
            if base == real or base.startswith(real.rstrip("/") + "/"):
                # Granting it would hand over the checkout and its .env.
                raise SandboxUnavailable(
                    f"Cannot confine scripts: {path} contains the Danbyte directory {base}. "
                    "Install Danbyte outside the Python and system directories."
                )
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
