"""Run an nmap the administrator installed, and read its XML (#451 B4).

Django-free. Nothing of nmap is bundled: Danbyte runs a binary the admin
installed (``NMAP_BINARY``, else ``nmap`` on PATH) and reads the XML the
admin asked for. nmap's data files are never read by Danbyte's own engine.

Safety, by construction:

* :func:`build_argv` is the only way an argument list is made. Every value
  comes from a fixed allow-list or is an integer checked against bounds;
  targets must be IP literals (``ipaddress``) and are written in their
  canonical form. There is no way to pass a flag, a script, a hostname or
  any text a user typed.
* The fixed flags: ``-sT`` (TCP connect - no raw packets), ``-sV`` with a
  bounded ``--version-intensity``, ``--unprivileged``, ``-Pn``, ``-n`` (no
  DNS), ``-p`` with our port list, ``-T2``-``-T4``, ``--max-rate``,
  ``--max-retries 1``, ``--host-timeout``, ``-oX -``. Never ``--script``
  (no NSE at all in this version), ``-O``, ``-sS`` or ``-A``.
* :func:`run` refuses to start as root, runs without a shell
  (``subprocess`` with the list), in a fresh temporary directory, with a
  scrubbed environment, stdin closed, a cap on what it reads and a deadline
  after which the whole process group is killed.
* :func:`parse_xml` refuses any DOCTYPE but nmap's own bare
  ``<!DOCTYPE nmaprun>`` (no internal subset, so no entity can be declared)
  and any ENTITY declaration, caps the size, and reads only the addresses
  that were asked for.
"""
from __future__ import annotations

import ipaddress
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import xml.etree.ElementTree as ET

from . import fingerprints
from .service_scan import BANNER_KEEP, MAX_PORTS, HostResult, PortResult, clean

INTENSITY_RANGE = (0, 5)
TIMING_RANGE = (2, 4)
RATE_RANGE = (1, 2000)
HOST_TIMEOUT_RANGE = (10, 1800)
HOSTGROUP_RANGE = (1, 16)
MAX_TARGETS = 4096
OUTPUT_MAX = 32 * 1024 * 1024
VERSION_TIMEOUT = 5.0
#: The environment nmap runs with: nothing of the worker's.
CLEAN_ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}


class NmapError(Exception):
    pass


def _bounded(name: str, value, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
        raise NmapError(f"{name} must be an integer from {lo} to {hi}.")
    return value


def port_spec(ports) -> str:
    """``[22, 80, 81, 82]`` -> ``"22,80-82"``; integers 1-65535 only."""
    if not isinstance(ports, list | tuple) or not ports or len(ports) > MAX_PORTS:
        raise NmapError(f"1 to {MAX_PORTS} ports.")
    clean_ports = sorted({_bounded("A port", p, 1, 65535) for p in ports})
    parts, start, prev = [], clean_ports[0], clean_ports[0]
    for p in clean_ports[1:] + [None]:
        if p is not None and p == prev + 1:
            prev = p
            continue
        parts.append(str(start) if start == prev else f"{start}-{prev}")
        if p is not None:
            start = prev = p
    return ",".join(parts)


def target(value) -> str:
    """An IP literal in canonical form, or :class:`NmapError`."""
    if not isinstance(value, str):
        raise NmapError("A target must be an IP address.")
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        raise NmapError("A target must be an IP address.") from None


def build_argv(binary: str, addresses, ports, *, intensity: int = 2, timing: int = 3,
               max_rate: int = 20, host_timeout: int = 300,
               max_hostgroup: int = 4) -> list[str]:
    """The complete argument list. Raises :class:`NmapError` for any value
    outside the allow-list."""
    if not isinstance(binary, str) or not os.path.isabs(binary):
        raise NmapError("The nmap path must be absolute.")
    if not isinstance(addresses, list | tuple) or not addresses \
            or len(addresses) > MAX_TARGETS:
        raise NmapError(f"1 to {MAX_TARGETS} targets.")
    targets = [target(a) for a in addresses]
    intensity = _bounded("Version intensity", intensity, *INTENSITY_RANGE)
    timing = _bounded("Timing", timing, *TIMING_RANGE)
    max_rate = _bounded("Max rate", max_rate, *RATE_RANGE)
    host_timeout = _bounded("Host timeout", host_timeout, *HOST_TIMEOUT_RANGE)
    max_hostgroup = _bounded("Hosts at once", max_hostgroup, *HOSTGROUP_RANGE)
    argv = [binary, "-sT", "-sV", "--version-intensity", str(intensity), "--unprivileged",
            "-Pn", "-n", "-p", port_spec(list(ports)), f"-T{timing}",
            "--max-rate", str(max_rate), "--max-retries", "1",
            "--host-timeout", f"{host_timeout}s", "--max-hostgroup", str(max_hostgroup),
            "-oX", "-"]
    if any(t.startswith("-") for t in targets):  # cannot happen: IP literals
        raise NmapError("A target must be an IP address.")
    return argv + targets


# ─── finding the binary ──────────────────────────────────────────────────────


def locate(configured: str = "") -> str:
    """The binary: ``configured`` (``NMAP_BINARY``) when set, else ``nmap``
    on PATH. "" when there is none the process may execute."""
    path = (configured or "").strip() or shutil.which("nmap") or ""
    if not path or not os.path.isabs(path):
        return ""
    real = os.path.realpath(path)
    if not os.path.isfile(real) or not os.access(real, os.X_OK):
        return ""
    return path


_VERSION = re.compile(r"Nmap version ([0-9][0-9A-Za-z.]{0,20})")


def version(path: str) -> str:
    """``nmap --version`` -> ``"7.95"``; "" when it does not answer like
    nmap."""
    if not path:
        return ""
    try:
        out = subprocess.run([path, "--version"], stdin=subprocess.DEVNULL,
                             capture_output=True, timeout=VERSION_TIMEOUT, env=CLEAN_ENV,
                             cwd=tempfile.gettempdir(), check=False)
    except (OSError, subprocess.SubprocessError):
        return ""
    m = _VERSION.search(out.stdout[:4096].decode("ascii", "replace"))
    return m.group(1) if m else ""


# ─── running it ──────────────────────────────────────────────────────────────


def run(argv: list[str], *, timeout: float, output_max: int = OUTPUT_MAX) -> bytes:
    """Run ``argv`` (from :func:`build_argv`) and return its stdout. No
    shell; a temporary working directory; a scrubbed environment; killed
    with its process group at ``timeout`` or once it writes more than
    ``output_max`` bytes."""
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        raise NmapError("Refusing to run nmap as root.")
    with tempfile.TemporaryDirectory(prefix="danbyte-nmap-") as cwd:
        try:
            proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, cwd=cwd, env=CLEAN_ENV,
                                    shell=False, start_new_session=True, close_fds=True)
        except OSError as exc:
            raise NmapError(f"nmap could not start: {exc.strerror or exc}") from None
        buf = bytearray()
        over = threading.Event()

        def read():
            while True:
                chunk = proc.stdout.read(65536)
                if not chunk:
                    return
                if len(buf) + len(chunk) > output_max:
                    over.set()
                    _kill(proc)
                    return
                buf.extend(chunk)

        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill(proc)
            proc.wait()
            reader.join(2)
            raise NmapError(f"nmap did not finish in {int(timeout)} s and was stopped.") \
                from None
        reader.join(5)
        if over.is_set():
            raise NmapError("nmap wrote more output than allowed and was stopped.")
        if proc.returncode != 0:
            raise NmapError(f"nmap exited with status {proc.returncode}.")
        return bytes(buf)


def _kill(proc) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        try:
            proc.kill()
        except OSError:
            pass


# ─── reading the XML ─────────────────────────────────────────────────────────

_BARE_DOCTYPE = re.compile(rb"<!DOCTYPE\s+nmaprun\s*>")
_DANGEROUS = re.compile(rb"<!\s*(DOCTYPE|ENTITY)", re.IGNORECASE)


def parse_xml(raw: bytes, addresses) -> list[HostResult]:
    """nmap ``-oX`` output -> one :class:`HostResult` per requested address
    (open TCP ports only). Raises :class:`NmapError` on anything unsafe or
    unreadable."""
    if len(raw) > OUTPUT_MAX:
        raise NmapError("The nmap output is too large.")
    body = _BARE_DOCTYPE.sub(b"", raw, count=1)
    if _DANGEROUS.search(body):
        raise NmapError("The nmap output declares a DOCTYPE or an entity; refused.")
    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        raise NmapError(f"The nmap output is not valid XML: {exc}") from None
    if root.tag != "nmaprun":
        raise NmapError("Not nmap XML output.")
    wanted = {target(a): a for a in addresses}
    found: dict[str, HostResult] = {}
    for host in root.iter("host"):
        addr = ""
        for a in host.findall("address"):
            if a.get("addrtype") in ("ipv4", "ipv6"):
                try:
                    addr = target(a.get("addr") or "")
                except NmapError:
                    addr = ""
                break
        if addr not in wanted:
            continue
        result = found.setdefault(addr, HostResult(wanted[addr]))
        for port in host.iter("port"):
            p = _port(port)
            if p is not None:
                result.open.append(p)
    return [found.get(target(a)) or HostResult(a, "failed", "Not in the nmap output.")
            for a in addresses]


def _int_attr(el, name, default=0) -> int:
    try:
        return int(el.get(name) or default)
    except ValueError:
        return default


def _port(el) -> PortResult | None:
    if el.get("protocol") != "tcp":
        return None
    state = el.find("state")
    if state is None or state.get("state") != "open":
        return None
    number = _int_attr(el, "portid")
    if not 1 <= number <= 65535:
        return None
    r = PortResult(port=number, source="nmap")
    svc = el.find("service")
    if svc is None:
        return r
    r.service = clean(svc.get("name") or "", 40)
    r.product = clean(svc.get("product") or "", 128)
    r.version = clean(svc.get("version") or "", 64)
    extra = clean(svc.get("extrainfo") or "", 200)
    r.banner = clean(" ".join(x for x in (r.product, r.version, extra) if x), BANNER_KEEP)
    method = svc.get("method") or ""
    conf = _int_attr(svc, "conf")
    r.rule = f"nmap {method or 'table'}, conf {conf}"
    cpes = [c.text or "" for c in svc.findall("cpe")]
    app = next((c for c in cpes if c.startswith(("cpe:/a:", "cpe:/o:"))), "")
    if app:
        r.cpe = fingerprints.cpe23(app, r.version)
        r.vendor = clean(app.split(":")[2].replace("_", " "), 128) if app.count(":") >= 2 \
            else ""
    os_bits = clean(svc.get("ostype") or "", 128)
    r.os = os_bits
    if method == "probed":
        r.confidence = "high" if r.version and r.product else "medium"
    else:
        r.confidence = "low"
    return r
